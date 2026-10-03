# platform-gateways coverage matrix (platform-007)

Each required behaviour maps to the test that fails when the behaviour is removed. Paths are relative to this directory;
run them with `pnpm --filter @pine/api exec vitest run src/platform/gateways`.

**Mutation** names the source mutation that was applied in platform-007 (one at a time, `vitest run <file> -t <test>`),
made the named test FAIL, and was reverted (117 mutation runs; the only survivors are the two double-guarded behaviours noted
in their rows, plus a first AAD mutation that removed only one side and was redone on both). Every row below was re-checked this way; rows whose behaviour has no single
removable line say why in the last column. platform-006's row "an 11 MB response is cut off at the 2 MiB cap" was
wrong (the title broke the schema, so the test passed without any cap); it is replaced below.

## PRD-02 section 4 (gateways)

| Required test | Test file › test name | Mutation (test fails) |
|---|---|---|
| OAuth state single use | github-auth.test.ts › links the GitHub identity by numeric id and the state is single use | consume with SELECT instead of DELETE … RETURNING |
| OAuth state expiry (10 min, literal) | github-auth.test.ts › SEC-GH-03 a state is valid for exactly 10 minutes (literal 600000 ms, stored expires_at = created_at + 10 min) | drop `!row.live`; TTL constant set to 24 h |
| OAuth state session binding | github-auth.test.ts › SEC-GH-03 a state bound to another session links nothing and is burnt | drop the session_id comparison |
| OAuth state user binding | github-auth.test.ts › SEC-GH-03 the state's user binding is checked on its own, not only through the verifier's AAD (the older "presented by another user's session" test is also guarded by the verifier AAD, so it alone cannot prove the check) | drop the user_id comparison |
| PKCE parameters | github-auth.test.ts › builds an authorization URL with PKCE S256, a 128-bit state and the API callback (S256(verifier) = challenge; verifier stored only encrypted) | challenge = verifier (plain); verifier appended in clear to the stored row |
| Token AAD binding (ciphertext swapped between users fails) | crypto.test.ts › SEC-GH-06 a ciphertext swapped to another user fails to decrypt; github-tokens.test.ts › SEC-GH-06 ciphertexts swapped between two users fail closed … | setAAD removed from encrypt AND decrypt |
| Key rotation decrypt | crypto.test.ts › SEC-GH-07 decrypts with a previous key after rotation …; github-tokens.test.ts › SEC-GH-07 a refresh decrypts under a previous key and re-encrypts … | decrypt only with the current key |
| Refresh single-flight (and rotation persisted) | github-tokens.test.ts › 10 concurrent requests from two processes with an expired token refresh exactly once and persist the rotated refresh token | in-lock freshness re-check removed; rotated refresh token not written |
| Webhook HMAC (bad signature rejected) | github-auth.test.ts › SEC-GH-10 rejects a missing, malformed or wrong signature with UNAUTHENTICATED and changes nothing | signature comparison removed |
| `X-OAuth-Scopes` non-empty rejected | github-auth.test.ts › SEC-GH-04 an OAuth token with non-empty X-OAuth-Scopes is revoked …; › SEC-GH-04 … (header missing) fails closed | header ignored; missing-header rule removed |
| Private/internal repos refused | github.test.ts › SEC-GH-13 refuses private, internal and visibility-less repositories …; › SEC-GH-13 a repository flipped to private is refused by every repository-scoped call | visibility check removed |
| Membership methods | github.test.ts › pull_head when …; › pull_commit when …; › branch_ancestor resolves the branch of this repository and compares against its head SHA, never the name | pull_head branch removed (others: see fork rows) |
| Fork-network commit that exists but is not a member | github.test.ts › SEC-GH-11 a fork-network commit that exists (GET /commits/{sha} is 200) is NOT_A_MEMBER for the PR and the branch | any listed commit accepted; compare against the caller's name; compare verdict ignored |
| SHA as branch name / `refs/` / tag / missing branch / renamed branch | github.test.ts › SEC-GH-11 a SHA-shaped branch name …; › SEC-GH-11 refs/ names …; › SEC-GH-11 a tag name …; › SEC-GH-11 a branch that does not exist …; › SEC-GH-11 a renamed branch (301) … | SHA rule removed; refs/ rule removed; branch 404 treated as member; 3xx not treated as NOT_A_MEMBER |
| Rate-limit mapping | github.test.ts › SEC-GH-14 a primary rate limit (403, remaining 0) …; › SEC-GH-14 a secondary limit with retry-after: 60 …; › 429 is RATE_LIMITED; 403 without rate-limit headers and 5xx are UPSTREAM | only 429 limited; 429 not limited |
| 401 → token deleted, link revoked, `GITHUB_NOT_LINKED`, metric `unauthorized`, attributable log line | github.test.ts › 401 deletes the token, revokes the link and throws GITHUB_NOT_LINKED (never UPSTREAM) | 401 mapping removed; metric removed; user id dropped from the log line |
| Decrypt failure → same, metric `decrypt_failed` (access row, refresh row, in-lock re-read) | github-tokens.test.ts › SEC-GH-06 ciphertexts swapped …; › SEC-GH-07 a key removed from configuration …; › decrypt failures on the refresh path › an expired access token with a refresh row under an unknown key id …; › … refresh ciphertext swapped from another user …; › an access token found fresh under the row lock but undecryptable … | revocation mapped to UPSTREAM; refresh-row DecryptError catch removed; in-lock DecryptError catch removed |
| Rejected refresh → same, metric `refresh_rejected`, attributable log line | github-tokens.test.ts › a rejected refresh deletes the tokens, revokes the link and throws GITHUB_NOT_LINKED (never UPSTREAM) | revocation mapped to UPSTREAM; user id dropped from the log line |
| GitHub response validation failures, generic messages | github.test.ts › a malformed SHA, an oversize title, a wrong type or non-JSON is UPSTREAM; › SEC-GH-15 UPSTREAM messages are generic … | schema parse removed; body/value appended to the status, refused and parse messages |
| GitHub 2 MiB response cap | github.test.ts › SEC-GH-15 a schema-valid response above 2 MiB is cut off while streaming and is UPSTREAM; the same shape below the cap passes | cap raised to 64 MiB; streamed cap ×1000; Content-Length pre-check removed |
| Content put / get | content-store.test.ts › SEC-EVID-03 computes sha256 and the raw CID server-side and stores the bytes | (direct round-trip assertions on identify()) |
| Content idempotency + pin enqueue | content-store.test.ts › is idempotent: the same bytes twice keep one row, one pin item and the first declared media type | ON CONFLICT updates the media type; pin insert removed |
| Content size cap | content-store.test.ts › rejects content above maxBytes or above one raw block (262144 bytes) … | maxBytes check removed |
| Blocked content never returned | content-store.test.ts › SEC-EVID-11 blocked content is never returned by get, has or retrieve; hidden content still is | moderation check removed from get; from retrieve |
| Retrieve digest mismatch | content-store.test.ts › SEC-EVID-09 rejects bytes whose digest does not match and tries the next gateway; › … on every gateway returns null and stores nothing | digest check removed |
| Retrieve redirect refusal | content-store.test.ts › SEC-EVID-09 refuses redirects: the Location is never fetched; › treats a 3xx answered despite redirect: error as a failure too; gateways.test.ts › a 3xx returned despite redirect: error is refused by the client itself (kind redirect) … | `redirect: "follow"` (content-store); client 3xx refusal removed (gateways.test.ts — the content-store "3xx answered" test survives that mutation because retrieve also accepts only status 200: two guards) |
| Retrieve size cap | content-store.test.ts › caps the streamed response at maxBytes even without Content-Length | cap 10 MB |
| Pin outbox CID mismatch (every returned CID) | content-store.test.ts › a Kubo CID that differs …; › a pinning-service CID that differs …; › a Kubo pin/add answer naming another CID (alone or among two) …; › a Kubo block/put answer with the right CID but another size …; › an existing pin listed by the pinning service under another CID … | each of the five checks removed / loosened |
| Content server headers | content-server.test.ts › SEC-EVID-06 serves bytes as an attachment with the sandbox headers, never inline | CSP removed; inline disposition; nosniff removed; text/html content type |
| Content server 451 | content-server.test.ts › SEC-EVID-11 answers 451 for blocked content without the bytes | 451 branch removed |
| Content server 404 | content-server.test.ts › answers 404 for absent content and malformed digests | (direct assertions) |
| Content server no Set-Cookie, only `/c/:sha256` | content-server.test.ts › SEC-EVID-07 serves nothing but GET/HEAD /c/:sha256 and never sets cookies | a cookie set in onSend; an extra route |
| Chain finalized-hash mismatch | chain.test.ts › throws an integrity error when the secondary has another hash at the finalized number | hash comparison removed |

