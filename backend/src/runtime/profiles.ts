import { CLI_LABEL, type ProfileCheckResponse, ProfileView, RegisterProfileBody, ServerFrame, UpdateProfileBody, WorkforceResponse, WorkforceView } from "@morrow/contracts";
import type { TeamRecord } from "../actors/types.ts";
import type { ProbeReport } from "../integrations/freestyle/index.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId, randomSlug } from "../lib/ids.ts";
import type { Logger } from "../lib/logger.ts";
import type { RealtimeHub } from "../realtime/hub.ts";
import type { RuntimeActors, StoredEnvironment } from "./actors.ts";
import { liveLeasesOnNode, toEnvironmentView, type EnvironmentRunner } from "./environments.ts";
import { KeyedMutex } from "./keyed.ts";

const REGISTRABLE = new Set(["provisioning", "bootstrapping", "awaiting_login", "ready"]);
/** One usage read per environment per this long, plus jitter so environments do not read in lockstep. */
export const USAGE_REFRESH_MS = 5 * 60_000;
export const USAGE_JITTER_MS = 60_000;
/** The CLIs whose subscription usage the VM can read (`vm/usage.sh`). The others have no usage readout. */
const USAGE_CLIS = new Set<string>(["claude", "codex"]);

/**
 * Profiles that went from signed in to signed out between two workforce views. Only a profile that was `ok`
 * in `prev` counts: a first snapshot (`prev` null), a brand-new profile and one already signed out never do,
 * so the owner hears about each lost login once, not on every probe or reconnect.
 */
export function newlySignedOut(prev: WorkforceView | null, next: WorkforceView): ProfileView[] {
  if (!prev) return [];
  return Object.values(next.profiles).filter((p) => p.auth === "auth_required" && prev.profiles[p.id]?.auth === "ok");
}

/** The owner-only notice for a lost login. Label and CLI only; nothing from the VM. */
export function signedOutToast(teamId: string, profile: ProfileView): Extract<ServerFrame, { kind: "toast" }> {
  const cli = CLI_LABEL[profile.cli];
  const name = profile.label === cli ? cli : `${profile.label} (${cli})`;
  return {
    kind: "toast",
    teamId,
    data: { level: "warning", title: `${name} is signed out`, body: "It won't take new tasks until you sign in again from Workforce." },
  };
}

/** A lost login is the owner's to fix (the terminal is theirs), so only their sockets hear about it. */
export function notifySignedOut(hub: Pick<RealtimeHub, "onWorkforceChange" | "publishToUser">, log: Logger): void {
  hub.onWorkforceChange((teamId, prev, next) => {
    for (const profile of newlySignedOut(prev, next)) {
      const sockets = hub.publishToUser(teamId, profile.ownerUserId, signedOutToast(teamId, profile));
      log.info("signed-out notice", { teamId, profileId: profile.id, cli: profile.cli, sockets });
    }
  });
}

export interface ProfileServiceOptions {
  actors: RuntimeActors;
  log: Logger;
  now: () => number;
  features: { freestyle: boolean; relay: boolean };
}

/**
 * CLI profiles: registration, the probe -> health flow, removal, and the flattened workforce view.
 * Health is only ever written from a probe (or an explicit offline mark before a pause); a failed probe
 * leaves the last known health alone instead of guessing.
 */
export class ProfileService {
  readonly #o: ProfileServiceOptions;
  readonly #envLocks = new KeyedMutex();
  /** When each environment's next usage read is due (`teamId/envId`). */
  readonly #usageDueAt = new Map<string, number>();
  #runner: EnvironmentRunner | null = null;

  constructor(options: ProfileServiceOptions) {
    this.#o = options;
  }

  attach(runner: EnvironmentRunner): void {
    this.#runner = runner;
  }

  get #env(): EnvironmentRunner {
    if (!this.#runner) throw new Error("profile service used before the runner was attached");
    return this.#runner;
  }

