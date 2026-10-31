# Freestyle VMs: integration reference

For the agent building the Freestyle side of the product (spec sections 2, 3, 8, 11, 12, 13). Everything here was checked against the installed SDK `freestyle@0.2.20` (`backend/node_modules/freestyle/`, both `dist/*.d.ts` and `src/*.ts`) or the official docs at `https://www.freestyle.sh/docs/*.md`. Each claim has a citation. Anything not verifiable is marked **UNVERIFIED**.

Citation shorthand:
- `SDK:<file>:<line>` = `backend/node_modules/freestyle/<file>` (for example `SDK:dist/vms/types.d.ts:384`).
- `DOC:<page>` = `https://www.freestyle.sh/docs/<page>.md` (for example `DOC:vms/pty`).
- `README` = `backend/node_modules/freestyle/README.md` (ships with 0.2.20, so it is version-matched).

Verification done during research (no real VMs, no billable calls):
- Typechecked a full sketch (section 10) with the backend's TypeScript 7.0.2: passes. A negative control (`vms.create({ cpu: 4 })`) fails as expected, so the types really resolve.
- Ran the SDK under Bun 1.4.4 against a local mock of the Freestyle API: `vm.exec`, server-side `vm.pty.open` (Authorization header on the WebSocket handshake, binary output, resize/input frames) and the browser identity-token handshake all behave as the source says.
- Ran a `bun test` of the terminal proxy (section 5, Approach A) against the mock: origin check, auth refusal, byte relay, resize clamping, replay reset and read-only enforcement all pass. Test files were deleted afterwards.
- `FREESTYLE_API_KEY` is **not set** in the research shell environment.

---

## 0. Quick answers

| Question | Answer |
|---|---|
| Base image with coding CLIs | `freestyle/ubuntu` (and its `-sm` ... `-3xl` siblings) ships `claude`, `codex`, `opencode`, `openclaw`, plus git, node, bun, docker, tmux. `DOC:vms/base-snapshots` "What's Installed" |
| Exec timeout | Default **30 s**. Max 5 min on older guest agents, up to 24 h on agents with native exec. `SDK:dist/vms/types.d.ts:384`, `README` "Long-running execs" |
| Browser terminal | Two working paths: (B) identity token used directly by the browser SDK + `connectXterm`, or (A) our backend proxies the PTY WebSocket. Recommend B for the owner's own terminal, A for read-only "inspect". Section 5 |
| VM states | `starting`, `running`, `pausing`, `paused`, `stopped` (deleted = 404). `SDK:dist/vms/types.d.ts:3` |
| Paused cost | Storage only. `DOC:vms/pricing-and-limits` "Usage pricing" |
| Demo cost (2 VMs x 5 h, default size) | About $2.67 at list price; $0 on the Free plan because it fits inside the monthly included usage. Section 9 |

---

## 1. Auth

### API key (backend)
- Env var: **`FREESTYLE_API_KEY`**. The client uses `options.apiKey ?? process.env.FREESTYLE_API_KEY` and sends `Authorization: Bearer <key>`. `SDK:src/client.ts:139-145`
- The constructor **throws** if no key is found (`"No Freestyle API key provided..."`), `SDK:src/client.ts:140-142`. Build the client lazily (on first use), not at module import, or the whole server crashes at boot when the var is missing. The sketch does this.
- The SDK itself does not read `.env` files (`README` "Credential precedence" paragraph). Bun auto-loads `.env` into `process.env` (backend `CLAUDE.md`), so under Bun a `.env` entry works anyway.
- Get a key: dashboard `https://dash.freestyle.sh` (`README`), or with the CLI: `freestyle login` then `freestyle tokens create "workforce-backend"` (add `--output json` and read `.token` for scripts). The key is shown once. `DOC:cli` "Authenticate"
- Other credential modes on the same constructor: `identityAccessToken` (end-user scoped token, section 5) and `stackAccessToken + teamId` (what the CLI uses). `SDK:dist/client.d.ts` `FreestyleOptions`

### CLI login flow
- The CLI is already installed locally as `backend/node_modules/.bin/freestyle` (`bunx freestyle ...` from `backend/`). Do not install it globally.
- `freestyle login` opens a Stack Auth browser page (`--no-browser` prints the URL). It stores a refresh token and team in `~/.freestyle/config.json` (mode 0600). Login does **not** create an API key. `README`, `DOC:cli`
- Credential precedence in the CLI: `--api-key`, then `FREESTYLE_API_KEY` in the environment, then `.env` in cwd, then the stored login. `DOC:cli`

---

## 2. Creating a persistent VM

### `freestyle.vms.create(options: CreateVmOptions)`
Returns `{ vm, vmId, data, firewallRules, tlsRules }`. `SDK:dist/vms/index.d.ts` `VmsNamespace.create`

Options (all from `SDK:dist/vms/types.d.ts:213-327`):

| Field | Meaning |
|---|---|
| `firewall` | **Required.** `{ rules: [...] }`. A VM gets no inbound and no outbound by default. `{ rules: [] }` is valid (reachable only via mapped domain or SSH). Section 8 |
| `snapshotId` | Snapshot id (`sh-...`), your slug, or public `freestyle/<name>`. Omit for the default `freestyle/ubuntu` |
| `slug` | Account-unique handle, 1-63 chars `[a-z0-9-]`, no leading/trailing/double hyphen. Usable anywhere an id is |
| `reassignSlug` | Steal the slug from whoever holds it |
| `displayName` | Label shown instead of the slug |
| `metadata` | Up to 64 entries, keys and values max 63 chars. Filter with `vms.list({ metadata: "k:v,k2:v2" })` |
| `idleTimeoutSeconds` | Pause after N seconds without network activity. Omit or `-1`/`null` = never |
| `autoDeleteSeconds` | Delete after N seconds not running. Omit/`-1` = never (but some plans impose a cap). `0` = ephemeral |
| `ttlSeconds`, `maxRunSeconds`, `maxRunTotalSeconds` | Hard deadlines / runtime budgets. Leave unset for persistent dev VMs |
| `automaticRestart` | Reboot after a crash. Default `true`. Never fights an intentional pause/poweroff |
| `vpcs` | Attach to one private network |
| `placement` | Anti-affinity by metadata |
| `tls` | Inline TLS rules (domains) created and deleted with the VM |

Things the spec might assume that are **not** there:
- **No CPU / memory / disk fields on create.** Size comes from the snapshot ("Hardware is baked in", `DOC:vms/base-snapshots`; "VMs always start at their snapshot's size", `DOC:vms/pricing-and-limits`). Grow later with `vm.resize({ cpu, memory, storage })` (MiB, grow-only, `SDK:dist/vms/types.d.ts:367-374`). The Free plan cannot go above the default 4 vCPU / 8 GiB / 32 GB.
- **No "persistent" flag.** A VM is persistent unless `autoDeleteSeconds: 0`. On plans that cap retention, omitting `autoDeleteSeconds` gets the cap; read `data.autoDeleteSeconds` and `data.autoDeleteFromPlan` after create (`SDK:dist/vms/types.d.ts:103-115`). Which plans cap it is **UNVERIFIED**.
- **No create-time command / user-data field** in `CreateVmOptions`. Run setup with `vm.exec` after create, or bake it into a snapshot.

