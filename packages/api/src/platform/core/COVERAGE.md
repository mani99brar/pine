# platform-core coverage matrix (platform-007)

Every required core test of PRD-02 sections 4, 3a and 3b, every item of the operator's coverage-gap list
(`operator-coverage-gaps-platform-core.md`, items 1-32) and every decision of `features/platform/decisions.md` that core
implements, mapped to the test file and test name that fails when the behaviour is removed. Files are relative to
`packages/api/src/platform/core/`. Every row was re-checked in platform-007 by reading the named test (several platform-006
rows claimed coverage that did not exist; those are marked "fixed" with the new test). "M: `name`" marks a row confirmed by a temporary mutation of the implementation in platform-007 (applied, the named test
file run and failing, file restored). "mutation not run" names planned mutations that were not executed: the sequential
mutation run was stopped by the host for low memory after 22 mutations (the restart was not attempted, per the session's
memory notice); those rows were verified by reading the test only. One mutation survived as an equivalent mutant:
`startup-log-raw-error` (logging `error.message` instead of `safeErrorMessage` in the startup catch) — the startup logger
redacts every string field itself, so the fatal line stays redacted; row 13's tests then guard the logger layer.

## PRD-02 section 3b (platform-007)

| Requirement | Test file | Test name |
|---|---|---|
| Redaction with EVERY secret (DB, migrator, read-model URL, both RPCs, GitHub client + webhook secret, token keys, Kubo URL, pinning URL + token, Envio URL + admin secret), each masked exactly; removing any value fails — (mutation not run: `each of the 12 `secretStrings` entries removed separately`) | config.test.ts | `SEC-OPS-02 every secret is registered with the platform redactor (PRD-02 3b)` › `masks each production secret exactly (native read model) …`, `… (envio read model) …` |
| … in a log line, an error response and an audit detail, through the composed platform (`startPlatform`, production env) — M: `server-no-migrator` | server.test.ts | `SEC-OPS-02 the composed platform redacts every production secret (PRD-02 3b)` › `masks each secret in a log line, an error response and an audit detail (native read model)`, `… (envio read model)` |
| Rate limits all-or-nothing (one CTE statement) — M: guard `NOT EXISTS (exhausted)` → `true` killed 4 tests | limits.test.ts | `is all-or-nothing: a refused statement increments none of its keys`, `a request refused by the per-user window does not consume its per-route window`, `enforces the per-route limit per user, and the per-user limit across routes` (rewritten: asserts user=2/route=2 after the refusal and two more `/open` successes) |
| SIWE per-IP and per-address windows in ONE statement (section 2.3) — (mutation not run: `siwe-keys-not-together`) | limits.test.ts | `SEC-AUTH-08 a challenge refused by the per-address window does not consume the IP window, and vice versa` |
| `main.ts` signal handling testable; SIGTERM/SIGINT stop accepting, abort jobs, close everything, exit 0 — (mutation not run: `no-signal-handlers`) | server.test.ts | `src/main.ts run(env, io): signal handling` › `SIGTERM stops accepting, aborts jobs, closes every resource and exits 0`, `SIGINT …` |
| … exit 1 when shutdown fails — (M: `shutdown-fail-exit0`; mutation not run: `shutdown-never-rejects`) | server.test.ts | `exits 1 when a shutdown step fails, after still closing every other resource` |
| `main.ts` runs when executed directly — (M: `no-direct-run`) | server.test.ts | `runs when executed directly: an invalid environment gives one redacted fatal line and exit 1` |
| Tolerant renewal-period test (TTL 15 s; observed period closer to ttl/3 than ttl/2) — (mutation not run: `default-renew-ttl-4`) | jobs.test.ts | `defaults: renewal every ttl/3 and acquisition polled every min(interval, 15 s)` |
| Gateway jobs are exactly three (wording) | — | gateways lane; core runs whatever `gateways.jobs` holds (server.test.ts `runs gateway jobs, module jobs and the core cleanup job …`) |

## Operator coverage gaps (items 1-32, operator-settled for platform-007)

