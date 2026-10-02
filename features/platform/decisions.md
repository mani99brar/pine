# Decisions: platform

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) and the security requirements on 2026-10-02.

## Decisions

- SIWE is EOA-only with server-issued byte-identical messages, `crypto.randomBytes(16)` nonces bound to a pre-session and local signature recovery: smart-contract wallets cannot log in (deferred), and the auth path makes no RPC call.
- Sessions: opaque `pine_s1_` tokens stored as SHA-256 in a `__Host-pine_session` cookie (Secure, HttpOnly, SameSite=Lax, Path=/), idle 24 h, absolute 7 days, rotated on login and GitHub link; admin = configured wallet allowlist re-checked per request plus a signature younger than 300 s.
- CSRF for every unsafe method: exact Origin, `Sec-Fetch-Site` not cross-site, header `x-pine-csrf: 1`, JSON content type (multipart only on flagged routes); the GitHub webhook is the only exempt route.
- GitHub: GitHub App with zero permissions by default, OAuth App with no scopes as configured fallback; PKCE S256; one GitHub id per user; tokens AES-256-GCM encrypted with key rotation; core reads identities only through `GitHubAuthFlow.identityOf`.
- Content: Postgres `bytea` is the source of truth for objects ≤ 262144 bytes; pins go through an outbox to Kubo and a Pinning Service API provider; user content is served only by the separate content server on a different registrable domain.
- Chain gateway: two RPC providers; `finalizedBlock()` requires both to agree on the hash at the finalized number.
- Runtime uses `node --import tsx` (pinned); migrations run only via `src/migrate.ts` with a separate migrator URL; the API verifies migrations at startup and refuses to start otherwise.

- Jobs: cross-process exclusion through lease rows in a core table (NOT NULL `expires_at`; atomic acquire only when expired;
  renewal; release sets `expires_at = started_at + interval`; database time only), provable on PGlite with two holder ids. This
  replaces the advisory-lock wording in the frozen JobDefinition comment while keeping its guarantee.
- Audit ownership: core audits every gateway-backed security event at its call sites (GitHub link start/success/failure incl. scope
  rejection, unlink, webhook accepted/rejected, revocations); gateways never write `audit_log` directly (accepted deviation from the
  "gateway audits" reading of SEC-GH-04/06/10). The revocation channel is the frozen code `GITHUB_NOT_LINKED`: gateways map GitHub
  401, token decrypt/AAD failure and a rejected refresh to it after deleting the token and marking the link revoked (never
  `UPSTREAM`), plus `metrics.increment("github_link_revoked", { reason })`; core wraps `gateways.github` in an auditing decorator
  as `ctx.github` that reads `identityOf(userId)` before forwarding and records `github.link.revoked` (actor = the userId argument)
  only when that identity was non-null and the call rejected with `GITHUB_NOT_LINKED` (never-linked users get no audit row). Webhook-driven revocations are
  not attributed to a Pine user in the audit log because `handleWebhook` returns `void` (accepted; metric and log carry them).
- SEC-GH-03 deviation (accepted): an OAuth callback with a missing, expired, reused or foreign-session state links nothing, is
  audited as `github.link.failed` and redirects 303 to `/settings?github=error` instead of answering 403.
- Sanctions (v1): `PINE_SANCTIONS_MODE` = `off` | `static`; production requires `static` with `PINE_SANCTIONS_DENYLIST_PATH` (JSON
  array of lowercase `0x` addresses, read at startup, invalid file = startup error). A hosted provider is a launch gate.
- Lease timing: the runner takes the TTL floor (default 60 s) and the renewal period (default ttl/3) as constructor options so the
  lease tests run in real time with sub-second values; tests never update `job_leases` directly.
- Grants: platform `0002_` grants DML on platform tables by name, only `SELECT` on `schema_migrations`, and default privileges for
  later tables; gateways and later migration groups never mention `pine_api`.
- PGlite was verified on 2026-10-02 to enforce the planned roles: `CREATE ROLE` in a `DO` block, grants by table name, default
  privileges for later tables, `SET ROLE pine_api` (UPDATE/DELETE on `audit_log` and UPDATE on `schema_migrations` fail with
  42501, the SECURITY DEFINER retention function works) and `now()` advancing between autocommit statements.
- `@fastify/cors` is not registered; public routes get `Access-Control-Allow-Origin: *` from an `onSend` hook keyed on the matched
  route's config; OPTIONS is not routed.
- Per-IP flood guard default 600/min (`PINE_IP_FLOOD_LIMIT_PER_MINUTE`, NAT-tolerant); per-user limit default 120/min.
- Rate limiting: `@fastify/rate-limit` is only the in-memory per-IP flood guard, installed as the FIRST instance-level `onRequest`
  hook via `app.rateLimit()` (verified: limited requests never reach later hooks; 404s are covered; no route sets
  `config.rateLimit`). Per-user, per-route and per-address limits are Postgres fixed windows keyed `user:<id>`,
  `user:<id>:<route>`, `ip:<ip>:<route>` (anonymous, only on routes with `rateLimitPerMinute`) and `siwe:<address>`. SEC-AUTH-08:
  SIWE challenge and verify are 20/min per IP and 20/min per address.