Idempotent get-or-create by slug: `vms.get(slug)` (404 if absent), else `create`; on a concurrent-create race the API answers 409 (the CLI checks `status === 409 && code === "CONFLICT"`, `SDK:src/cli/prompt.ts:47-49`), so re-`get`. Implemented in `ensureEngineerVm` (section 10).

### Base snapshots (`DOC:vms/base-snapshots`, `SDK:dist/vms/types.d.ts:14-28`)

| Slug | vCPU | Memory | Disk | Plan |
|---|---|---|---|---|
| `freestyle/busybox` | 1 | 128 MiB | 1 GB | all, no libc, sh only |
| `freestyle/ubuntu-sm` | 2 | 4 GiB | 16 GB | all |
| `freestyle/ubuntu` (default) | 4 | 8 GiB | 32 GB | Free max |
| `freestyle/ubuntu-lg` | 8 | 16 GiB | 64 GB | Hobby+ |
| `freestyle/ubuntu-xl` | 16 | 32 GiB | 128 GB | Pro |
| `freestyle/ubuntu-2xl` | 32 | 64 GiB | 128 GB | Pro |
| `freestyle/ubuntu-3xl` | 64 | 128 GiB | 256 GB | custom only |
| `freestyle/kali` | 4 | 8 GiB | 32 GB | security tools |

All Ubuntu sizes are Ubuntu 24.04 with identical software. Installed (`DOC:vms/base-snapshots` "What's Installed"):
- **Coding agents: `claude`, `codex`, `opencode`, `openclaw`**, installed in a shared root-owned Node tree and symlinked into `/usr/local/bin`, so they work in `vm.exec()` without sourcing a profile and are on PATH for every Linux user.
- Node LTS (nvm at `/usr/local/nvm`), `bun`, `bunx`, `typescript`, Python dev env at `/opt/freestyle/python`, `uv`, Docker (daemon at boot), `git`, `curl`, `jq`, `tmux`, `vim`, `sudo`, `wg`.
- An `ubuntu` user (uid 1000) with passwordless sudo. `vm.exec()` and `vm.pty` default to it; `vm.linuxUser("root")` for system changes.
- `gh` (GitHub CLI) is **not** listed. Install it in the golden snapshot if needed.
- The slug `freestyle/ubuntu` is re-pointed on every catalog rebuild (`SDK:dist/vms/types.d.ts:5-13`), so CLI versions drift. Our own snapshot freezes them ("Saved snapshots keep their installed versions", `DOC:vms/base-snapshots`).
- Exact CLI versions on the current image: **UNVERIFIED** (needs a running VM). Docs suggest `command -v node npm bun bunx claude codex python3 uv` inside the VM.

### Our golden snapshot (Relay preinstalled, nothing logged in)
`vm.snapshot({ slug?, displayName?, autoDeleteSeconds?, ttlSeconds? })` captures **memory and disk**; the VM must be running or paused; resolves when bootable. `SDK:dist/vms/index.d.ts` `Vm.snapshot`, `SDK:dist/vms/snapshots.d.ts`

Rules for us:
1. Build from the size you want every engineer VM to have (`freestyle/ubuntu-sm` or `freestyle/ubuntu`): children inherit the snapshot's hardware.
2. Install only tools: Agent Relay CLI (and `gh` if used). Git is already there, so "install Git tooling" in spec section 8 is unnecessary.
3. **Do not log in, do not enroll the Relay node, and do not leave any daemon running** before snapshotting. The snapshot includes memory, so a running Relay daemon (with its node identity and open sockets) would be cloned into every VM. Enroll per VM after boot with a per-VM node name.
4. Do not follow the Freestyle Claude Code guide's "snapshot after login" advice (`DOC:guides/run-claude-code-in-a-sandbox` "Snapshot Your Logged-In Claude Code"). That bakes one person's credential into every clone, which is exactly what spec section 8 forbids.

SDK version (in sketch, `buildGoldenSnapshot`): create builder from `freestyle/ubuntu`, `vm.linuxUser("root").exec("npm install -g agent-relay@<version>")` (root owns the shared Node tree, `DOC:vms/base-snapshots`), verify `command -v git claude codex agent-relay`, `vm.snapshot({ slug: "workforce-base" })`, delete builder. The exact Relay install command is **UNVERIFIED here** (take it from the Relay research doc; `agent-relay` is the npm package and bin name in `backend/package.json` / `backend/node_modules/.bin`).

CLI version (one command, from `DOC:vms/cli` "Build A Snapshot From Scratch"):
```bash
bunx freestyle snapshot create --base freestyle/ubuntu --slug workforce-base --script ./golden-setup.sh
```
A non-zero script exit deletes the VM and takes no snapshot. Manage with `freestyle.vms.snapshots.list/get/update/delete` (`SDK:dist/vms/snapshots.d.ts`). Snapshots count against the plan limit (Free: 10).

---

## 3. Lifecycle

States: `"starting" | "running" | "pausing" | "paused" | "stopped"` (`SDK:dist/vms/types.d.ts:3`). There is no `deleted` state: a deleted VM's `get` is a 404. There are **no lifecycle webhooks** in the SDK (no webhook/event APIs anywhere in `src/`), so poll `vm.data()` / `vms.get()` / `vms.list({ state })`.

| Action | API | What persists | Source |
|---|---|---|---|
| Pause | `vm.pause()` | Memory, processes, open files, disk. PTY processes freeze. Does not count against concurrent-VM limit; still a saved VM | `DOC:vms/lifecycle` "Paused", `DOC:vms/pty` "Lifecycle Behavior" |
| Resume / boot | `vm.start()` | Paused: resumes same processes at same point. Stopped: fresh boot from disk | `SDK:dist/vms/index.d.ts` `Vm.start` |
| Stop | No SDK method. `vm.exec("poweroff").catch(() => {})` then poll until `stopped` (the exec rejects because the VM dies mid-call) | Disk only; memory and PTY sessions gone | `DOC:vms/lifecycle` "Stopped" |
| Snapshot | `vm.snapshot()` | Memory + disk copy | `DOC:vms/base-snapshots` |
| Delete | `vm.delete()` / `vms.delete(id)` | Nothing. Also deletes firewall rules naming the VM | `DOC:vms/lifecycle`, `DOC:vms/network/firewall` "Lifecycle" |
| Resize | `vm.resize({...})` | Grow-only; CPU/mem live when running, on resume when paused; disk only while running | `DOC:vms/lifecycle` "Resize" |

