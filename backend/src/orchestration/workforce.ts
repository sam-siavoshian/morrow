// Typed door into the TeamWorkforce actor (one per team). Calls go through `invoke`, which retries
// `unavailable` always and `outcome_unknown` only for methods that are safe to replay (they carry an
// idempotency key or are reads/sweeps). Failures surface as browser-safe AppErrors.
import { z } from "zod";
import { createTerseTransport, generated, type ActorRpcTransport } from "../actors/client.ts";
import { invoke } from "../actors/invoke.ts";
import type { Env } from "../env.ts";
import type { ActorTypes } from "../generated/types.js";
import type { Logger } from "../lib/logger.ts";

type Methods = ActorTypes["TeamWorkforce"]["Methods"];
type MethodName = keyof Methods;
export type WorkforceResult<K extends MethodName> = Awaited<ReturnType<Methods[K]>>;

export type OutboxClaim = WorkforceResult<"claimOutbox">[number];
export type OutboxResult = Parameters<Methods["completeOutbox"]>[1];
export type Lease = NonNullable<WorkforceResult<"getLease">>;
export type CliProfile = NonNullable<WorkforceResult<"getProfile">>;
export type TaskRecord = NonNullable<WorkforceResult<"getTask">>;
export type WorkforceSnapshot = WorkforceResult<"getView">;
export type PlanInput = Parameters<Methods["recordPlan"]>[1];
export type PlanWorkstreamInput = PlanInput["workstreams"][number];
export type ReservePick = Parameters<Methods["reserveWorkers"]>[1][number];
export type VerificationInput = Parameters<Methods["submitVerification"]>[1];
export type ConflictInput = Parameters<Methods["resolveConflict"]>[2];
export type SpawnStatus = Parameters<Methods["recordSpawnStatus"]>[2];

/** Every TeamWorkforce method, called as `(teamId, ...args)`. */
export type WorkforceApi = { [K in MethodName]: (teamId: string, ...args: Parameters<Methods[K]>) => ReturnType<Methods[K]> };

/**
 * Replay safety per method. `claimOutbox` is the only unsafe write: a replayed claim would hide items for a
 * visibility timeout (delaying, never duplicating, their side effects), so it is not retried on outcome_unknown.
 */
const IDEMPOTENT: Record<MethodName, boolean> = {
  ackHandoff: true,
  addWorkstream: true,
  beginPlanning: true,
  cancelSubagent: true,
  cancelTask: true,
  claimOutbox: false,
  completeOutbox: true,
  completeWorkstream: true,
  createTask: true,
  delegate: true,
  deleteTask: true,
  getInternals: true,
  getLease: true,
  getNotified: true,
  getProfile: true,
  getTask: true,
  getView: true,
  markNotified: true,
  markProfileLimited: true,
  noteWaiting: true,
  pickAttempt: true,
  reconcile: true,
  recordContract: true,
  recordPlan: true,
  recordProfileUsage: true,
  recordSpawnStatus: true,
  recordSubagentResult: true,
  registerProfile: true,
  removeProfile: false,
  reportCheckpoint: true,
  requestHandoff: true,
  resolveConflict: true,
  reserveWorkers: true,
  retryTask: true,
  setTaskThread: true,
  setTaskWorkforce: true,
  stoppingSubagents: true,
  submitVerification: true,
  updateProfileHealth: true,
};

export function createWorkforceClient(config: Env["terse"], log: Logger, transport?: ActorRpcTransport): WorkforceApi {
  const t = transport ?? createTerseTransport(config);
  const api: Partial<Record<MethodName, unknown>> = {};
  for (const name of Object.keys(IDEMPOTENT) as MethodName[]) {
    api[name] = (teamId: string, ...args: unknown[]) =>
      invoke(
        () => {
          const stub = generated.actors.TeamWorkforce.get(teamId, t) as unknown as Record<MethodName, (...a: unknown[]) => Promise<unknown>>;
          return stub[name](...args);
        },
        { op: `TeamWorkforce.${name}`, idempotent: IDEMPOTENT[name] },
        { log },
      );
  }
  return api as WorkforceApi;
}

const Inventory = z.object({
  actors: z.array(z.object({ actorName: z.string(), instances: z.array(z.object({ actorId: z.string() })) })),
});

/**
 * Ids of every TeamWorkforce instance the control plane knows (live or dormant), so the reconcilers can find
 * teams with unfinished work after a restart. Uses the control plane's observe API with the admin secret.
 * Terse Cloud has no such API (it answers 401 to a session token, 404 to the API key), so there the hint is empty
 * and the TeamDirectory alone lists the teams to resume.
 */
export async function listWorkforceTeamIds(config: Env["terse"], fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (config.kind === "cloud") return [];
  const project = encodeURIComponent(config.projectId ?? "local");
  const res = await fetchFn(`${config.controlPlaneUrl}/v1/projects/${project}/observe/actors`, {
    headers: { authorization: `Bearer ${config.secret}` },
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`observe/actors: HTTP ${res.status}`);
  }
  const parsed = Inventory.safeParse(await res.json());
  if (!parsed.success) throw new Error("observe/actors: unexpected response shape");
  const ids = parsed.data.actors.filter((a) => a.actorName === "TeamWorkforce").flatMap((a) => a.instances.map((i) => i.actorId));
  return [...new Set(ids)].filter((id) => /^[A-Za-z0-9._-]{1,128}$/.test(id));
}
