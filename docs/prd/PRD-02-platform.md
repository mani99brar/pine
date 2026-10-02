# PRD-02: API platform (feature `platform`)

Implements ADR-0001 D9–D11, D14–D15 and the SEC-AUTH, SEC-GH, SEC-EVID (storage/serving), SEC-OPS and SEC-LEGAL hooks of
`docs/security/requirements.md`. Frozen contracts: `packages/api/src/contracts/{app,config,errors,redact,migrations,platform,testing}.ts`,
`packages/api/src/modules.ts`, `packages/api/migrations/platform/0001_core.sql`, everything in `packages/shared/src`.
Stack (dependencies frozen in `packages/api/package.json`): Fastify 5, `fastify-type-provider-zod` + zod 4, `@fastify/cookie`,
`@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/swagger`, drizzle-orm + `pg` (PGlite in tests), viem, prom-client.

## 1. Lanes and ownership

| Lane | Owns (path prefixes) |
|---|---|
| `platform-core` | `packages/api/src/platform/core`, `packages/api/src/main.ts`, `packages/api/src/migrate.ts`, `packages/api/migrations/platform` (new files 0002+ only), `packages/api/README.md`, `packages/api/.env.example` |
| `platform-gateways` | `packages/api/src/platform/gateways` (replaces the stub `index.ts`), `packages/api/migrations/gateways` |

Rules: the lanes meet only through `contracts/platform.ts` (`GatewayFactory`, `Gateways`, `GitHubAuthFlow`, `ContentServer`,
`PlatformSecrets`). Core never queries gateway tables; gateways never register HTTP routes on the main app (they return the
`ContentServer` and `jobs`). Each lane's tests use fakes of the other side (write them in the lane's own test files). `src/main.ts`
imports `createGateways` from `./platform/gateways/index.js` and `createReadModel` from `./readmodel.js` (a stub owned by a later
`assembly` lane) and must typecheck against the stubs.

## 2. platform-core

### 2.1 Configuration and secrets (fail closed, SEC-OPS-01)
- `loadConfig(env)` → `{ config: AppConfig, secrets: PlatformSecrets, server: ServerSettings }`, all validated with zod; any missing
  or invalid value is a startup error naming the variable (never its value). Document every variable in `.env.example`
  (prefix `PINE_`), including the admin wallet allowlist, terms digest, trusted-proxy hop count, compliance settings, ports.
- Production refinements: https origins; `apiOrigin === publicOrigin`; `userContentOrigin` has a different registrable domain
  (compare the last two DNS labels at least; reject subdomains of publicOrigin); `chainId === 100`; `allowDraftPolicies === false`;
  `enabledPolicyFamilies` excludes `SC-001`; the two RPC URLs differ; token-encryption keys are 32 bytes (base64) with unique ids;
  compliance country header configured; sanctions mode not `off`.
- Every secret string is registered with `createRedactor` at startup.

### 2.2 HTTP application (`buildApp`)
- `buildApp({ ctx, gateways, modules, settings })` returns a Fastify instance with: `requestIdHeader: false` and UUID request ids,
  `trustProxy` set to the configured hop count (default off), body limit 64 KiB for JSON, zod validator/serializer compilers,
  `@fastify/swagger` with the zod transform serving `/api/openapi.json`.
- Logging: pino JSON; `redact` paths for authorization, cookie, set-cookie, `x-pine-csrf`; a request serializer that logs method,
  route pattern and path **without query string**; every logged error passes through `safeErrorMessage(error, ctx.redact)`.
- Security headers (helmet): API responses `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy: no-referrer`, HSTS in production, `Cache-Control: no-store` on authenticated responses.
- CORS: none for credentialed routes. Routes with `config.pine.public` get `Access-Control-Allow-Origin: *`, no credentials,
  GET/HEAD only; the platform does not read cookies for them.
