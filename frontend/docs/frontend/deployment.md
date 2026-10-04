# Deploying the Pine frontends

Pine Prism (`apps/prism`) is a Next.js 16 deployable inside the self-contained `frontend/` pnpm workspace. It uses the workspace packages in `packages/*`, which are compiled from TypeScript source through `transpilePackages`, so there is no separate package build step.

## 1. Choose a data source

| Mode | Set | What works | What you must run |
|---|---|---|---|
| `api` (production) | `NEXT_PUBLIC_PINE_DATA_SOURCE=api` plus the deployment below | Everything, against the Pine backend: SIWE sign-in, GitHub linking, claims, drafts, previews, publication, evidence, oracle and funding plans verified in the browser | The backend of this repository (`../packages/api`, the native indexer, PostgreSQL) behind one edge proxy: see `../deploy/README.md` |
| `mock` (default) | nothing | Everything, with fixtures, a simulated wallet and demo sign-in | Nothing. Use it for previews, design review and demos |
| `rest` / `envio` | `NEXT_PUBLIC_PINE_DATA_SOURCE=rest\|envio` | Read-only adapters for the frontend's own earlier contracts (`docs/indexer/`) | A service implementing those contracts (the Pine backend does not) |

### `api` mode

The browser talks to the backend on the page's own origin (`/api/v1`): the session is the backend's HttpOnly
`__Host-pine_session` cookie, and every unsafe request carries the backend's CSRF contract (`x-pine-csrf: 1`, exact
`Origin`, JSON bodies). In production the edge proxy routes `/api/*`, `/healthz`, `/readyz` and
`/.well-known/pine.json` to `pine-api` and everything else to this app; locally, `PINE_API_INTERNAL_URL` makes Next.js
proxy those paths itself.

- **Identity.** A wallet signs in with Sign-In with Ethereum. The server issues the EIP-4361 message and the browser
  checks its domain, URI, address, chain, terms statement and expiry before the wallet signs it. Signing accepts the
  terms digest in the statement. GitHub is linked afterwards through the backend (PKCE, state bound to the session);
  the callback lands on `/settings`. next-auth stays mounted but signed out and silent.
- **Transactions.** The backend proposes every transaction as a plan. The browser decodes each plan with its own
  vendored copy of `@pine/shared` (`packages/core/src/pine-shared`, kept identical by `scripts/sync-shared.mjs --check`)
  and verifies it against the deployment pinned in this build (`NEXT_PUBLIC_PINE_*`) and against markets read from
  ClaimRegistry on the user's RPC, within the user's limits, before any wallet prompt. Step labels come from the decoded
  calldata. A publication's preview is verified too: the claim document digest is recomputed, the question re-rendered
  and the `createClaim` arguments compared with the document.
- **The app's own `/api/*` handlers** (Auth.js, GitHub proxy, IPFS upload, account store, agent API) are demo-mode
  features: in `api` mode they answer 404, and in production the proxy never routes `/api/*` to this app. Agents use the
  backend's `/api/v1/agents/claims`, `/.well-known/pine.json` and `/api/openapi.json`.

## 2. Environment for production (`api` mode)

`NEXT_PUBLIC_*` values are compiled into the browser bundle: set them before `next build`.

```bash
NEXT_PUBLIC_PINE_DATA_SOURCE=api
NEXT_PUBLIC_SITE_URL=https://app.pine.example        # = PINE_PUBLIC_ORIGIN of the API
NEXT_PUBLIC_CHAIN_ID=100
NEXT_PUBLIC_PINE_CLAIM_REGISTRY=0x...                # = PINE_CLAIM_REGISTRY (forge deployment record)
NEXT_PUBLIC_PINE_EVIDENCE_REGISTRY=0x...             # = PINE_EVIDENCE_REGISTRY
NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK=...                # = PINE_DEPLOYMENT_BLOCK
NEXT_PUBLIC_RPC_URL_100=                             # optional public Gnosis RPC for wallet reads (no API keys: it is public)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=                # optional; injected wallets work without it
PINE_API_INTERNAL_URL=http://127.0.0.1:3000          # runtime, server only: public reads for page metadata
```

