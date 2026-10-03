# @pine/api

Fastify HTTP API and background jobs for Pine (GitHub claim verification markets). Specification: `docs/prd/PRD-02-platform.md`;
decisions: `docs/adr/ADR-0001-architecture.md` and `features/platform/decisions.md`; security requirements: `docs/security/requirements.md`.

## Architecture

```
            edge proxy / CDN (TLS, per-IP limits for user content, country header)
              |                                   |
   https://app.example (same origin)      https://pine-usercontent.net
              |                                   |
   +----------v-----------+            +----------v-----------+
   | API (src/main.ts)     |            | user-content server  |  separate Fastify instance, no cookies,
   |  /api/v1/*, /healthz, |            |  GET /c/:sha256      |  attachment + sandbox CSP (gateways lane)
   |  /readyz, openapi     |            +----------------------+
   |  jobs runner          |---- internal :9464 /metrics (Prometheus)
   +----------+-----------+
              | pine_api (DML only)
          Postgres  <---- pine_migrator (DDL, `migrate` command only)
              |
     read model (native indexer schema via a read-only role, or Envio GraphQL)
```

- `src/platform/core` (this lane): configuration and secrets, `buildApp` (hardened Fastify), SIWE sessions, CSRF, rate limits,
  quotas, audit log, moderation and admin routes, compliance gateway, metrics, jobs runner, cleanup job, process composition.
- `src/platform/gateways`: GitHub (OAuth/App linking, API access), content store and IPFS pinning, user-content server, chain gateway.
- `src/modules/*`: route modules (claims, markets, funding) registered by `buildApp` from `src/modules.ts`.

Request pipeline (every request, unmatched routes included): per-IP flood guard (in memory) → CSRF for POST/PUT/PATCH/DELETE
(exact `Origin`, `Sec-Fetch-Site` not `cross-site`, `x-pine-csrf: 1`, JSON content type; multipart only on flagged routes; the
GitHub webhook is the only exempt route, and the only route without a session lookup; any other route declaring either exemption
refuses startup) → session lookup (never for public routes) → Postgres per-user / per-route windows. All windows of one
request are consumed in ONE all-or-nothing statement: when any key is at its limit nothing is incremented, so a refused request
never uses up another window's budget. The SIWE routes consume their per-IP (`ip:<ip>:<route>`) and per-address
(`siwe:<address>`) windows together in that statement after body validation (20/min each).
Public routes (`config.pine.public`) are GET/HEAD only, never read cookies and answer `Access-Control-Allow-Origin: *`;
`@fastify/cors` is not registered and OPTIONS is not routed.

GitHub webhook (`POST /api/v1/webhooks/github`): every delivery with a missing or invalid signature answers 401 and increments
`pine_github_webhook_rejected_total`; the `github.webhook.rejected` audit row is written only for the first rejection per client
(IPv4 address, or IPv6 /64) per minute and at most 60 times per minute overall (Postgres fixed windows `webhook-rejected:*`), so
anonymous traffic adds at most 60 audit rows per minute. Alert on the counter, not on audit rows.

## Processes

| Process | Command | Notes |
|---|---|---|
| Migrations | `pnpm --filter @pine/api migrate` | Runs every pending migration group as `pine_migrator` (`PINE_MIGRATOR_DATABASE_URL`), prints applied ids, exits non-zero on error. Run before every deploy. |
| API | `pnpm --filter @pine/api start` (`node --import tsx src/main.ts`) | Verifies migrations and the chain id at startup and refuses to start otherwise. Serves the API, the user-content server, the internal metrics listener and the jobs runner. SIGTERM/SIGINT (first signal only): stop accepting, abort jobs, close the content server, metrics listener, read model, gateways and pool, exit 0; exit 1 when any shutdown step failed (the remaining steps still run). A refused startup exits 1 after one redacted fatal line. |
| Indexer | `@pine/indexer-native` (or Envio) | Writes the read model; see PRD-05. |

Health: `GET /healthz` (process alive), `GET /readyz` (database reachable, migrations verified, read model not halted and its
indexed block within `PINE_MAX_INDEXER_LAG_SECONDS`). Both are public and cookie-free. The readiness result is computed at most
once every 5 s and served from that cache (migrations are verified at startup and re-verified at most every 60 s), so probes and
anonymous callers never cause a database round trip per request; a change of state can take up to 5 s to show.