  /** One profile per CLI per environment: two would share one login and double-count capacity. */
  register(team: TeamRecord, envId: string, ownerUserId: string, body: RegisterProfileBody): Promise<ProfileView> {
    return this.#envLocks.run(`${team.id}/${envId}`, async () => {
      const env = await this.#o.actors.getEnvironment(team.id, envId);
      if (!env) throw notFound("Environment not found.");
      if (!REGISTRABLE.has(env.phase) || !env.nodeName) throw conflict("Profiles can only be added to a running environment.");
      if (body.scopes !== "all") {
        const known = new Set(team.projects.map((p) => p.id));
        if (body.scopes.some((id) => !known.has(id))) throw badRequest("Invalid request. scopes: unknown project");
      }
      const view = await this.#o.actors.getWorkforceView(team.id);
      if (Object.values(view.profiles).some((p) => p.envId === envId && p.cli === body.cli))
        throw conflict(`This environment already has a ${body.cli} profile.`);
      const result = await this.#o.actors.registerProfile(team.id, {
        id: newId("cp"),
        envId,
        ownerUserId,
        nodeName: env.nodeName,
        cli: body.cli,
        label: body.label,
        scopes: body.scopes,
        maxConcurrent: body.maxConcurrent,
      });
      if (!result.ok) throw conflict(result.reason === "too_many_profiles" ? "This team has too many profiles." : "That profile belongs to someone else.");
      this.#o.log.info("profile registered", { teamId: team.id, envId, profileId: result.profile.id, cli: body.cli });
      // Learn its login state now; the probe kicks the node config when readiness changes.
      this.#env.probe(team.id, envId).catch((error) => this.#o.log.warn("probe after register failed", { teamId: team.id, envId, error }));
      return result.profile;
    });
  }

  /**
   * How many workers one login runs at once. The actor's register updates an existing profile in place, so
   * everything else goes back as stored. It runs under the environment's lock, as register and remove do, so a
   * removal racing it can never bring the profile back. The node's capacity does not follow this setting
   * (`desiredNodeConfig`), so nothing restarts: the next placement uses the new number, running workers keep
   * going, and a value below the live count only holds new work until enough of them finish.
   */
  async update(teamId: string, envId: string, profileId: string, body: UpdateProfileBody): Promise<ProfileView> {
    return this.#envLocks.run(`${teamId}/${envId}`, async () => {
      const [stored, view] = await Promise.all([this.#o.actors.getProfile(teamId, profileId), this.#o.actors.getWorkforceView(teamId)]);
      const current = view.profiles[profileId];
      if (!stored || !current || stored.envId !== envId) throw notFound("Profile not found.");
      if (current.maxConcurrent === body.maxConcurrent) return current;
      const result = await this.#o.actors.registerProfile(teamId, {
        id: stored.id,
        envId: stored.envId,
        ownerUserId: stored.ownerUserId,
        nodeName: stored.nodeName,
        cli: stored.cli,
        label: stored.label,
        scopes: current.scopes,
        maxConcurrent: body.maxConcurrent,
      });
      // Same id, owner and environment as stored, so the actor only refuses if the profile changed hands meanwhile.
      if (!result.ok) throw conflict("This profile changed. Reload and try again.");
      this.#o.log.info("profile concurrency changed", { teamId, envId, profileId, from: current.maxConcurrent, to: body.maxConcurrent });
      return result.profile;
    });
  }

  async check(teamId: string, profileId: string): Promise<ProfileCheckResponse> {
    const profile = await this.#o.actors.getProfile(teamId, profileId);
    if (!profile) throw notFound("Profile not found.");
    const report = await this.#env.probe(teamId, profile.envId);
    if (!report) throw conflict("This environment is not running. Resume it first.");
    const current = (await this.#o.actors.getWorkforceView(teamId)).profiles[profileId];
    if (!current) throw notFound("Profile not found.");
    const cli = report.clis[profile.cli];
    return {
      profile: current,
      probe: {
        ok: report.ok,
        error: report.error,
        installed: cli.installed,
        version: cli.version,
        auth: cli.auth,
        node: report.relay.node,
        probedAt: report.probedAt,
      },
    };
  }

  async remove(teamId: string, profileId: string): Promise<void> {
    const profile = await this.#o.actors.getProfile(teamId, profileId);
    if (!profile) throw notFound("Profile not found.");
    // Under the environment's lock, so an update in flight finishes first instead of writing the profile back.
    const result = await this.#envLocks.run(`${teamId}/${profile.envId}`, () => this.#o.actors.removeProfile(teamId, profileId));
    this.#o.log.info("profile removed", { teamId, profileId, expiredLeases: result.expiredLeaseIds.length });
    // Its harness leaves the node config.
    this.#env.kick(teamId, profile.envId);
  }

  /** Probe -> health for every profile on the environment. True when any profile's readiness flipped. */
  async onProbe(teamId: string, env: StoredEnvironment, report: ProbeReport): Promise<boolean> {
    if (!report.ok) {
      this.#o.log.warn("probe failed; profile health unchanged", { teamId, envId: env.id, error: report.error });
      return false;
    }
    const view = await this.#o.actors.getWorkforceView(teamId);
    let changed = false;
    for (const profile of Object.values(view.profiles)) {
      if (profile.envId !== env.id) continue;
      const auth = report.clis[profile.cli].auth;
      const health = { auth, online: report.relay.node === "active", observedAt: report.probedAt };
      const applied = await this.#o.actors.updateProfileHealth(teamId, profile.id, health, `probe-${randomSlug(16)}`);
      if (!applied) continue;
      if ((profile.auth === "ok") !== (auth === "ok")) changed = true;
      if (auth === "auth_required" && profile.auth !== "auth_required")
        this.#o.log.warn("profile needs a new login", { teamId, envId: env.id, profileId: profile.id, cli: profile.cli });
    }
    return changed;
  }

  /**
   * Reads subscription usage for one environment when it is due and stores it on its Claude Code and Codex
   * profiles. At most once per `USAGE_REFRESH_MS` (plus jitter) per environment, failed reads included, and
   * only while it has a signed-in Claude Code or Codex profile; callers only ask for active teams. opencode,
   * Cursor Agent, Gemini CLI and Grok have no usage readout. Returns how many profiles got a new reading.
   */
  async refreshUsage(teamId: string, envId: string): Promise<number> {
    const k = `${teamId}/${envId}`;
    const now = this.#o.now();
    if (now < (this.#usageDueAt.get(k) ?? 0)) return 0;
    const view = await this.#o.actors.getWorkforceView(teamId);
    const profiles = Object.values(view.profiles).filter((p) => p.envId === envId && USAGE_CLIS.has(p.cli) && p.auth === "ok");
    if (profiles.length === 0) return 0;
    this.#usageDueAt.set(k, now + USAGE_REFRESH_MS + Math.floor(Math.random() * USAGE_JITTER_MS));
    const report = await this.#env.readUsage(teamId, envId);
    if (!report) return 0;
    if (!report.ok) {
      this.#o.log.warn("usage read failed", { teamId, envId, error: report.error });
      return 0;
    }
    let applied = 0;
    for (const profile of profiles) {
      if (profile.cli !== "claude" && profile.cli !== "codex") continue;
      const usage = report[profile.cli].usage;
      if (usage && (await this.#o.actors.recordProfileUsage(teamId, profile.id, usage))?.applied) applied++;
    }
    this.#o.log.info("usage read", { teamId, envId, claude: report.claude.status, codex: report.codex.status, applied });
    return applied;
  }

  async markOffline(teamId: string, envId: string): Promise<void> {
    const view = await this.#o.actors.getWorkforceView(teamId);
    for (const profile of Object.values(view.profiles)) {
      if (profile.envId !== envId) continue;
      await this.#o.actors.updateProfileHealth(teamId, profile.id, { auth: profile.auth, online: false, observedAt: this.#o.now() }, `offline-${randomSlug(16)}`);
    }
  }

  async removeForEnvironment(teamId: string, envId: string): Promise<void> {
    this.#usageDueAt.delete(`${teamId}/${envId}`);
    await this.#envLocks.run(`${teamId}/${envId}`, async () => {
      const view = await this.#o.actors.getWorkforceView(teamId);
      for (const profile of Object.values(view.profiles)) {
        if (profile.envId === envId) await this.#o.actors.removeProfile(teamId, profile.id);
      }
    });
  }

  /** Environments (not disconnected) with their profiles and live lease counts. */
  async workforce(teamId: string): Promise<WorkforceResponse> {
    const [envs, view] = await Promise.all([this.#o.actors.listEnvironments(teamId), this.#o.actors.getWorkforceView(teamId)]);
    const profiles = Object.values(view.profiles);
    return {
      environments: envs
        .filter((env) => env.phase !== "disconnected")
        .map((env) => ({
          ...toEnvironmentView(env),
          profiles: profiles.filter((p) => p.envId === env.id),
          liveLeases: liveLeasesOnNode(view, env.nodeName),
        })),
      features: this.#o.features,
    };
  }
}