- CSRF (SEC-AUTH-14) on POST/PUT/PATCH/DELETE: exact `Origin` match with `publicOrigin` (reject missing Origin), reject
  `Sec-Fetch-Site: cross-site`, require `x-pine-csrf: 1`, require `content-type: application/json` unless the route sets
  `config.pine.multipart` (then `multipart/form-data`). Failures are `CSRF_REJECTED`. Exempt only the GitHub webhook route.
- Authentication hook: for non-public routes, read `__Host-pine_session`, look up `sha256(token)`, enforce idle (24 h) and absolute
  (7 d) expiry, compute `isAdmin` from the configured allowlist on every request, fill GitHub identity via
  `gateways.githubAuth.identityOf`, set `request.session`; touch the idle expiry at most once per 5 minutes.
- `app.requireSession`, `app.requireAdmin` (admin + session authenticated within 300 s, else `STEP_UP_REQUIRED`).
- Error handler: `toErrorResponse(error, request.id, ctx.redact)`, `Retry-After` when present; 5xx logged with the redacted message.
- Rate limiting: `@fastify/rate-limit` with a Postgres-backed store (fixed window table), key = user id or client IP; default
  120/min; `config.pine.rateLimitPerMinute` overrides per route.
- Registers every module from `src/modules.ts` inside its own plugin scope, passing `ctx`.

### 2.3 Wallet authentication (SEC-AUTH-01..13)
- `POST /api/v1/auth/siwe/challenge {address}` → sets `__Host-pine_presession` (random, 10 min), stores a nonce
  (`crypto.randomBytes(16)` hex; at most 5 outstanding per pre-session; single use) and returns the exact EIP-4361 message:
  domain = host of `publicOrigin`, uri = `publicOrigin`, version `1`, chain id 100, nonce, issuedAt now, expirationTime now+10 min,
  statement `Sign in to Pine. I accept the terms with sha256 <termsDigest>.` Never use viem `generateSiweNonce`.
- `POST /api/v1/auth/siwe/verify {message, signature}`: the message must equal the stored text byte for byte (lookup by nonce
  with an atomic delete), belong to the same pre-session and be unexpired; recover the signer locally with
  `recoverMessageAddress` and compare with the challenged address (no RPC; contract wallets cannot log in). Then upsert the user
  (`users.wallet_address` lowercase), create a session token `pine_s1_` + base64url(32 random bytes) stored as SHA-256, set
  `__Host-pine_session` (Secure, HttpOnly, SameSite=Lax, Path=/), delete the pre-session, record the terms acceptance (user, terms
  digest, message, signature, time) and an audit entry. Every failure returns `UNAUTHENTICATED` with a generic message and an audit
  entry; no detail about which check failed reaches the client.
- `POST /api/v1/auth/logout`, `GET /api/v1/auth/session` (wallet, GitHub login, admin flag, terms status, expiries).
- GitHub linking routes (session required): `POST /api/v1/auth/github/start` → `{authorizationUrl}`;
  `GET /api/v1/auth/github/callback?code&state` → `githubAuth.complete`, rotate the session, redirect (303) to
  `publicOrigin + /settings?github=linked` (or `?github=error`); `DELETE /api/v1/auth/github`. The callback is a top-level GET
  protected by the single-use state bound to the session.
- `POST /api/v1/webhooks/github` (no session, CSRF-exempt, raw body ≤ 64 KiB) → `githubAuth.handleWebhook`.

### 2.4 Platform services in AppContext
- `quotas` (Postgres fixed windows per user and quota name; limits from config; atomic consume; `QUOTA_EXCEEDED` with Retry-After).
- `audit` (INSERT-only table; `redactDeep` on details; 8 KiB cap; IP stored, documented 30-day truncation job).
- `moderation`: table of `(subject, id) -> {action hide|block, reason, actor, at}`; admin routes
  `GET/POST/DELETE /api/v1/admin/moderation` (requireAdmin, audit every change). Moderation never edits documents or chain data.