Other lifecycle facts:
- **Files while paused:** `vm.fs` reads (`readFile`, `readTextFile`, `readFileStream`, `readDir`, `stat`, `exists`) work on paused and stopped VMs without starting compute; writes, `mkdir`, `remove` wake the VM automatically. `DOC:vms/files` "Read Files While Paused"
- **Wake triggers:** an idle-paused VM resumes on `start()` or on the next traffic reaching it (`DOC:vms/lifecycle` "Idle Timeout"). Typing into a paused VM's PTY session wakes it (`DOC:vms/pty` "Lifecycle Behavior"). Still call `start()` before attaching, as the PTY doc instructs.
- **Idle timeout** counts network activity: traffic over its public address, and terminal input. Output alone does not count. `SDK:dist/vms/types.d.ts:230-235`, `DOC:vms/pty`. Whether a long-lived **outbound** WebSocket (Relay) counts as activity is **UNVERIFIED**. So do not use `idleTimeoutSeconds` for agent VMs during the demo; let the backend decide (spec already says pause only when idle). The VM record has `lastNetworkActivity` (`SDK:dist/vms/types.d.ts:159`) if you want to build your own idle logic.
- **Resume latency:** not documented as a number. Docs claim base snapshots "start in about a second" (`DOC:vms/base-snapshots`) and provisioning "p99s under 400ms" (`DOC:index`, marketing). Measure it on the day.
- **Slow calls:** the client sends every request as a background request; if it takes more than 5 s the API answers 202 and the SDK polls every 2 s until the real result (`SDK:src/client.ts:8-12, 91-101`). So `create`, `start` on a cold VM, or `snapshot` can take a while but still resolve with the normal value. Do not wrap them in short HTTP timeouts.
- Errors: non-2xx throws `FreestyleApiError` with `.status`, `.code` (branch on code), `.message`. Network failures throw `FreestyleTransportError`. `SDK:src/errors.ts`, `README` "Transport"

---

## 4. Exec

```ts
vm.exec(options: string | ExecOptions): Promise<ExecResult>
interface ExecOptions { command: string; linuxUser?: string; timeoutMs?: number; env?: Record<string,string>; stdin?: string /* base64, <=1 MiB decoded */ }
interface ExecResult { stdout?: string | null; stderr?: string | null; statusCode?: number | null }
```
`SDK:dist/vms/types.d.ts:375-396`. Posts to `/v5/vms/{id}/exec-await` (`SDK:src/vms/index.ts:100-103`).

- `command` runs through the guest's shell.
- **Timeout:** default **30 000 ms**. Max **300 000 ms (5 min)** unless the guest agent advertises native exec, then up to **86 400 000 ms (24 h)**; asking for more than 5 min on an older agent returns `AGENT_UNSUPPORTED` (`SDK:dist/vms/types.d.ts:384`, `README` "Long-running execs"). The docs page still says "The maximum timeout is five minutes" (`DOC:vms`). Plan for 5 min.
- Non-zero exit is **not** an exception. Check `statusCode`; `null` means it was killed by the timeout (`SDK:dist/vms/index.d.ts` `Vm.exec` doc). `stdout`/`stderr` can be `null`, so `result.stdout?.trim()`.
- **No streaming.** `exec` buffers until the command exits (`DOC:guides/run-a-web-terminal-in-a-sandbox` "Stream the Server's Logs"). Even `freestyle vm exec` in the CLI just prints the buffered result (`SDK:src/cli/commands/vm.ts:283-298`). For live output use a PTY.
- **User:** `linuxUser` option, or `vm.linuxUser("alice").exec(...)`. Default is the uid-1000 account (`ubuntu`), or `root` if none (`SDK:dist/vms/types.d.ts:378-383`). The user must already exist.
- **Env:** `env` object, keys must be POSIX names. Pass untrusted values through `env` and reference `"$VAR"` in the command, never interpolate into the command string (done in `ensureLinuxUser`).
- VM shutdown or reboot ends running execs (`README`).

---

## 5. PTY and the browser terminal

### The primitive (`SDK:src/vms/pty.ts`, `DOC:vms/pty`)
- `vm.pty.open(opts)` / `vm.linuxUser(u).pty.open(opts)` opens a WebSocket to `/v5/vms/{id}/pty`. Options: `exec` (omit = login shell), `cols`/`rows` (default 80x24), `linuxUser`, **`slug`** (named session, get-or-create: an existing session with that name is returned and `exec` is not re-run; `session.created` tells which), **`replaceOnExit`** (respawn the shell in place when it exits, keeping id, name, scrollback). `SDK:src/vms/pty.ts:57-94`
- Events: `onData(Uint8Array)`, `onExit(code)`, `onClose`, `onError`, `onStateChange`, `onReplayStart({exact})`, `onReplayEnd`. `SDK:src/vms/pty.ts:106-119`
- `session.write(data)`, `session.resize({cols,rows})`, `session.signal("sigint"|"sigkill")`, `session.detach()` (closes the socket only; the shell keeps running), `vm.pty.close(id|slug)` (kills it), `vm.pty.list()`. `SDK:src/vms/pty.ts:514-556, 645-656`
- `vm.pty.attach({ session: idOrSlug })` reattaches; retained scrollback replays first. `SDK:src/vms/pty.ts:592-603`
- `reconnect: true` keeps one handle across dropped connections: exponential backoff 400 ms to 10 s, up to 5 min per outage, re-sends the last size, never re-runs `exec`. Stops on process exit, 4xx (other than 409/429), or WS close code 1008. `SDK:src/vms/pty.ts:420-486`, `DOC:vms/pty` "Detach And Reattach"
- Each connection must receive `sessionInfo` within `connectTimeoutMs` (default 15 s), `SDK:src/vms/pty.ts:328-336`. (The web-terminal guide says `pty.open` "has no timeout of its own"; the 0.2.20 source disagrees. Either way, start a paused VM before opening.)
- `write()` and `signal()` **throw** while not connected; input is never buffered or retried. `SDK:src/vms/pty.ts:514-529`
- **Set `TERM` yourself.** The Claude guide says the PTY shell does not set it and the claude TUI exits with "TERM environment variable not set" (`DOC:guides/run-claude-code-in-a-sandbox` "Run Claude Code Interactively"). Use `exec: "env TERM=xterm-256color bash -l"`.
- Node/Bun use the bundled `ws` package so the handshake can carry `Authorization` (`SDK:src/vms/pty.ts:139-155`). Bun counts as Node here (`process.versions.node` is set). `ws@8.22.0` is installed. Verified working under Bun 1.4.4 against a local mock.
- Client input (keys, resize, signals) counts as VM activity; output does not (`DOC:vms/pty`).

