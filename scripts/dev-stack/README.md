# Local integration stack (development only)

One command boots the whole backend on this machine against a **local anvil fork of Gnosis Chain**, so the Next.js
frontend (`http://localhost:3004`) can be driven end to end by Playwright. Nothing is broadcast to a real network: the fork
only *reads* Gnosis state from a public archive RPC; every transaction exists only inside the local anvil. The only keys are
anvil's public dev accounts.

```sh
scripts/dev-stack/up.sh             # idempotent: keeps healthy parts, (re)starts the rest (~20 s cold, ~2 s warm)
scripts/dev-stack/up.sh --restart   # also restart the indexer and API (after backend code changes)
node scripts/dev-stack/smoke.mjs    # end-to-end smoke test without a browser (~1 min); --skip-funding to stop after listing
scripts/dev-stack/down.sh           # stop everything, remove the Postgres container (next up = fresh chain + database)
scripts/dev-stack/down.sh --purge   # also delete .state/ (generated dev secrets, logs)
```

Requires Docker (image `postgres:16-alpine`), Foundry (`anvil`, `forge`), Node 22+ (the repo targets 24; 22.14 works),
`jq`, `openssl`, `curl`, and `pnpm install --frozen-lockfile` at the repo root. The scripts call `node --import tsx`
directly, never `pnpm` (pnpm rewrites `pnpm-lock.yaml`).

## What runs

| Service | Address | Notes |
|---|---|---|
| Postgres 16 | `127.0.0.1:55432/pine` | container `pine-dev-pg`; roles from `deploy/postgres`, random dev passwords in `.state/secrets.env` |
| anvil | `http://127.0.0.1:8545` (also `http://localhost:8545`) | chain id 100, fork of block 48570000, 1 s blocks, `finalized` = head - 2, clock synced to wall time |
| Pine contracts | see `.state/deployment.json` | `contracts/script/Deploy.s.sol` broadcast by anvil account #0 |
| native indexer | health `http://127.0.0.1:9465/readyz` | `packages/indexer-native`, finalized blocks of the fork, polls every 1 s |
| API (dev server) | `http://127.0.0.1:3000` | `packages/api/scripts/dev-server.ts`: the real `run()` of `src/main.ts`, fake GitHub + fake IPFS |
| user content | `http://127.0.0.1:3001` | `GET /c/<sha256>` (attachment, sandbox CSP) |
| API metrics | `http://127.0.0.1:9464/metrics` | |
| dev control | `http://127.0.0.1:3999` | `GET /dev/health`, `GET /dev/github/repos`, `POST /dev/github/authorize` |