| # | Gap | Test file | Test name |
|---|---|---|---|
| 1 | All-or-nothing rate limits; SIWE keys in one statement (code fixed: CTE in `consumeRateLimits`, `pineCore.bodyRateLimitKeys` consumed in preHandler with the request keys) — M (see 3b) | limits.test.ts | rows of 3b above; (c) also asserts the refused challenge wrote no pre-session/nonce and the IP keeps its whole budget (20 more challenges) |
| 2 | SEC-OPS-04 exact proxy hops with multi-entry X-Forwarded-For — (M: `trust-all-hops`) | limits.test.ts | `SEC-OPS-04 client IP from exactly the configured proxy hops` › `… with one hop, client-supplied leftmost X-Forwarded-For entries are ignored`, `… with two hops the client is the entry the second proxy appended`, `… the flood-guard bucket does not change when only spoofed leftmost entries vary`, `… a sign-in behind one hop records the proxied client IP in the audit log` |
| 3 | SEC-AUTH-03 nonce consumed atomically, replay on a live pre-session — (M: `nonce-select-not-delete`) | siwe.test.ts | `SEC-AUTH-03 a nonce is consumed by its first attempt: a replay on the same, still-valid pre-session fails` |
| 4 | Decorator reads identity BEFORE forwarding (real revocation semantics) — (M: `decorator-identity-after-call`) | github.test.ts | `<method>: forwards arguments and result unchanged, and audits a revocation that removed the identity` (8 methods), `ctx.github audits a revocation whose gateway removed the identity before throwing` |
| 5 | SEC-AUTH-21 moderation DELETE needs requireAdmin + fresh step-up — (M: `moderation-delete-no-requireAdmin`) | moderation.test.ts | `SEC-AUTH-21 unblocking (DELETE) needs an admin with a fresh signature; refused attempts change nothing` |
| 6a | SEC-AUTH-04 expired stored message while the pre-session is alive — (M: `nonce-expiry-check-removed`) | siwe.test.ts | `SEC-AUTH-04 rejects a stored message past its expiration while the pre-session is still valid` |
| 6b | Explicit field checks on the stored message (terms digest / chain id changed) — (M: `field-check-removed`) | siwe.test.ts | `SEC-AUTH-04 explicit field checks run on the stored message: refused when SEC-LEGAL-03 the terms digest changed …`, `… SEC-AUTH-04 the chain id changed …` |
| 7 | CSRF on PUT and PATCH — (M: `csrf-no-put-patch`) | app.test.ts | `SEC-AUTH-14 applies to PUT: every CSRF rule is enforced and a valid request passes`, `… PATCH …` |
| 8 | CSRF on every unsafe platform route, only the webhook exempt (code: `buildApp` refuses any other route with `csrfExempt`/`noSession`) — (M: `verify-csrf-exempt`, `exemption-allowlist-removed`) | app.test.ts | `SEC-AUTH-14 every unsafe platform route enforces CSRF and has no side effect when refused`, `SEC-AUTH-14 refuses to start when any route other than the GitHub webhook sets pineCore.csrfExempt`, `… pineCore.noSession` |
| 9 | ctx.compliance / ctx.quotas built from settings (createCoreServices) — (M: `services-env-test`, `services-no-sanctions`, `services-default-quotas`) | compliance.test.ts | `SEC-LEGAL-01/02 ctx.compliance and ctx.quotas are built from the configured settings (createCoreServices)` (also audits `country_unknown`) |
| 10 | Country lists per action merged with the global list, wallets lowercased, quotas, loopback host defaults, invalid entries refused — (M: `config-fund-market-wrong`, `config-metrics-host-any`, `config-blocked-wallets-ignored`) | config.test.ts | `loads compliance lists, wallet allowlists, quotas and loopback host defaults`, `refuses an invalid <variable> naming the variable` (6 variables) |
| 11 | Previous token keys: 16-byte, non-base64, duplicate ids — (M: `config-previous-ids-not-unique`) | config.test.ts | `SEC-OPS-01 validates every previous token key: 32 bytes, base64, unique ids, no key material echoed` |
| 12 | No secret in AppConfig/ServerSettings with every secret set, both backends — (M: `config-kubo-in-server`) | config.test.ts | `SEC-OPS-02 secrets are not part of AppConfig or ServerSettings (production, every secret set, native read model)`, `… envio read model` |
| 13 | Refused startup logs secret-bearing errors redacted (DB URL in connect error, keyed RPC URL in chain error) — (`startup-log-raw-error` ran and SURVIVED as an equivalent mutant: `stderrLogger` redacts every field itself) | server.test.ts | `SEC-OPS-02 a refused startup logs connection errors redacted …`, `SEC-OPS-02 a refused startup logs RPC errors redacted …, closing what it opened` |
| 14 | Process exits 1 on an invalid config; main.ts passes `routeModules`, the factories and a pool on `PINE_DATABASE_URL` — (mutation not run: `main-empty-modules`, `main-wrong-pool-url`) | server.test.ts | `SEC-OPS-01 a refused startup exits 1 without installing signal handlers`, `runs when executed directly …`, `composes the real dependencies: src/modules.ts, the gateway and read-model factories, a pool on PINE_DATABASE_URL` (the module stubs register no routes yet, so identity of `routeModules` is asserted instead of their routes) |
| 15 | Shutdown order; metrics listener closed — (M: `app-not-closed-first`; mutation not run: `no-metrics-close`) | server.test.ts | `shuts down in order: stop accepting, abort jobs, then content server, read model, gateways and pool; metrics port closed`; SIGTERM test asserts `app.closed` < `job.aborted` < `gateways.close` and `db.close` last |
| 16 | Gateway chain-object and read-model chain-id checks; content server on its own host/port — (M: `no-gateway-chain-check`, `no-readmodel-chain-check`; mutation not run: `content-on-api-host`) | server.test.ts | `refuses to start when the gateway chain object is for another chain, …`, `refuses to start when the read model reports another chain, …`, `starts the content server on PINE_USER_CONTENT_HOST/PORT` |
| 17 | Runner runs gateway + module jobs + cleanup; cleanup job really cleans — (mutation not run: `no-cleanup-job`, `no-module-jobs`, `cleanup-job-noop`) | server.test.ts, cleanup.test.ts | `runs gateway jobs, module jobs and the core cleanup job; module jobs are aborted on shutdown`; `runs as a JobDefinition: purges expired rows, nulls old audit IPs and counts tables with deletions` |
| 18 | Job errors counted — (mutation not run: `job-error-not-counted`) | jobs.test.ts | `logs failures redacted and retries at the next interval` (now asserts `job_runs{result: error}` ≥ 2 and `ok` for a good job) |
| 19 | Default TTL 60 s (read-only SELECT), poll min(interval, 15 s), random holder id — (mutation not run: `default-ttl-30s`, `default-poll-1s`, `constant-holder`) | jobs.test.ts | `defaults: lease TTL 60 s, poll period min(interval, 15 s), and a random holder id per runner` |
| 20 | Grants by name cover quota_usage, moderation_states, job_leases; no `ON ALL TABLES` — (mutation not run: `grant-no-quota-moderation-leases`) | audit.test.ts | `quotas, moderation and job leases work as pine_api (grants by table name)`, `0002 grants tables by name, never ON ALL TABLES` |
| 21 | 0002 idempotent for a pre-created LOGIN role — (mutation not run: `role-created-unconditionally`) | migrate.test.ts | `applies every pending migration through the injected executor, …` (now pre-creates `pine_api LOGIN`, asserts it stays LOGIN and the grants apply) |
| 22 | /readyz with an unreachable database and a throwing read model — (mutation not run: `readyz-db-always-ok`, `readyz-status-throw-ok`) | health.test.ts | `readyz is not ready when the database is unreachable; the reason is logged redacted and never returned`, `readyz is 503 with readModel failed when the read model status throws` |
| 23 | GET /auth/session fields; terms re-acceptance after a digest change — (mutation not run: `session-terms-hardcoded`, `session-isadmin-false`) | sessions.test.ts | `SEC-LEGAL-03 reports wallet, admin flag, expiries and terms status; a new terms digest needs re-acceptance` |
| 24 | Decorator around every GitHubGateway method — (M: `decorator-getCommit-unwrapped`) | github.test.ts | the 8 table-driven tests of row 4 |
| 25 | Nonce and tokens derived exactly from node:crypto randomBytes — (M: `nonce-math-random`) | random.test.ts | `SEC-AUTH-02 the SIWE nonce is randomBytes(16) as hex`, `SEC-AUTH-09 the session token is pine_s1_ + base64url(randomBytes(32))`, `… pre-session token …` |
| 26 | /metrics not on the public app | app.test.ts | `GET /metrics and /api/metrics on the main app are 404 without metric text` |
| 27 | audit_log.created_at = database now() — (mutation not run: `audit-created-at-app-clock`) | audit.test.ts | `created_at is database now(), never the application clock` |
| 28 | Cleanup in bounded batches — (mutation not run: `cleanup-unbounded`) | cleanup.test.ts | `purges in bounded batches of at most 1000 rows per statement` (2 500 windows: 1000 + 1000 + 500) |
| 29 | Callback failure logged redacted (OAuth code) — (mutation not run: `callback-log-raw`) | github.test.ts | `SEC-GH-03 token exchange failure` (now also inspects `hh.logs`) |
| 30 | Webhook never reads cookies — (M: `webhook-session-lookup`) | github.test.ts | `the webhook never reads cookies: a valid session cookie triggers no session lookup or user window` |
| 31 | Production code never imports testing/ or contracts/testing — (mutation not run: `server-imports-testing`) | imports.test.ts | `no import specifier points into a testing/ directory or contracts/testing`, `the scanner recognises every import form it must refuse` |
| 32 | migrate.ts exits 1 when runMigrations fails — (mutation not run: `migrate-swallow-errors`) | migrate.test.ts | `SEC-OPS-10 exits 1 with one redacted fatal line and applies nothing when runMigrations fails: a migration file with invalid SQL`, `… a changed checksum of an applied migration` |