`AUTH_*`, `PINE_IPFS_UPLOAD_*` and `NEXT_PUBLIC_PINE_API_URL` are not used in `api` mode. The reference deployment
(systemd unit, env template, nginx and Caddy examples) is in `../deploy/` (`pine-web.service`, `env/web.env`).

### Local development against the backend

```bash
scripts/dev-stack/up.sh            # repository root: Postgres, anvil fork of Gnosis with Pine deployed, pine-api, indexer
set -a && . scripts/dev-stack/.state/frontend.env && set +a
cd frontend/apps/prism && corepack pnpm exec next dev -p 3004 -H 127.0.0.1    # http://localhost:3004
# production build instead: corepack pnpm build && corepack pnpm exec next start -p 3004 -H 127.0.0.1
```

Bind Prism to loopback (`-H 127.0.0.1`): otherwise Next.js listens on every interface and Prism, with its dev proxy to the
local API (`PINE_DEV_PROXY=1`), is reachable from the LAN. `frontend.env` already sets `NEXT_PUBLIC_RPC_URL_100` to the
fork. See `scripts/dev-stack/README.md` ("Start Prism against the stack", "Your own wallet on the fork").

## 3. Vercel

Create one Vercel project per app, all pointing at the same repository:

| Setting | Value |
|---|---|
| Root Directory | `frontend/apps/prism` |
| Framework | Next.js |
| Install Command | `pnpm install --frozen-lockfile` (run in `frontend/`, the frontend workspace root) |
| Build Command | `pnpm build` |
| "Include files outside root directory" | enabled (needed for `packages/*`) |

## 4. Docker (self-hosting)

Set `output: 'standalone'` in the app's `next.config.ts` (enable it with `NEXT_OUTPUT=standalone` if the app reads it), then:

```dockerfile
# docker build -f Dockerfile -t pine-prism frontend   # build context = frontend/
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP=prism
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pine/app-${APP} build

FROM node:22-alpine AS run
ARG APP=prism
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /repo/apps/${APP}/.next/standalone ./
COPY --from=build /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=build /repo/apps/${APP}/public ./apps/${APP}/public
ENV APP_DIR=apps/${APP}
CMD node $APP_DIR/server.js
```

## 5. Pre-launch checklist

- [ ] Chain addresses in `packages/core/src/chains.ts` re-verified against Seer, Reality.eth and Kleros deployments, with `verified: true` set (SPEC §10.3).
- [ ] Policy texts pinned to IPFS, and the `uri` values in `packages/core/src/policies.ts` updated. Hashes stay unchanged.
- [ ] Evidence mechanism and commit-reveal design approved (SPEC §10.5).
- [ ] Oracle answering, monitoring and escalation funding assigned (SPEC §10.7).
- [ ] Legal and regulatory review completed (SPEC §8).
- [ ] `NEXT_PUBLIC_PINE_DATA_SOURCE=api` and `NEXT_PUBLIC_PINE_DEMO_WALLET` unset or `0`. The demo banner disappears automatically.
- [ ] `NEXT_PUBLIC_PINE_CLAIM_REGISTRY`, `NEXT_PUBLIC_PINE_EVIDENCE_REGISTRY` and `NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK` equal the API's deployment (a mismatch makes every plan fail verification), and `node scripts/sync-shared.mjs --check` passes for the release.
- [ ] `AUTH_URL` (or `NEXTAUTH_URL`) set to the public origin. Without it, wallet linking (SIWE domain) and Auth.js trust `X-Forwarded-Host`. In that case run behind a proxy that overwrites the header.
- [ ] `AUTH_SECRET` set. Production mock mode without it uses a public development secret, so sessions can be forged. Mock mode is for previews only.
- [ ] Demo sign-in is disabled automatically in production `rest` mode without GitHub OAuth. Configure `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` before launch.
- [ ] Security headers reviewed. Add a CSP that allows your RPC, WalletConnect, IPFS gateway and GitHub avatar hosts.
- [ ] Observability: route-handler logs, client error reporting (wire into each app's `error.tsx`), and uptime checks on `/api/agent/v1/claims` and `/llms.txt`.
- [ ] Abuse controls: rate-limit `/api/ipfs`, `/api/github/*` and `/api/account/*` at the edge.

`docs/frontend/launch-gates.md` tracks every open launch gate.