Jobs run in every API process; cross-process exclusion uses lease rows in `job_leases` (database time; 60 s TTL, renewed every
20 s; a crashed process blocks a job for at most 60 s). A run whose lease is not confirmed in time (renewal failing or hanging,
pool starved, network partition) is aborted locally 40 s after the last confirmed renewal was sent, i.e. one renewal period
before the lease can expire; a renewal that finds the lease taken aborts at once. Abort is cooperative (jobs check their
`AbortSignal` between batches) and a job is not started again in that process until the aborted run has settled; alert on
`pine_job_lease_lost_total`. A finished run waits at most 2 s for an in-flight renewal and then releases its lease: the release
sets `expires_at = started_at + interval` and renames the holder (`<holder>:released`), so no process starts the job again
before one interval has passed and a late renewal of the finished run can never extend the released row. The core cleanup job (`platform.cleanup`, every 5 minutes) purges expired
nonces, pre-sessions and sessions, rate-limit windows older than one hour and quota windows older than two days, and nulls audit
IPs older than 30 days. Gateway tables (OAuth states, tokens, content) are maintained by gateway jobs.

## Environment

Every variable is documented in `.env.example` and validated at startup (zod). A missing or invalid value stops the process
with a one-line JSON error on stderr naming the variable, never its value. Secrets (database and RPC URLs, GitHub client and
webhook secrets, token-encryption keys, Kubo and pinning-service URLs and token, the read-model database URL or Envio GraphQL URL
and admin secret, and the migrator URL when present in the API's environment) have no defaults, are kept out of the
module-visible `AppConfig` and `ServerSettings`, and are registered with the redactor (exact match) so they never reach a log line,
response, audit row or column.

Production refuses to start unless: all origins are https; `PINE_API_ORIGIN` equals `PINE_PUBLIC_ORIGIN`; the user-content
origin is on another registrable domain; chain id 100; draft policies off; `SC-001` disabled; the two RPC URLs differ; the
country header is configured with `PINE_TRUST_PROXY_HOPS` ≥ 1 (explicitly set); `PINE_SANCTIONS_MODE=static`; both pin targets are
configured (`PINE_KUBO_API_URL`, and `PINE_PINNING_SERVICE_URL` with `PINE_PINNING_SERVICE_TOKEN`); the GitHub App webhook secret
is set; Seer/Reality/Kleros/Swapr addresses equal the verified Gnosis deployment. Token keys must always be
32 bytes with unique ids.

The sanctions denylist (`PINE_SANCTIONS_DENYLIST_PATH`, JSON array of lowercase `0x` addresses) is read once at startup:
**restart the API to apply a new list**. An unreadable or invalid file stops startup.

## Postgres roles and grants

| Role | Rights | Used by |
|---|---|---|
| `pine_migrator` | DDL on the `public` schema, owner of every table; `CREATEROLE` only if it must create `pine_api` | `migrate` command only |
| `pine_api` | `USAGE` on `public`; `SELECT/INSERT/UPDATE/DELETE` on platform tables by name and (default privileges) on every later table created by the migrator; **`SELECT` only on `schema_migrations`**; **`INSERT/SELECT` only on `audit_log`**; `EXECUTE` on `pine_audit_expire_ips` | API process |
| `pine_indexer` | DDL/DML on the indexer schema only | native indexer |
| `pine_readonly` | `SELECT` on the indexer schema | API read model (`PINE_READ_MODEL_DATABASE_URL`), analytics |

- Platform migration `0002_platform_core.sql` creates `pine_api` as `NOLOGIN` when it does not exist. In production the DBA
  pre-creates it `WITH LOGIN PASSWORD ...` (and grants `CONNECT` on the database); the migration then only grants.
- **Migrations only ever run as `pine_migrator`**, all groups in one `migrate` invocation: `ALTER DEFAULT PRIVILEGES` covers
  tables created later by the same role, so a table created by another role would be invisible to `pine_api`.
- The API never has DDL rights and cannot modify the migration ledger; it verifies migrations at startup and refuses to start
  when anything is pending, modified, out of order or unknown.
- The audit log is append-only for the API. IPs are nulled after 30 days by the `SECURITY DEFINER` function
  `pine_audit_expire_ips` (`search_path` pinned, `EXECUTE` revoked from `PUBLIC`), called by the cleanup job.
- Connections set `statement_timeout` 15 s and `lock_timeout` 5 s; waiting for a pooled connection times out after 5 s (below
  the 20 s lease renewal period). Use `sslmode=verify-full` in every production URL.

## TLS and proxies

- TLS terminates at the edge proxy. Set `PINE_TRUST_PROXY_HOPS` to the exact number of proxies in front of the API; client IPs
  (rate limits, audit) and the country header are only trusted through those hops. HSTS (1 year, includeSubDomains) is sent in
  production.
- The proxy must set the country header (`PINE_COMPLIANCE_COUNTRY_HEADER`, e.g. Cloudflare `CF-IPCountry`) and strip any
  client-supplied copy.
- Serve the API same-origin with the web app under `/api`. Serve the user-content server only on its own registrable domain.
- The user-content server has **no in-app per-IP rate limit**: configure per-IP limits for it at the edge proxy/CDN.
- The per-IP flood guard of the API is in memory per process (N processes allow N× the limit); fleet-wide per-IP limits belong
  to the edge proxy. Per-user limits and quotas are shared through Postgres.
- Bind the metrics listener (`PINE_METRICS_HOST`/`PINE_METRICS_PORT`) to a private interface; never expose it publicly.

## Backups

Encrypted backups with point-in-time recovery; restore-test quarterly (SEC-OPS-11). The token-encryption keys
(`PINE_TOKEN_KEY_CURRENT`, `PINE_TOKEN_KEYS_PREVIOUS`) are stored separately from database backups, so restored ciphertexts are
unreadable without them.

## Key and secret rotation

- GitHub token keys: generate `openssl rand -base64 32`, deploy it as `PINE_TOKEN_KEY_CURRENT=<new-id>:<key>` and move the old
  key to `PINE_TOKEN_KEYS_PREVIOUS`. A gateways job re-encrypts stored tokens under the current key and reports how many remain
  under retired keys; remove a previous key only when that count is zero.
- GitHub client secret and webhook secret: add the new secret in GitHub, deploy it, then revoke the old one.
- Database passwords and RPC API keys: rotate at the provider, deploy the new URLs, restart.
- Terms: publishing new terms means a new `PINE_TERMS_DIGEST`; every user must accept again (next sign-in), and compliance
  answers `TERMS_REQUIRED` until then.
- Sessions: `POST /api/v1/auth/logout {"everywhere": true}` deletes all sessions of a user; deleting all rows of `sessions`
  logs everyone out.

## Launch gates (ADR-0001; human decisions, enforced fail-closed in code)

1. Served and blocked jurisdictions and the regulatory role (geofence lists, `PINE_BLOCKED_COUNTRIES*`).
2. Sanctions/KYC posture and a hosted screening provider (v1 uses the static denylist).
3. Terms, privacy notice and risk-disclosure copy (`PINE_TERMS_DIGEST`).
4. Fee and revenue model; sponsorship-program structure.
5. Insider and self-dealing rules; staff conflict-of-interest policy.
6. SC-001 enablement and the live-vulnerability disclosure process (`SC-001` refused in production).
7. Evidence takedown, legal hold and transparency policy; data retention and GDPR basis.
8. Smart-contract-wallet login (ERC-1271/6492) — off; EOA-only SIWE.
9. Linking to or embedding trading UI.
10. External contract audit, hardware-wallet deployer, incident response.
11. GitHub App vs OAuth App spike (SEC-GH-02); Seer/Kleros review of question and policy text; human approval of policy texts.
12. Pinning provider accounts; the meaning of the minimum funding budget.

## Development

```
pnpm install --frozen-lockfile
pnpm --filter @pine/api typecheck
pnpm --filter @pine/api exec vitest run src/platform/core
```

Tests run on PGlite (in-memory Postgres). Each PGlite instance needs about 0.7 GB (1.1 GB while initialising); the core test
helpers serialise database-backed test files across vitest workers with a lock in the OS temp directory.