## Review sidecar S-1 (operator-settled before freeze)

| Requirement | Test file | Test name |
|---|---|---|
| Every secret variable (all 14 of `SECRET_VARIABLES`, incl. `PINE_PINNING_SERVICE_TOKEN`, `PINE_ENVIO_ADMIN_SECRET` and `PINE_MIGRATOR_DATABASE_URL`) is at least 16 characters (`MIN_SECRET_LENGTH`; the frozen redactor ignores secrets under 8); the refusal names the variable and never echoes the value; `migrate.ts` applies the same minimum to the migrator URL | config.test.ts | `SEC-OPS-02 every secret variable is at least 16 characters (the redactor ignores secrets under 8)` › `covers every secret variable`, `refuses a <n>-character <VARIABLE> naming the variable without echoing the value` (one per variable, e.g. `PINE_ENVIO_ADMIN_SECRET=testing`), `accepts a 16-character admin secret and pinning token` |

## PRD-02 section 4 (core)

| Requirement | Test file | Test name |
|---|---|---|
| Config refusal per production rule (https origins, apiOrigin, user-content registrable domain incl. subdomains, chain 100, drafts, SC-001, distinct RPCs, country header, sanctions, trust-proxy hops, webhook secret, Seer/AMM = GNOSIS_EXTERNAL, pin targets) | config.test.ts | `production refinements (SEC-OPS-01)` › `refuses <rule>` (one test per rule; each asserts the message names the rule and echoes no secret) |
| Token keys 32 bytes, unique ids (current and previous) | config.test.ts | `SEC-OPS-01 refuses token keys that are not 32 bytes or have duplicate ids`, `SEC-OPS-01 validates every previous token key …` |
| Errors name the variable, never the value | config.test.ts | `SEC-OPS-01 names a missing variable without echoing any value` |
| CSRF missing/wrong Origin, cross-site, missing header, wrong content type | app.test.ts | `SEC-AUTH-14 rejects a missing Origin`, `… a foreign Origin`, `… a suffix-matching Origin`, `… the user-content Origin`, `… Origin null`, `… Sec-Fetch-Site cross-site`, `… a missing x-pine-csrf header`, `… a wrong x-pine-csrf value`, `… a text/plain body (forged fetch)`, `… a form post`; PUT/PATCH rows above |
| CSRF charset parameter accepted | app.test.ts | `accepts application/json with a charset parameter` |
| Multipart only where allowed | app.test.ts | `SEC-AUTH-14 rejects multipart on a JSON-only route`, `accepts multipart only on a flagged route (SEC-AUTH-14)` |
| CSRF on bodyless DELETE and unmatched routes | app.test.ts | `SEC-AUTH-14 applies to DELETE without a body …`, `SEC-AUTH-14 applies to unsafe requests on unmatched routes` |
| SIWE replayed nonce (fixed: now on a live pre-session) | siwe.test.ts | `SEC-AUTH-03 a nonce is consumed by its first attempt …`; also `SEC-AUTH-03 rejects a replayed nonce` (after success) |
| SIWE nonce from another pre-session | siwe.test.ts | `SEC-AUTH-03 rejects a nonce issued to another pre-session (and does not burn it)` (asserts `foreign_presession`) |
| SIWE expired (fixed: reason asserted while the pre-session is alive) | siwe.test.ts | `SEC-AUTH-04 rejects a stored message past its expiration while the pre-session is still valid` |
| SIWE altered message byte | siwe.test.ts | `SEC-AUTH-01 rejects a signature over the stored message plus an appended line` (asserts `message_mismatch`), `SEC-AUTH-01 rejects a message with one altered byte` |
| SIWE wrong chain id/domain/uri (fixed: field checks reached on the stored message) | siwe.test.ts | `SEC-AUTH-04 explicit field checks run on the stored message …` (2), `SEC-AUTH-04 explicit field checks reject every mutated field of a stored message` (unit), `SEC-AUTH-04 rejects a signed message with another <field>` (byte check) |
| SIWE signature by another key | siwe.test.ts | `SEC-AUTH-05 rejects a signature by another key` (asserts `signature_mismatch`) |
| SIWE contract wallet impossible (no RPC) | siwe.test.ts | `SEC-AUTH-05 contract wallets cannot sign in: ERC-6492/1271 signatures are refused without any RPC call` |
| Session expiry idle / absolute | sessions.test.ts | `SEC-AUTH-12 an idle session expires after 24 h (valid at -1 s, refused at the boundary)`, `SEC-AUTH-12 an active session still expires at the 7-day absolute limit` |
| Rotation on link keeps authenticatedAt | sessions.test.ts | `linking GitHub rotates the session but never refreshes the admin step-up window`, `SEC-AUTH-11 rotation issues a new token, invalidates the old one and keeps authenticatedAt …` |
| Logout | sessions.test.ts | `SEC-AUTH-13 a cookie used after logout gets 401 and the cookie is cleared`, `SEC-AUTH-13 log out everywhere …` |
| Admin step-up | sessions.test.ts, moderation.test.ts | `SEC-AUTH-21 requireAdmin: 401 without a session, 403 for non-admins, STEP_UP_REQUIRED after 300 s`, `SEC-AUTH-21 removing a wallet from the allowlist …`; moderation POST and DELETE rows |
| Public routes ignore cookies, CORS * | app.test.ts | `public routes ignore cookies, get ACAO * and never credentials`, `public routes never read cookies: no session lookup or identityOf call happens` |
| Credentialed routes no CORS; OPTIONS not routed | app.test.ts | `SEC-AUTH-16 credentialed routes never carry CORS headers …`, `SEC-AUTH-16 OPTIONS is not routed and never yields Access-Control-Allow-Credentials` |
| Public routes GET/HEAD only | app.test.ts | `refuses to start when a module declares a public non-GET route` |
| Quotas | limits.test.ts, compliance.test.ts | `consumes atomically up to the limit, then QUOTA_EXCEEDED …`, `refuses an amount larger than the limit …`, `a new fixed window starts after the window ends`; row 9 (wiring) |
| Rate-limit keys (authenticated keyed by user id) | limits.test.ts | `an authenticated request is keyed by user id …`, `anonymous requests write nothing without a route limit and use ip:<ip>:<route> with one`, `enforces the per-route limit per user, and the per-user limit across routes` |
| Audit redaction | audit.test.ts | `SEC-OPS-07 redacts every string in details recursively, including keys, …`, `caps details at 8 KiB` |
| `SET ROLE pine_api`: INSERT works, UPDATE/DELETE fail | audit.test.ts | `SEC-OPS-07 as pine_api: INSERT works, UPDATE/DELETE/TRUNCATE fail with a permission error` |
| Moderation routes | moderation.test.ts | `blocks content, …`, `lists and removes states; …`, `SEC-AUTH-21 non-admins get 403, …` (POST/GET), `SEC-AUTH-21 unblocking (DELETE) …`, `SEC-OPS-06 validates subject ids and reasons …` |
| Compliance 451 / TERMS_REQUIRED | compliance.test.ts | `SEC-LEGAL-02 refuses a wallet on the sanctions denylist with 451 and audits`, `SEC-LEGAL-01 refuses a blocked country …`, `SEC-LEGAL-01 fails closed in production …`, `SEC-LEGAL-03 TERMS_REQUIRED …`, row 9 |
| Jobs never overlap | jobs.test.ts | `a job never overlaps itself across two processes and runs at most once per interval` |
| Lease: B cannot acquire while A holds; A releases; B not before interval; B after | jobs.test.ts | `B cannot acquire while A holds; after A releases B cannot acquire before the interval; B acquires after it` |
| Lease: expired (crashed) holder taken over | jobs.test.ts | `an expired (crashed) holder is taken over after the TTL` |
| Lease: holder that lost its lease aborts | jobs.test.ts | `a holder whose renewal updates zero rows aborts its run and does not release the new holder's lease` |
| Error responses never contain secrets | app.test.ts, server.test.ts | `never returns secrets from an internal error and logs it redacted`, `redacts secrets inside ApiError messages`; 3b composition rows |
| `/readyz` stale / halted (and DB down, status throwing) | health.test.ts | `readyz is 503 when the read model is stale …`, `readyz is 503 when the read model is halted`, row 22 |
| Log lines: no query strings or cookies | app.test.ts | `log lines contain no query strings, cookies, CSRF header values or OAuth codes` |
| Auditing GitHub decorator (both cases) | github.test.ts | rows 4/24; `a user who never linked GitHub gets the same error and no audit row`, `a module that catches the error cannot hide the revocation`, `ctx.github in the platform context is the auditing decorator` |
| Webhook accepted / rejected audits | github.test.ts | `passes the exact raw bytes (<type>) to the gateway and audits github.webhook.accepted`, `SEC-GH-04 a bad signature gets 401 and a rejected audit …`, `SEC-GH-04 rejected webhooks are audited once per client …`, `SEC-GH-04 at most 60 rejected-webhook audit rows per minute …` |
| Callback failures → `?github=error`, nothing linked | github.test.ts | `SEC-GH-03 <case>` (expired, foreign-session, no session, exchange failure, scope rejection, identity conflict, …), `SEC-GH-03 a reused state links nothing the second time` |
| Sanctions config | config.test.ts | `refuses SEC-LEGAL-02 sanctions mode off`, `… unset`; `sanctions configuration (SEC-LEGAL-02)` › `refuses a denylist file with <case>`, `refuses an unreadable denylist file`, `refuses a denylist with more than 100000 entries`, `reads a real denylist file from disk (duplicates allowed)` |
| SEC-AUTH-08: 21st challenge per IP → 429, other IP/route unaffected | limits.test.ts | `SEC-AUTH-08 the 21st challenge from one IP in a minute gets 429; another IP and another route are unaffected` |
| SEC-AUTH-08: per-address across IPs; verify the same | limits.test.ts | `SEC-AUTH-08 the per-address challenge limit applies across IPs`, `SEC-AUTH-08 verify is limited per IP the same way`, `SEC-AUTH-08 verify is limited per challenged address across IPs` |
| Webhook bad signature → 401 + rejected; internal failure → 500 | github.test.ts | `SEC-GH-04 a bad signature gets 401 …`, `SEC-GH-04 a missing signature …`, `an internal failure gets 500 and a failed audit` |
| SIWE signing only in tests/testing; production never imports testing/ | `forbidden` check; imports.test.ts | rule `SEC-TX-09`; row 31 |