### Approach B (recommended for the owner's private terminal): identity token in the browser
How it works (`DOC:vms/pty` "Browser Clients", `DOC:vms/client-sessions`, `SDK:src/identities.ts`):
1. Server: one Freestyle identity per app user (`freestyle.identities.create()`), store `identityId` in our DB.
2. Server: `identity.permissions.vm.grant({ vmId, allowedLinuxUsers: [engineerUser] })`. Use the real VM id, not the slug. With `allowedLinuxUsers` set, every request must name an allowed user or it is rejected.
3. Server: `identity.tokens.create({ expiresAt })` (RFC 3339; omit = never expires). Token string is returned once. Send it only to that authenticated user.
4. Browser: `new Freestyle({ identityAccessToken })`, then `connectXterm({ pty: fs.vms.ref(vmId).linuxUser(user).pty, terminal, slug: "main" })`. The browser SDK sends the token as WebSocket subprotocols `freestyle-pty` + `freestyle-identity.<base64url token, no padding>` (`SDK:src/vms/pty.ts:162-176`, verified against a local mock).
5. `connectXterm` (`SDK:src/vms/xterm.ts:47-141`) wires input/output/resize, enables reconnect by default, clears the screen before replay, and mutes terminal-query replies during replay (stops garbage being typed into the shell). `dispose()` detaches without killing the shell.

Scoping and expiry:
- An identity token can only touch VMs granted to that identity, only as the allowed Linux users, and only exec/PTY routes. It cannot create resources. `DOC:vms/client-sessions`, `README` ("scoped to one VM's exec/PTY routes")
- **Expiry blocks new requests and reattach but does not disconnect an open terminal.** Mint a fresh token when the user reconnects. Expired tokens are purged after 24 h. `DOC:vms/pty` "Browser Clients"
- Revoke: `identity.tokens.revoke(tokenId)`, `identity.permissions.vm.revoke(vmId)`, or `identities.delete(id)` (drops tokens and grants). Whether revocation cuts an already-open terminal is **UNVERIFIED**; to cut access instantly, also `vm.pty.close("main")` from the server (kills the shell).
- Reattach after disconnect: same `slug: "main"` = same shell and scrollback. When the SDK's 5-minute recovery gives up (or the token expired), `onClose` fires; re-mint the token and call `connectXterm` again (sketch `openPrivateTerminal`).
- Also usable for SSH and VS Code/Cursor: `ssh <vm>+<user>:<token>@beta-ssh.freestyle.sh` (`DOC:vms/ssh`).

### Approach A: our backend proxies the PTY
Backend opens the PTY with the API key (`vm.linuxUser(u).pty.open({ slug: "main", reconnect: true, ... })`) and relays bytes over our own WebSocket (Bun.serve). This is the pattern in `DOC:guides/run-a-web-terminal-in-a-sandbox` "Bridge the PTY to a Browser". We own auth, origin checks, read-only enforcement and audit, but we re-implement replay reset and browser-leg reconnect. Full code in section 10 (`terminal-proxy.ts`, tested locally).

### Which one
| | B: identity token | A: backend proxy |
|---|---|---|
| Code we write | ~30 lines browser + ~25 lines server | ~100 lines server + ~40 browser |
| Reconnect / replay / query muting | SDK does it | We do it |
| API key exposure | Never leaves server | Never leaves server |
| Credential in browser | Short-lived token = shell as that user on that VM until expiry | None |
| Read-only viewers | Not possible (a token is a full shell) | Enforced server-side |
| Hops | Browser to Freestyle directly | Browser to us to Freestyle |

Recommendation: **B for "Open private terminal"** (the person already gets a full shell, so the token grants nothing extra; short TTL like 15 min, grant restricted to one Linux user, revoke on logout). **A only for permission-gated read-only "terminal inspect"** of a teammate's worker, because identity grants have no read-only mode. Both can point at the same named session (`slug: "main"`), so the owner and an inspector see the same shell.

Doc inconsistency to know about: the Claude Code guide and the web-terminal guide say browsers cannot open the PTY because they cannot set auth headers (`DOC:guides/run-claude-code-in-a-sandbox`, `DOC:guides/run-a-web-terminal-in-a-sandbox`). That is outdated for API keys only; the PTY page and the 0.2.20 source support browsers through identity tokens.

**UNVERIFIED:** whether `api.freestyle.sh` serves CORS headers for browser REST calls. The browser SDK makes one REST call during reconnect (`GET /pty/sessions` preflight, `SDK:src/vms/pty.ts:616-633`). The docs explicitly document browser clients, so it should work. If it fails on the first real try, fall back to Approach A.

Security notes for either path:
- Never send the API key to the browser.
- A: check `Origin` on the WS upgrade (cookies ride along on cross-site WS handshakes), authorize before `upgrade()`, clamp resize values, drop input for read-only viewers, log errors server-side and send the browser a generic message.
- B: XSS in our app equals shell access until token expiry. Keep TTL short, no `localStorage` for the token, CSP on the app.

---

## 6. Linux users and CLI auth isolation

- Create users as root via exec (`DOC:vms/client-sessions`, `DOC:vms/ssh` "SSH As A Linux User"): `useradd --create-home --shell /bin/bash <user>`. Selecting a user in `exec`/`pty` does not create it (`DOC:vms/pty`).
- Run processes as that user: `vm.linuxUser("alice").exec(...)`, `vm.linuxUser("alice").pty.open(...)` (`SDK:src/vms/index.ts:105-135`).
- Each user gets their own `$HOME`, so CLI auth lands per user: Claude Code stores its login under `~/.claude` (`DOC:guides/run-claude-code-in-a-sandbox` "Authenticate"); Codex caches it in `~/.codex/auth.json` (OpenAI docs, `https://developers.openai.com/codex/auth`). The CLIs themselves are shared from `/usr/local/bin`.
- Identity grants with `allowedLinuxUsers` keep each human's token confined to their own Linux user (`DOC:vms/ssh` "Multiple Developers").
- Isolation limits, be honest about them:
  - `ubuntu` has passwordless sudo (`DOC:vms/base-snapshots`). Do not add engineer users to `sudo` if several profiles share one VM, or they can read each other's homes.
  - `vm.fs` operates **as root** (`DOC:vms/cli` "Files And SCP", `DOC:guides/run-claude-code-in-a-sandbox`), and the API key can `exec` as root. Our backend can technically read every CLI credential on every VM. "The platform does not own provider secrets" (spec section 1) is a policy we keep, not something Freestyle enforces.
- Login flows inside the browser terminal:
  - Claude Code: run `claude`, use `/login`; it prints an OAuth URL, the user approves, credential is stored under `~/.claude` (`DOC:guides/run-claude-code-in-a-sandbox`). First run also shows a theme picker and a per-directory trust prompt (same guide); a human just answers them.
  - Codex: use **`codex login --device-auth`** (or "Sign in with Device Code"). The default flow redirects to `localhost:1455` on the VM, which the user's browser cannot reach. `https://developers.openai.com/codex/auth` "Login on headless devices"
  - Long OAuth URLs wrap in xterm. Add the xterm web-links addon or make sure copy works across wrapped lines.