## PRD-02 section 3a (gateways lane)

| Required behaviour / test | Test file › test name | Mutation (test fails) |
|---|---|---|
| Pin outbox per-target completion (both orders) | content-store.test.ts › PRD-02 3a per-target completion: … only Kubo was configured …; › … only the pinning service was configured … | selection reduced to one target's flag (each order) |
| `pinned` means both targets (schema) | content-store.test.ts › 'pinned' requires both targets: the database refuses a pinned row with an unconfirmed target | (constraint asserted directly) |
| `0002_` backfill | migrations.test.ts › reopens items closed as pinned before a target was configured, keeping each confirmed target done | (platform-006 mutation; unchanged) |
| Exhaustive job list (3 jobs, no refresh job — PRD-02 3b wording) | jobs.test.ts › the gateways run exactly three jobs, all covered below (no background token-refresh job exists) | (list asserted directly) |
| Pin outbox stops when aborted before / during a batch | jobs.test.ts › pin outbox job › aborted before the batch …; › aborted during a batch …; › an abort cancels the request in flight … | pre-batch check removed; abort branch removed; job signal not passed to the request |
| Token re-encryption stops when aborted before / during | jobs.test.ts › token re-encryption job › aborted before the batch …; › aborted during a batch … | in-batch check removed |
| OAuth-state purge stops when aborted before / during | jobs.test.ts › OAuth-state purge job › aborted before …; › aborted during the purge … | loop signal check removed |
| Tolerant timing tests (≥ 1 s slack) | github.test.ts › SEC-GH-14 caps concurrent GitHub calls across all users at 90 (waits up to 10 s, then 1 s more); jobs.test.ts `< 5 s` for a 50 ms abort; gateways.test.ts timeout window 150 ms – 1.5 s for a 200 ms timeout; RPC timeout test uses fake timers | n/a |