- Leases: TTL independent of the job interval (default 60 s), renewal ttl/3, acquisition polled every min(interval, 15 s).
- `audit_log.created_at` uses database `now()` like leases and IP retention.
- The webhook route parses JSON and form bodies as raw Buffers (64 KiB) so the HMAC covers the exact bytes.
- Webhook: bad/missing signature → gateway throws `ApiError("UNAUTHENTICATED")` → 401 + `github.webhook.rejected`; other errors →
  500 + `github.webhook.failed`.
- platform-004 review fixes (carried by platform-005): branch membership resolves a real branch of this repository first and
  compares against its head SHA (SEC-GH-11; SHA-shaped names, `refs/` and tags refused); unlink revokes the grant, not only the
  token; lease runs abort on a local deadline timer (`sentAt + ttl − renewalPeriod`, reset by each successful renewal) or a
  zero-row renewal, with a pg `connectionTimeoutMillis` below the renewal period; jobs check `signal` between batches and are not
  re-acquired before an aborted run settles; rejected webhooks are audited only on the first rejection per IP (/64 for IPv6) per
  minute and at most 60 per minute overall, via the Postgres fixed-window statement; `/readyz` is cached for 5 s; a renamed branch
  (301) is NOT_A_MEMBER; a stale revoked webhook after a quick re-link deleting the new tokens is accepted (fail-safe).
- platform-005 review fixes (platform-006): await the in-flight renewal before release; moderation change and audit in one
  transaction; pin outbox per-target completion; tolerant timing tests; and the tests PRD-02 section 3a lists. Every lane's
  completion includes a coverage matrix: each required test of PRD-02 section 4/3a and each decision → the test file and test name
  that would fail if the behaviour were removed.
- Metrics use a dedicated prom-client `Registry`. Migrations always run as the migrator role (default privileges depend on it).
- Metrics adapter: lazy, cached by name, label names fixed at first use, mismatching samples dropped with one warning.
- Gateways I/O injection: `createGateways(deps)` wraps an exported `buildGateways(deps, io)` (`fetch` + two viem transports);
  it checks `eth_chainId` on both RPC transports.
- SIWE test signing helpers live only in `*.test.ts` or `src/platform/core/testing/` (exempt from the forbidden-pattern gate);
  production code never imports from a `testing/` directory.
- PGlite serialises queries, so race-freedom of quota/nonce/rate-limit/refresh statements is guaranteed by their single-statement or
  `FOR UPDATE` shape, not by tests (accepted).
- Clock: `ctx.clock.now()` as a bound parameter everywhere except job leases and IP retention (database `now()`).
- Per-IP flood guard is in-memory per process (`@fastify/rate-limit` default store); per-user limits and quotas are in Postgres.
- Roles and grants live in platform migrations (`pine_api` created idempotently as NOLOGIN, default privileges for later tables,
  INSERT/SELECT-only on `audit_log`, a hardened SECURITY DEFINER IP-retention function), proven with `SET ROLE pine_api` on PGlite.
- Inside transactions, helpers use the transaction handle only (PGlite serialises queries; nested `ctx.db` calls deadlock).
- Per-IP rate limiting happens before any session lookup; core registers `@fastify/multipart` (one file, size limit from config) and
  maps `GitHubGatewayError` to ApiError codes in its error handler.
- Concurrency-sensitive writes are single atomic SQL statements (quota consume, nonce consume, rate-limit increment).
- The user-content server has no in-app per-IP rate limit; the edge proxy/CDN provides it (documented in the README).
- Accepted deviations from docs/security/requirements.md (reviewers: these are decisions, not defects): admin sessions share the
  normal idle/absolute expiry but every destructive admin action needs a wallet signature younger than 300 s (STEP_UP_REQUIRED is
  401 as in the frozen contract); SIWE nonces are bound to the pre-session cookie, not to an IP hash; secrets are plain strings
  registered with the redactor and kept out of AppConfig instead of a `Secret` wrapper type; per-IP limits come from the rate limiter
  and `QuotaGateway` stays per-user; sessions rotate on login and GitHub link and are deleted on logout and unlink.

## Assumptions

- The API is served same-origin with the web app under `/api` in production (`apiOrigin === publicOrigin`).
- A trusted reverse proxy provides the client IP and the geofence country header only when `trustProxy` hops are configured; otherwise both are ignored (and production compliance for publish/fund fails closed when the country is required).
- Rate-limit and quota windows are fixed windows in Postgres; precision of a few seconds is acceptable.

## Deferred

- The read-model wiring in `src/readmodel.ts`, the full composition end-to-end test and deployment manifests (feature `assembly`).
- Email notifications, smart-contract-wallet login, a hosted sanctions-screening provider (v1 uses a static denylist; provider choice is a launch gate).
