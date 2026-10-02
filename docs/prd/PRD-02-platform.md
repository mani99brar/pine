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
  compliance country header configured; sanctions mode `static`.
- Sanctions screening (v1): `PINE_SANCTIONS_MODE` is `off` or `static` (default `off` outside production; production refuses
  anything but `static`). `static` requires `PINE_SANCTIONS_DENYLIST_PATH`: a UTF-8 JSON file holding an array of `0x` + 40
  lowercase-hex addresses (≤ 100000 entries, duplicates allowed); it is read once at startup and any unreadable or invalid file is
  a startup error naming the variable. Changing the list requires a restart (documented in the README).
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
  GET/HEAD only; the platform does not read cookies for them. `@fastify/cors` is NOT registered (a preflight would match Fastify's
  wildcard OPTIONS route, whose config is not the target route's): an `onSend` hook adds the header from the matched route's own
  `config.pine.public`; public routes are simple GET/HEAD requests that need no preflight and OPTIONS is not routed (test that an
  OPTIONS request never yields `Access-Control-Allow-Credentials` and credentialed routes never carry CORS headers).
- CSRF (SEC-AUTH-14) on POST/PUT/PATCH/DELETE: exact `Origin` match with `publicOrigin` (reject missing Origin), reject
  `Sec-Fetch-Site: cross-site`, require `x-pine-csrf: 1`, require `content-type: application/json` unless the route sets
  `config.pine.multipart` (then `multipart/form-data`). Failures are `CSRF_REJECTED`. Exempt only the GitHub webhook route.
- Authentication hook: for non-public routes, read `__Host-pine_session`, look up `sha256(token)`, enforce idle (24 h) and absolute
  (7 d) expiry, compute `isAdmin` from the configured allowlist on every request, fill GitHub identity via
  `gateways.githubAuth.identityOf`, set `request.session`; touch the idle expiry at most once per 5 minutes.
- `app.requireSession`, `app.requireAdmin` (admin + session authenticated within 300 s, else `STEP_UP_REQUIRED`).
- Error handler: `toErrorResponse(error, request.id, ctx.redact)`, `Retry-After` when present; 5xx logged with the redacted message.
- Rate limiting in two stages: a per-IP flood guard in `onRequest` BEFORE any session lookup using `@fastify/rate-limit`'s
  in-memory store (no database write for anonymous traffic; N processes allow N× the limit, acceptable for a flood guard; fleet-wide
  per-IP limits belong to the edge proxy) with its own NAT-tolerant default of 600 requests/min per IP
  (`PINE_IP_FLOOD_LIMIT_PER_MINUTE`), then the per-user limit after authentication in Postgres fixed windows; default
  120/min; `config.pine.rateLimitPerMinute` overrides per route. A cookie that matches no session skips `identityOf`. Test that an
  authenticated request is keyed by user id.
- Multipart: core registers `@fastify/multipart` once with `limits: { fileSize: config.evidence.maxUploadBytes, files: 1, fields: 10,
  parts: 11 }`; only routes with `config.pine.multipart` accept that content type (CSRF rules), everything else is JSON-only.
- Errors: the core error handler maps `GitHubGatewayError` codes to ApiError codes before `toErrorResponse` (GITHUB_NOT_LINKED →
  FORBIDDEN, REPO_NOT_PUBLIC and NOT_A_MEMBER → UNPROCESSABLE, NOT_FOUND → NOT_FOUND, RATE_LIMITED → RATE_LIMITED, UPSTREAM →
  UPSTREAM_UNAVAILABLE) so routine GitHub failures never surface as 500.
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
  protected by the single-use state bound to the session. Every callback failure (state missing/expired/reused/bound to another
  session, token exchange or identity failure, scope rejection, identity conflict) links nothing, records an audit entry
  `github.link.failed` with a reason code, and redirects 303 to `?github=error` (accepted deviation from SEC-GH-03's "403": a
  top-level navigation must land on the web app; the security property — nothing is linked — is what the test asserts).
- `POST /api/v1/webhooks/github` (no session, CSRF-exempt, raw body ≤ 64 KiB) → `githubAuth.handleWebhook`; core audits
  `github.webhook.accepted` (details: `X-GitHub-Event`, `X-GitHub-Delivery`) when it resolves and `github.webhook.rejected` when it
  throws (204 / 401 respectively). The frozen seam returns `void`, so a webhook-driven revocation is not attributed to a Pine user
  in the audit log; the gateways' metric and redacted log line carry it (accepted).

### 2.4 Platform services in AppContext
- `quotas` (Postgres fixed windows per user and quota name; limits from config; atomic consume; `QUOTA_EXCEEDED` with Retry-After).
- `audit` (INSERT-only table; `redactDeep` on details; 8 KiB cap; IP stored, 30-day truncation through the retention function).
  Core records audit entries at its own call sites for every gateway-backed security event: GitHub link start, link success and
  failure (including scope rejection and identity conflicts), unlink, webhook results, and token revocations reported by gateways.
  The revocation channel is the frozen error code: the gateway throws `GitHubGatewayError("GITHUB_NOT_LINKED")` after it has
  deleted an unusable token (GitHub 401, decrypt/AAD failure, refresh rejected). Core builds `ctx.github` as an auditing decorator
  around `gateways.github`: before forwarding a call it reads `gateways.githubAuth.identityOf(userId)`; when that identity was
  non-null and the call then rejects with `GITHUB_NOT_LINKED`, the decorator records `github.link.revoked` (actor = the `userId`
  argument, details: method name) before rethrowing, so modules that catch the error themselves cannot hide it. A user who never
  linked GitHub (identity null before the call) gets the same error and NO audit row: the claims routes call `ctx.github` routinely
  for such users and map the error to "connect GitHub". Test both cases with fakes.
- `moderation`: table of `(subject, id) -> {action hide|block, reason, actor, at}`; admin routes
  `GET/POST/DELETE /api/v1/admin/moderation` (requireAdmin, audit every change). Moderation never edits documents or chain data.
- `compliance.assertAllowed(request, session, action)`: blocked wallet list (static denylist file or env), geofence from the
  configured trusted header (only honoured when trustProxy is configured) per action, fail-closed in production when the country is
  unknown for `publish_claim` and `fund_market`, and terms acceptance of the current digest (`TERMS_REQUIRED`).
- `metrics` via prom-client on an internal listener (`/metrics`, bound to the configured internal port, not the public app). The
  adapter creates counters and histograms lazily, caches them by name (never registers a name twice), fixes a metric's label names
  at its first use, and drops (with one redacted warning per name) a later sample whose label keys differ instead of throwing.
- `clock` (system clock), `redact`, `db` (drizzle over `pg` Pool, statement timeout 15 s).

### 2.5 Jobs runner
Runs `[...gateways.jobs, ...modules.flatMap(m => m.jobs ?? [])]`: one loop per job, never overlapping itself; `AbortSignal` on
shutdown; errors logged redacted, counted, retried next interval. Cross-process exclusion uses **lease rows** (this keeps the
JobDefinition guarantee "at most one execution of a job at a time across all API processes" without holding a connection):
table `job_leases(name text pk, holder text not null, started_at timestamptz not null, expires_at timestamptz NOT NULL)`.
- Acquire (one statement, database time only): `INSERT INTO job_leases (name, holder, started_at, expires_at) VALUES ($1, $2, now(),
  now() + $ttl) ON CONFLICT (name) DO UPDATE SET holder = $2, started_at = now(), expires_at = now() + $ttl WHERE
  job_leases.expires_at <= now() RETURNING holder` — acquired iff a row is returned (holder = random per-process id).
- Renew every ttl/3 while running: `UPDATE ... SET expires_at = now() + $ttl WHERE name = $1 AND holder = $2` (abort the job when
  zero rows are updated). TTL = max(60 s, 2 × the job's interval).
- Release on finish: `UPDATE ... SET expires_at = started_at + $interval WHERE name = $1 AND holder = $2`, so no process (including
  this one) starts the job again before one interval has passed since this run started; `expires_at` is never NULL.
- The TTL floor (default 60 s) and the renewal period (default ttl/3) are constructor options of the runner so tests run in real
  time with short values: tests use a floor of 0, an interval of at least 1 s (ttl = 2 × interval) and a renewal period of at
  least 250 ms, so every "before the interval" assertion has a window of ≥ 1 s under CPU contention; all lease tests live in one
  file; tests never write `job_leases` directly.
- Required tests on PGlite with two holder ids: B cannot acquire while A holds; A releases; B cannot acquire before the interval;
  B acquires after it; an expired (crashed) holder is taken over; a holder that lost its lease aborts.

### 2.5a Concurrency-safe statements and housekeeping
- Inside a transaction every helper uses the transaction handle (`tx`), never `ctx.db`: PGlite serialises all queries through one
  mutex, so a nested `ctx.db` query inside an open transaction deadlocks the tests (and would break atomicity in production).
- Every concurrency-sensitive operation is ONE atomic SQL statement: quota consume (`INSERT ... ON CONFLICT DO UPDATE ... WHERE
  used + $n <= limit RETURNING`), nonce consume (`DELETE ... RETURNING`), per-user rate-limit increment, session lookup/touch; the
  GitHub token refresh takes `SELECT ... FOR UPDATE` inside its transaction. PGlite serialises all queries, so tests cannot prove
  these races: the statement shapes are the control and are reviewed (accepted in decisions.md).
- Clock rule: every timestamp written or compared for sessions, nonces, pre-sessions, OAuth states, quotas, rate limits, previews
  and plans uses `ctx.clock.now()` passed as a bound parameter; only job leases and the IP-retention function use database `now()`.
- Keys: tables use uuid or `GENERATED ALWAYS AS IDENTITY` keys; migrations also grant `USAGE, SELECT` on existing sequences and set
  `ALTER DEFAULT PRIVILEGES ... GRANT USAGE, SELECT ON SEQUENCES TO pine_api`.
- Cleanup job (core): purge expired nonces, pre-sessions, sessions, OAuth states (via gateways only through its own job) and
  rate-limit windows older than one hour; bounded batches.
- Roles and grants are owned by platform migrations so tests and production behave the same: `0002_` (or later) creates the role
  `pine_api` idempotently (`DO $$ ... IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pine_api') THEN CREATE ROLE pine_api
  NOLOGIN ...`; in production the DBA pre-creates it with LOGIN and the migration is a no-op for creation), grants USAGE on the schema
  and DML on the platform tables by name (never `ON ALL TABLES`), only `SELECT` on `schema_migrations` (so `verifyMigrations` works
  but the ledger cannot be altered), `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
  pine_api` (so later groups' tables are covered), and `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM pine_api` (INSERT and
  SELECT only). Test under `SET ROLE pine_api`: `verifyMigrations` succeeds and `UPDATE schema_migrations` fails. Gateways (and every
  later group's) migrations never mention `pine_api`: the default privileges cover them, and the role does not exist in a lane that
  lacks platform `0002_`.
- Audit IP retention: a `SECURITY DEFINER` function (`SET search_path = public, pg_temp`, `REVOKE EXECUTE ... FROM PUBLIC`,
  `GRANT EXECUTE ... TO pine_api`) that only nulls `ip` on rows older than 30 days; the cleanup job calls it. Tests use
  `SET ROLE pine_api` on PGlite to prove UPDATE/DELETE on `audit_log` fail with a permission error and the function still works
  (SEC-OPS-07/10).
- Session rotation copies `authenticatedAt` (the time of the last wallet signature) from the old session: linking GitHub never
  refreshes the admin step-up window (test it).
- CSRF details: the checks run in `onRequest` (before body parsing) so failures are always `CSRF_REJECTED`; the content type is
  compared as a parsed media type (`application/json; charset=utf-8` is JSON); requests without a body (no content-length or 0, no
  transfer-encoding) need no content type; the custom header and Origin rules always apply.
- `termsDigest` and all digests in config are `0x`-prefixed lowercase 32-byte hex (the redactor keeps 0x-prefixed hashes).
- Production config requires an explicit `PINE_TRUST_PROXY_HOPS` (0 is refused when a compliance country header is configured,
  because behind the same-origin proxy every request would share the proxy's IP and every publish/fund would fail closed) and Seer/AMM addresses equal to `GNOSIS_EXTERNAL`
  (refuse to start otherwise); the deployment manifest is always `buildDeploymentManifest(config.contracts)`.

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
- Token lifecycle duties (SEC-GH-07/10): a gateways job re-encrypts stored tokens under the `current` key and reports how many
  remain under retired keys; `unlink` first revokes the token at GitHub (`DELETE /applications/{client_id}/token` with client
  credentials) and then deletes it; any GitHub 401 for a user token, a token that fails to decrypt (wrong AAD, unknown key id,
  tampered ciphertext) and a rejected refresh all delete the stored token, mark the link revoked (so `identityOf` returns null) and
  throw `GitHubGatewayError("GITHUB_NOT_LINKED")` — never `UPSTREAM`. They also increment `pine_github_link_revoked_total{reason}`
  and log a redacted line; core audits them through its decorator (section 2.4). The metric is emitted as
  `metrics.increment("github_link_revoked", { reason })` (exposed as `pine_github_link_revoked_total`), `reason` one of
  `unauthorized`, `decrypt_failed`, `refresh_rejected`, `webhook`.
- `GitHubGateway`: `fetch` only to `https://api.github.com` (injectable for tests), `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version`, 10 s timeout, `redirect: "error"`, zod-validated responses, size cap 2 MiB. Public repositories only:
  refuse `private !== false` or `visibility !== "public"` with `REPO_NOT_PUBLIC`. Map 404→NOT_FOUND, 403/429 with rate-limit headers →
  RATE_LIMITED, 401 → GITHUB_NOT_LINKED (after the revocation above), others → UPSTREAM (messages redacted). `listPublicRepos` first refreshes the login with `GET /user` using the user's
  token (logins are renamed and re-registered, SEC-GH-05; the stored login is never a lookup key), then uses
  `GET /users/{login}/repos?type=owner&sort=pushed`; `getRepoById` uses `GET /repositories/{id}`; `listPullCommits` pages up to 250;
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
- `createContentServer()`: separate Fastify instance (no cookie plugin, `trustProxy` off, **no in-app per-IP rate limit**: abuse
  limiting for the user-content host is done by the edge proxy/CDN, documented in the README, because the frozen seam carries no
  proxy settings and a socket-keyed limit behind a proxy would be a global throttle): `GET /c/:sha256` → 451 when blocked, 404 when absent,
  else the bytes with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename="<sha256>.bin"`,
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: public, max-age=31536000, immutable`,
  `Cross-Origin-Resource-Policy: cross-origin`; nothing else is served.

### 3.3 Chain gateway
viem public clients for both RPC URLs (http transport, 10 s timeout, limited retries); `assertChainId` at startup on both.
The frozen `GatewayDependencies` has no I/O injection, so `createGateways(deps)` is a thin wrapper over an exported internal
`buildGateways(deps, io)` where `io` supplies `fetch` (GitHub, IPFS gateways, Kubo, pinning service) and the two viem
transports; tests call `buildGateways` with fakes, and `buildGateways` checks `eth_chainId` on BOTH transports (throwing on a
mismatch) before returning;
`finalizedBlock()` reads the `finalized` tag from the primary and requires the secondary's hash at that number to match
(mismatch → throw an integrity error); every error message redacted (RPC URLs embed keys).

## 4. Required tests (each lane, vitest on PGlite; name the SEC id in negative tests)
- core: config refusal cases per production rule; CSRF (missing/wrong Origin, cross-site fetch metadata, missing header, wrong
  content type, charset parameter accepted, multipart only where allowed); SIWE (replayed nonce, nonce from another pre-session,
  expired, altered message byte, wrong chain id/domain/uri, signature by another key, contract wallet impossible); session expiry
  (idle/absolute), rotation on link keeps authenticatedAt, logout; admin step-up; public routes ignore cookies and get CORS *; quotas;
  rate limit keys; audit redaction and `SET ROLE pine_api` (INSERT works, UPDATE/DELETE fail); moderation routes; compliance (451,
  TERMS_REQUIRED); jobs never overlap and the lease tests of section 2.5;
  error responses never contain secrets (inject a secret-bearing error); `/readyz` stale/halted handling; log lines contain no query
  strings or cookies; the auditing GitHub decorator; webhook accepted/rejected audits; callback failures redirect to `?github=error`
  with nothing linked (SEC-GH-03); sanctions config (production refuses `off`, invalid denylist file refused).
- SIWE tests sign with viem test accounts only inside `*.test.ts` files or `src/platform/core/testing/` (the forbidden-pattern gate
  exempts exactly those); production code never imports from a `testing/` directory.
- gateways: OAuth state single-use/expiry/session binding; PKCE parameters; token AAD binding (ciphertext swapped between users
  fails); key rotation decrypt; refresh single-flight; webhook HMAC (bad signature rejected); `X-OAuth-Scopes` non-empty rejected;
  private/internal repos refused; membership methods incl. a fork-network commit that exists but is not a member; rate-limit
  mapping; 401 and decrypt failure → token deleted, link revoked, `GITHUB_NOT_LINKED`; GitHub response validation failures; content put/get/idempotency/size cap/blocked; retrieve digest mismatch and redirect
  refusal and size cap; pin outbox CID mismatch; content server headers, 451, 404, no Set-Cookie; chain finalized-hash mismatch.

## 5. Checks (controller-run)
Both lanes: `pnpm --filter @pine/api typecheck` (typecheck), `pnpm exec eslint packages/api/src` (typecheck kind),
`node scripts/check-forbidden.mjs` (unit), and the lane's tests:
`pnpm --filter @pine/api exec vitest run src/platform/core` (core) or `.../src/platform/gateways` (gateways) (unit).

## 6. Out of scope
Route modules (claims, markets, funding), indexers, read-model wiring (`src/readmodel.ts`), frontend, email.