## PRD-02 section 3a (platform-006, re-checked)

| Requirement | Test file | Test name |
|---|---|---|
| Release marks the holder released; a late renewal updates zero rows | jobs.test.ts | `a renewal that lands after the release updates zero rows and cannot extend the released lease` |
| Runner awaits an in-flight renewal (at most 2 s) before releasing | jobs.test.ts | `awaits an in-flight renewal before releasing`, `waits at most 2000 ms for a hung renewal, then releases (and the release still wins)` |
| Lease store is a constructor dependency | jobs.test.ts | every runner test using `wrappedStore` (no direct `job_leases` writes) |
| Moderation change + audit in one transaction | moderation.test.ts | `SEC-OPS-07 a moderation change and its audit entry commit together` › 3 tests |
| Production needs both pin targets | config.test.ts | `refuses SEC-EVID pin target Kubo missing`, `… Pinning Service missing`, `… both missing` |
| Successful renewal moves the deadline | jobs.test.ts | `each successful renewal moves the local deadline: …` |
| Deadline armed at acquire (first renewal hangs / fails) | jobs.test.ts | `the deadline is armed at acquire: a first renewal that hangs …`, `… that fails …` |
| No re-acquire before an aborted run settles | jobs.test.ts | `does not re-acquire a job before its aborted run settles (zero-row renewal, no other holder)` |
| Gateway jobs stop on abort | — | gateways lane; core cleanup: cleanup.test.ts `checks its AbortSignal between batches: an aborted run deletes nothing` |
| `migrate.ts` `main(env, io)`: success, refusals in process and as child process, failing migrations | migrate.test.ts | `applies every pending migration …`, `refuses SEC-OPS-10 …` (both describes), `SEC-OPS-02 a connection failure …`, row 32 |
| Multipart limits | multipart.test.ts | `refuses a file one byte above maxUploadBytes with 413 PAYLOAD_TOO_LARGE`, `refuses a second file with 413`, `refuses more than 10 fields with 413`, `accepts one file of exactly maxUploadBytes with a few fields` |