- `compliance.assertAllowed(request, session, action)`: blocked wallet list (static denylist file or env), geofence from the
  configured trusted header (only honoured when trustProxy is configured) per action, fail-closed in production when the country is
  unknown for `publish_claim` and `fund_market`, and terms acceptance of the current digest (`TERMS_REQUIRED`).
- `metrics` via prom-client on an internal listener (`/metrics`, bound to the configured internal port, not the public app).
- `clock` (system clock), `redact`, `db` (drizzle over `pg` Pool, statement timeout 15 s).

### 2.5 Jobs runner
Runs `[...gateways.jobs, ...modules.flatMap(m => m.jobs ?? [])]`: one loop per job, never overlapping itself; each execution runs
inside a transaction on a dedicated connection holding `pg_try_advisory_xact_lock(hashtext(job name))` (skip when not acquired);
`AbortSignal` on shutdown; errors logged redacted, counted, retried next interval.

### 2.6 Processes
- `src/main.ts`: load config → redactor → logger → pg pool → `verifyMigrations` (refuse to start on any problem) → gateways →
  read model (`createReadModel`) → assert chain id → AppContext → `buildApp` → listen; start the content server
  (`gateways.createContentServer().listen` on the user-content host/port), the metrics listener and the jobs runner; graceful
  SIGTERM/SIGINT shutdown (stop accepting, abort jobs, close servers, gateways, read model and pool, exit 0).
- `src/migrate.ts`: `runMigrations` with `PINE_MIGRATOR_DATABASE_URL` (DDL role), prints applied ids, exits non-zero on error.
- `/healthz` (process alive) and `/readyz` (DB reachable, migrations verified, read model not halted and its indexed block timestamp
  within `maxIndexerLagSeconds` of the clock) on the main app (public, no cookies).
- `README.md`: architecture, environment variables, Postgres roles and grants (migrator, api with INSERT-only audit, indexer,
  readonly), process list, TLS, backups, key rotation, launch gates from ADR-0001.

## 3. platform-gateways

### 3.1 GitHub (SEC-GH-01..15)
- `GitHubAuthFlow` (contracts/platform.ts) for `kind: "app"` (expiring user tokens + refresh) and `kind: "oauth"` (no scopes;
  verify `X-OAuth-Scopes` is empty, otherwise revoke and fail). PKCE S256; state = 128-bit random, stored hashed with the session
  id and code verifier, single use, 10 minutes. Token endpoint `https://github.com/login/oauth/access_token`, identity
  `GET https://api.github.com/user` (numeric id + login). One GitHub id maps to one Pine user (`CONFLICT` otherwise).
- Tokens encrypted with AES-256-GCM: random 96-bit IV, AAD = `pine:github:<userId>:<tokenKind>:<keyId>`, key from
  `secrets.tokenEncryptionKeys` (decrypt with any listed key, re-encrypt with `current` on refresh). Refresh is single-flight per
  user (row lock) and rotates the refresh token. `handleWebhook` verifies `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare)
  and deletes the user's tokens for `github_app_authorization` revocations.
- `GitHubGateway`: `fetch` only to `https://api.github.com` (injectable for tests), `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version`, 10 s timeout, `redirect: "error"`, zod-validated responses, size cap 2 MiB. Public repositories only:
  refuse `private !== false` or `visibility !== "public"` with `REPO_NOT_PUBLIC`. Map 404→NOT_FOUND, 403/429 with rate-limit headers →
  RATE_LIMITED, others → UPSTREAM (messages redacted). `listPublicRepos` uses `GET /users/{login}/repos?type=owner&sort=pushed`
  (login from the stored identity); `getRepoById` uses `GET /repositories/{id}`; `listPullCommits` pages up to 250;
  `verifyCommitMembership`: `pull_head` iff `GET /repos/{o}/{r}/pulls/{n}` head sha equals the commit; `pull_commit` iff listed in
  the PR commits; `branch_ancestor` iff `GET /repos/{o}/{r}/compare/{sha}...{branch}` has status `ahead` or `identical` and
  `behind_by == 0`; otherwise `NOT_A_MEMBER`.

