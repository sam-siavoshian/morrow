# Terse Durable Actors (durable-actors 0.14.4): how to build TeamWorkforce

Audience: the agent implementing the real `TeamWorkforce` actor. Everything here is backed by one of:

- **[pkg]** the installed package `backend/node_modules/durable-actors` (researched on 0.14.3; Morrow now pins 0.14.4), `dist/*.d.ts`
- **[src]** the GitHub repo `TerseAI/durable-actors` at tag `v0.14.3` (commit `1450b71`). I fetched the tag and diffed it against `main`: identical, so the source below is the source of the release you have installed.
- **[docs]** repo docs: `README.md`, `docs/reference/typescript-guide.md`, `docs/reference/cli.md`, `docs/reference/configuration.md`, `docs/self-hosting.md`, `examples/`
- **[blog]** https://www.useterse.ai/blog/terse-vs-cloudflare-durable-objects
- **[run]** the smoke test in section 7, executed with Bun 1.4.4 on macOS arm64. Output is pasted verbatim, except epoch-millisecond values, which are replaced with `<epoch-ms>`.

Things I could not verify are marked **UNVERIFIED**.

---

## 0. Short version

- An actor is a class that `extends Actor`. One instance per ID. Calls to one instance run **one at a time, including across `await`** unless a method in the class is `@Interleave`. [docs: typescript-guide "Interleaving calls"] [run: 10-way race, exactly one winner]
- `@Persisted` fields are saved **on every assignment** (immediately), not at method end. A plain method that writes then throws **keeps the write**. Only `@Atomic` methods roll back on throw. [src] [run]
- In-place mutation (`this.map[k] = v`, `arr.push(x)`) is **not saved**, and the in-memory copy silently diverges until the next throw or restart reloads from disk. Always reassign. [docs] [run]
- Alarms: one slot per actor. `this.alarm.set(ms)`, `this.alarm.get()`, `this.alarm.delete()`, callback `async onAlarm()`. There is **no `onResume` on Actor** (it exists only on `ActorResource`). [pkg]
- Alarm writes are **not part of the `@Atomic` transaction** (a throwing `@Atomic` method still leaves the alarm armed). [src] [run]
- In local dev, **pending alarms are lost when `durable-actors dev` restarts** (in-memory alarm store). Persisted fields survive. [src] [run]
- WebSockets: backend calls `actors.X.prepareWebsocket({ actorId, metadata })`, gets a `ws://.../v1/socket?key=<signed JWT>` URL valid for 60 s, browser opens it with plain `new WebSocket(url)`. The grant is bound to one actor and its metadata is signed. It is **reusable until it expires**, so treat it as a bearer credential. [src] [run]
- `@Emittable` on a public `@Persisted` field gives every connected socket a `state` snapshot on connect and a `state_update` after each successful call. Free live dashboard. [docs] [run]
- Hosting: Terse Cloud is now a documented managed service (docs.useterse.ai: `bunx terse-cli install`, browser login, `terse deploy`, an API key from the web app). Self-hosting on GKE with the Helm chart is the other path. Morrow uses Terse Cloud in production (`docs/architecture.md` section 13) and `durable-actors dev --no-watch` beside the backend locally. [docs.useterse.ai] [docs] [run]

---

## 1. Project layout, CLI, local dev

### What `durable-actors init` creates [run]

`bun x durable-actors@0.14.3 init terse-smoke` created exactly these files (no git init, no `.env`):

```
.gitignore      node_modules/ dist/ generated/ .durable-actors/ .env .env.* !.env.example
bunfig.toml     [run] bun = true
package.json    deps: durable-actors 0.14.3; dev: @types/node ^22, typescript ~5.9.3; scripts: dev, check; trustedDependencies: esbuild
README.md
tsconfig.json   target ES2022, module NodeNext, strict, noEmit   (no experimentalDecorators: TC39 standard decorators)
src/actors.ts   a Counter actor
```

`init --template <actor|chat|ai-chat|documents>` picks other starters. [docs: cli.md]

### Where actors live

`durable-actors dev` discovers `actors.ts` or `actors.py` in `src/` or the project root; set `DURABLE_ACTORS_ENTRYPOINT` if more than one exists. Export every actor class from that file. [docs: cli.md "durable-actors dev"]

### `durable-actors dev` [run] [docs] [src]

- Starts a ~60 MB native Rust runtime. First run downloads it from `https://github.com/TerseAI/durable-actors/releases/download/v<version>/durable-actors-<platform>-<arch>.tar.gz` into `~/.cache/durable-actors/<version>/<platform>-<arch>/` and checks a checksum. Prebuilt only for darwin/linux on arm64/x64. [src: `sdk/src/runtimeInstaller.ts:41-72`] [run: cache dir contained `durable-actors`, 60722768 bytes]
- **No Docker. No Python** (Python only for Python actors). Needs Bun >= 1.4.2. [docs: README] [run]
- Port: `7100` by default (`--port`, or `DURABLE_ACTORS_PORT`; `0` = free port). [docs: cli.md]
- **Binds `127.0.0.1` only**, hard-coded. There is no bind flag. [src: `src/control_plane/local.rs:117` `TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port))`] [run: `lsof` showed `TCP 127.0.0.1:7100 (LISTEN)`]
- State: `<project>/.durable-actors/` (`DURABLE_ACTORS_DATA_DIR` overrides). Local SQLite files plus `objects/` and `code/`. [docs: configuration.md] [run]
- Auth: disabled by default. `DURABLE_ACTORS_SECRET` (aka `--api-key`) enables a shared secret that backends send as `Authorization: Bearer`. [src: native `dev --help` lists `--api-key [env: DURABLE_ACTORS_SECRET=]`; `sdk/src/client-runtime/settings.ts:79-81`] **UNVERIFIED** at runtime (I ran with auth off).
- Watch mode is on by default. It **polls every source file under the project dir**, excluding `.git node_modules .venv venv __pycache__ .durable-actors generated target dist`. Any edit anywhere in the project reloads actors. [src: `src/control_plane/local_watch.rs:33-55`] During a reload calls fail with HTTP 503 `code: "unavailable"`, message `actor host is unavailable: actor host is not ready`. [run: my first call after creating `smoke.ts` in the project hit exactly this; log line `status=503 ... /invoke` then `Updated local actors.`]
  - Consequence: keep the actor project in its **own folder**, not inside `backend/`, or run `--no-watch` for the demo.
- Idle eviction: actors shut down after `DURABLE_ACTORS_HOST_IDLE_TIMEOUT_MS` (default 10000 ms), locally too. Open WebSockets stay at the gateway and do not keep the actor alive. [docs: configuration.md] [run: `inspect` showed `TeamWorkforce team-demo dormant` after idling]
- Cold start: first call to a dormant actor after a restart reported `routingMs: 1010`. [run: raw curl output]
- Ready banner [run]:

```
durable actors / local

  Ready    http://127.0.0.1:7100
  Project  local
  State    /…/terse-smoke/.durable-actors
  ...
     DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7100
     Authentication is disabled. No secret is needed for local development.
```

Other CLI commands [docs: cli.md] [run]:

- `durable-actors inspect` lists instances and status; `inspect TeamWorkforce/<id>` prints persisted state as JSON, private fields included. Very handy for the demo and debugging.
- `durable-actors observe` opens a local observability UI. **UNVERIFIED** (not opened).
- `durable-actors start` is the production control plane (Postgres + GCS + GKE). Not for us.

### `durable-actors generate` [run] [docs]

- With no arguments it fetches the contract from the running server (`GET /v1/projects/local/deployment/contract`) and writes `./generated/`. `generate <entrypoint> --out-dir <dir>` compiles from source instead (documented, **UNVERIFIED**).
- Connection settings come from env or `.env`/`.env.local`: `DURABLE_ACTORS_CONTROL_PLANE_URL` (default `http://127.0.0.1:7100`), `DURABLE_ACTORS_PROJECT_ID` (default `local` on localhost), `DURABLE_ACTORS_SECRET`. [docs: cli.md; src: `sdk/src/client-runtime/settings.ts:34-41`]
- Output is **self-contained**: `generated/index.js`, `index.d.ts`, `types.d.ts` and a copied `generated/runtime/` (fetch-based client, MIT). The backend does not need the `durable-actors` package at runtime to call actors. `runtime/package.json` maps the browser build to stubs that throw `actors must be used on the server`. [run] [src: `sdk/src/client-runtime/index.browser.ts`]
- Public methods are emitted; TS `private`/`protected` methods and lifecycle hooks are not. [src: `sdk/src/compiler/rpc-contract.ts` `publicMethods`] [run: `tsPrivateProbe` absent from generated client]
- Regenerate after changing method signatures or public types.

Recommended layout for us:

```
Hunted Hack YC/
  actors/                 # its own Bun project: package.json with durable-actors 0.14.3
    src/actors.ts         # TeamWorkforce
    .durable-actors/      # local state (gitignored, back it up before the demo)
  backend/
    src/generated/        # output of: bunx durable-actors generate --out-dir src/generated (run from backend/, server running)
```

---

## 2. Decorators and exact semantics

All decorators are TC39 standard decorators and are **no-ops at runtime**; the compiler reads them statically into the actor schema (`atomicMethods`, `interleaveMethods`, field flags). [src: `sdk/src/actor/decorators.ts`, `sdk/src/actor/schema.ts`]

