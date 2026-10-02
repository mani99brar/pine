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
  rejection, unlink, webhook results, revocations reported by gateways); gateways never write `audit_log` directly but surface those
  events as distinguishable errors/results, metrics and redacted logs (accepted deviation from the "gateway audits" reading of
  SEC-GH-04/06/10).
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