## decisions.md (core-relevant)

| Decision | Test file | Test name / note |
|---|---|---|
| SIWE EOA-only, byte-identical message, randomBytes(16) nonce bound to the pre-session, local recovery, no RPC | siwe.test.ts, random.test.ts | `issues the exact EIP-4361 message and a pre-session cookie`, row 25, SEC-AUTH-01/03/05 rows; `forbidden` rule SEC-AUTH-02 |
| Each allowed challenge writes ≤ 1 pre-session and ≤ 1 nonce row | siwe.test.ts | `SEC-AUTH-08 each allowed challenge writes at most one pre-session and one nonce row` |
| Sessions: `pine_s1_`, SHA-256 at rest, cookie attributes, idle 24 h, absolute 7 d, rotation on login and link | siwe.test.ts, sessions.test.ts, random.test.ts | `creates a session: __Host- cookie attributes, …`, `SEC-AUTH-11 a session cookie supplied before sign-in is never valid afterwards (fixation)`; session rows above |
| Admin = allowlist per request + signature ≤ 300 s (STEP_UP_REQUIRED 401) | sessions.test.ts, moderation.test.ts | admin rows above |
| CSRF on every unsafe method; the webhook is the only exempt route | app.test.ts | CSRF rows, row 8 |
| Core reads identities only through `identityOf`; unknown cookie skips it | sessions.test.ts | `fills the GitHub identity through identityOf on every request`, `rejects malformed and unknown session cookies without a GitHub lookup` |
| Runtime verifies migrations at startup and refuses otherwise | server.test.ts | `SEC-OPS-10 refuses to start with pending migrations, before creating gateways` |
| Jobs: lease rows, NOT NULL expires_at, atomic acquire only when expired, renewal, release = started_at + interval, database time | jobs.test.ts | lease rows above |
| Audit ownership (link start/success/failure/unlink, webhook, revocations) | github.test.ts | `start requires a session and is audited`, `a successful callback links, rotates the session …`, `SEC-GH-03 …`, `unlink deletes the link and the session, and is audited`, rows 4/24, webhook rows |
| SEC-GH-03 deviation (303 to `?github=error`) | github.test.ts | `SEC-GH-03 <case>` |
| Sanctions `off`/`static`, production `static` + denylist | config.test.ts | sanctions rows |
| Lease timing options; defaults TTL 60 s, renewal ttl/3, poll min(interval, 15 s) | jobs.test.ts | row 19, 3b renewal row, `refuses a renewal period that would put the local deadline before the next renewal` |
| Grants by name, SELECT only on `schema_migrations`, default privileges; INSERT/SELECT-only audit_log | audit.test.ts, migrate.test.ts | `SEC-OPS-10 pine_api can verify migrations but cannot alter the ledger or create tables`, `the whole sign-in flow works as pine_api …`, `default privileges cover a later migration group's table …`, rows 20/21 |
| SECURITY DEFINER IP retention, not executable by PUBLIC | audit.test.ts | `SEC-OPS-07 the retention function nulls IPs older than 30 days only, callable by pine_api`, `the retention function is not executable by PUBLIC` |
| `@fastify/cors` not registered; ACAO from onSend; OPTIONS not routed | app.test.ts | CORS rows |
| Flood guard 600/min default; per-user 120/min | config.test.ts | `loads a valid development configuration with defaults` |
| Flood guard first onRequest hook, covers 404s, before CSRF and session lookup (fixed: valid session cookie now) | app.test.ts | `limits per IP before CSRF and the session lookup, including unmatched routes`, `refuses to start when a module sets config.rateLimit` |
| Postgres fixed windows `user:`, `user:…:route`, `ip:…:route`, `siwe:` (all-or-nothing) | limits.test.ts | rate-limit rows above |
| Country header honoured only with trustProxy | compliance.test.ts | `SEC-LEGAL-01 ignores the country header unless trustProxy is configured` |
| `audit_log.created_at` = database `now()` (fixed) | audit.test.ts | row 27 |
| Webhook raw Buffers (64 KiB), no session | github.test.ts | `passes the exact raw bytes (<type>) …`, `refuses bodies over 64 KiB`, row 30 |
| Rejected webhook audits rate-limited per IP /64 and 60/min (one all-or-nothing statement) | github.test.ts, limits.test.ts | `SEC-GH-04 rejected webhooks are audited once per client …`, `SEC-GH-04 at most 60 …`; `ipBucket` › `keeps IPv4 (also IPv4-mapped) and reduces IPv6 to its /64` |
| Local deadline, connection timeout below renewal period | jobs.test.ts, pg.test.ts | deadline rows; `the pool connection timeout is below the default renewal period`; `sets the statement timeout to 15 s and a connection timeout below the default renewal period` |
| Jobs check `signal` between batches (core cleanup) | cleanup.test.ts | `checks its AbortSignal between batches: an aborted run deletes nothing` |
| `/readyz` cached 5 s; migrations re-verified ≤ every 60 s | health.test.ts | `serves /readyz from a 5 s single-flight cache …`, `re-verifies migrations at most every 60 s and trusts a startup verification` |
| Metrics: dedicated Registry, lazy, cached, label names fixed, mismatches dropped once; internal listener only | metrics.test.ts, app.test.ts | `creates counters and histograms lazily in a dedicated registry`, `two adapters never collide (no global registry)`, `drops samples whose label keys differ …`, `serves GET /metrics on the internal listener only`; row 26 |
| Inside transactions only `tx` is used | moderation.test.ts | the rollback tests (a nested `ctx.db` call would deadlock PGlite and time out) |
| Clock: `ctx.clock.now()` bound parameter | sessions.test.ts, limits.test.ts, siwe.test.ts | expiry and window tests advance only the FakeClock |
| Core registers `@fastify/multipart`; maps `GitHubGatewayError` codes | multipart.test.ts, app.test.ts | multipart rows; `maps GitHub gateway errors to client codes, never 500` |
| Secrets kept out of AppConfig/ServerSettings, registered with the redactor | config.test.ts, server.test.ts | rows 12 and 3b |
| `main.ts` composition, graceful shutdown, chain-id checks | server.test.ts | rows 13-17 and 3b |
| Every variable documented in `.env.example` | config.test.ts | `documents every variable in .env.example` |

## Not covered by an executed test (accepted or documented)

- Race-freedom of the single-statement quota/nonce/rate-limit/session-touch statements under real concurrency (PGlite
  serialises queries; accepted in decisions.md). For the all-or-nothing rate-limit CTE specifically: under READ COMMITTED
  a request racing another one at the very limit can still see its other keys incremented (the per-row conflict WHERE
  keeps every key at or below its limit, so this fails closed).
- `ALTER DEFAULT PRIVILEGES` and `pine_api` DML against a real Postgres server (assembly e2e; PGlite proves it here).
- Migrations always running as `pine_migrator` (an operational rule in the README; the code cannot know the role).
- No in-app per-IP limit on the user-content server (gateways lane; README documents the edge-proxy duty).
- Fleet-wide per-IP limiting (edge proxy; the in-memory flood guard is per process by decision).
- Routes of the real `src/modules.ts` modules responding through `main.ts` (the claims/markets/funding modules are still
  stubs without routes; `run` is proven to pass `routeModules` itself).
- The real `process` signal objects: `run(env, io)` is driven with an injected signal emitter; the child-process test proves
  the direct-run entry point, not a real SIGTERM delivered to a listening process.