Exports: `Actor, Atomic, Compute, Emittable, Ephemeral, Interleave, Persisted, Resource, unchecked, ActorInvocationError` plus types. There is **no `@Compute` method or field decorator; `Compute(...)` is a class decorator**. [pkg: `dist/index.d.ts`, `dist/actor/compute.d.ts`]

### Class rules [pkg] [src] [run]

- Must `extends Actor` directly. [src: `sdk/src/actor/actor.ts` `validateActorClass`]
- Every instance field needs `@Persisted` or `@Ephemeral` (initialized private `ActorResource` fields are implicitly ephemeral). [pkg: `dist/actor/actor.d.ts` class doc]
- **Every prototype method must be `async`, including TS `private` helpers.** My first build failed with `actor method TeamWorkforce.scheduleNextCooldownAlarm must be async`. [run] [src: `sdk/src/actor/actor.ts:208-228` `discoverMethods`] Use JS `#private` methods (they are not on the prototype) or module-level functions for sync helpers. [run: `#scheduleNextCooldownAlarm()` and `#remember()` work]
- Reserved names: `then, connect, broadcast, db, alarm`. `onAlarm` must take no arguments. No getters/setters, no symbol methods, no overloads, no generic or optional RPC methods. [src: `actor.ts:208-228`, `compiler/rpc-contract.ts:30-70`]
- Actor ID: 1–128 chars of `[A-Za-z0-9._-]`. [pkg: `Actor.get` doc] So `TeamWorkforce(teamProjectId)` needs a sanitized ID like `${teamId}.${projectId}`.
- Method args and results must be JSON. [src: `sdk/src/client-runtime/stub.ts`, `client.ts:168-172`]

### `@Persisted` (field)

- "Saves each assignment; reassign objects and arrays to save changes. `@Atomic` methods save on success." [pkg: `dist/actor/decorators.d.ts`]
- Outside `@Atomic`, every assignment is written immediately (`immediate: true`). [src: `sdk/src/host/database.ts:107-110`]
- **Reassign, do not mutate.** "Nested mutations such as `this.messages.push(message)` only change memory; they are not saved, even at method completion." [docs: typescript-guide.md:322] Verified, and it is worse than "not saved": memory and disk diverge until the instance is rebuilt.

```
same activation, after reassign(a) + pushInPlace(b): {"calls":2,"items":["a","b"]}
after a throwing call (calls was 2, throw bumped it to 3 before throwing): {"calls":0,"items":["a"]}
```
  [run: `mutation-probe.ts`] The pushed `"b"` was visible to the next call, then vanished as soon as any call threw.
- Doc bug to ignore: the repo `README.md:63,66` and `examples/chat/README.md:45` show `this.messages.push(...)`. The actual `examples/chat/src/actors.ts` reassigns. Follow the guide.
- Assign `undefined` to remove a saved value. New fields get their default only if missing from storage. Cannot decorate JS `#private` fields. [docs: typescript-guide.md:322-324] [src: decorators.ts:24]

### `@Atomic` (method)

- "Saves all of the method's writes together when it succeeds, or none if it throws." [pkg]
- On throw the runtime rolls back SQLite and **rebuilds the instance from disk**, so `@Ephemeral` fields reset too. [src: `sdk/src/host/actor-runtime.ts:146-152, 221-224`]
- Verified [run]: `reserveThenThrow` bumped `epoch`, added a lease, set the profile busy, then threw. After: epoch unchanged (2 -> 2), no lease added, profile still `ready`.
- **Exception: alarms are outside the transaction.** The host forwards `SetAlarm`/`DeleteAlarm` straight to the control plane and ignores the transaction flag. [src: `src/host/actor_database/session.rs:131-150`] [run: `alarm.set inside throwing @Atomic -> alarmAt=<epoch-ms> (NOT rolled back)`]. Rule: set or delete the alarm as the **last** statement of a method, and make `onAlarm` safe to run when nothing is due.
- Background SQL (from un-awaited work) throws while an `@Atomic` method is running. [src: `sdk/src/host/database.ts:51-55`]

### Plain methods (no decorator)

- Writes are saved as they happen. **A throw does not undo writes made before it.** [docs: typescript-guide.md:319] [run: `plain method write-then-throw: scratch 0 -> 1 (write KEPT)`]
- The in-memory instance is rebuilt from disk after a throw (non-interleaved classes), so un-saved in-place mutations and ephemeral fields are discarded. [src: actor-runtime.ts:151] [run: mutation probe above]
- Doc contradiction: typescript-guide.md:298 and the [blog] say "a failed call normally rolls back its field and SQLite changes". That is only true for `@Atomic`. Measured behavior matches typescript-guide.md:319.
- **For TeamWorkforce: mark every state transition `@Atomic`.**

### `@Interleave` (method, experimental)

- Lets other calls run while that method awaits. "Disables error rollback for the whole actor class." [pkg]
- The runtime skips the rollback/rebuild for every method once any method is interleaved. [src: actor-runtime.ts:62, 151, 207] Verified on a probe class [run]:

```
atomicWriteThenThrow threw: actor_error boom in interleaved class
after @Atomic throw in a class that has an @Interleave method: {"holder":"","value":1}
racyClaim results (both true = double claim): true true final: {"holder":"B","value":1}
```
  and `durable-actors inspect` confirmed `"value": 1` was **persisted**: the thrown `@Atomic` write committed. A check-then-act across `await` in an interleaved method gave two winners.
- **For TeamWorkforce: no `@Interleave` anywhere in the class.** Not "use carefully". None.

### `@Ephemeral` (field)

- "Marks a temporary field that may reset between calls." Lives in memory while the actor is awake; resets on shutdown. [pkg] [docs] Also resets after any failed call in a non-interleaved class (instance rebuild). [run: `calls` went 2 -> 0 after `plainThrow`]. Use only for caches.

### `@Emittable` (field)

- Requires a **public** `@Persisted` field. [pkg] [src: decorators.ts:33-36; actor-runtime.ts:297-301]
- On connect the socket first receives `{type:"state", state:{...emittable fields}}`. After each successful call that changed one of them, every socket gets `{type:"state_update", changes:{field: fullNewValue}, removed:[], version}`. [pkg: `dist/actor/socketValidation.d.ts`] [run: first frame `state` with keys `leases, profiles`; two `state_update` frames after a reserve]
- `changes` carries the **entire new value of each changed field**, not a deep diff. [src: actor-runtime.ts:278-295] [run: sample `state_update` contained the whole `profiles` map]. Keep emittable fields small; never mark the idempotency ledger emittable. Everything emittable goes to every connected socket of that actor.

### `@Resource` (field)

- Field type implements `ActorResource { onResume(): Promise<void>; onGracefulShutdown(): Promise<void> }`. `onResume` runs every time the instance is (re)created; `onGracefulShutdown` runs on graceful eviction only ("not called when actor crashes"). [pkg: `dist/actor/resource.d.ts`] [src: actor-runtime.ts:67-83, 246-252] [docs: typescript-guide "Using @Resource"]. Not tested. We do not need it.

### `Compute(options)` (class decorator)

- `@Compute({ cpu, cpuLimit, memoryMiB, memoryLimitMiB, idleTimeoutMs, regions })` overrides sandbox resources per class. [pkg: `dist/actor/compute.d.ts`] Relevant only for hosted/GKE. **UNVERIFIED** whether local dev honors `idleTimeoutMs`.

### `unchecked<T>(value)` / `Unchecked<T>`

- Opts a complex type out of client contract generation (client sees `unknown`); "This only impacts the client generation process." [pkg: `dist/actor/unchecked.d.ts`] [docs]. Not needed for us.

### Runtime input is NOT validated

- Raw HTTP calls reach your method with whatever JSON was sent. `releaseLease({"evil":true}, "not-a-number")` ran and returned `{"ok":false,"reason":"unknown lease"}`. [run: curl] The TS host only uses Ajv at compile time. [src: `compiler/validate-public-contract.ts`] **Validate every argument inside the actor** (zod is already a dependency of the package; or hand-written guards).

---

## 3. Alarms, wake-up, background work

### API [pkg: `dist/actor/alarm.d.ts`, `dist/actor/actor.d.ts`]

```ts
this.alarm.get(): number | null       // scheduled Unix ms, or null
this.alarm.set(timestampMs: number)   // replaces the single slot; past timestamps are due immediately
this.alarm.delete()
async onAlarm(): Promise<void>        // "The alarm is cleared afterward unless this callback sets a new one."
```

There is **one** alarm per actor. To track many cooldowns, store deadlines in state and always arm the slot for the earliest one (see `#scheduleNextCooldownAlarm` in section 7). [docs: "Each actor has one alarm. Setting it again replaces the previous timestamp."]

### Delivery semantics [src: `src/control_plane/alarms.rs`, `invocation.rs`]

