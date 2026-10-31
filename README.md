# Morrow

A cloud coding platform for teams. Everyone signs their own Claude Code, Codex or opencode subscription into a persistent cloud VM. Morrow pools them. Give it a task and a planner splits the work, leases the right CLIs across the team, and runs them side by side. Every agent talks to every other agent through Agent Relay, so none of them works blind. When one hits its usage limit, another one picks up from a checkpoint.

## How it fits together

| Piece | What it does | Where |
|---|---|---|
| Web | Next.js 16 app: sidebar inbox, composer, mission control, workforce, onboarding | `web/` |
| Backend | Bun + Hono API, realtime hub, orchestration (planner, dispatcher, monitor, handoff, verifier) | `backend/` |
| Actors | Terse durable actors: `User`, `Team`, `TeamWorkforce` (the lease authority and task state machine) | `actors/` |
| Contracts | Zod schemas and types shared by web and backend | `packages/contracts/` |
| VMs | Freestyle VMs, one per engineer environment, each running an Agent Relay node | `backend/vm/` |

The build contract is `docs/architecture.md`. Product intent is in `docs/spec.md`. Research behind each integration is in `docs/research/`.

## Run it locally (no vendor keys needed)

```bash
bun install
bun run dev:stack
```

If Terse exits with `failed to parse nameserver address` (some phone hotspots put a scoped IPv6 DNS server in `/etc/resolv.conf`), prefix the command with `DURABLE_ACTORS_TEST_DOCKER=1` to run Terse in Docker instead.

This starts:
- Terse in a temp folder.
- A fake GitHub sign-in with users `ada`, `linus` and `grace`.
- The backend on :8787.
- The web app on :3000.

It creates no teams, repos, VMs or tasks. Sign in and set everything up through the app.

The fake GitHub sign-in is temporary and local only. It exists so the team can sign in for QA until a real GitHub OAuth app is configured; once it is, set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (see below) and this stand-in goes away. Without a Freestyle key, environments show their honest disabled state, and Relay is off in this stack.

## Run it for real

Copy `backend/.env.example` to `backend/.env` and fill it in. Boot fails with a clear list of anything missing.

| Key | Needed for |
|---|---|
| `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` | Sessions and encrypting secrets at rest (32 bytes, base64) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in, repo access, verification. Create a GitHub OAuth app with callback `<APP_ORIGIN>/api/auth/github/callback` |
| `DURABLE_ACTORS_CONTROL_PLANE_URL`, `DURABLE_ACTORS_SECRET` | Terse. Run `bun run --cwd actors dev` with the same secret (hex) |
| `FREESTYLE_API_KEY` | Cloud VMs and terminals. Without it, environments show an honest disabled state |
| `RELAY_BASE_URL` | Defaults to hosted Agent Relay. `disabled` turns it off |

The VM image needs building once, after the Freestyle key is set:

```bash
bun backend/vm/build-golden.ts
```

Then:

```bash
bun run --cwd actors dev      # Terse on 127.0.0.1:7100
bun run dev:backend           # API + realtime on :8787
bun run dev:web               # web on :3000
```

## Checks

```bash
bun run typecheck
bun run test                  # actors (real Terse), backend, web
(cd backend && RELAY_E2E=1 bun test test/relay test/runtime)   # real Relay engine + brokers
DURABLE_ACTORS_TEST_DOCKER=1 bun run test   # run local Terse in Docker when the native runtime will not boot
cd web && BACKEND_URL=http://127.0.0.1:8787 NEXT_PUBLIC_REALTIME_URL=ws://127.0.0.1:8787 bun run build   # both required in production builds
```

## What is verified and what isn't

Verified locally:
- Actors against a real Terse dev server.
- Backend against real Terse, a Freestyle mock and a real self-hosted Relay engine.
- VM scripts in an Ubuntu container.
- The web app in a browser against the dev stack.

Not yet run against real Freestyle, hosted Relay, real GitHub or real Claude Code / Codex output. Those need keys. Known limits are listed in `docs/architecture.md` section 13.
