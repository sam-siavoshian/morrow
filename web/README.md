# web

Next.js 16 app (App Router, cacheComponents). Design system in `src/components/ui`, data layer in `src/lib`.

See the root `README.md` to run the full stack. Read `AGENTS.md` before changing routes: Next 16 has breaking changes.

```bash
bun run dev
bun test
BACKEND_URL=... NEXT_PUBLIC_REALTIME_URL=... bun run build   # both required (baked in at build time)
```