- Poller every 100 ms (`DEFAULT_POLL_INTERVAL`), up to 100 in flight. [alarms.rs:17-18] Observed: fired about 257 ms after the deadline. [run]
- Delivery is an invocation of method `onAlarm` with request id `alarm-<revision>`. Up to 3 attempts with exponential backoff from 1 s, 60 s per attempt, when the host did not execute it or the outcome is unknown. [alarms.rs:19-25, 116-145; invocation.rs:18-47]
- If `onAlarm` **throws**, the outcome is `failed`, which counts as delivered; the alarm is then cleared (unless you re-armed it first). No retry. [invocation.rs:44-46; alarms.rs:256-273 `finish` clears only if revision unchanged] **UNVERIFIED** by run.
- The alarm wakes an evicted actor. [run: actor idled 20 s (> 10 s eviction), `onAlarm` ran, profile restored, and the still-open browser socket received the `worker.capacity_restored` broadcast]
- `onAlarm` is **callable over the raw HTTP API** like any method: `POST .../invoke {"method":"onAlarm"}` returned `completed`. [run: curl] [src: actor-runtime.ts:103] So it can run when nothing is due. Always re-check deadlines against `Date.now()` inside it.

### Persistence of the schedule

- Production control plane: alarms live in Postgres (`PostgresAlarmStore`). [src: `src/control_plane/process.rs:299`]
- **Local dev: `MemoryAlarmStore`** (the default in `ControlPlaneService::new`, never replaced in `local.rs`). [src: `src/control_plane/service.rs:96`; `local.rs:392`] The actor's SQLite does not hold the alarm; the host reads it from the control plane. [src: session.rs:131-136]
- Verified [run]: armed an alarm 25 s out, restarted `dev` 13 s before it was due:

```
armed alarm at <epoch-ms> alarmAt <epoch-ms> alarmLogLen 1
... restart ...
state after restart: {"epoch":2,"leases":2,"profiles":{...},"alarmAt":null,"alarmLogLen":1}
... waited past the deadline ...
after restart: alarmAt null alarmLogLen 1 last fired@<epoch-ms>:restored=p-claude-sam
```
  Fields survived, the alarm did not, and it never fired.
- Fix: keep `cooldownUntil` in persisted state (source of truth) and add an `@Atomic async reconcile()` that re-runs the cooldown sweep and re-arms the alarm. Call it from the backend on boot and on a slow interval (for example every 30 s), and call the same private sweep at the top of `reserveWorkers`. That also covers "Terse restart" in spec section 11.

### `onResume`

Not an `Actor` hook. It exists only on `ActorResource` (`@Resource` fields). [pkg: `dist/actor/actor.d.ts` lists only `onConnect/onMessage/onDisconnect/onAlarm`; `dist/actor/resource.d.ts`]

### Background work

- Un-awaited work can keep writing after a call returns, but **does not keep the actor alive**: the repo's own background example has a scenario commented "Each step outlasts the idle timeout. Fails until background work keeps the actor alive." [src: `examples/background/cli/src/index.ts:29-30`]
- An unhandled rejection crashes the actor worker and fails every running invocation. [src: `examples/background/background-gym/src/actors.ts`, comment in `steps()`]
- For us: no background loops in TeamWorkforce. Time-based work goes through the alarm; external work (Relay spawn, Freestyle calls) happens in the backend.

### Serialization cost

Calls queue behind each other, including across `await`. [docs] [run: the 10 concurrent `reserveWorkers` each held the actor through a 50 ms `await`]. Never call the network from a TeamWorkforce method; one slow call blocks the whole team's coordination.

---

## 4. WebSockets

### Types [pkg: `dist/actor/actor.d.ts`, `dist/actor/socket.d.ts`]

```ts
class TeamWorkforce extends Actor<Metadata, Incoming, Outgoing, Tag> { ... }
async onConnect(socket)                         // accept by returning; deny with socket.reject(4003, reason)
async onMessage(socket, message: Incoming)      // parsed JSON
async onDisconnect(socket, code, reason, wasClean)  // "may be skipped on server failure"
this.broadcast(msg, { except?, tags?, tagMatch? })   // includes sender by default; not saved
this.getConnections(tag?) / this.getConnectionCount()
this.setWebSocketAutoResponse({ request: "ping", response: "pong" })  // gateway answers raw text without waking the actor
socket.send(msg) / socket.close(code?, reason?) / socket.setTags(...tags)  // max 10 tags
socket.metadata   // backend-supplied, max 16 KiB JSON, reassign to update
```

`socket.reject()` needs an explicit code in 3000–4999 ("the default 1008 is currently rejected"). [pkg: socket.d.ts]

### Grant flow [src] [run]

1. Backend (after checking the user is a member of this team/project):
   ```ts
   const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId, metadata: { userId } })
   // -> { websocketUrl, homeRegion, connectByMs }
   ```
   This POSTs `/v1/projects/{project}/actors/{name}/{id}/find-websocket`, which requires the API key when one is configured (`authorized_admin`). [src: `public_api.rs:186-192`; generated `runtime/proxy.d.ts`]
2. Browser: `new WebSocket(grant.websocketUrl)`. Plain WebSocket, JSON text frames, no subprotocol. Send `JSON.stringify(msg)`; parse `event.data` with `JSON.parse`. [run]

URL shape: `ws://127.0.0.1:7100/v1/socket?key=<JWT>` (`wss` for an https origin). [src: `admin.rs:256-279`] [run]

The key is an EdDSA JWT [src: `issuer.rs:146-171`, `socket_ticket.rs:29-65`] with these claims (decoded from a real grant) [run]:

```
{"scope":"actor:socket","actor":{"project_id":"local","actor_name":"TeamWorkforce","actor_id":"team-demo"},"metadata":{"userId":"sam"},"aud":"durable-actors-authority:websocket"}
grant.connectByMs - now (ms): 59999
```

### Is a grant safely scoped to one actor?

- **Yes for actor and metadata.** Both are inside the signed JWT. I re-pointed `actor_id` to `someone-elses-team` and kept the signature: refused (client `error`, gateway log `status=401 ... /v1/socket`). [run] The browser cannot change `metadata`, so `socket.metadata.userId` is trustworthy as long as the backend set it correctly.
- **Not single-use.** No `jti`/replay check; validity is `connect_by_ms` at most 60 s after issue. [src: `socket_ticket.rs:47-65`, `issuer.rs:148`] The same URL opened a second socket. [run: `same grant URL used a second time within connectByMs -> opened`]. Treat the URL as a password for 60 s: return it with `Cache-Control: no-store`, do not log it (it is in the query string, so watch proxy access logs).
- **Authorization is checked only at connect.** "An accepted socket remains authorized until it closes, including while the actor sleeps." To revoke (user removed from team), find their sockets with `getConnections()` and `close()` them. [docs: typescript-guide "Emitting state"]

### Reconnect

- No built-in reconnect and no replay: "Reconnect in your application; messages are not replayed." [pkg: socket.d.ts `ActorConnection` doc] Each reconnect needs a **fresh grant** from the backend (60 s window). [docs]
- With `@Emittable`, a reconnect gets a fresh `state` snapshot, so the dashboard self-heals. Custom `broadcast` events sent while disconnected are lost; do not rely on them for state.
- The chat example simply says "Reload to retry". [src: `examples/chat/src/Chat.tsx`] Write a backoff loop: on `close`, wait 0.5 s / 1 s / 2 s..., fetch a new grant, reconnect.

### Browser cannot reach `127.0.0.1:7100` on another machine

The dev server binds localhost and puts its own origin in the grant URL. [src: local.rs:117-120] Two options:
- Run the browser on the same machine (demo laptop). Works as is.
- Relay through the backend (recommended). I tested a ~40-line Bun relay: backend issues the grant, rewrites the URL to `ws://<backend>/actor-socket?key=...`, and pipes frames to `ws://127.0.0.1:7100/v1/socket?key=...`. Result: `via proxy, frame types: state,pong | state keys: leases,profiles`. [run: `ws-proxy.ts`, full code in section 7]. Note the first frame took over 400 ms on a cold actor; my first attempt with a 400 ms wait saw no frames, 3 s worked.

---

## 5. Calling actors from our backend

```ts
import { actors, ActorInvocationError } from "./generated/index.js"
const wf = actors.TeamWorkforce.get(teamProjectId)   // no network call yet
const result = await wf.reserveWorkers(taskId, ["p-claude-sam"], idempotencyKey)
```

- Transport: `POST {controlPlaneUrl}/v1/projects/{projectId}/actors/{Name}/{id}/invoke` with `{requestId, method, args, homeRegion}`; `requestId` is a fresh `crypto.randomUUID()` per call. [src: `sdk/src/client-runtime/client.ts:35-97`]
- Explicit settings (instead of env): `createActorTransport({ controlPlaneUrl, projectId?, apiKey? })` then `actors.TeamWorkforce.get(id, transport)`. Keep `apiKey` on the server. [pkg: generated `index.d.ts`; src: stub.ts:60-62]
- The generated stub has methods only (no backend `connect`/`broadcast`). Lifecycle hooks are not exposed in the client but **are callable over raw HTTP** (see section 3).

### Errors [src: `sdk/src/client-runtime/errors.ts:15-28`, `client.ts:58-143`] [run]

`ActorInvocationError { code, requestId, message }`: "Retrying an `outcome_unknown` operation may run it twice; `unavailable` never ran."

