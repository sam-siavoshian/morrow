# Deploying Morrow

```
browser ──https──> trymorrow.dev (Vercel, web/)
   │                   └── /api/* rewrite ──https──┐
   └──────── wss (realtime, direct) ───────────────┤
                                                   v
                         Tailscale Funnel  https://<mini>.<tailnet>.ts.net
                                                   │
                                     Mac mini  127.0.0.1:8787  (backend/, launchd)
                                                   │
                     Terse Cloud (actors/)   Agent Relay (hosted)   Freestyle VMs
```

- **Web** runs on Vercel at `trymorrow.dev`. The browser only ever talks to `trymorrow.dev` for HTTP, so the
  session cookie stays first-party. `/api/*` is rewritten to the backend by `web/next.config.ts`.
- **Backend** runs on the Mac mini under launchd, bound to `127.0.0.1`. Tailscale Funnel is its only public
  ingress. Realtime WebSockets connect to the Funnel host directly (Vercel rewrites do not carry them).
- **Durable state** lives in Terse Cloud. The backend holds no state of its own, so a restart resumes from Terse.

A custom `api.trymorrow.dev` is not possible with Funnel (it only serves `*.ts.net` names). It would need
Cloudflare Tunnel with the domain's DNS on Cloudflare, or port forwarding on the mini's router. Nothing in
the app depends on the backend hostname beyond `BACKEND_URL` and `NEXT_PUBLIC_REALTIME_URL`, so switching later
is a config change.

Do the steps in order. Every secret below goes into `deploy/mac-mini/backend.env` on your laptop (gitignored),
never into the repo.

## 1. Terse Cloud (actors)

```bash
cd actors
bunx terse-cli install      # browser login
bunx terse-cli attach       # creates terse.config.json for this project
bunx terse-cli deploy       # prints TERSE_ACTOR_URL=https://api.useterse.ai/v1/projects/<id>/actors
```

Create an API key at app.useterse.ai, under API keys. Put both into `backend.env`:

```
TERSE_ACTOR_URL=https://api.useterse.ai/v1/projects/<id>/actors
TERSE_API_KEY=<key>
```

Redeploy actors whenever `actors/src` changes. Deploy actors before the backend when both change: the backend
calls actor methods by name, so it must never run against an older actor build.

## 2. GitHub OAuth app

github.com > Settings > Developer settings > OAuth Apps > New OAuth App.

- Homepage URL: `https://trymorrow.dev`
- Authorization callback URL: `https://trymorrow.dev/api/auth/github/callback`

Copy the client id and a new client secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

## 3. Freestyle

Put the API key in `FREESTYLE_API_KEY`, then build the golden VM snapshot once (and again after any change in
`backend/vm/`):

```bash
cd backend && FREESTYLE_API_KEY=... bun vm/build-golden.ts
```

Agents cannot start until the snapshot exists.

Each member also gets one warm snapshot per team (their VM right after the repos were cloned, so the next
environment skips the clone). They count against the plan's snapshot limit: 10 on Free, which fits about
nine members; use Hobby or above for more. A golden image rebuild makes the old warm snapshots unused, and
Freestyle deletes them after 7 days.

## 4. Mac mini prerequisites (once)

On the mini:

1. Tailscale app installed, signed in to your tailnet, and set to start at login.
2. Funnel allowed for the mini in the tailnet policy (admin console > Access controls, `nodeAttrs` with
   `"attr": ["funnel"]`), and HTTPS certificates enabled (admin console > DNS).
3. The `root1` user logs in automatically after a reboot (System Settings > Users & Groups > Automatically log
   in as). The backend is a per-user LaunchAgent, so it starts when that user's session does. Without
   auto-login a power cut leaves the backend down until someone logs in.

Check headroom before the first deploy: `ssh root1@100.83.86.5 'memory_pressure | tail -1; df -h ~'`. The
backend needs well under 1 GB; other long jobs on the mini share the 16 GB.

