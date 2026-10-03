# Coverage matrix: composition lane (PRD-06 sections 3 and 3a)

Every requirement of PRD-06 sections 3 and 3a and every assembly decision that concerns this lane, mapped to the test that fails
when the behaviour is removed. Files are in `packages/api/test/e2e/`. "PG" = runs only with `PINE_E2E_DATABASE_URL`
(required with `PINE_E2E_REQUIRE_PG=1`); everything else runs on both PGlite and PostgreSQL 16.

## src/readmodel.ts

| Requirement | Test |
|---|---|
| `kind === "native"` selects `@pine/indexer-native` over the read-only connection | readmodel.test.ts › native read model › "serves the indexed scenario through the factory…"; every journey/negative test (the app's read model comes from `buildReadModel`) |
| native with a pg pool on the read-only URL (production I/O) | readmodel.test.ts › "createReadModel (production I/O) reads as pine_readonly…" (PG) |
| `kind === "envio"` selects `@pine/read-model-envio` | readmodel.test.ts › "selects the Envio client for kind envio…" |
| backend chain id equals the config's (native: no foreign cursor; Envio: endpoint indexes the chain) | readmodel.test.ts › "refuses a native index that holds another chain's cursor", "refuses an Envio endpoint that indexes another chain…" |
| kind and `PINE_INDEXER_BACKEND` agree | readmodel.test.ts › "refuses when the connection kind and PINE_INDEXER_BACKEND disagree" |
| index schema = this build's migrations (fail closed) | readmodel.test.ts › "refuses an index whose migrations are not exactly this build's…" |
| no URL / admin secret in refusals | readmodel.test.ts › the two "refuses…" Envio/migration tests, "…a refused login does not echo the URL or password" (PG) |

## Database (decision: real PostgreSQL 16 with the production driver when configured)

| Requirement | Test |
|---|---|
| `PINE_E2E_REQUIRE_PG=1` without a URL fails the suite | deploy-assets.test.ts › "runs on PostgreSQL 16 when PINE_E2E_DATABASE_URL is set…"; `databaseMode()` is called by every database-backed file (`openE2eDatabase`, concurrency.test.ts at collection) |
| the PGlite configuration is verified on its own | policy check `e2e-pglite` (the whole suite with both variables unset; PG-only cases skip, the PGlite placeholder runs) |
| fresh `pine_e2e_<hex>` per file, roles pre-created WITH LOGIN (deploy/postgres/00-roles.sql), database from 01-database.sql | support/database.ts `openPostgres` (every PG run); a failure of either SQL file fails every file's `beforeAll` |
| the database is dropped afterwards | database-cleanup.test.ts › "creates its own pine_e2e_<hex> database and drops it on close (gone from pg_database)" (PG; checked to fail when the drop is removed) |
| a failed `DROP DATABASE` is reported (afterAll fails, redacted), never swallowed | end to end: database-cleanup.test.ts › "fails the harness's close() with a redacted message when the drop really fails (template database)" (PG: `createE2e()`, `ALTER DATABASE … IS_TEMPLATE true`, `e2e.close()` must reject with `DROP DATABASE pine_e2e_… failed: … template database` and no secret; fails if support/app.ts `closeAll` or support/database.ts swallows the drop error); helpers: "reports a failed DROP DATABASE with a redacted message (forced failure)", "closeE2eDatabase fails when the drop fails…", "closeE2eDatabase reports a failed admin end…", "refuses to drop a database the setup did not create"; every file awaits `close()` in `afterAll` |
| `bootstrapRoles` refuses a non-loopback cluster unless `PINE_E2E_DISPOSABLE_CLUSTER=1` | through the real entry point: database-cleanup.test.ts › "refuses a non-loopback cluster before contacting it, without echoing the URL or its password" (`openE2eDatabase(env)`; `openPostgres` runs `assertDisposableCluster` before connecting and before `bootstrapRoles`; both modes); URL edge cases: "accepts the loopback hosts 127.0.0.1, ::1 and localhost", "refuses remote hosts, look-alike hosts, host overrides, sockets and non-postgres URLs", "accepts any cluster only with PINE_E2E_DISPOSABLE_CLUSTER=1 exactly", "throws without echoing the URL or its password"; CI's URL passes the guard: deploy-assets.test.ts › "runs the e2e suite on a postgres:16 service…" |
| migrations of the API and the indexer run as the database owner, through the real migrate commands | support/database.ts (`src/migrate.ts` `main`, `@pine/indexer-native/migrate-cli` `main`, as `pine_migrator`) |
| API as `pine_api` (production `connect`), read model as `pine_readonly`, indexer as `pine_indexer`; grants incl. DML on gateways/claims/markets/funding tables | readmodel.test.ts › "SEC-IDX-11 pine_readonly can only read pine_index; pine_api has DML…" (PG); journey.test.ts writes every module's tables as `pine_api` (PG) |
| draft delete racing a first publication (no 500, no deadlock to the client) | concurrency.test.ts › "PRD-03 §8b a draft delete racing a first publication…" (PG) |
| concurrent quota consumption at the limit (never over-consumed) | concurrency.test.ts › "SEC-EVID-01 concurrent uploads at the quota limit…" (PG) |
| two job runners competing for one lease (at most one runs) | concurrency.test.ts › "PRD-02 2.5 two API processes competing for one job lease…" (PG) |
| two identical publication requests (one row) | concurrency.test.ts › "PRD-03 §6 identical concurrent publication requests create one row and one plan…" (PG) |

## Journey (SPEC section 3), journey.test.ts

| Step | Test |
|---|---|
| SIWE login (cookie attributes, terms accepted) | "signs in with SIWE…" |
| GitHub link (fake GitHub; PKCE S256; session rotation) | "links GitHub through the OAuth App flow…" |
| draft, preview | "saves a draft and previews the immutable claim document…" |
| publication plan (verified), idempotent | "returns a verified createClaim publication plan…" |
| simulated ClaimCreated, reconciliation to `confirmed` | "reconciles the simulated ClaimCreated to `confirmed`…" |
| integrity `verified`, listing, agent feed | "verifies the claim's integrity, lists it publicly and in the agent feed" |
| funding ladder plan verified, after the SEC-LEGAL-03 risk acknowledgement (an acknowledgement below the computed maximum loss is refused with 409 and the fresh figures, no plan; the accepted figures are echoed in the plan details) | "returns a verified YES-ladder funding plan…" |
| allowance bound at plan level (decision 6): the plan's only approval goes to the position manager and equals exactly the mint's desired amounts (planned residual 0; fails if the approval grows) | "returns a verified YES-ladder funding plan…" (`approve[1] - (amount0Desired + amount1Desired) === 0n`, one approve selector in the plan) |
| allowance bound on chain (decision 6): residual after the real mint at most 10 wei, only toward the position manager (Algebra rounding) | NOT this lane: contracts/test/e2e/E2EScenarioBase.sol › `test_replayedFunding_ladderMintSwapAndPayoutsAfterYes` (`MAX_RESIDUAL_ALLOWANCE`), deploy-e2e lane, fork job |
| evidence manifest upload, commit plan, client-side reveal, simulated reveal, user-content download | "stores an evidence manifest and artifact, returns a verified commit plan…" |
| oracle status and due actions (the public status is cached per market and account for `ORACLE_CACHE_SECONDS`, PRD-04 4a: a read right after the simulated answer still shows the cached state; the answer shows after the TTL) | "reports oracle status and due actions…" |
| simulated resolution | "finalizes, returns a verified resolve plan…" |
| redeem plan | "returns a verified redeem plan for the winning outcome tokens" |
| every plan verifies after `planFromWire` | support/app.ts `request()` runs `planFromWire` + `verifyPlan` on every candidate plan of every response (a failure throws in the step); harness.test.ts › "finds malformed plans so that planFromWire rejects them…" proves malformed plans are not skipped; final journey test asserts the count |
| no secret in any response, log line or stored error | "verified every plan of every response, and leaked no secret…" (journey, negative, concurrency) |

## Negative paths, negative.test.ts

| Path | Test |
|---|---|
| CSRF | "SEC-AUTH-14 refuses unsafe requests without the custom header…" |
| stale read model -> NOT_READY | "SEC-IDX-07 answers NOT_READY for every plan while the read model lags…" |
| halted read model -> NOT_READY | "SEC-IDX-07 answers NOT_READY while the indexer is halted…" |
| SC-001 disabled | "SEC-LEGAL-09 refuses an SC-001 draft even when the configuration lists the family" |
| blocked content (451) | "SEC-EVID-12 an admin block makes the user-content host answer 451…", "SEC-OPS-06 a blocked claim document leaves only metadata…" |
| compliance refusal (451) | "SEC-LEGAL-02 refuses every plan for a screened wallet…", "SEC-LEGAL-01 refuses publication and funding from a blocked country…" |
| cookies ignored on public routes | "SEC-AGENT-04 returns identical cookie-free responses…" |
| no secret in responses/logs (RPC outage embedding URL and key) | "SEC-OPS-03 an RPC outage whose error embeds the provider URL and key…" and the final leak test |

## Deployment assets, README, runbooks, CI (deploy-assets.test.ts)

Every row was checked by mutating the asset (23 mutations: removed trigger, moved fork command, removed job env or step
guard, a `secrets` job-level `if`, non-loopback CI URL, `log_format` back in a server block, removed limits, query in the
log format, removed `ssl_protocols`, swapped upstream, missing include, Caddy rate limit/log import/`respond` ordering,
shared OS user, wrong file mode): each made the file fail.

| Requirement | Test |
|---|---|
| env templates without secrets, valid under production rules | "SEC-OPS-01 deploy/env/api.env plus a filled secrets template…", "…refuse the template with SC-001 enabled or with draft policies", "deploy/env/indexer.env…", "deploy/env/migrate.secrets.env.example…" |
| systemd units (api, indexer-native, migrate oneshot), hardened, existing entry points | "cover migrations (oneshot), the API and the native indexer, hardened", "start existing entry points…" |
| SEC-OPS-10: one OS user per unit (pine-api, pine-indexer, pine-migrate) | "SEC-OPS-10 runs every unit as its own unprivileged OS user and group" |
| SEC-OPS-10: each secrets file 0640 root:<unit user>, env headers and deploy/README.md agree, no file shared between units | "SEC-OPS-10 makes each secrets file readable only by its unit's user…" |
| nginx: `log_format` (and the other http-context directives) only in deploy/proxy/nginx-http.conf; deploy/README.md documents both includes, in order | "keeps log_format and the other http-context directives out of server blocks (nginx -t), in nginx-http.conf" |
| proxy: same-origin API, separate user-content host (another registrable domain) | "the API configuration they serve is same-origin…"; nginx and Caddy "serves the web app and the API on one origin and user content only from its own host" |
| proxy: per-IP limits on the user-content host | nginx and Caddy "applies per-IP limits on the user-content host" |
| proxy: TLS | nginx "terminates TLS (1.2/1.3 only, HSTS) and redirects plain HTTP"; Caddy "terminates TLS for both hosts…" |
| proxy: no query strings in access logs | nginx "logs no query strings: every server logs with pine_noquery…"; Caddy "logs no query strings: both hosts import the snippet…" |
| CI on push and pull_request | "runs on both push and pull_request, never pull_request_target" |
| CI: pinned action SHAs, `permissions: contents: read` | "pins every action to a full commit SHA and keeps the token read-only" |
| CI: fork/e2e forge commands only in the fork job; job-level env maps `GNOSIS_RPC_URL: ${{ secrets.GNOSIS_RPC_URL }}`; steps guarded `if: env.GNOSIS_RPC_URL != ''`; no `secrets` in any job-level `if`, no gate job; no other job references the secret; other jobs run only the offline registry forge suites | "runs the GNOSIS_RPC_URL fork commands only in the fork job…" |
| CI: e2e on a postgres:16 service with `PINE_E2E_REQUIRE_PG=1`, URL accepted by the role guard | "runs the e2e suite on a postgres:16 service…" |
| CI: gitleaks over the whole history (checksum-pinned binary, `.github/workflows/gitleaks.toml`) | "scans the whole history with a checksum-pinned gitleaks…" (static only, see below) |
| CI: every controller check, `pnpm audit --prod` (high), forbidden gate, frozen install, pnpm 12.8.1 | "runs every controller check of every feature, pnpm audit and the forbidden gate" |
| README and docs commands and links match the code | "documents only pnpm scripts that exist", "links only to files that exist" |
| release checklist lists every launch gate; no submitted code; anvil fork with throwaway keys | "the release checklist lists every launch gate of PRD-06 section 3…" |

## Not covered by an executed check

- The nginx and Caddy examples are checked statically only (no nginx or caddy on the verification host or in CI): run
  `nginx -t` / `caddy validate` on the proxy host.
- The CI workflow is parsed and checked statically here; it runs only on GitHub (no actionlint on the host).
- gitleaks is not installed on the verification host: the `secrets` job and the release checklist's green-CI gate are its
  only checks. It was last run locally (gitleaks 8.30.1, whole history, no findings) in run assembly-002, before the
  later merges; whether the allowlist passes on the current history is unverified.
- Kubo and pinning setup (`deploy/ipfs`), backup and restore procedures: documentation, exercised by the operator.
