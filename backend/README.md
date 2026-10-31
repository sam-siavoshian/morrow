# backend

Bun + Hono API, realtime hub, team runtime (Relay workspaces, VM lifecycle, profiles, terminals) and orchestration.

See the root `README.md` to run it and `docs/architecture.md` for how it works. Env vars are in `.env.example`.

```bash
bun run dev        # watch mode on :8787
bun test           # RELAY_E2E=1 adds the real Relay engine suites
bun run typecheck
```
