// The one import of the generated Terse client (`durable-actors generate --out-dir src/generated`), and the only place
// that knows how to reach the actors. Everything else in the backend goes through the gateway and the clients built
// from `createTerseTransport`.
//
// Two ways to reach them (Env["terse"]):
//  - `runtime`: a durable-actors server (local dev, tests, self-hosted). Every call carries its admin secret.
//  - `cloud`: Terse Cloud. The API key never reaches the runtime: it is exchanged at `<actorUrl>/access` for a
//    short-lived runtime session (renewed by the generated session transport), and at `<actorUrl>` for socket grants.
//    Same flow as terse-sdk's ActorAccessTransport and ActorProxy.
import { z } from "zod";
import type { Env } from "../env.ts";
import * as generated from "../generated/index.js";

export { generated };
export type { ActorRpcTransport } from "../generated/index.js";

type TerseConfig = Env["terse"];
type SocketAuthorization = { actorId: string; metadata: { userId: string } };

const SETUP_TIMEOUT_MS = 10_000;

const Session = z.object({ projectId: z.string(), controlPlaneUrl: z.string(), token: z.string().min(1), expiresAtMs: z.number().int() });
const Grant = z.object({
  websocketUrl: z.string().refine((v) => URL.canParse(v) && new URL(v).protocol === "wss:", "must be a wss:// URL"),
  connectByMs: z.number().int(),
});

/** `dispose` (session transports only) stops renewing; an idle session transport stops on its own after a minute. */
export function createTerseTransport(
  config: TerseConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): generated.ActorRpcTransport & { dispose?(): void } {
  if (config.kind === "runtime")
    return generated.createActorTransport({ controlPlaneUrl: config.controlPlaneUrl, apiKey: config.secret, projectId: config.projectId });
  return generated.createActorSessionTransport({
    projectId: config.projectId,
    getSession: async () => {
      const res = await fetchFn(`${config.actorUrl}/access`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        // A refused key stops renewal for good; anything else is retried by the next call.
        if (res.status === 401 || res.status === 403) throw new generated.ActorSessionRejectedError(`Terse refused the API key (HTTP ${res.status})`);
        throw new Error(`Terse session: HTTP ${res.status}`);
      }
      const session = Session.safeParse(await res.json());
      if (!session.success) throw new Error("Terse session: unexpected response shape");
      return session.data;
    },
  });
}

/** A one-time grant for a backend-held socket to one actor instance. */
export async function prepareActorSocket(
  config: TerseConfig,
  actorName: "Team" | "TeamWorkforce",
  authorization: SocketAuthorization,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<{ websocketUrl: string; connectByMs: number }> {
  if (config.kind === "runtime") {
    const options = { controlPlaneUrl: config.controlPlaneUrl, apiKey: config.secret, projectId: config.projectId, setupTimeoutMs: SETUP_TIMEOUT_MS };
    const grant = await generated.actors[actorName].prepareWebsocket(authorization, options, { fetch: fetchFn });
    return { websocketUrl: grant.websocketUrl, connectByMs: grant.connectByMs };
  }
  const res = await fetchFn(config.actorUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ actorName, actorId: authorization.actorId, metadata: authorization.metadata }),
    signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    redirect: "error",
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Terse socket grant: HTTP ${res.status}`);
  }
  const grant = Grant.safeParse(await res.json());
  if (!grant.success) throw new Error("Terse socket grant: unexpected response shape");
  return grant.data;
}

/** Throws unless the deployment answers with these credentials: what readiness reports for Terse. */
export async function pingTerse(config: TerseConfig, timeoutMs: number, fetchFn: typeof fetch = globalThis.fetch): Promise<void> {
  const url =
    config.kind === "runtime"
      ? `${config.controlPlaneUrl}/v1/projects/${encodeURIComponent(config.projectId ?? "local")}/deployment/contract`
      : `${new URL(config.actorUrl).origin}/sdk/projects/${encodeURIComponent(config.projectId)}/actors/contract`;
  const res = await fetchFn(url, {
    headers: { authorization: `Bearer ${config.kind === "runtime" ? config.secret : config.apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`terse ping: HTTP ${res.status}`);
}