## Operator coverage gaps (operator-coverage-gaps-platform-gateways.md, operator-settled for platform-007)

| # | Gap | Test file › test name | Mutation (test fails) |
|---|---|---|---|
| 1 P1 | GitHub REST 2 MiB cap | github.test.ts › SEC-GH-15 a schema-valid response above 2 MiB is cut off while streaming … (a) streamed, reader stops ≤ 2 MiB + 2 chunks; (b) Content-Length above the cap refused before reading; (c) just under 2 MiB passes | cap 64 MiB; streamed check ×1000; Content-Length check removed |
| 2 P1 | 10 s timeout on every outbound request; hangs fail | gateways.test.ts › a request whose upstream never answers fails at the timeout as a network error; › every request through buildGateways carries a 10 s timeout signal; timeouts.test.ts › GitHub REST, the token endpoint, an IPFS gateway, Kubo and the pinning service are all called with 10_000 ms; › a GitHub API that never answers is UPSTREAM …, and frees its concurrency slots; › a token endpoint that never answers …; › a hung first IPFS gateway times out and retrieve uses the second one; › a hung Kubo node counts a failed attempt … | timeout signal that never fires; default 600 s; job requests without the timeout |
| 3 P2 | OAuth state valid 10 minutes (literal) | github-auth.test.ts › SEC-GH-03 a state is valid for exactly 10 minutes …; purge test uses the literal too | TTL constant 24 h |
| 4 P2 | Refresh-path decrypt failures | github-tokens.test.ts › decrypt failures on the refresh path (3 tests) | refresh-row catch removed (2 tests); in-lock catch removed |
| 5 P2 | Each user's own token; per-user single-flight | github-tokens.test.ts › per-user tokens › interleaved concurrent calls of two users each carry only their own token, also across a refresh | single-flight map keyed by a constant |
| 6 P2 | Re-encryption reports the remaining count | jobs.test.ts › token re-encryption job › aborted during a batch (exact lines "1 re-encrypted … 3 remain", then "… 0 remain") | count reported as 0 |
| 7 P2 | Persisted pin errors redacted | content-store.test.ts › failure messages carrying a secret are redacted before they are persisted in last_error or logged | `String(error)` instead of `safeErrorMessage` |
| 8 P2 | Generic UPSTREAM messages | github.test.ts › SEC-GH-15 UPSTREAM messages are generic … | body appended to status / refused / parse messages |
| 9 P2 | Every returned CID checked | content-store.test.ts › a Kubo pin/add answer naming another CID …; › a Kubo block/put answer with the right CID but another size …; › an existing pin listed by the pinning service under another CID … | pin/add check removed or loosened to `some`; size check removed; list check removed |
| 10 P2 | `createContentServer()` wiring, listen and close | content-store.test.ts › gateways.createContentServer() over the Postgres store › listens, serves …, 451 for blocked, 404 otherwise, never a cookie, and closes | server wired to a store without moderation; close() a no-op |
| 11 P2 | RPC transports: 10 s timeout, limited retries | gateways.test.ts › PRD-02 3.3 an RPC answering HTTP 500 is retried a limited number of times (3 requests) …; › PRD-02 3.3 each RPC attempt is aborted after exactly 10 s … (viem retries timeouts, so a hung RPC fails after ≤ 3 × 10 s, not 10 s) | retryCount 5; timeout 60 s |
| 12 P2 | Concurrent link race → CONFLICT | github-auth.test.ts › one GitHub id per Pine user under a concurrent link › the partial-unique-index race inside complete() is CONFLICT … | 23505 mapping removed |
| 13 P2 | Revocation log line attributable (user id + reason) | github-auth.test.ts › SEC-GH-10 a valid github_app_authorization revocation …; github.test.ts › 401 deletes the token …; github-tokens.test.ts › a rejected refresh deletes … | user id dropped from the line |
| 14 P2 | Bounded token-endpoint / revocation / Kubo / PSA responses; token-endpoint validation | github-auth.test.ts › token endpoint and revocation responses are bounded and validated (4 tests); github-tokens.test.ts › SEC-GH-15 an oversize token-endpoint answer to a refresh …; content-store.test.ts › Kubo and pinning-service answers above 64 KiB are retryable failures … | token-endpoint cap 64 MiB (4 tests); token_type refine removed; token charset removed; pin cap 64 MiB |
| 15 P2 | OAuth App links with an empty `X-OAuth-Scopes` | github-auth.test.ts › OAuth App fallback (SEC-GH-04) › links when X-OAuth-Scopes is present and empty … | empty header treated as missing |
| 16 P2 | Re-encryption never overwrites a concurrent refresh | github-tokens.test.ts › re-encryption never overwrites a concurrent refresh › a refresh that rewrites the rows between the job's read and write wins … | compare-and-set conditions removed |