| code | meaning | seen in run | what the backend does |
|---|---|---|---|
| `actor_error` | method threw, or method not found | yes: `code=actor_error message="boom after writes"`; unknown method -> `actor method TeamWorkforce.nope was not found` | do not retry; surface reason |
| `unavailable` | host not ready / connection refused; never executed | yes: HTTP 503 during hot reload | safe to retry with backoff |
| `outcome_unknown` | may have executed (crash, network drop after send) | documented in `examples/persistence/cli/README.md` | retry **only** with the same app idempotency key |
| `unauthenticated` | 401/403, bad API key | no | config bug |

The client itself retries once internally for `not_executed` replies. [src: client.ts:67-73]

### Idempotency

There is **no idempotency option** in the generated client. `requestId` "identifies this caller attempt; it is not an application idempotency key". [src: errors.ts:19-20] Idempotency has to live in actor state: store `key -> result` and return the stored result on repeat. Verified [run]:

```
PASS  idempotent retry with same key returns the original lease  {"leases":[{"epoch":1,...}],"ok":true}
PASS  markProfileLimited applied once, duplicate event ignored  {"lim":{"ok":true},"dup":{"duplicate":true,"ok":true}}
```

Prune that ledger (for example keep the last 500 keys) or it grows forever and every write re-serializes it.

### Next.js

The generated client is plain `fetch` plus `process.env`, so it should work in Next.js Node-runtime route handlers. **UNVERIFIED** (only tested from Bun). Never import it in client components; the browser build throws by design.

---

## 6. Hosting

| Option | Status | Fit for a 5-hour build |
|---|---|---|
| Hosted Terse cloud | Documented now as Terse Cloud at docs.useterse.ai (account, `terse deploy`, API key, default limits of 500 active actors and 50 starts per second per project). When this section was first written there was no signup or doc for it. | Morrow's production choice. |
| Self-host on GCP | GKE Standard + gVisor sandbox node pool + Postgres + GCS bucket + HTTPS ingress + Helm chart. [docs: self-hosting.md] | No. Spec section 13 already skips "production GKE Terse deploy". |
| `durable-actors dev` on the backend's machine | Works. Verified end to end. | **Yes.** |

What I recommend:

1. Run `durable-actors dev --no-watch` (set `DURABLE_ACTORS_SECRET`) on the **same host as the Bun backend**: the demo laptop, or one Linux VM with a persistent disk. Prebuilt binaries exist for linux arm64/x64. [src: runtimeInstaller.ts:42] Running it on a Linux VM is **UNVERIFIED** (only macOS arm64 tested).
2. Only the backend talks to port 7100. Freestyle VMs never call Terse. Worker monitors send signed events to `POST /api/events/worker`, and the backend applies the transition. That matches spec section 12.
3. Browsers get live state through the backend's WebSocket relay (section 4) or through the backend's own SSE stream fed by a backend-held socket.
4. Local state is one directory with no replication in local mode (Litestream/GCS is for the hosted path). Copy `.durable-actors/` before the demo if you care about the data.
5. Do not run it on an agent VM. If that VM pauses, coordination stops.

Can the Bun backend talk to a local `dev`? Yes. That is exactly what the smoke test does (`smoke.ts` is a separate Bun process using the generated client against `http://127.0.0.1:7100`).

---

## 7. Smoke test (real run)

Location: `/private/tmp/claude-501/-Users-samsiavoshian/60bb8e57-8f5c-453b-b0d6-1299ff591d77/scratchpad/terse-smoke/`

### Commands

```sh
bun x durable-actors@0.14.3 init terse-smoke
cd terse-smoke && bun install            # 144 packages installed
bun run --bun check                       # tsc --noEmit, clean
nohup bun x durable-actors dev > logs/dev1.log 2>&1 &
bun x durable-actors generate             # Generated 1 actor contract(s) in …/terse-smoke/generated.
bun smoke.ts phase1
bun smoke.ts arm                          # arm a 25 s alarm
kill <dev pid>                            # restart the dev server
nohup bun x durable-actors dev > logs/dev2.log 2>&1 &
EXPECT_EPOCH=2 EXPECT_LEASES=2 bun smoke.ts phase2
bun smoke.ts after-arm                    # after the armed deadline passed
bun interleave-probe.ts
bun mutation-probe.ts
bun ws-proxy.ts
```

### Results

| Check | Result |
|---|---|
| (a) two concurrent `reserveWorkers` for one profile, exactly one wins | **PASS** (also 10-way race: 1 winner, 9 losers) |
| (b) state survives a dev server restart | **PASS** (epoch 2, both leases, profile statuses intact) |
| (c) throw inside `@Atomic` rolls back | **PASS** (epoch, leases, profile status unchanged) |
| alarm schedules, wakes an evicted actor, restores cooldown, broadcasts to an open socket | **PASS** |
| pending alarm survives dev server restart | **FAIL by design of local dev** (lost) |
| alarm set inside throwing `@Atomic` is rolled back | **No** (alarm stays armed) |
| plain method write before throw is rolled back | **No** (write kept) |
| `@Atomic` rollback in a class with any `@Interleave` | **No** (write committed) |
| fencing: stale epoch rejected | **PASS** |
| idempotent retry and duplicate event | **PASS** |
| WS: `state` snapshot, `state_update`, custom broadcast, `reject(4003)`, forged grant refused | **PASS** |
| WS grant single-use | **No** (reusable for 60 s) |

### `phase1` output

```
grant.websocketUrl host+path: ws://127.0.0.1:7100/v1/socket
grant.connectByMs - now (ms): 59999
grant JWT claims: {"scope":"actor:socket","actor":{"project_id":"local","actor_name":"TeamWorkforce","actor_id":"team-demo"},"metadata":{"userId":"sam"},"aud":"durable-actors-authority:websocket"}
PASS  ws: first frame is a `state` snapshot of @Emittable fields  ["leases","profiles"]
PASS  ws: onMessage ping -> pong
INFO  same grant URL used a second time within connectByMs -> opened
PASS  ws: grant with re-pointed actor id is refused  "error"
PASS  ws: onConnect socket.reject(4003) closes the browser socket  "closed 4003 missing user"
r1: {"leases":[{"epoch":1,"leaseId":"lease-1","profileId":"p-claude-sam","status":"active","taskId":"task-A"}],"ok":true}
r2: {"ok":false,"reason":"profile p-claude-sam is busy"}
PASS  (a) exactly one concurrent reserve wins
PASS  (a) 10-way race: exactly one winner  ["WIN","lose","lose","lose","lose","lose","lose","lose","lose","lose"]
PASS  idempotent retry with same key returns the original lease  {"leases":[{"epoch":1,"leaseId":"lease-1","profileId":"p-claude-sam","status":"active","taskId":"task-A"}],"ok":true}
PASS  fencing: stale epoch rejected  {"ok":false,"reason":"stale epoch 0, lease is 1"}
PASS  ws: state_update frames arrived after reserve  2
PASS  ws: custom broadcast event arrived
sample state_update: {"changes":{"leases":{"lease-1":{"epoch":1,"leaseId":"lease-1","profileId":"p-claude-sam","status":"active","taskId":"task-A"}},"profiles":{"p-claude-lee":{"cooldownUntil":null,"harness":"claude","ownerUserId":"lee","profileId":"p-claude-lee","status":"ready","vmId":"vm-lee"},"p-claude-sam":{"cooldo
thrown: ActorInvocationError code=actor_error message="boom after writes" requestId=166df30b-6980-406e-90dd-0617a5fd0c52
PASS  (c) error is ActorInvocationError
PASS  (c) @Atomic throw: epoch unchanged  {"before":2,"after":2}
PASS  (c) @Atomic throw: no lease added
PASS  (c) @Atomic throw: profile still ready  "ready"
INFO  plain method write-then-throw: scratch 0 -> 1 (write KEPT)
INFO  alarm.set inside throwing @Atomic -> alarmAt=<epoch-ms> (NOT rolled back)
PASS  markProfileLimited applied once, duplicate event ignored  {"lim":{"ok":true},"dup":{"duplicate":true,"ok":true}}
PASS  limited profile's lease revoked
PASS  alarm armed at cooldownUntil  {"alarmAt":<epoch-ms>,"until":<epoch-ms>}
PASS  reserve on limited profile rejected  {"ok":false,"reason":"profile p-claude-sam is limited"}
waiting 20s for onAlarm (actor idle-evicts after 10s)...
alarmLog: ["fired@<epoch-ms>:restored=p-claude-sam"]
PASS  onAlarm restored the profile to ready  {"cooldownUntil":null,"harness":"claude","ownerUserId":"sam","profileId":"p-claude-sam","status":"ready","vmId":"vm-sam"}
PASS  browser saw worker.capacity_restored broadcast
final epoch: 2 leases: 2
ALL CHECKS PASSED
```

(The very first `phase1` attempt failed on its first call with `ActorInvocationError: actor host is unavailable: actor host is not ready`, `code: "unavailable"`, because the watcher was reloading after I created `smoke.ts` in the project. The rerun above is clean.)

### Restart outputs