- Alternative worth knowing (not in scope): Freestyle can inject a Claude subscription token (`claude setup-token`) at the edge via a TLS rule so it never touches the VM (`DOC:guides/inject-claude-code-oauth-token-at-the-edge`). Conflicts with the spec's "user logs in interactively on their VM" model, so skip for the hackathon.

---

## 7. Files

`vm.fs` (`SDK:dist/vms/fs.d.ts`, `DOC:vms/files`):
- `writeFile(path, string | Uint8Array | Blob, { mode?, onProgress?, signal?, chunkSize?, maxAttempts? })`, `writeTextFile(path, text, opts)`. Atomic (readers see old or new, never half), sha256-verified, auto-chunked above 8 MiB, up to 16 GiB per file. `mode` defaults to the target's existing mode, else **0o600**.
- `readFile(path, { offset?, length? }) -> Uint8Array` (never `String(bytes)`, use `readTextFile` or `TextDecoder`), `readTextFile`, `readFileStream`, `readDir`, `mkdir` (creates parents), `remove` (recursive), `exists`, `stat`.
- Paths must be absolute, no `..`, max 4096 chars.
- Writes are **root-owned**. After writing a config into a user's home: `vm.linuxUser("root").exec({ command: 'chown "$U:$U" "$P"', env: { U, P } })`.
- Good fit for bootstrap: write `/home/<user>/bootstrap.sh` with `mode: 0o755`, chown, then `vm.linuxUser(user).exec("/home/<user>/bootstrap.sh")`. Write a systemd unit to `/etc/systemd/system/` and `systemctl enable --now` as root for long-lived daemons like the Relay node runtime (systemd is pid 1, `DOC:vms/base-snapshots`).

---

## 8. Networking

### Firewall (`DOC:vms/network/firewall`, `SDK:dist/firewall.d.ts`)
- Allow-only rules, `source -> destination`, required on create. Inside a create, an endpoint with no identity (`{}`) means the new VM.
- Matchers: `vmId`, `vpcId`, `tunnelId`, `cidr`, `public: true`, `port` (needs `protocol`), `protocol` (`tcp|udp|icmp`). No domain-name matchers on firewall rules.
- **Recommended rule for worker VMs:**
  ```ts
  firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] }
  ```
  This covers model providers (Anthropic, OpenAI, OAuth pages), GitHub over HTTPS (443) and SSH (22), npm/apt, and the Agent Relay / Relaycast WebSocket (outbound). Both VMs reach Relay through its cloud endpoint, so no VM-to-VM rule is needed.
- Why not narrow to `tcp/443`: the docs do not say where the VM's DNS resolver lives, so a port-restricted rule might break DNS (**UNVERIFIED**). Git over SSH also needs 22. Keep it broad for the hackathon.
- **No inbound rules needed** for PTY, SSH (`beta-ssh.freestyle.sh`) or published domains: platform-delivered traffic is always allowed (`DOC:vms/network/firewall` "Freestyle's Own Traffic Always Works").
- Outbound mail ports 25/465/587 are blocked regardless of rules.
- `freestyle.firewall.evaluate({...})` checks a connection without changing anything.

### Domains / previews (`DOC:vms/network/tls-inbound`, `DOC:vms/domains`, `SDK:dist/tls.d.ts`)
```ts
await freestyle.tls.rules.create({
  action: "allow",
  domain: "ws-alice-preview.style.dev", // any unused style.dev subdomain, free, no DNS/verification
  source: { public: true },
  destination: { vmId, port: 3000 },
});
```
- HTTPS is terminated at the edge; no firewall rule needed. Can also be declared inline in `vms.create({ tls: { rules: [...] } })` so it dies with the VM.
- It is **public to anyone with the URL**. For anything sensitive add Forward Auth (`DOC:vms/forward-auth`) or keep previews to throwaway apps.

---

## 9. Pricing and limits (`DOC:vms/pricing-and-limits`)

| Resource | Price | Included per month (all plans) |
|---|---|---|
| vCPU-hour | $0.04032 | 200 |
| GiB-memory-hour | $0.0129 | 400 |
| GiB-storage-hour | $0.000086 | 60,000 |
| GB transfer | $0.02 | 50 (Free), 500 (Hobby/Pro) |

Billed per second on **allocated** resources (idle cores still bill). **Paused = storage only.**

| Plan | Price | Concurrent VMs | Saved VMs | Snapshots | Max per VM |
|---|---|---|---|---|---|
| Free | $0, never bills | 10 | 10 | 10 | 4 vCPU / 8 GiB / 32 GB |
| Hobby | $50/mo min (is usage credit) | 40 | 200 | 1,000 | 8 / 16 GiB / 64 GB |
| Pro | $500/mo min (is usage credit) | 400 | 4,000 | 12,000 | 32 / 64 GiB / 256 GB |

Adding a card to Free charges a refunded $1 verification. On Free, exhausting an allowance **pauses** affected VMs until reset.

Per-VM hourly cost (computed from the table above):
- `freestyle/ubuntu` (4 vCPU / 8 GiB / 32 GB): 0.16128 + 0.1032 + 0.00275 = **~$0.267/h** running; **~$0.0028/h** paused.
- `freestyle/ubuntu-sm` (2 / 4 GiB / 16 GB): 0.08064 + 0.0516 + 0.00138 = **~$0.134/h** running.

Hackathon demo, 2 VMs x 5 h on `freestyle/ubuntu`: 40 vCPU-h, 80 GiB-mem-h, ~320 GiB-storage-h = **~$2.67 at list price, $0 on Free** (well inside 200 / 400 / 60,000 included). Add a few minutes for the golden-snapshot builder VM. Even a full day of rehearsals fits in Free.

---

## 10. Code sketch (typechecks against freestyle@0.2.20)

Location: `/private/tmp/claude-501/-Users-samsiavoshian/60bb8e57-8f5c-453b-b0d6-1299ff591d77/scratchpad/freestyle-sketch/` (scratch, may be cleaned up; the full code is reproduced below). Typecheck: `bun x tsc --noEmit -p .` with a tsconfig whose `paths` and `typeRoots` point at `backend/node_modules` (plus a `node_modules` symlink to it). Result: 0 errors.

Files: `vms.ts` (server lifecycle + token minting), `terminal-proxy.ts` (Approach A), `browser.ts` (both browser clients), `demo.ts` (snapshot build + end-to-end flow). Copy into `backend/src/freestyle/` and adjust imports.