### 3.2 Content store and user-content server (SEC-EVID-01..11)
- Table `content_blobs(sha256 text pk, size int, cid text, declared_media_type text, bytes bytea, created_at)`; `put` checks
  `bytes.length <= min(maxBytes, 262144)`, computes digest and raw CID with `@pine/shared/canonical` (`identify`), inserts
  idempotently and enqueues a pin job. `get`/`has` consult `moderation` and never return `block`ed content.
- `retrieve(sha256, maxBytes)`: local first, then each configured gateway `GET {gateway}/ipfs/{cid}?format=raw` with
  `Accept: application/vnd.ipld.raw`, `redirect: "error"`, 10 s timeout, streamed size cap, digest verification; a verified copy is
  stored locally. No other URL is ever fetched.
- Pin outbox job: `block/put?cid-codec=raw&mhtype=sha2-256` + `pin/add` on the Kubo RPC API (when configured), then
  Pinning Service API `POST /pins {cid}` (when configured); the CID returned must equal the local one, otherwise the item is marked
  `integrity_failed` and alerted. Retries with backoff; idempotent.
- `createContentServer()`: separate Fastify instance (no cookie plugin): `GET /c/:sha256` → 451 when blocked, 404 when absent,
  else the bytes with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<sha256>.bin"`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: public, max-age=31536000, immutable`,
  `Cross-Origin-Resource-Policy: cross-origin`; per-IP rate limit; nothing else is served.

### 3.3 Chain gateway
viem public clients for both RPC URLs (http transport, 10 s timeout, limited retries); `assertChainId` at startup on both;
`finalizedBlock()` reads the `finalized` tag from the primary and requires the secondary's hash at that number to match
(mismatch → throw an integrity error); every error message redacted (RPC URLs embed keys).

## 4. Required tests (each lane, vitest on PGlite; name the SEC id in negative tests)
- core: config refusal cases per production rule; CSRF (missing/wrong Origin, cross-site fetch metadata, missing header, wrong
  content type, multipart only where allowed); SIWE (replayed nonce, nonce from another pre-session, expired, altered message
  byte, wrong chain id/domain/uri, signature by another key, contract wallet impossible); session expiry (idle/absolute), rotation
  on link, logout; admin step-up; public routes ignore cookies and get CORS *; quotas atomic under concurrency; rate limit;
  audit redaction; moderation routes; compliance (451, TERMS_REQUIRED); jobs never overlap and respect the advisory lock;
  error responses never contain secrets (inject a secret-bearing error); `/readyz` stale/halted handling; log lines contain no query
  strings or cookies.
- gateways: OAuth state single-use/expiry/session binding; PKCE parameters; token AAD binding (ciphertext swapped between users
  fails); key rotation decrypt; refresh single-flight; webhook HMAC (bad signature rejected); `X-OAuth-Scopes` non-empty rejected;
  private/internal repos refused; membership methods incl. a fork-network commit that exists but is not a member; rate-limit
  mapping; GitHub response validation failures; content put/get/idempotency/size cap/blocked; retrieve digest mismatch and redirect
  refusal and size cap; pin outbox CID mismatch; content server headers, 451, 404, no Set-Cookie; chain finalized-hash mismatch.

## 5. Checks (controller-run)
Both lanes: `pnpm --filter @pine/api typecheck` (typecheck), `pnpm exec eslint packages/api/src` (typecheck kind),
`node scripts/check-forbidden.mjs` (unit), and the lane's tests:
`pnpm --filter @pine/api exec vitest run src/platform/core` (core) or `.../src/platform/gateways` (gateways) (unit).

## 6. Out of scope
Route modules (claims, markets, funding), indexers, read-model wiring (`src/readmodel.ts`), frontend, email.