```
$ bun smoke.ts arm
armed alarm at <epoch-ms> alarmAt <epoch-ms> alarmLogLen 1
--- stopping dev server (SIGTERM to bun CLI pid 47965)
no durable-actors dev processes running

$ (restart) EXPECT_EPOCH=2 EXPECT_LEASES=2 bun smoke.ts phase2
  Ready    http://127.0.0.1:7100
state after restart: {"epoch":2,"leases":2,"profiles":{"p-claude-lee":"ready","p-claude-sam":"ready","p-codex-omar":"busy"},"alarmAt":null,"alarmLogLen":1}
PASS  (b) epoch survived restart  {"epoch":2,"expected":"2"}
PASS  (b) leases survived restart
ALL CHECKS PASSED

$ bun smoke.ts after-arm        # run after the armed deadline
after restart: alarmAt null alarmLogLen 1 last fired@<epoch-ms>:restored=p-claude-sam
```

### Raw HTTP probes (curl against the dev server, auth off)

```
--- TS-private async method over raw HTTP:
{"outcome":{"metadata":{"durationMs":3.826584,"hostState":"cold","queueWaitMs":0.0115,"routingMs":1010.0895},"result":"tsPrivateProbe reachable","type":"completed"}}
--- JS #private helper over raw HTTP:
{"error":{"code":"invalid_request","message":"actor method may contain only ASCII letters, digits, '.', '-', and '_'"}}
--- unknown method:
{"outcome":{"code":"actor_error","message":"actor method TeamWorkforce.nope was not found",...,"type":"failed"}}
--- wrong arg types:
{"outcome":{...,"result":{"ok":false,"reason":"unknown lease"},"type":"completed"}}
--- onAlarm invoked directly:
{"outcome":{...,"result":null,"type":"completed"}}
```

So: TS `private async` methods are RPC-callable, `#private` are not, args are not type-checked, and `onAlarm` can be triggered by anyone holding the API key (or anyone at all with auth off).

### Probe outputs

```
$ bun interleave-probe.ts
atomicWriteThenThrow threw: actor_error boom in interleaved class
after @Atomic throw in a class that has an @Interleave method: {"holder":"","value":1}
racyClaim results (both true = double claim): true true final: {"holder":"B","value":1}

$ bun x durable-actors inspect InterleaveProbe/<id>
State:
{
  "holder": "B",
  "value": 1
}

$ bun mutation-probe.ts
same activation, after reassign(a) + pushInPlace(b): {"calls":2,"items":["a","b"]}
after a throwing call (calls was 2, throw bumped it to 3 before throwing): {"calls":0,"items":["a"]}
idle 13s so the actor is evicted (default idle timeout 10000 ms)...
after eviction + reactivation: {"calls":0,"items":["a"]}

$ bun ws-proxy.ts
via proxy, frame types: state,pong | state keys: leases,profiles
```

All processes were stopped afterwards (`pgrep -fl durable-actors` empty, port 7100 free).

### `src/actors.ts` (full smoke actor, as run)

The `InterleaveProbe` and `MutationProbe` classes and the methods under "smoke-test probes" are test-only. Do not copy them into the real actor.

```ts
import { Actor, Atomic, Emittable, Ephemeral, Interleave, Persisted, type ActorSocket } from "durable-actors"

// ---------- public types (become part of the generated client contract) ----------

export type ProfileStatus = "ready" | "busy" | "limited"

export type Profile = {
    profileId: string
    ownerUserId: string
    vmId: string
    harness: "claude" | "codex"
    status: ProfileStatus
    cooldownUntil: number | null
}

export type LeaseStatus = "active" | "released" | "revoked"

export type Lease = {
    leaseId: string
    taskId: string
    profileId: string
    epoch: number
    status: LeaseStatus
}

export type ReserveResult = { ok: true; leases: Lease[] } | { ok: false; reason: string }

type Metadata = { userId: string }
type Incoming = { type: "ping" }
type Outgoing =
    | { type: "pong"; at: number }
    | { type: "event"; name: string; profileId?: string; taskId?: string; epoch?: number }

type Socket = ActorSocket<Metadata, Outgoing>

// Small helper so the "atomic across await" claim is actually exercised.
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class TeamWorkforce extends Actor<Metadata, Incoming, Outgoing> {
    // @Emittable requires a public @Persisted field. Browsers get `state` on connect and `state_update` after each successful call.
    @Persisted @Emittable profiles: Record<string, Profile> = {}
    @Persisted @Emittable leases: Record<string, Lease> = {}

    // Monotonic fencing generation. Never decremented, never reused.
    @Persisted private epoch = 0
    // Idempotency ledger: request key / event id -> stored result.
    @Persisted private processed: Record<string, ReserveResult | true> = {}
    // Proof that onAlarm ran (smoke test only).
    @Persisted private alarmLog: string[] = []
    // Proof for the non-atomic rollback comparison (smoke test only).
    @Persisted private scratch = 0

    // ---------------- profile registry ----------------

    async registerProfile(input: Omit<Profile, "status" | "cooldownUntil">): Promise<Profile> {
        const existing = this.profiles[input.profileId]
        const profile: Profile = existing
            ? { ...existing, ...input }
            : { ...input, status: "ready", cooldownUntil: null }
        // Reassign, never mutate nested: `this.profiles[id] = x` would NOT be saved.
        this.profiles = { ...this.profiles, [profile.profileId]: profile }
        this.broadcast({ type: "event", name: "profile.registered", profileId: profile.profileId })
        return profile
    }

    // ---------------- atomic claim with fencing ----------------

    @Atomic
    async reserveWorkers(taskId: string, profileIds: string[], key: string): Promise<ReserveResult> {
        const prior = this.processed[key]
        if (prior !== undefined && prior !== true) return prior // idempotent retry returns the original result

        for (const id of profileIds) {
            const profile = this.profiles[id]
            if (!profile) return this.#remember(key, { ok: false, reason: `unknown profile ${id}` })
            if (profile.status !== "ready") return this.#remember(key, { ok: false, reason: `profile ${id} is ${profile.status}` })
            const held = Object.values(this.leases).find(l => l.profileId === id && l.status === "active")
            if (held) return this.#remember(key, { ok: false, reason: `profile ${id} already leased by ${held.leaseId}` })
        }

        // Deliberate await between validation and write. Without @Interleave the actor
        // holds its lock across this await, so a concurrent call cannot slip in.
        await pause(50)

        let nextEpoch = this.epoch
        const newLeases: Lease[] = profileIds.map(profileId => {
            nextEpoch += 1
            return { leaseId: `lease-${nextEpoch}`, taskId, profileId, epoch: nextEpoch, status: "active" }
        })
        this.epoch = nextEpoch
        this.leases = { ...this.leases, ...Object.fromEntries(newLeases.map(l => [l.leaseId, l])) }
        this.profiles = {
            ...this.profiles,
            ...Object.fromEntries(profileIds.map(id => [id, { ...this.profiles[id]!, status: "busy" as const }]))
        }
        for (const lease of newLeases)
            this.broadcast({ type: "event", name: "worker.reserved", profileId: lease.profileId, taskId, epoch: lease.epoch })
        return this.#remember(key, { ok: true, leases: newLeases })
    }

    // Fenced completion: a stale epoch (old worker reappearing) is rejected.
    @Atomic
    async releaseLease(leaseId: string, epoch: number): Promise<{ ok: boolean; reason?: string }> {
        const lease = this.leases[leaseId]
        if (!lease) return { ok: false, reason: "unknown lease" }
        if (lease.epoch !== epoch) return { ok: false, reason: `stale epoch ${epoch}, lease is ${lease.epoch}` }
        if (lease.status !== "active") return { ok: false, reason: `lease is ${lease.status}` }
        this.leases = { ...this.leases, [leaseId]: { ...lease, status: "released" } }
        const profile = this.profiles[lease.profileId]
        if (profile && profile.status === "busy")
            this.profiles = { ...this.profiles, [profile.profileId]: { ...profile, status: "ready" } }
        return { ok: true }
    }

    // ---------------- cooldown + alarm ----------------

    @Atomic
    async markProfileLimited(profileId: string, untilMs: number, eventId: string): Promise<{ ok: boolean; duplicate?: boolean }> {
        if (this.processed[eventId] === true) return { ok: true, duplicate: true }
        const profile = this.profiles[profileId]
        if (!profile) throw new Error(`unknown profile ${profileId}`)

        // Revoke every active lease held by this profile (future claims are blocked by status).
        const revoked = Object.values(this.leases)
            .filter(l => l.profileId === profileId && l.status === "active")
            .map(l => ({ ...l, status: "revoked" as const }))
        this.leases = { ...this.leases, ...Object.fromEntries(revoked.map(l => [l.leaseId, l])) }
        this.profiles = { ...this.profiles, [profileId]: { ...profile, status: "limited", cooldownUntil: untilMs } }
        this.processed = { ...this.processed, [eventId]: true }

        this.#scheduleNextCooldownAlarm()
        this.broadcast({ type: "event", name: "worker.quota_limited", profileId })
        return { ok: true }
    }

    // One alarm slot per actor: always arm it for the EARLIEST pending deadline.
    #scheduleNextCooldownAlarm(): void {
        const deadlines = Object.values(this.profiles)
            .map(p => p.cooldownUntil)
            .filter((t): t is number => t !== null)
        if (deadlines.length === 0) this.alarm.delete()
        else this.alarm.set(Math.min(...deadlines))
    }

    async onAlarm(): Promise<void> {
        const now = Date.now()
        const restored: string[] = []
        const next = { ...this.profiles }
        for (const p of Object.values(this.profiles)) {
            if (p.status === "limited" && p.cooldownUntil !== null && p.cooldownUntil <= now) {
                next[p.profileId] = { ...p, status: "ready", cooldownUntil: null }
                restored.push(p.profileId)
            }
        }
        this.profiles = next
        this.alarmLog = [...this.alarmLog, `fired@${now}:restored=${restored.join(",") || "none"}`]
        this.#scheduleNextCooldownAlarm() // re-arm for any later cooldowns
        for (const profileId of restored) this.broadcast({ type: "event", name: "worker.capacity_restored", profileId })
    }

    // ---------------- websockets ----------------

    async onConnect(socket: Socket): Promise<void> {
        if (!socket.metadata?.userId) {
            socket.reject(4003, "missing user")
            return
        }
        socket.setTags("dashboard")
    }

    async onMessage(socket: Socket, message: Incoming): Promise<void> {
        if (message.type === "ping") socket.send({ type: "pong", at: Date.now() })
    }

    // ---------------- reads ----------------

    async getState(): Promise<{
        profiles: Record<string, Profile>
        leases: Record<string, Lease>
        epoch: number
        alarmLog: string[]
        alarmAt: number | null
        scratch: number
    }> {
        return {
            profiles: this.profiles,
            leases: this.leases,
            epoch: this.epoch,
            alarmLog: this.alarmLog,
            alarmAt: this.alarm.get(),
            scratch: this.scratch
        }
    }

    // ---------------- smoke-test probes (delete in the real actor) ----------------

    // Full reserve, then throw. With @Atomic every write must vanish.
    @Atomic
    async reserveThenThrow(taskId: string, profileId: string): Promise<void> {
        this.epoch = this.epoch + 1
        this.leases = {
            ...this.leases,
            [`lease-${this.epoch}`]: { leaseId: `lease-${this.epoch}`, taskId, profileId, epoch: this.epoch, status: "active" }
        }
        this.profiles = { ...this.profiles, [profileId]: { ...this.profiles[profileId]!, status: "busy" } }
        throw new Error("boom after writes")
    }

    // Same shape without @Atomic: checks whether a plain method keeps writes made before a throw.
    async plainWriteThenThrow(): Promise<void> {
        this.scratch = this.scratch + 1
        throw new Error("boom after plain write")
    }

    // Does alarm.set() roll back with an @Atomic throw? (Source says alarms bypass the SQLite transaction.)
    @Atomic
    async atomicSetAlarmThenThrow(delayMs: number): Promise<void> {
        this.alarm.set(Date.now() + delayMs)
        throw new Error("boom after alarm.set")
    }

    async armAlarm(delayMs: number): Promise<number> {
        const at = Date.now() + delayMs
        this.alarm.set(at)
        return at
    }

    // TS `private` is erased at runtime. Is this still invocable over raw HTTP? (smoke probe)
    private async tsPrivateProbe(): Promise<string> {
        return "tsPrivateProbe reachable"
    }

    #remember(key: string, result: ReserveResult): ReserveResult {
        this.processed = { ...this.processed, [key]: result }
        return result
    }
}

// Probe: what @Interleave does to atomicity and rollback (smoke test only, never ship this pattern).
export class InterleaveProbe extends Actor {
    @Persisted private value = 0
    @Persisted private holder = ""

    @Atomic
    async atomicWriteThenThrow(): Promise<void> {
        this.value = this.value + 1
        throw new Error("boom in interleaved class")
    }

    // Check-then-act across an await, but interleaved: two callers can both pass the check.
    @Interleave
    async racyClaim(key: string): Promise<boolean> {
        const free = this.holder === ""
        await pause(50)
        if (free) this.holder = key
        return free
    }

    async read(): Promise<{ value: number; holder: string }> {
        return { value: this.value, holder: this.holder }
    }
}

// Probe: in-place mutation vs reassignment of a @Persisted array, and @Ephemeral lifetime (smoke test only).
export class MutationProbe extends Actor {
    @Persisted items: string[] = []
    @Ephemeral private calls = 0

    async reassign(v: string): Promise<number> {
        this.items = [...this.items, v]
        this.calls++
        return this.calls
    }
    async pushInPlace(v: string): Promise<number> {
        this.items.push(v)
        this.calls++
        return this.calls
    }
    async plainThrow(): Promise<void> {
        this.calls++
        throw new Error("plain throw")
    }
    async read(): Promise<{ items: string[]; calls: number }> {
        return { items: this.items, calls: this.calls }
    }
}
```