### vms.ts
```ts
// Freestyle VM lifecycle for one engineer environment. Server-only: holds the API key.
import {
  Freestyle,
  FreestyleApiError,
  type ExecResult,
  type FirewallSpec,
  type Vm,
  type VmData,
  type VmState,
} from "freestyle";

let client: Freestyle | undefined;

/** The constructor throws when no key is found, so build it lazily, not at import time. */
export function freestyle(): Freestyle {
  if (!client) {
    const apiKey = process.env.FREESTYLE_API_KEY?.trim();
    if (!apiKey) throw new Error("FREESTYLE_API_KEY is not set");
    client = new Freestyle({ apiKey });
  }
  return client;
}

/** Outbound to any public address, all ports/protocols. No inbound (PTY/SSH/domains need none). */
export const WORKER_FIREWALL: FirewallSpec = {
  rules: [{ action: "allow", source: {}, destination: { public: true } }],
};

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // 1-63 chars, no leading/trailing/double hyphen
const LINUX_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertSlug(slug: string): void {
  if (slug.length > 63 || !SLUG_RE.test(slug)) throw new Error(`invalid VM slug: ${slug}`);
}
export function assertLinuxUser(user: string): void {
  if (!LINUX_USER_RE.test(user) || user === "root") throw new Error(`invalid linux user: ${user}`);
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof FreestyleApiError && error.status === status;
}

/**
 * Get-or-create the engineer's persistent VM, keyed by slug.
 * Size comes from the snapshot (there is no cpu/memory field on create); grow later with vm.resize().
 */
export async function ensureEngineerVm(opts: {
  slug: string; // e.g. `env-${engineerShortId}`
  snapshotId: string; // our golden snapshot slug or sh-... id
  metadata: Record<string, string>; // <=64 entries, keys/values <=63 chars
}): Promise<{ vm: Vm; data: VmData; created: boolean }> {
  assertSlug(opts.slug);
  const fs = freestyle();
  try {
    const data = await fs.vms.get(opts.slug);
    return { vm: fs.vms.ref(data.id), data, created: false };
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
  try {
    const { vm, data } = await fs.vms.create({
      snapshotId: opts.snapshotId,
      slug: opts.slug,
      metadata: opts.metadata,
      firewall: WORKER_FIREWALL,
      idleTimeoutSeconds: null, // never auto-pause; our backend decides when to pause
      // autoDeleteSeconds omitted: VM is persistent (some plans impose a cap; read data.autoDeleteSeconds)
    });
    return { vm, data, created: true };
  } catch (error) {
    // Lost a race with a concurrent create for the same slug: return the winner.
    if (error instanceof FreestyleApiError && error.status === 409) {
      const data = await fs.vms.get(opts.slug);
      return { vm: fs.vms.ref(data.id), data, created: false };
    }
    throw error;
  }
}

/** Create the per-engineer Linux account once. Username goes through env, never string-interpolated. */
export async function ensureLinuxUser(vm: Vm, user: string): Promise<void> {
  assertLinuxUser(user);
  const result = await vm.linuxUser("root").exec({
    command:
      'set -eu; id -u "$NEW_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$NEW_USER"; ' +
      'install -d -o "$NEW_USER" -g "$NEW_USER" -m 700 "/home/$NEW_USER/work"',
    env: { NEW_USER: user },
    timeoutMs: 30_000,
  });
  if (result.statusCode !== 0) throw new Error(`useradd failed: ${result.stderr ?? ""}`);
}

export interface HealthReport {
  ok: boolean;
  tools: Record<string, string | null>;
  raw: ExecResult;
}

/** Short probe. exec defaults to a 30 s timeout; non-zero exit does not throw; statusCode null = timed out. */
export async function healthCheck(vm: Vm, user: string): Promise<HealthReport> {
  const raw = await vm.linuxUser(user).exec({
    command:
      "for t in git claude codex agent-relay; do printf '%s=' \"$t\"; command -v \"$t\" || echo; done",
    timeoutMs: 20_000,
  });
  const tools: Record<string, string | null> = {};
  for (const line of (raw.stdout ?? "").split("\n")) {
    const [name, path] = line.split("=", 2);
    if (name) tools[name] = path ? path : null;
  }
  const ok = raw.statusCode === 0 && Object.values(tools).every((p) => p !== null);
  return { ok, tools, raw };
}

/** Poll until the VM reports `target`. There are no lifecycle webhooks in the SDK. */
export async function waitForState(vm: Vm, target: VmState, timeoutMs = 120_000): Promise<VmData> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await vm.data();
    if (data.state === target) return data;
    if (Date.now() > deadline) throw new Error(`VM ${vm.id} stuck in ${data.state}, wanted ${target}`);
    await Bun.sleep(500);
  }
}

/** Freeze memory + processes. PTY sessions freeze too; Relay's socket will drop on the far side. */
export async function pauseVm(vm: Vm): Promise<VmData> {
  const data = await vm.data();
  if (data.state === "paused") return data;
  await vm.pause();
  return waitForState(vm, "paused");
}

/** Resume a paused VM (or boot a stopped one), then gate on a fresh health probe. */
export async function resumeVm(vm: Vm, user: string): Promise<HealthReport> {
  const data = await vm.data();
  if (data.state !== "running") {
    await vm.start();
    await waitForState(vm, "running");
  }
  return healthCheck(vm, user);
}

/**
 * Browser-terminal credential (identity approach). One Freestyle identity per app user,
 * stored in our DB; grant is scoped to one VM and one Linux user; token is short-lived.
 */
export async function mintTerminalToken(opts: {
  identityId: string | null; // null on first use, then persist the returned id
  vmId: string; // real VM id (data.id), not the slug
  linuxUser: string;
  ttlMs?: number;
}): Promise<{ identityId: string; token: string; tokenId: string; expiresAt: string }> {
  assertLinuxUser(opts.linuxUser);
  const fs = freestyle();
  const identityId = opts.identityId ?? (await fs.identities.create()).identityId;
  const identity = fs.identities.ref(identityId);
  try {
    const grant = await identity.permissions.vm.get(opts.vmId);
    const users = grant.allowedLinuxUsers;
    if (!users || users.length !== 1 || users[0] !== opts.linuxUser) {
      await identity.permissions.vm.update(opts.vmId, [opts.linuxUser]);
    }
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
    await identity.permissions.vm.grant({ vmId: opts.vmId, allowedLinuxUsers: [opts.linuxUser] });
  }
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? 15 * 60_000)).toISOString();
  const created = await identity.tokens.create({ expiresAt });
  return { identityId, token: created.token, tokenId: created.id, expiresAt };
}
```
Note: that `permissions.vm.get` returns 404 when no grant exists is an assumption (**UNVERIFIED**); the catch branch handles it, and any other status is rethrown so a wrong guess fails loudly rather than silently.