State lives in `scripts/dev-stack/.state/` (git-ignored): `logs/*.log`, `pids/`, `deployment.json`, `api.env`,
`indexer.env`, `secrets.env`, and **`frontend.env`** (the frontend's environment against this stack).

The API dev server refuses to start unless `PINE_ENVIRONMENT=development`, every origin, listener, database and RPC URL is
loopback and the RPC answers as anvil. Its injected `fetch` answers GitHub (`api.github.com`, the `github.com` token
endpoint) from `DevGitHub` (the e2e `FakeGitHub` plus PR lists, branches, compare and token refresh) and IPFS (Kubo,
pinning service, gateway on reserved `.invalid` hosts) from an in-memory fake; every other URL fails like a network error.

Dev settings that differ from production: draft policies allowed (every catalog version is a draft), no country header,
sanctions off, generous rate limits and quotas, `PINE_TRUST_PROXY_HOPS=0`.

## Accounts

anvil's public test mnemonic `test test test test test test test test test test test junk`, 100,000 xDAI each:
account #0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` deploys the contracts; account #1
`0x70997970C51812dc3A010C7d01b50e0d17dc79C8` is the smoke test's wallet (any of the ten works in the browser); account #9
`0xa0Ee7A142d267C1f36714E4a8F75612F20a79720` is the only admin (`PINE_ADMIN_WALLETS`, moderation routes).

Seeded GitHub data (`GET http://127.0.0.1:3999/dev/github/repos` lists every SHA): `pine-labs/keeper-bot` (id 812734551,
PR #12 with 2 commits, PR #15 with 1 commit, branches `main`, `feature/retry-budget`, `fix/gas-reserve-guard`) and
`pine-labs/fee-splitter` (PR #7). `GET /api/v1/github/repos` lists the repositories owned by the linked login, so link as
**`pine-labs` (GitHub user id 190455201, the default)** to see them; any linked login can open them by owner/name.
One GitHub user id links to one wallet at a time (`?github=error` otherwise): give each test wallet its own
`githubUserId` (the login can stay `pine-labs`), or unlink with `DELETE /api/v1/auth/github`. The smoke test uses id
190455299 and unlinks at the end; it leaves a listed claim and a funded market behind as demo data.

## Frontend integration

- Load `.state/frontend.env` (`NEXT_PUBLIC_PINE_DATA_SOURCE=api`, `PINE_API_INTERNAL_URL=http://127.0.0.1:3000`, the
  registry addresses and deployment block, `NEXT_PUBLIC_PINE_RPC_URL=http://127.0.0.1:8545`, `PINE_DEV_CONTROL_URL`).
- The web origin must be exactly `http://localhost:3004` (SIWE domain/URI and the CSRF Origin check derive from it). The
  proxy of `/api/v1/*`, `/api/openapi.json`, `/.well-known/pine.json`, `/healthz`, `/readyz` must forward `Origin`,
  `Cookie`, `Sec-Fetch-Site`, `x-pine-csrf` and `Content-Type` unchanged, return `Set-Cookie` unchanged, and must not
  follow redirects (the GitHub callback answers 303).
- Unsafe requests need `Origin: http://localhost:3004`, `x-pine-csrf: 1` and `content-type: application/json` when there is
  a body (no content type without a body, e.g. `POST /api/v1/auth/github/start`).
- Cookies are `__Host-pine_session` (Secure, HttpOnly, SameSite=Lax) and `__Host-pine_presession` (Secure, HttpOnly,
  SameSite=Strict). Chromium accepts Secure cookies on `http://localhost`; use the Chromium project in Playwright.
- SIWE: `POST /api/v1/auth/siwe/challenge {address}` returns the exact EIP-4361 `message` (domain `localhost:3004`, URI
  `http://localhost:3004`, chain id 100, statement `Sign in to Pine. I accept the terms with sha256 0x…`, 10 min expiry) and
  sets the pre-session cookie. Sign that string byte for byte (`personal_sign`, EOA only) and
  `POST /api/v1/auth/siwe/verify {message, signature}`. Limits: 20/min per IP per route, and challenge + verify share
  20/min per address (about 10 logins per minute per wallet).
- GitHub: `POST /api/v1/auth/github/start` returns `{authorizationUrl}` on `https://github.com/login/oauth/authorize`. In
  Playwright, intercept that navigation, ask the dev control server to "approve" it and redirect to the callback:

  ```ts
  await page.route("https://github.com/login/oauth/authorize**", async (route) => {
    const res = await fetch(`${process.env.PINE_DEV_CONTROL_URL}/dev/github/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationUrl: route.request().url(), githubUserId: 190455201, login: "pine-labs" }),
    });
    const { callbackUrl } = await res.json(); // http://localhost:3004/api/v1/auth/github/callback?code=…&state=…
    await route.fulfill({ status: 302, headers: { location: callbackUrl } });
  });
  ```

  The callback links the account, rotates the session cookie and answers `303` to
  `http://localhost:3004/settings?github=linked` (`?github=error` on any failure).
- Transactions: verify every plan with `planFromWire` + `verifyPlan`, send its steps from the signed-in wallet to
  `http://127.0.0.1:8545`, report hashes (`POST /api/v1/publications/:id/submitted {txHash}`,
  `POST /api/v1/funding/plans/:planId/submitted {stepId, txHash}`). A new claim shows up in `GET /api/v1/claims` once
  indexed, reconciled (job every 30 s) and integrity-verified (job every 60 s): typically 15-90 s.

## Reset and troubleshooting

- Fresh everything: `down.sh && up.sh`. Code changes in `packages/api` or `packages/indexer-native`: `up.sh --restart`.
- A port in use by something else makes `up.sh` stop with the port number; logs are in `.state/logs/`.
- Fork source: `PINE_DEV_FORK_URL="https://…"` (an archive RPC; default `rpc.gnosischain.com`, then
  `rpc.gnosis.gateway.fm`) and `PINE_DEV_FORK_BLOCK=<number>`; anvil caches fork state under `~/.foundry/cache/rpc`.
- `/readyz` 503 with `readModel: stale`: the indexer is behind or the chain clock is behind the wall clock; `up.sh` moves
  the chain clock forward when it lags more than 30 s.