### `smoke.ts` (client script, as run)

```ts
// Smoke test for TeamWorkforce. Usage:
//   bun smoke.ts phase1   (fresh state: concurrency, rollback, fencing, idempotency, alarms, websockets)
//   bun smoke.ts phase2   (after a dev-server restart: state survival + pending-alarm survival)
import { actors, ActorInvocationError } from "./generated/index.js"

const ACTOR_ID = process.env.ACTOR_ID ?? "team-demo"
const wf = actors.TeamWorkforce.get(ACTOR_ID)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
    if (!ok) failures++
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`)
}

async function phase1() {
    // --- setup
    for (const [profileId, harness, vmId] of [
        ["p-claude-sam", "claude", "vm-sam"],
        ["p-codex-omar", "codex", "vm-omar"],
        ["p-claude-lee", "claude", "vm-lee"]
    ] as const)
        await wf.registerProfile({ profileId, ownerUserId: profileId.split("-")[2]!, vmId, harness })

    // --- websocket: backend issues grant, "browser" connects with the plain WebSocket API
    const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: ACTOR_ID, metadata: { userId: "sam" } })
    const claims = JSON.parse(Buffer.from(new URL(grant.websocketUrl).searchParams.get("key")!.split(".")[1]!, "base64url").toString())
    console.log("grant.websocketUrl host+path:", new URL(grant.websocketUrl).origin + new URL(grant.websocketUrl).pathname)
    console.log("grant.connectByMs - now (ms):", grant.connectByMs - Date.now())
    console.log("grant JWT claims:", JSON.stringify({ scope: claims.scope, actor: claims.actor, metadata: claims.metadata, aud: claims.aud }))
    const frames: any[] = []
    const ws = new WebSocket(grant.websocketUrl)
    ws.onmessage = e => frames.push(JSON.parse(String(e.data)))
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")) })
    ws.send(JSON.stringify({ type: "ping" }))
    await sleep(300)
    check("ws: first frame is a `state` snapshot of @Emittable fields", frames[0]?.type === "state" && "profiles" in frames[0].state, Object.keys(frames[0]?.state ?? {}))
    check("ws: onMessage ping -> pong", frames.some(f => f.type === "pong"))

    // Grant reuse: is the URL single-use?
    const ws2 = new WebSocket(grant.websocketUrl)
    const reuse = await new Promise<string>(res => { ws2.onopen = () => res("opened"); ws2.onclose = e => res(`closed ${e.code} ${e.reason}`) })
    console.log("INFO  same grant URL used a second time within connectByMs ->", reuse)
    ws2.close()

    // Tampered grant: flip the actorId in the JWT payload, keep the signature
    const [h, , s] = new URL(grant.websocketUrl).searchParams.get("key")!.split(".")
    const forged = Buffer.from(JSON.stringify({ ...claims, actor: { ...claims.actor, actor_id: "someone-elses-team" } })).toString("base64url")
    const forgedUrl = new URL(grant.websocketUrl); forgedUrl.searchParams.set("key", `${h}.${forged}.${s}`)
    const ws3 = new WebSocket(forgedUrl.toString())
    const forgedResult = await new Promise<string>(res => { ws3.onopen = () => res("opened"); ws3.onerror = () => res("error"); ws3.onclose = e => res(`closed ${e.code}`) })
    check("ws: grant with re-pointed actor id is refused", forgedResult !== "opened", forgedResult)

    // Missing metadata -> onConnect rejects with 4003
    const bad = await actors.TeamWorkforce.prepareWebsocket({ actorId: ACTOR_ID, metadata: { userId: "" } })
    const ws4 = new WebSocket(bad.websocketUrl)
    const rejected = await new Promise<string>(res => { ws4.onopen = () => {}; ws4.onclose = e => res(`closed ${e.code} ${e.reason}`) })
    check("ws: onConnect socket.reject(4003) closes the browser socket", rejected.startsWith("closed 4003"), rejected)

    // --- (a) two concurrent reserveWorkers for the same profile -> exactly one wins
    frames.length = 0
    const [r1, r2] = await Promise.all([
        wf.reserveWorkers("task-A", ["p-claude-sam"], "req-A"),
        wf.reserveWorkers("task-B", ["p-claude-sam"], "req-B")
    ])
    console.log("r1:", JSON.stringify(r1))
    console.log("r2:", JSON.stringify(r2))
    check("(a) exactly one concurrent reserve wins", [r1, r2].filter(r => r.ok).length === 1)

    // 10-way race on a different profile
    const race = await Promise.all(Array.from({ length: 10 }, (_, i) => wf.reserveWorkers(`task-R${i}`, ["p-codex-omar"], `race-${i}`)))
    check("(a) 10-way race: exactly one winner", race.filter(r => r.ok).length === 1, race.map(r => (r.ok ? "WIN" : "lose")))

    // Idempotent retry of the winning key returns the same lease, no new epoch
    const winnerKey = r1.ok ? "req-A" : "req-B"
    const winner = (r1.ok ? r1 : r2) as Extract<typeof r1, { ok: true }>
    const retry = await wf.reserveWorkers("task-A", ["p-claude-sam"], winnerKey)
    check("idempotent retry with same key returns the original lease", retry.ok && retry.leases[0]!.epoch === winner.leases[0]!.epoch, retry)

    // Fencing: stale epoch rejected, current epoch accepted
    const lease = winner.leases[0]!
    const stale = await wf.releaseLease(lease.leaseId, lease.epoch - 1)
    check("fencing: stale epoch rejected", !stale.ok, stale)
    await sleep(200)
    check("ws: state_update frames arrived after reserve", frames.some(f => f.type === "state_update"), frames.filter(f => f.type === "state_update").length)
    check("ws: custom broadcast event arrived", frames.some(f => f.type === "event" && f.name === "worker.reserved"))
    console.log("sample state_update:", JSON.stringify(frames.find(f => f.type === "state_update"))?.slice(0, 300))

    // --- (c) throw inside @Atomic rolls back every write
    const before = await wf.getState()
    try { await wf.reserveThenThrow("task-X", "p-claude-lee"); check("(c) reserveThenThrow threw", false) }
    catch (e) {
        const err = e as ActorInvocationError
        console.log("thrown:", err.name, "code=" + err.code, "message=" + JSON.stringify(err.message), "requestId=" + err.requestId)
        check("(c) error is ActorInvocationError", e instanceof ActorInvocationError)
    }
    const after = await wf.getState()
    check("(c) @Atomic throw: epoch unchanged", after.epoch === before.epoch, { before: before.epoch, after: after.epoch })
    check("(c) @Atomic throw: no lease added", Object.keys(after.leases).length === Object.keys(before.leases).length)
    check("(c) @Atomic throw: profile still ready", after.profiles["p-claude-lee"]!.status === "ready", after.profiles["p-claude-lee"]!.status)

    // Plain (non-@Atomic) method: does a write before a throw survive?
    try { await wf.plainWriteThenThrow() } catch {}
    const plain = await wf.getState()
    console.log(`INFO  plain method write-then-throw: scratch ${after.scratch} -> ${plain.scratch} (${plain.scratch > after.scratch ? "write KEPT" : "rolled back"})`)

    // alarm.set() inside an @Atomic method that throws: rolled back or not?
    try { await wf.atomicSetAlarmThenThrow(60_000) } catch {}
    const alarmProbe = await wf.getState()
    console.log(`INFO  alarm.set inside throwing @Atomic -> alarmAt=${alarmProbe.alarmAt} (${alarmProbe.alarmAt ? "NOT rolled back" : "rolled back"})`)

    // --- markProfileLimited + alarm restores capacity (actor idles >10s, so this also proves the alarm wakes an evicted actor)
    frames.length = 0
    const until = Date.now() + 15_000
    const lim = await wf.markProfileLimited("p-claude-sam", until, "evt-quota-1")
    const dup = await wf.markProfileLimited("p-claude-sam", until, "evt-quota-1")
    check("markProfileLimited applied once, duplicate event ignored", lim.ok && dup.duplicate === true, { lim, dup })
    const limitedState = await wf.getState()
    check("limited profile's lease revoked", limitedState.leases[lease.leaseId]!.status === "revoked")
    check("alarm armed at cooldownUntil", limitedState.alarmAt === until, { alarmAt: limitedState.alarmAt, until })
    const blocked = await wf.reserveWorkers("task-C", ["p-claude-sam"], "req-C")
    check("reserve on limited profile rejected", !blocked.ok, blocked)
    console.log("waiting 20s for onAlarm (actor idle-evicts after 10s)...")
    await sleep(20_000)
    const restored = await wf.getState()
    console.log("alarmLog:", JSON.stringify(restored.alarmLog))
    check("onAlarm restored the profile to ready", restored.profiles["p-claude-sam"]!.status === "ready", restored.profiles["p-claude-sam"])
    check("browser saw worker.capacity_restored broadcast", frames.some(f => f.name === "worker.capacity_restored"))
    ws.close()

    // Error type for calling an unknown method on the raw transport
    console.log("final epoch:", restored.epoch, "leases:", Object.keys(restored.leases).length)
}