### terminal-proxy.ts (Approach A, tested locally with `bun test` against a mock)
```ts
// Approach A: our backend owns the PTY (API key never leaves the server) and relays bytes to the browser.
// Wire to browser: binary = terminal bytes both ways; text = JSON control.
//   server -> browser: {"type":"reset"} (before replayed scrollback), {"type":"exited","code":n}, {"type":"error","message":s}
//   browser -> server: {"type":"resize","cols":n,"rows":n}
import type { PtySession } from "freestyle";
import { freestyle } from "./vms.ts";

interface WsData {
  vmId: string;
  linuxUser: string;
  writable: boolean;
  session?: PtySession;
  closed?: boolean;
}

/** Your auth: resolve the caller from the cookie and check they may open this environment. */
type Authorize = (req: Request, envId: string) => Promise<{ vmId: string; linuxUser: string; writable: boolean } | null>;

const PTY_SLUG = "main"; // get-or-create: reconnects land on the same shell + scrollback
const SHELL = "env TERM=xterm-256color bash -l"; // PTY shells do not set TERM; claude/codex TUIs need it

export function startTerminalProxy(authorize: Authorize, port = 8787) {
  return Bun.serve<WsData>({
    port,
    async fetch(req, server) {
      const match = new URL(req.url).pathname.match(/^\/api\/environments\/([\w-]+)\/terminal$/);
      if (!match?.[1]) return new Response("not found", { status: 404 });
      // CSWSH guard: browsers send cookies on cross-site WS handshakes, so pin the Origin.
      if (req.headers.get("origin") !== process.env.APP_ORIGIN) return new Response("forbidden", { status: 403 });
      const grant = await authorize(req, match[1]);
      if (!grant) return new Response("forbidden", { status: 403 });
      if (server.upgrade(req, { data: grant })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      async open(ws) {
        const { vmId, linuxUser } = ws.data;
        const vm = freestyle().vms.ref(vmId);
        try {
          // A paused VM must be started first; pty.open does not wake it.
          const { state } = await vm.data();
          if (state !== "running") await vm.start();
          const session = await vm.linuxUser(linuxUser).pty.open({
            slug: PTY_SLUG,
            exec: SHELL, // only runs when the slug is new
            replaceOnExit: true, // `exit` respawns the shell instead of killing the terminal
            cols: 120,
            rows: 32,
            reconnect: true, // server<->Freestyle leg self-heals for up to 5 min
            connectTimeoutMs: 15_000,
            onReplayStart: () => ws.send(JSON.stringify({ type: "reset" })),
            onData: (bytes) => ws.send(bytes),
            onExit: (code) => ws.send(JSON.stringify({ type: "exited", code })),
            onClose: () => ws.close(1011, "pty closed"),
          });
          if (ws.data.closed) {
            session.detach(); // browser left while we were connecting
            return;
          }
          ws.data.session = session;
        } catch (error) {
          console.error("pty open failed", { vmId, error }); // log details server-side only
          ws.send(JSON.stringify({ type: "error", message: "Terminal unavailable. Retry in a moment." }));
          ws.close(1011, "pty open failed");
        }
      },
      message(ws, message) {
        const session = ws.data.session;
        if (!session || session.state !== "connected") return; // input is never buffered
        if (typeof message === "string") {
          try {
            const msg = JSON.parse(message) as { type?: string; cols?: unknown; rows?: unknown };
            if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
              const cols = Math.min(Math.max(msg.cols as number, 10), 500);
              const rows = Math.min(Math.max(msg.rows as number, 5), 200);
              session.resize({ cols, rows });
            }
          } catch {
            /* ignore malformed control frames */
          }
          return;
        }
        if (ws.data.writable) session.write(new Uint8Array(message)); // read-only viewers never type
      },
      close(ws) {
        ws.data.closed = true;
        ws.data.session?.detach(); // detach, never close(): the shell and its login survive
      },
    },
  });
}
```
WS upgrades are `GET`, so spec section 12's `POST /api/environments/:id/terminal` maps to Approach B (returns a token); Approach A needs a `GET` upgrade route (can be the same path).

### browser.ts
```ts
// Browser side. Frontend installs @xterm/xterm (+ @xterm/addon-fit); typed here against the SDK's
// structural XtermTerminal so this file typechecks without xterm installed.
import { Freestyle, connectXterm, type XtermTerminal } from "freestyle";

// ---------- Approach B (recommended for the owner's private terminal): identity token, SDK does the rest.
interface TerminalGrant {
  token: string; // short-lived identity access token, scoped to one VM + one Linux user
  vmId: string;
  linuxUser: string;
}

export async function openPrivateTerminal(terminal: XtermTerminal, envId: string): Promise<() => void> {
  let disposed = false;
  let current: { dispose(): void } | undefined;
  let failures = 0;

  const connect = async (): Promise<void> => {
    const res = await fetch(`/api/environments/${encodeURIComponent(envId)}/terminal`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`terminal grant failed: ${res.status}`);
    const grant = (await res.json()) as TerminalGrant;
    const pty = new Freestyle({ identityAccessToken: grant.token }).vms.ref(grant.vmId).linuxUser(grant.linuxUser).pty;
    current = await connectXterm({
      pty,
      terminal,
      slug: "main", // same named session as the proxy path, so both land on one shell
      exec: "env TERM=xterm-256color bash -l",
      replaceOnExit: true,
      onClose: () => {
        // Fires once the SDK's own 5-minute reconnect gives up, or on a fatal error such as an
        // expired token (expiry blocks reattach, not an open socket). Re-mint and retry.
        if (disposed) return;
        current?.dispose();
        const delay = Math.min(1000 * 2 ** failures++, 15_000);
        setTimeout(() => void connect().then(() => (failures = 0)).catch(console.error), delay);
      },
    });
  };

  await connect();
  return () => {
    disposed = true;
    current?.dispose(); // detaches; the shell keeps running in the VM
  };
}

// ---------- Approach A client: talk to our own proxy (terminal-proxy.ts). Needed for read-only inspect.
export function openProxiedTerminal(terminal: XtermTerminal, envId: string): () => void {
  const url = new URL(`/api/environments/${encodeURIComponent(envId)}/terminal`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const encoder = new TextEncoder();
  const sendResize = () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    }
  };
  ws.onopen = sendResize;
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      const msg = JSON.parse(event.data) as { type: string; message?: string };
      if (msg.type === "reset") terminal.write("\x1bc"); // clear before replayed scrollback
      if (msg.type === "error") terminal.write(`\r\n${msg.message ?? "Terminal error"}\r\n`);
      return;
    }
    terminal.write(new Uint8Array(event.data as ArrayBuffer));
  };
  const input = terminal.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  });
  const resize = terminal.onResize(sendResize);
  return () => {
    input.dispose();
    resize.dispose();
    ws.close();
  };
}
```
Frontend usage: `const term = new Terminal({ allowProposedApi: true }); term.open(el); const close = await openPrivateTerminal(term, envId);` (`allowProposedApi` per `DOC:vms/pty` "With xterm.js"). Add `@xterm/addon-fit` to track container size. `@xterm/xterm` is **not** installed in `backend/node_modules` (only `@xterm/headless`); the frontend must add it. Bundling note: the SDK's PTY module contains `await import("ws")`, only executed under Node/Bun; `ws` ships a `browser` entry, so a browser bundle should resolve it, but confirm with the real frontend build.