## 5. Backend on the mini

```bash
cp deploy/mac-mini/backend.env.example deploy/mac-mini/backend.env   # fill it in
openssl rand -base64 32    # SESSION_SECRET
openssl rand -base64 32    # DATA_ENCRYPTION_KEY (different value)
deploy/mac-mini/deploy.sh
```

`deploy.sh` ships the code over Tailscale, installs Bun and production dependencies, installs the launchd agent
(restart on crash, hourly log rotation) and waits for `/readyz`. Run it again for every backend release. Keep
`DATA_ENCRYPTION_KEY` backed up somewhere safe (a password manager): losing it makes every stored token
unreadable.

Then expose it, on the mini:

```bash
tailscale funnel --bg 8787
tailscale funnel status     # shows https://<mini>.<tailnet>.ts.net
```

Set `REALTIME_URL=wss://<mini>.<tailnet>.ts.net` in `backend.env` and run `deploy.sh` again.

Check from anywhere: `curl -fsS https://<mini>.<tailnet>.ts.net/readyz`.

`deploy/mac-mini/deploy.sh --status` shows the service state, the funnel and the last log lines. Logs live in
`~/morrow/logs/backend.log` on the mini.

## 6. Web on Vercel

The Vercel project `morrow` is linked at the repo root with Root Directory `web`. Set, for Production:

```bash
vercel env add BACKEND_URL production               # https://<mini>.<tailnet>.ts.net
vercel env add NEXT_PUBLIC_REALTIME_URL production  # wss://<mini>.<tailnet>.ts.net
vercel deploy --prod
```

Both are read at build time (the CSP's `connect-src` takes the realtime origin), so redeploy after changing
either. Point the domain: `trymorrow.dev` is attached to the project; add `www.trymorrow.dev` as a redirect to
the apex in the Vercel dashboard if you want it.

## 7. Client IP check (before opening sign-ups)

Pre-auth rate limits (sign-in, invite preview) key on the caller's IP, read from `X-Forwarded-For`. Each proxy
in front of the backend appends one entry, and `TRUSTED_PROXY_HOPS` says how many to trust. The two paths in:

- HTTP via Vercel: Vercel edge, then the Funnel proxy, then the backend.
- WebSocket and direct hits on the Funnel host: the Funnel proxy, then the backend.

Find the real chain once the stack is up: set `LOG_LEVEL=debug` in `backend.env`, run `deploy.sh`, load
`https://trymorrow.dev`, then `grep http.client ~/morrow/logs/backend.log` on the mini. Each line shows
`forwardedFor`, `peer` and the `clientIp` the current setting picks. Pick the hop count that lands on your own
public IP (`curl -s https://ifconfig.me`) for the Vercel path (expected: 2), then set `LOG_LEVEL=info` again
and redeploy. Confirm a second visitor on another network gets
a different value. A count that is too low makes every visitor share Vercel's address and one rate-limit
bucket; too high lets a caller pick their own bucket by sending a fake header.

Known limit: the Funnel host is public, so a caller who skips Vercel can prepend a fake `X-Forwarded-For` entry
and spread pre-auth requests across buckets. Signed-in traffic is limited per user and is not affected. Invite
and OAuth tokens are random enough that this does not make guessing them practical.

## Rollback

- Web: `vercel rollback` (or promote an older deployment in the dashboard).
- Backend: re-run `deploy.sh` from the previous checkout. The backend is stateless.
- Actors: `terse deploy` from the previous checkout. The older build then reads state the newer one wrote, so
  add new state fields as optional and never repurpose an existing one.

## Rotating secrets

- `SESSION_SECRET`: rotating signs everyone out.
- `DATA_ENCRYPTION_KEY`: do not rotate in place; stored tokens are encrypted with it.
- `TERSE_API_KEY`, `FREESTYLE_API_KEY`, `GITHUB_CLIENT_SECRET`: create the new one, update `backend.env`,
  run `deploy.sh`, then revoke the old one.