async function phase2() {
    const s = await wf.getState()
    console.log("state after restart:", JSON.stringify({ epoch: s.epoch, leases: Object.keys(s.leases).length, profiles: Object.fromEntries(Object.entries(s.profiles).map(([k, v]) => [k, v.status])), alarmAt: s.alarmAt, alarmLogLen: s.alarmLog.length }))
    check("(b) epoch survived restart", s.epoch === Number(process.env.EXPECT_EPOCH), { epoch: s.epoch, expected: process.env.EXPECT_EPOCH })
    check("(b) leases survived restart", Object.keys(s.leases).length === Number(process.env.EXPECT_LEASES))
}

// Arms an alarm, then the operator restarts the dev server before it fires (see doc).
async function armForRestart() {
    const at = await wf.armAlarm(25_000)
    const s = await wf.getState()
    console.log("armed alarm at", at, "alarmAt", s.alarmAt, "alarmLogLen", s.alarmLog.length)
}

async function afterRestartAlarm() {
    const s = await wf.getState()
    console.log("after restart: alarmAt", s.alarmAt, "alarmLogLen", s.alarmLog.length, "last", s.alarmLog.at(-1))
}

const phase = process.argv[2]
if (phase === "phase1") await phase1()
else if (phase === "phase2") await phase2()
else if (phase === "arm") await armForRestart()
else if (phase === "after-arm") await afterRestartAlarm()
console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
```

### `interleave-probe.ts` and `mutation-probe.ts`

```ts
// interleave-probe.ts
import { actors, ActorInvocationError } from "./generated/index.js"
const p = actors.InterleaveProbe.get(`probe-${Date.now()}`)
try { await p.atomicWriteThenThrow() } catch (e) { console.log("atomicWriteThenThrow threw:", (e as ActorInvocationError).code, (e as Error).message) }
console.log("after @Atomic throw in a class that has an @Interleave method:", JSON.stringify(await p.read()))
const [a, b] = await Promise.all([p.racyClaim("A"), p.racyClaim("B")])
console.log("racyClaim results (both true = double claim):", a, b, "final:", JSON.stringify(await p.read()))
```

```ts
// mutation-probe.ts
import { actors } from "./generated/index.js"
const p = actors.MutationProbe.get(`mut-${Date.now()}`)
await p.reassign("a")
await p.pushInPlace("b")
console.log("same activation, after reassign(a) + pushInPlace(b):", JSON.stringify(await p.read()))
try { await p.plainThrow() } catch {}
console.log("after a throwing call (calls was 2, throw bumped it to 3 before throwing):", JSON.stringify(await p.read()))
console.log("idle 13s so the actor is evicted (default idle timeout 10000 ms)...")
await new Promise(r => setTimeout(r, 13_000))
console.log("after eviction + reactivation:", JSON.stringify(await p.read()))
```

### `ws-proxy.ts` (backend WebSocket relay, tested)

```ts
// Minimal backend WS relay: browser -> ws://<our-backend>/actor-socket?key=... -> ws://127.0.0.1:7100/v1/socket?key=...
// Lets the actor runtime stay bound to localhost (durable-actors dev always binds 127.0.0.1).
import { actors } from "./generated/index.js"
const UPSTREAM = "ws://127.0.0.1:7100/v1/socket"
type Data = { key: string; upstream?: WebSocket; queue: (string | Buffer)[] }
const server = Bun.serve<Data>({
    port: 7199,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === "/api/workforce/socket") {
            // A real backend authenticates the user and checks team membership here.
            const grant = await actors.TeamWorkforce.prepareWebsocket({ actorId: "team-demo", metadata: { userId: "sam" } })
            const key = new URL(grant.websocketUrl).searchParams.get("key")!
            return Response.json({ websocketUrl: `ws://127.0.0.1:7199/actor-socket?key=${encodeURIComponent(key)}`, connectByMs: grant.connectByMs }, { headers: { "cache-control": "no-store" } })
        }
        if (url.pathname === "/actor-socket") {
            const key = url.searchParams.get("key")
            if (!key) return new Response("missing key", { status: 400 })
            return srv.upgrade(req, { data: { key, queue: [] } }) ? undefined : new Response("upgrade failed", { status: 400 })
        }
        return new Response("not found", { status: 404 })
    },
    websocket: {
        open(ws) {
            const up = new WebSocket(`${UPSTREAM}?key=${encodeURIComponent(ws.data.key)}`)
            ws.data.upstream = up
            up.onopen = () => { for (const m of ws.data.queue) up.send(m); ws.data.queue = [] }
            up.onmessage = e => ws.send(String(e.data))
            up.onclose = e => ws.close(e.code >= 3000 || e.code === 1000 ? e.code : 1011, e.reason)
            up.onerror = () => ws.close(1011, "upstream error")
        },
        message(ws, msg) {
            const up = ws.data.upstream
            if (up?.readyState === WebSocket.OPEN) up.send(msg); else ws.data.queue.push(msg as string)
        },
        close(ws) { ws.data.upstream?.close() }
    }
})
// Self-test: act as the browser.
const { websocketUrl } = await (await fetch("http://127.0.0.1:7199/api/workforce/socket")).json() as { websocketUrl: string }
const frames: any[] = []
const browser = new WebSocket(websocketUrl)
browser.onmessage = e => frames.push(JSON.parse(String(e.data)))
await new Promise(r => (browser.onopen = r))
browser.send(JSON.stringify({ type: "ping" }))
await new Promise(r => setTimeout(r, 3000))
console.log("via proxy, frame types:", frames.map(f => f.type).join(","), "| state keys:", Object.keys(frames.find(f => f.type === "state")?.state ?? {}).join(","))
browser.close(); server.stop(true); process.exit(0)
```

For production use, cap the pre-open `queue` length and authenticate the upgrade request.

---

## 8. Rules for the real TeamWorkforce actor

1. Every state transition is `@Atomic`. No `@Interleave` anywhere in the class.
2. Reassign persisted objects. Never `this.x[k] = v`, `push`, `splice`, `delete`.
3. Helpers are `#private` (sync is fine) or module functions. Never TS `private async` (RPC-callable).
4. Validate all arguments at the top of each method (shape, lengths, ID charset). The runtime does not.
5. No network I/O inside methods. The actor is a pure state machine; the backend does Relay/Freestyle/Git calls around it (outbox pattern from spec section 5).
6. Idempotency keys and event IDs are stored in actor state with the result; prune to a bounded size.
7. `epoch` is a single monotonic counter; each lease carries its epoch; every completion/handoff/ack checks it.
8. One alarm slot: store deadlines in state, arm for the earliest, call `alarm.set/delete` last in the method, and make `onAlarm` a no-op when nothing is due (it can be invoked spuriously over HTTP, and an `@Atomic` throw does not undo an alarm).
9. Add `@Atomic async reconcile()` (sweep due cooldowns, expire leases, re-arm alarm). Backend calls it on boot and on an interval, because local dev loses pending alarms on restart.
10. `@Emittable` only on small public fields that every team member may see. Keep idempotency ledgers, internal epochs, and anything sensitive private.
11. `onConnect`: reject sockets without `metadata.userId`; the backend must check membership before calling `prepareWebsocket`.