## Other PRD-02 section 3 behaviours

| Behaviour | Test file › test name | Mutation (test fails) |
|---|---|---|
| Unlink revokes the grant (client credentials, fresh token), then deletes locally; failure counted | github-auth.test.ts › unlink (SEC-GH-10) › revokes the whole grant …; › refreshes an expired access token first …; › still deletes the local ciphertext when GitHub is unreachable … | token endpoint instead of grant; no refresh before revoking; failure not counted |
| Webhook revocation deletes tokens (metric `webhook`); non-signature errors are ordinary errors | github-auth.test.ts › SEC-GH-10 a valid github_app_authorization revocation …; › other failures after a valid signature are ordinary errors … | revocation loop removed; metric removed |
| Stale revoked webhook after a quick re-link (accepted fail-safe) | github-auth.test.ts › accepted fail-safe: a stale revoked webhook … | (behaviour asserted directly) |
| One GitHub id per user (sequential) | github-auth.test.ts › one GitHub id maps to one Pine user …; the in-transaction holder check is backed by the partial unique index, so removing the check alone keeps CONFLICT (verified: mutation survives by design); the race row (#12) covers the index path | — |
| `listPublicRepos` refreshes the login with `GET /user` first; another account revokes | github.test.ts › refreshes the login with GET /user first …; › SEC-GH-05 a token answering for another GitHub account revokes the link | stored login used; account check removed |
| GitHub headers, redirects refused | github.test.ts afterEach (origin, redirect mode, Accept, X-GitHub-Api-Version on every call); › a GitHub redirect is refused (UPSTREAM) … | API-version header removed; `redirect: "follow"` |
| Only configured hosts | gateways.test.ts › refuses any origin that is not configured, before fetching | allowlist check removed |
| `buildGateways` checks `eth_chainId` on both transports | chain.test.ts › checks eth_chainId on both providers at startup; gateways.test.ts › refuses to start when an RPC reports another chain | chain id check removed |
| RPC errors redacted | chain.test.ts › redacts RPC URLs and keys from every error; gateways.test.ts › PRD-02 3.3 an RPC answering HTTP 500 … | raw error rethrown |
| No token in any log line | github-auth.test.ts › SEC-GH-08 no token reaches a log line …; webhook test | (assertion on every line) |
| No in-app rate limit on the content server | content-server.test.ts › has no in-app per-IP rate limit … | n/a (absence) |
| listPullCommits stops at 250 | github.test.ts › listPullCommits pages 100 at a time and stops at 250 | limit 1000 |

## decisions.md (operator-settled choices this lane keeps)

| Decision | Test file › test name |
|---|---|
| GitHub App with zero permissions by default, OAuth App with no scopes as fallback; PKCE S256 | github-auth.test.ts › the OAuth App fallback requests no scopes; › OAuth App fallback (SEC-GH-04) › links when X-OAuth-Scopes is present and empty …; › builds an authorization URL with PKCE S256 … |
| One GitHub id per user (`CONFLICT`) | github-auth.test.ts › one GitHub id maps to one Pine user …; › the partial-unique-index race inside complete() is CONFLICT … |
| Tokens AES-256-GCM with key rotation; core reads identities only through `identityOf` | crypto.test.ts (all); github-tokens.test.ts › SEC-GH-07 the re-encryption job …; › re-encryption never overwrites a concurrent refresh … |
| Content ≤ 262144 bytes in Postgres; pins via an outbox to Kubo and a Pinning Service API provider | content-store.test.ts › rejects content above …; › puts the raw block into Kubo, pins it, asks the pinning service … |
| User content only on the separate content server | content-server.test.ts (all); content-store.test.ts › gateways.createContentServer() over the Postgres store … |
| Two RPC providers must agree on the finalized hash | chain.test.ts › throws an integrity error when the secondary has another hash …; › throws when the secondary does not have the block |
| Gateways never write `audit_log`; core audits gateway-backed security events | gateways.test.ts › gateway production sources › never touch audit_log … |
| Revocation channel `GITHUB_NOT_LINKED` + `metrics.increment("github_link_revoked", { reason })` for `unauthorized`, `decrypt_failed`, `refresh_rejected`, `webhook` | rows 401 / decrypt / refresh / webhook above |
| Webhook bad/missing signature → `ApiError("UNAUTHENTICATED")`; other failures ordinary errors | github-auth.test.ts › SEC-GH-10 rejects a missing, malformed or wrong signature …; › … when no secret is configured; › other failures after a valid signature … |
| Webhook-driven revocations are carried by metric and log (no audit row) | github-auth.test.ts › SEC-GH-10 a valid github_app_authorization revocation … (exact log line with user id and reason) |
| Branch membership resolves a real branch (platform-004 P1); renamed branch 301 → NOT_A_MEMBER | SEC-GH-11 rows above |
| Unlink revokes the grant, not only the token | github-auth.test.ts › revokes the whole grant at GitHub … |
| Stale revoked webhook after a quick re-link deletes the new tokens (accepted fail-safe) | github-auth.test.ts › accepted fail-safe … |
| Jobs check `signal` between batches; gateways run exactly three jobs (pin outbox, re-encryption, OAuth-state purge); token refresh on demand and single-flight per user | jobs.test.ts (all); github-tokens.test.ts single-flight and per-user tests |
| Pin outbox per-target completion; `0002_` migration, 0001 never edited | content-store.test.ts per-target rows; migrations.test.ts |
| I/O injection via `buildGateways(deps, io)` (`fetch` + two viem transports); `createGateways` checks `eth_chainId` on both | testing/harness.ts › createHarness → buildGateways; gateways.test.ts createGateways tests |
| Gateway migrations never mention `pine_api` | gateways.test.ts › never name the pine_api role … |
| Production code never imports from `testing/` | gateways.test.ts › gateway production sources › never import from a testing/ directory |
| Content server has no in-app per-IP rate limit (edge proxy) | content-server.test.ts › has no in-app per-IP rate limit … |
| Inside transactions only the transaction handle is used | No dedicated test: a nested `db` call would deadlock PGlite and hang the store/refresh tests (accepted design rule) |
| PGlite serialises queries: race-freedom of refresh/link statements comes from their FOR UPDATE / single-statement shape, not from tests (accepted); races that matter are staged deterministically (#12, #16, in-lock re-check) | — |
| Core-lane decisions (SIWE, sessions, CSRF, leases, rate limits, sanctions, metrics adapter, migrations runner, grants, redaction secret list) | Not in this lane; covered by platform-core |
