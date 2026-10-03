# Deploying the Pine frontends

All three apps (`apps/console`, `apps/docket`, `apps/field`) are independent Next.js 16 deployables. They share the workspace packages in `packages/*`, which are compiled from TypeScript source through `transpilePackages`, so there is no separate package build step.

## 1. Choose a data source

| Mode | Set | What works | What you must run |
|---|---|---|---|
| `mock` (default) | nothing | Everything, with fixtures, a simulated wallet and demo sign-in | Nothing. Use it for previews, design review and demos |
| `rest` | `NEXT_PUBLIC_PINE_DATA_SOURCE=rest`, `NEXT_PUBLIC_PINE_API_URL` | Indexed reads plus server-side drafts and accounts | A service implementing `docs/indexer/rest-api.openapi.yaml` |
| `envio` | `NEXT_PUBLIC_PINE_DATA_SOURCE=envio`, `NEXT_PUBLIC_ENVIO_GRAPHQL_URL` | Indexed on-chain reads; manifests hydrated from IPFS. Drafts and preferences stay in the browser | An Envio HyperIndex deployment per `docs/indexer/envio/` |

See `docs/indexer/README.md` for the trade-offs between the two.

## 2. Required environment for live operation

```bash
NEXT_PUBLIC_PINE_DATA_SOURCE=rest            # or envio
NEXT_PUBLIC_PINE_API_URL=https://api.example.org
NEXT_PUBLIC_ENVIO_GRAPHQL_URL=https://indexer.example.org/v1/graphql
NEXT_PUBLIC_SITE_URL=https://console.example.org   # absolute URLs in agent data, feeds, OG tags
NEXT_PUBLIC_CHAIN_ID=100
NEXT_PUBLIC_IPFS_GATEWAY=https://cdn.kleros.link
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...           # optional; injected wallets work without it
NEXT_PUBLIC_PINE_DEMO_WALLET=0
PINE_IPFS_UPLOAD_URL=...                           # server-side pinning endpoint used by /api/ipfs
PINE_IPFS_UPLOAD_TOKEN=...
AUTH_SECRET=$(openssl rand -base64 32)             # required outside mock mode
AUTH_URL=https://console.example.org              # REQUIRED in production: SIWE domain + Origin checks use it instead of forwarded headers
AUTH_GITHUB_ID=...                                 # GitHub OAuth app
AUTH_GITHUB_SECRET=...
```

**GitHub OAuth app:** set the callback URL to `https://<host>/api/auth/callback/github`. The requested scope is `read:user` only. Public repositories need no repository scope (SPEC §2).

## 3. Vercel

Create one Vercel project per app, all pointing at the same repository:

| Setting | Value |
|---|---|
| Root Directory | `apps/console` (or `apps/docket`, `apps/field`) |
| Framework | Next.js |
| Install Command | `pnpm install --frozen-lockfile` (Vercel runs it at the workspace root) |
| Build Command | `pnpm build` |
| "Include files outside root directory" | enabled (needed for `packages/*`) |

## 4. Docker (self-hosting)

Set `output: 'standalone'` in the app's `next.config.ts` (enable it with `NEXT_OUTPUT=standalone` if the app reads it), then:

```dockerfile
# docker build --build-arg APP=console -t pine-console .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pine/app-${APP} build

FROM node:22-alpine AS run
ARG APP
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
- [ ] `NEXT_PUBLIC_PINE_DEMO_WALLET=0` and the data source is not `mock`. The demo banner disappears automatically.
- [ ] `AUTH_URL` (or `NEXTAUTH_URL`) set to the public origin. Without it, wallet linking (SIWE domain) and Auth.js trust `X-Forwarded-Host`. In that case run behind a proxy that overwrites the header.
- [ ] `AUTH_SECRET` set. Production mock mode without it uses a public development secret, so sessions can be forged. Mock mode is for previews only.
- [ ] Demo sign-in is disabled automatically in production `rest` mode without GitHub OAuth. Configure `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` before launch.
- [ ] Security headers reviewed. Add a CSP that allows your RPC, WalletConnect, IPFS gateway and GitHub avatar hosts.
- [ ] Observability: route-handler logs, client error reporting (wire into each app's `error.tsx`), and uptime checks on `/api/agent/v1/claims` and `/llms.txt`.
- [ ] Abuse controls: rate-limit `/api/ipfs`, `/api/github/*` and `/api/account/*` at the edge.

`docs/frontend/launch-gates.md` tracks every open launch gate.