---

## 9. Spec corrections and risks

### Spec section 6 (and related) checked against the package

| Spec says | Reality | Action |
|---|---|---|
| "Use Terse @Persisted, @Atomic, @Emittable, actor WebSockets, and onAlarm" | All exist with those names. Scheduling API is `this.alarm.set(ms)` / `get()` / `delete()`, **one slot per actor**. [pkg] | Model "alarm schedule" as earliest-deadline re-arm. |
| "Reassign persisted objects/arrays rather than mutating nested fields in place" | Correct. Verified. Mutations are kept in memory and silently lost later. [docs] [run] | Keep. |
| "Do not indiscriminately use @Interleave on methods whose atomic transitions depend on serialization" | **Too weak.** One `@Interleave` method anywhere in the class disables rollback for **every** method, including `@Atomic` ones. A throwing `@Atomic` write was durably committed. [pkg] [src] [run] | Rule: no `@Interleave` in TeamWorkforce at all. |
| Section 5: "Terse may make a state transition atomic" | Only `@Atomic` methods are atomic. Plain methods save each assignment immediately and keep writes made before a throw. [run] The [blog] and typescript-guide.md:298 claim failed calls roll back by default; that is wrong for plain methods. | Mark all transitions `@Atomic`. |
| `onAlarm()`: "due cooldowns/retries trigger reconciliation" | Works and wakes evicted actors. But: alarm set/delete is **not transactional**, `onAlarm` can be invoked directly via HTTP, a throwing `onAlarm` is not retried, and **local dev drops pending alarms on restart**. [src] [run] | Persist deadlines, idempotent `onAlarm`, `reconcile()` from backend. |
| Section 11 "Terse restart: persisted actor restore" | Fields restore (verified). Alarms do not in local dev (verified). | Backend calls `reconcile()` on boot. |
| `reserveWorkers(taskId, targets, key)` idempotency | The client has no idempotency option; `requestId` is a random per-attempt UUID. [src] | Store `key -> result` in the actor (as in the smoke actor). |
| `TeamWorkforce(teamProjectId)` | Actor IDs allow only `[A-Za-z0-9._-]`, 1–128 chars. [pkg] | Use `${teamId}.${projectId}` with safe IDs. |
| Section 13 skips "production GKE Terse deploy" | Superseded: Terse Cloud is now documented, and Morrow deploys there. [docs.useterse.ai] | Locally, run `durable-actors dev --no-watch` beside the backend. |

### Top risks for a 5-hour build

1. **Alarm loss on dev restart.** Mitigated by `reconcile()`; without it a cooldown can stay "limited" forever after a restart mid-demo.
2. **Hot reload 503s.** Any file save in the actor project reloads and calls fail with `unavailable` for a moment. Separate folder, `--no-watch` during the demo, backend retries `unavailable` with backoff.
3. **Raw API surface.** TS-private async methods and `onAlarm` are callable, args are unchecked, and auth is off by default. Set `DURABLE_ACTORS_SECRET`, keep 7100 on localhost, validate inputs, use `#private` helpers.
4. **WebSocket grant is a reusable 60 s bearer URL.** Issue it right before connect, `no-store`, never log it, check membership first. Remove users by closing their sockets.
5. **Browser access.** The dev server binds 127.0.0.1 and writes that origin into the grant. A remote browser needs the backend relay.
6. **Serialization means one slow method blocks the whole team.** Keep methods pure and fast; no external calls inside the actor.
7. **Unbounded state.** `processed` ledger and old leases grow; `@Emittable` resends the full field on every change. Prune and keep emittable fields small.
8. **Single local copy of state.** No replication in local mode. Copy `.durable-actors/` before demoing.
9. **UNVERIFIED pieces:** Next.js route handlers calling the generated client, `DURABLE_ACTORS_SECRET` with `dev`, `generate <entrypoint>` from source, running `dev` on a Linux VM, `observe` UI, `@Compute`/`@Resource` behavior. Test the first two before relying on them.

## Findings from wiring the storage, push and restart fixes

Verified against the SDK and host source and by tests in this repo, not taken from the docs alone.

- **Whole-field writes.** Each invocation reads every `@Persisted` field before and after the method (to diff emitted state) and writes a changed field whole. Big maps in fields therefore cost their full size per write and twice per read. TeamWorkforce moved its records to SQLite for this (architecture section 5.3). [src: `sdk/src/host/actor-runtime.ts`, the `database.fields()` calls around each invocation]
- **Private fields are never emitted.** `emittableFields` skips `private` fields even with `@Emittable`, so an emitted field must be public. [src: `actor-runtime.ts`, `emittableFields`]
- **Connect snapshots use the state after `onConnect`.** Work done in `onConnect` (TeamWorkforce's schema upgrade) is in the first snapshot. [src: `actor-runtime.ts`, `socketEffects(command, state, ...)` after the hook]
- **State is published before the response.** The host publishes socket state for a call, then completes the request. The two still travel separate paths, so a client must not assume the push has arrived when the response does (the backend waits 1 s after its own writes before trusting the pushed view). [src: `src/host/actor_host.rs`, `StatePublicationCompleted` before `Completion`]
- **Auto-response.** The gateway compares the whole text frame with the configured request; a match is answered at the gateway and the actor never runs. Any other text goes to `onMessage`, and text the SDK cannot parse as JSON fails the handler, which closes the socket with 4400. So the keepalive is the JSON text `{"type":"ping"}`: an actor without the auto-response still parses it. The pair lives in the gateway's per-actor room and is set again on every connect, so it comes back after a Terse restart. Protocol-level ping frames are answered by the gateway too. Measured on the dev runtime (Docker test server): on 0.14.3 a text ping matching the pair set in `onConnect` got no gateway reply; on 0.14.4 the gateway answers with exactly the configured text for both Team and TeamWorkforce. Morrow pins 0.14.4 and has no actor-side pong. [src: `src/sockets/browser.rs` `receive` (4400 on a failed handler), `src/sockets/mod.rs` `auto_response`, `sdk/src/actor/socket.ts` `JSON.parse(message.data)` before any handler runs]
- **Declaration bundle trap.** `generate` bundles public types with its own tsconfig (NodeNext, no `allowImportingTsExtensions`). When an entrypoint re-exports an actor class from another file, that file is compiled as source, and any value import ending in `.ts` fails with TS5097. Keep such files to package value imports plus `import type`. [src: `sdk/src/compiler/declarations.ts` `writeBundleConfig`, `resolveImports`] [run]
- **Actor inventory.** `/observe/actors` is a bounded in-memory cache per control-plane process: empty after a restart, idle actors forgotten. It is a hint, never a list of record. Morrow keeps its own durable list in the `TeamDirectory` actor. [docs: configuration.md, "Host lifecycle reports"]
- **Production alarms.** The self-hosted chart keeps alarms in PostgreSQL and polls them (`DURABLE_ACTORS_ALARM_POLL_INTERVAL_MS`, default 100 ms); only the dev server loses them on restart. [docs: configuration.md; self-hosting.md]