### demo.ts (end-to-end: create -> health -> terminal token -> pause -> resume)
```ts
// BILLABLE when run. Not executed during research; typechecked only.
import { freestyle, WORKER_FIREWALL, ensureEngineerVm, ensureLinuxUser, healthCheck, mintTerminalToken, pauseVm, resumeVm } from "./vms.ts";

/** One-time: bake tools into a snapshot BEFORE any login, and with no Relay daemon running. */
export async function buildGoldenSnapshot(relayVersion: string): Promise<string> {
  const fs = freestyle();
  const { vm } = await fs.vms.create({ snapshotId: "freestyle/ubuntu", firewall: WORKER_FIREWALL, slug: "golden-builder" });
  try {
    // git, claude, codex, node, bun already ship on freestyle/ubuntu. Root owns the shared Node tree.
    const install = await vm.linuxUser("root").exec({
      command: 'set -eu; npm install -g "agent-relay@$RELAY_VERSION"; command -v git claude codex agent-relay',
      env: { RELAY_VERSION: relayVersion },
      timeoutMs: 300_000,
    });
    if (install.statusCode !== 0) throw new Error(`install failed: ${install.stderr ?? ""}`);
    const { snapshotId } = await vm.snapshot({ slug: "workforce-base" });
    return snapshotId;
  } finally {
    await vm.delete();
  }
}

export async function demo(engineer: { shortId: string; linuxUser: string }, snapshotId: string) {
  const { vm, data } = await ensureEngineerVm({
    slug: `env-${engineer.shortId}`,
    snapshotId,
    metadata: { app: "workforce", engineer: engineer.shortId },
  });
  await ensureLinuxUser(vm, engineer.linuxUser);

  const health = await healthCheck(vm, engineer.linuxUser);
  if (!health.ok) throw new Error(`unhealthy: ${JSON.stringify(health.tools)}`);

  // Hand this to the browser (Approach B). Persist identityId against the app user.
  const grant = await mintTerminalToken({ identityId: null, vmId: data.id, linuxUser: engineer.linuxUser });
  console.log({ vmId: data.id, identityId: grant.identityId, expiresAt: grant.expiresAt });

  await pauseVm(vm);
  const afterResume = await resumeVm(vm, engineer.linuxUser);
  console.log("healthy after resume:", afterResume.ok);
}
```
After resume, also wait for the Relay node to reconnect before routing work (spec section 8); that check belongs to the Relay integration.

---

## 11. Spec corrections and risks

### Spec section 8, line by line
| Spec says | Verdict |
|---|---|
| "clean Freestyle Ubuntu base image (includes claude, codex and other coding agents)" | **Correct.** `freestyle/ubuntu` ships `claude`, `codex`, `opencode`, `openclaw` (`DOC:vms/base-snapshots`). Caveat: the slug floats to new builds, so pin by snapshotting our own image. |
| "Install Relay + Git tooling in a pre-login snapshot" | **Half right.** Git is already installed; only Relay (and `gh` if used) is needed. Snapshots include **memory**, so no Relay daemon may be running or enrolled at snapshot time. |
| "Terminals via Freestyle PTY; bridge its server-authenticated WebSocket through our backend terminal proxy or a scoped identity-token mechanism" | **Correct, both exist** (section 5). The identity path is browser-direct via WS subprotocol; two Freestyle guides that say browsers cannot connect are outdated. |
| "vm.exec ... (5-minute max timeout)" | **Incomplete.** Default is **30 s** (the real gotcha). Max is 5 min on older guest agents, up to 24 h with native exec (`SDK:dist/vms/types.d.ts:384`, `README`). exec never streams. Design for 5 min. |
| "Track VM running/paused independently" | Correct. Actual states: `starting/running/pausing/paused/stopped`; no webhooks, so poll. |
| "Pausing freezes memory and processes and makes the Relay node offline; on resume, wait for broker reconnect" | **Correct** (`DOC:vms/lifecycle`). Add: paused VMs bill storage only, files stay readable, `vm.fs` writes and PTY keystrokes wake it, and an idle-paused VM also wakes on inbound traffic. Still call `vm.start()` explicitly before reattaching. |
| "VM snapshots must not replicate authenticated profiles across engineers" | **Correct and stronger than it looks**: snapshots copy memory and disk, and the official Claude guide recommends snapshotting after login. Never snapshot an engineer VM for reuse. |

Other spec claims worth fixing:
- Section 1/2/3: "OAuth/session artifacts remain on VM disk under the correct Linux user" and "our app does not own provider secrets": achievable, but our API key is root on every VM (`vm.fs` is root, `exec` can be root). This is a policy boundary, not a technical one. Say so in the pitch if asked.
- Section 3 step 3: "provision a persistent Ubuntu VM": there is no size or persistence flag on create; size = snapshot, persistence = not setting `autoDeleteSeconds: 0`.
- Section 11 "Freestyle VM paused / detection: lifecycle state": there is no push channel; poll `vms.list({ metadata: "app:workforce" })` on an interval.
- Section 12 `POST /api/environments/:id/terminal`: fits the token approach. The proxy approach needs a `GET` WS upgrade.

### Top risks for a 5-hour build
1. **Credential cloning via snapshots.** Snapshot only the golden builder, never an engineer VM. Highest-impact mistake available.
2. **Exec 30 s default.** Any install/clone/test run via `exec` without `timeoutMs` dies at 30 s with `statusCode: null`. Long work goes to the PTY or Relay runtime.
3. **Codex login on a VM.** Default flow needs a localhost callback the browser cannot reach. Use `codex login --device-auth`.
4. **`TERM` unset in PTY.** Claude's TUI refuses to start. Always open the shell with `env TERM=xterm-256color bash -l`.
5. **Browser identity path not yet exercised against the real API** (CORS on the reconnect preflight, real token handshake). First real call decides; Approach A is the tested fallback.
6. **Idle auto-pause killing working agents.** Whether Relay's outbound socket counts as activity is unknown. Keep `idleTimeoutSeconds` unset; pause only from the backend.
7. **Plan retention caps.** Free may cap `autoDeleteSeconds` for unused VMs and snapshots (both types say "some plans cap"). Check `autoDeleteFromPlan` on the first VM and snapshot so demo VMs do not vanish between rehearsal and demo.
8. **Free plan ceilings**: 10 concurrent VMs, 10 saved VMs, 10 snapshots, max 4 vCPU / 8 GiB per VM. Fine for 2 VMs, but delete builder VMs and stale snapshots.
9. **`FREESTYLE_API_KEY` not set** in the current environment. Create one (`bunx freestyle login && bunx freestyle tokens create "workforce"`) and put it in `backend/.env` (Bun loads it).
10. **Public previews.** `style.dev` domains are open to anyone with the link; do not route anything sensitive without Forward Auth.
