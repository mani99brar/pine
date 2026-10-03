# Coverage matrix: indexer-envio and read-model-envio (indexers-004)

Every requirement of PRD-05 sections 3.1, 3.2, 3a and 3b (Envio lane), the operator gap file, and every decision of `features/indexers/decisions.md`
that applies to this lane, mapped to the test that would fail if the behaviour were removed. Paths are relative to
`packages/`. `IE` = `indexer-envio/test/`, `RM` = `read-model-envio/test/`. Gate: `pnpm --filter @pine/indexer-envio test`
(unit-envio) and `pnpm --filter @pine/read-model-envio test` (unit-read-model), each one full run.

## PRD-05 3.1 indexer-envio

| Requirement | Test file › test name |
|---|---|
| config.yaml: chain 100, the five contracts, the events of `chain-events.ts` | IE `config.test.ts` › "declares exactly the chain-events.ts sources, each signature equal to the shared ABI (names, order, types, indexed)" |
| Event signatures pinned to `@pine/shared/abi/{external,generated}` (names, order, indexed, topic0) | IE `config.test.ts` › same test |
| External addresses from `GNOSIS_EXTERNAL`; Pine registries from env with scenario placeholder defaults | IE `config.test.ts` › "pins external addresses to GNOSIS_EXTERNAL and defaults Pine registries to the scenario placeholders" |
| `rollback_on_reorg: true`, `block_lag` ≈ 40 default, `max_reorg_depth`, lowercase addresses, transaction hash field selection | IE `config.test.ts` › "SEC-IDX-03 indexes Gnosis with reorg rollback (depth 200), a ~40 block lag, lowercase addresses and transaction hashes" |
| `field_selection` with block hash and transaction hash (block hash is an Envio default) | IE `config.test.ts` › "selects the block hash and the transaction hash for every event (Envio's generated event types expose both)" (reads the codegen output; a dropped field is typed `FieldNotSelected`) |
| RPC fallback from env, HyperSync token optional; start block from env | IE `config.test.ts` › "configures the RPC from env as a fallback to HyperSync, with Pine registries and start block from env" |
| Every id/block/logIndex/timestamp/amount/bond/repositoryId is `BigInt`; lists are `Json` | RM `queries.test.ts` › "stores every number the read model returns as BigInt and lists as Json (decisions.md)" |
| Schema entities mirror the records; field names the read model queries exist | RM `queries.test.ts` › "<Entity> has every queried field" (one per entity) |
| Handlers implement the reference semantics on every frozen scenario (field by field vs `MemoryReadModel`) | IE `entities.test.ts` › "<scenario>: entities equal the reference records and the committed snapshot" (claims-and-evidence, oracle, many-claims) |
| Deterministic handlers (run twice by Envio; batches and re-runs give the same rows) | IE `entities.test.ts` › "SEC-IDX-04 <scenario>: processing in several batches, or again from scratch, gives identical entities" |
| Replaying a processed range into the same store changes nothing (no double counting of `answerCount`, bounty, stages) | IE `entities.test.ts` › "SEC-IDX-04 <scenario>: re-submitting an already processed range to the same store is refused and changes nothing (no double counting)" (every batch of every scenario) |
| No external calls, clocks, randomness or effects in handlers | IE `static.test.ts` › "SEC-IDX-03 no handler source performs I/O, reads clocks or randomness, or calls Envio effects"; "SEC-IDX-03 handler sources import only envio, viem and each other" (every import form, via `ts.preProcessFile`); "the import check sees every import form (multi-line, side-effect, re-export, dynamic, require)"; "process.env is read only once, for the question timeout" |
| Untracked ids ignored by entity lookup — every event kind | IE `handlers.test.ts` › "events of untracked ids create no rows and only advance the progress marker" (LogNewAnswer, LogAnswerReveal, LogNotifyOfArbitrationRequest, LogCancelArbitration, LogFinalize, LogFundAnswerBounty, ConditionResolution, ArbitrationFinished, then a later LogNewAnswer still ignored; zero rows in every entity); "duplicates, …" (LogReopenQuestion of an untracked question, RequestNotified, the ids of a duplicate ClaimCreated) |
| Reference edge cases (first-wins duplicates incl. a duplicate ClaimCreated naming new ids, reveal/commitment linking via viem keccak, reopen, Kleros stages, first-wins resolution, publication over a committed submission ignored) | IE `handlers.test.ts` › "duplicates, superseded reveals, reopen into a tracked question, Kleros stages and first-wins resolution match the reference" |
| Lowercase hex ids, hashes and addresses whatever the input case | IE `handlers.test.ts` › "mixed-case ids, answers, hashes and checksummed addresses are stored lowercase, as the reference stores them"; RM `validation.test.ts` › "sends a checksummed submitter filter lowercased"; RM `read-model.test.ts` › "builds evidence, oracle, arbitration and resolution lookups by lowercase id" |
| Decoded Pine values outside the frozen `ChainEvent` domain halt (repositoryId, deadlines, bytes20 commit, every evidence timestamp) | IE `handlers.test.ts` › "SEC-IDX ClaimCreated with <label> stops processing" (repositoryId 0 / 2^53, evidenceDeadline 2^53, revealDeadline 2^64−1); "SEC-IDX ClaimCreated whose commit is not bytes20 (<label>) stops processing" (3); "SEC-IDX EvidenceCommitted with committedAt 2^53 stops processing"; "SEC-IDX EvidenceRevealed with revealedAt 2^53 / committedAt 2^53 on a committed submission stops processing and leaves it committed"; "SEC-IDX EvidencePublished with publishedAt 2^53 stops processing"; boundaries "a repositoryId of exactly 2^53 - 1 is accepted", "evidence timestamps of exactly 2^53 - 1 are accepted" |
| Third-party values accepted in their full on-chain domain (no third-party event can halt) | IE `handlers.test.ts` › "third-party values of tracked ids are stored in their full on-chain domain (no third-party event can halt)" |
| Look-alike contract ignored (SEC-IDX-05), every source | IE `handlers.test.ts` › "SEC-IDX-05 an identical event from a look-alike contract never reaches a handler" (ClaimCreated); "SEC-IDX-05 tracked-id events of every other source from a look-alike contract never reach a handler (the genuine ones apply)" (EvidenceCommitted, EvidencePublished, LogNewAnswer, LogNotifyOfArbitrationRequest, LogFinalize, LogReopenQuestion, ConditionResolution, ArbitratorAnswered, RequestNotified, each with a control that the genuine event changes entities); IE `static.test.ts` › "SEC-IDX-05 no handler registration accepts events from any address (no `wildcard`)" |
| Block timestamps, not event-carried values (SEC-IDX-10) | IE `handlers.test.ts` › "SEC-IDX-10 createdAt, resolvedAt and arbitration times are block timestamps, not values carried in the event" |
| Committed entity snapshots per scenario: sorted, decimal bigints, events SHA-256; rewritten only with `UPDATE_SNAPSHOTS=1` | IE `entities.test.ts` › "<scenario>: entities equal … and the committed snapshot"; IE `static.test.ts` › "sort entities and rows by id, …"; "the events hash changes with any event field …"; "are written only with UPDATE_SNAPSHOTS=1; otherwise the committed file is read and never touched" |
| Question timeout from env, validated at load | IE `static.test.ts` › "defaults to Seer's 302400 s and accepts positive integers"; "refuses anything else (fail closed at load)" |
| …reaches the handlers (timeout, finalizeTs) | IE `timeout.test.ts` › "a configured timeout of 86400 s sets every question's timeout and finalizeTs = ts + 86400, as the reference computes" (scenarioOracle vs `MemoryReadModel({ questionTimeout: 86400 })`) |
| …an invalid value stops processing | IE `timeout-invalid.test.ts` › "an invalid value stops processing before any entity is written" |

## PRD-05 3.2 read-model-envio

| Requirement | Test file › test name |
|---|---|
| Conformance suite against the in-test Hasura fake | RM `conformance.test.ts` › `describeReadModelConformance("envio", …)` (every frozen-suite test) |
| Fake serves only the snapshots the real handlers produced, bound to the events' SHA-256 (factory throws otherwise) | RM `package.test.ts` › "there is exactly one committed snapshot per frozen scenario, each bound to that scenario's events"; "the factory throws for events whose SHA-256 differs from every recorded hash" |
| Hasura semantics stated and tested (numerics as strings, `_gt`/`_lt` on numerics, `order_by`, `limit`, errors) | RM `fake-hasura.test.ts` › all seven tests |
| Query construction (where/order_by/limit, keyset, variables only, lowercase ids) | RM `read-model.test.ts` › "posts only to the configured URL, …"; "builds listClaims filters, keyset and order …"; "builds evidence, oracle, arbitration and resolution lookups by lowercase id"; "SEC-OPS-14 sends exactly one POST per call, …"; "rejects limits outside 1..100 and non-integer deadlines before any request"; RM `validation.test.ts` › "rejects deadline filters that are not safe integers, before any request" (both bounds; 1.5, NaN, ±2^53, ∞); "sends a checksummed submitter filter lowercased" |
| Options validated (timeoutMs 1..120000, chainId, maxResponseBytes positive integers) | RM `validation.test.ts` › "refuses an invalid timeoutMs, chainId or maxResponseBytes with code configuration, without echoing the value" |
| Opaque cursors; invalid → `InvalidCursorError`, before any request, every scope | RM `read-model.test.ts` › "reject garbage, tampered keys and cursors of another order with InvalidCursorError"; RM `validation.test.ts` › "listEvidence rejects forged evidence-scope cursors with InvalidCursorError before any request"; "listClaims rejects evidence_deadline_asc cursors with a bad deadline or market part before any request" |
| zod-validated responses (validation failures), every row kind | RM `read-model.test.ts` › "SEC-IDX-05 rejects a claim row with <label>" (8 cases); "rejects an evidence row whose id does not match registry:submissionId"; "rejects malformed Json lists (markets, payout numerators)"; "accepts safe-integer JSON numbers for numeric columns …"; "SEC-OPS-02 fails closed on <label> with a redacted error" (8 cases); RM `validation.test.ts` › "<Entity>: rejects <label> (invalid_response, redacted)" for OracleQuestion (13), OracleAnswer (10), Arbitration (7), ArbitrationStage (7), EvidenceSubmission via getEvidence (10) and listEvidence (3), ConditionResolution (8): uppercase addresses/hashes, non-hex32, unsafe and negative numbers, unknown enums, wrong JSON types, missing fields; plus "<Entity>: the untouched row validates" controls |
| 10 s timeout | RM `read-model.test.ts` › "SEC-OPS-02 aborts after the timeout (10 s by default) …"; "SEC-OPS-02 the timeout covers a body that stalls after the headers, even if fetch ignores the abort signal" |
| Redacted errors (no URL, secret, response body or row text, GraphQL error text, underlying message; no `cause`) | RM `read-model.test.ts` › "SEC-OPS-02 surfaces GraphQL errors by count only, never their text"; "SEC-OPS-02 never rethrows a fetch error …"; every `expectRedacted` assertion; RM `validation.test.ts` › "an invalid row's untrusted text (title, rejection reason) never reaches the error, which names only the failing field"; "no error code chains a cause or carries request or response details" (network, timeout, http, too_large, invalid_json, graphql, invalid_response, too_many_rows, configuration) |
| The production fetch path (no `fetch` option: `globalThis.fetch`) posts once to the URL, `redirect: "error"`, abort signal, streamed body | RM `validation.test.ts` › "POSTs once to the configured URL with redirects refused and an abort signal, and reads the body as a stream"; "maps a fetch TypeError (as fetch raises on a redirect) to code network, redacted" |
| `status()` from `_meta` and the progress singleton; `halted: false` | RM `read-model.test.ts` › "reads _meta for the configured chain and the progress singleton"; "SEC-IDX-07 never reports an indexed block below the last applied event, …"; "fails closed when the endpoint does not index the configured chain or answers malformed metadata"; RM `validation.test.ts` › "rejects an unsafe, negative or non-decimal progress timestamp or block, and a negative or non-numeric head" |
| "`halted: false` unless the endpoint reports errors": an endpoint error makes `status()` throw (fail closed) instead of answering | RM `read-model.test.ts` › "an endpoint reporting GraphQL errors makes status() throw: it never answers halted: false over an error" |
| `test:live` exists, runs the live config, excluded from `test` | RM `package.test.ts` › "exists, runs the live config, and is not part of `test`" |
| `test:live` actually runs the conformance queries and is not vacuous (the script itself, run as `package.json` defines it) | RM `live-script.test.ts` › "passes against the Hasura fake serving the <scenario> rows over HTTP" (all three snapshots; asserts every read-model operation reached the endpoint); "fails against an endpoint that answers GraphQL errors"; "refuses to run without ENVIO_GRAPHQL_URL instead of passing vacuously" (exit code ≠ 0 and the message) |

## PRD-05 3a (indexers-002 review fixes, this lane)

| Requirement | Test file › test name |
|---|---|
| Reject a `graphqlUrl` with userinfo | RM `read-model.test.ts` › "SEC-OPS-14 refuses a graphqlUrl with userinfo (user and password, user only, password only) without echoing it" |
| Refuse http:// with an admin secret unless `allowInsecureTransport: true` | RM `read-model.test.ts` › "SEC-OPS-14 refuses an admin secret over http:// unless allowInsecureTransport is exactly true" |
| …never derived from NODE_ENV/VITEST | RM `read-model.test.ts` › "the insecure-transport refusal does not depend on the environment (this run has VITEST and NODE_ENV=test set)" |
| Response read as a stream with a byte cap | RM `read-model.test.ts` › "SEC-OPS-02 reads the body as a stream and cancels it once the byte cap is exceeded (never buffers it whole)"; "the cap counts UTF-8 bytes, not characters (8 MiB by default)"; "cancels the body of a non-2xx response instead of reading it" |
| Read-only Hasura role for the API documented | `read-model-envio/README.md` › "Hasura access for the API (read-only role)" (documentation; no Hasura in tests — see untested) |
| Unpaginated lists: explicit limit 10,000 + 1 extra row, throw when exceeded; documented divergence | RM `read-model.test.ts` › "ListOracleAnswers / ListClaimsByQuestion / GetArbitration returns exactly 10,000 rows and throws too_many_rows at 10,001 (never a silent truncation)"; "builds evidence, oracle, arbitration and resolution lookups by lowercase id" (limit 10,001 in the variables); "with the default byte cap, an oversized whole list still fails closed (too_large before the row cap)"; "the cap does not apply to paginated lists, …"; README "Lists returned whole" |
| Production refuses placeholder addresses / start block (fail-closed start script, the only entry point) | IE `start.test.ts` › "refuses to start without the Pine registry addresses and start block (the config.yaml defaults)"; "refuses either placeholder address in either variable, in any letter case"; "refuses malformed, zero, third-party and identical registry addresses"; "refuses start block 0 (the placeholder) and anything that is not a positive integer"; "run as a process with the placeholder defaults, it exits 1 before starting Envio"; "never launches envio when the check fails, and reports each refusal"; "`start` is the only package script that starts Envio, and it runs the check"; "the placeholder and external lists are those of config.yaml, SCENARIO_ADDRESSES and GNOSIS_EXTERNAL" |
| `ENVIO_BLOCK_LAG` ≥ 40 enforced by the same script | IE `start.test.ts` › "refuses a lag below 40 (including the test value 0) or a malformed one; accepts 40 and above"; "defaults ENVIO_BLOCK_LAG to 40 and sets it explicitly for envio"; "the bound matches config.yaml's default lag"; "launches `envio start` (the pinned package's bin) with the validated environment and returns its exit code" |
| Docs: never `envio start` directly; single data source unless HyperSync or a verified RPC (launch gate); untracked-id spam | `indexer-envio/README.md` › "Starting: `pnpm --filter @pine/indexer-envio start` only", "Operational notes"; runtime warning pinned by IE `start.test.ts` › "warns that a run without HyperSync trusts one unverified source"; https RPC by "requires an https RPC URL when one is configured and never echoes it" |
| `schema.graphql` has no list-typed fields | IE `static.test.ts` › "has no list-typed fields (no Postgres arrays; lists are Json, PRD-05 3.1/3a)"; "declares no @derivedFrom (virtual list) fields" |

## decisions.md (lane-relevant entries)

| Decision | Test file › test name |
|---|---|
| Reference semantics are the specification; the frozen conformance suite is the oracle | IE `entities.test.ts` (all); RM `conformance.test.ts` |
| Envio is the optional backend (rollback on reorg, block lag ≈ 40); `test:live` is its launch gate | IE `config.test.ts` › "SEC-IDX-03 indexes Gnosis with reorg rollback …"; IE `start.test.ts` block-lag tests; RM `package.test.ts` › "exists, runs the live config, …" |
| Each indexer owns its storage; nothing imports `@pine/api` | IE `static.test.ts` › "nothing in indexer-envio or read-model-envio imports @pine/api (decisions.md)" |
| `viem` is a direct dependency of `@pine/indexer-envio` (keccak) | IE `static.test.ts` › "SEC-IDX-03 handler sources import only envio, viem and each other"; IE `handlers.test.ts` › reference edge cases (reveal → commitment id) |
| Envio fake serves committed snapshots from the real handlers (sorted, decimal bigints, event-hash bound, `UPDATE_SNAPSHOTS=1` only) | see 3.1 snapshot row and RM `package.test.ts` snapshot-binding tests |
| Envio cannot filter by tracked id: spam only slows the optional backend (documented) | `indexer-envio/README.md` › "Spam on untracked ids" (documentation) |
| BigInt everywhere, no Postgres arrays; config.yaml signatures pinned to the shared ABIs | RM `queries.test.ts` › "stores every number … as BigInt and lists as Json"; IE `static.test.ts` › "has no list-typed fields …"; IE `config.test.ts` › "declares exactly the chain-events.ts sources, …" |
| Decoded values outside the frozen `ChainEvent` domain halt | IE `handlers.test.ts` › describe "handlers: Pine events outside the frozen ChainEvent domain halt": every check of `ClaimRegistry.ts` and `EvidenceRegistry.ts` has a test (see the 3.1 row) |
| Test memory: cross-process lock for `createTestIndexer` files; gate passes as one full run | IE `static.test.ts` › "every test file that runs createTestIndexer imports the cross-process lock first (decisions.md, test memory)"; the gate itself |
| …the lock's rules: atomic mkdir with the owner pid, a dead or same-process owner taken over, a live owner waited for, release only by the owner | IE `lock.test.ts` › "takes a free lock and records this process as the owner; release removes it"; "waits while another live process holds it, and takes it over once that process is dead"; "takes over a lock left by an earlier file of this same process"; "takes over a stale directory without a pid file, but not a fresh one …"; "never releases a lock another process owns"; "waits up to 30 minutes by default, …" |
| Native-only decisions (two RPC providers, roles, poller plan, chunking, cursor guard, driver portability) | not applicable to this lane |

## PRD-05 3b (indexers-003 review fixes, this lane)

| Requirement | Test file › test name |
|---|---|
| `scripts/start.mjs` forwards SIGTERM/SIGINT to the `envio start` child (stub child) | IE `start.test.ts` › "forwards SIGTERM and SIGINT to the envio child while it runs, and only exits when the child exits, with its code"; "forwards every repeated signal (a second Ctrl-C reaches envio too)"; "installs the handlers only while the child runs and removes them when it exits" |
| …and exits with the child's code | IE `start.test.ts` › "exits with the child's own code after a forwarded signal …"; "a child killed by a signal exits 128 + the signal number"; "launches `envio start` (the pinned package's bin) with the validated environment and returns its exit code"; "a child that cannot be started exits 1, removes the handlers and does not print the spawn error"; "an error of a running child (a failed kill) does not end the wrapper while envio still runs" |
| …in a real process (default signal source `process`, a signal sent to the wrapper's PID only) | IE `start.test.ts` › "as a real process, a SIGTERM sent only to the wrapper's PID reaches the child and the wrapper exits with the child's code" |
| The start script prints the single-source warning when it launches without HyperSync | IE `start.test.ts` › "logs the single-source warning and still launches envio when no HyperSync token is set" |

## Operator gap file (`operator-coverage-gaps-indexer-envio.md`)

Received from the operator during the run (after the 2-minute check). Every item is closed; each test below was
checked by applying the item's mutation to the source and seeing the test fail (sources restored afterwards).

| # | Gap | Closed by (test file › test name) |
|---|---|---|
| 1 (P1) | SEC-IDX-05 look-alike emitters for every source | IE `handlers.test.ts` › "SEC-IDX-05 tracked-id events of every other source from a look-alike contract never reach a handler (the genuine ones apply)"; IE `static.test.ts` › "SEC-IDX-05 no handler registration accepts events from any address (no `wildcard`)" — kills `wildcard: true` on LogNewAnswer, LogFinalize, ConditionResolution, EvidenceCommitted, ArbitratorAnswered |
| 2 (P1) | Untracked ids for LogNotifyOfArbitrationRequest, LogCancelArbitration, LogFinalize | IE `handlers.test.ts` › "events of untracked ids create no rows and only advance the progress marker" — kills an unconditional `OracleQuestion.set` in each guard |
| 3 (P1) | Domain halts for EvidenceRevealed (committedAt, revealedAt), EvidencePublished, the bytes20 commit | IE `handlers.test.ts` › "SEC-IDX EvidenceRevealed with revealedAt 2^53 …", "… committedAt 2^53 …", "SEC-IDX EvidencePublished with publishedAt 2^53 stops processing", "SEC-IDX ClaimCreated whose commit is not bytes20 (…) stops processing", "evidence timestamps of exactly 2^53 - 1 are accepted" |
| 4 (P1) | zod validation of every row kind | RM `validation.test.ts` › describe "response validation of every row kind (SEC-IDX-05, read-model side)" — kills each loosening listed (answerer, ts, bestAnswer, finalizeTs, stage, stage txHash, submitter, status, resolvedAt, resolution txHash) |
| 5 (P1) | Forged cursors of every scope | RM `validation.test.ts` › "listEvidence rejects forged evidence-scope cursors …"; "listClaims rejects evidence_deadline_asc cursors with a bad deadline or market part …" |
| 6 (P2) | Default `globalThis.fetch` path | RM `validation.test.ts` › "POSTs once to the configured URL with redirects refused …"; "maps a fetch TypeError … to code network, redacted" — kills `redirect: "follow"` in the default wrapper |
| 7 (P2) | Redaction of row text, no `cause` for any code | RM `validation.test.ts` › "an invalid row's untrusted text … never reaches the error …"; "no error code chains a cause or carries request or response details" — kills appending the rows to the message and chaining a cause |
| 8 (P2) | SEC-IDX-06 `eth_chainId` at startup | Code: `scripts/start.mjs` verifies eth_chainId == 100 on the RPC Envio uses (`ENVIO_GNOSIS_RPC_URL` or the config.yaml default) before launching, fail closed. IE `start.test.ts` › describe "start script: chain id (SEC-IDX-06)": "launches only after the RPC Envio will use answers eth_chainId 0x64 …"; "refuses another chain (exit 1, no launch, the URL never echoed)"; "refuses when the RPC fails to answer, without echoing the URL or the error"; "fetchChainId sends one eth_chainId POST with redirects refused and a timeout, …"; "fetchChainId throws on an HTTP error, …". HyperSync's own chain selection is Envio's (by chain id 100). |
| 9 (P2) | ENVIO_QUESTION_TIMEOUT reaches the handlers; invalid fails | IE `timeout.test.ts`; IE `timeout-invalid.test.ts` — kills a hard-coded `302_400n` and a lenient parser |
| 10 (P2) | SEC-IDX-04 replay into the same store | IE `entities.test.ts` › "SEC-IDX-04 <scenario>: re-submitting an already processed range to the same store is refused and changes nothing (no double counting)" |
| 11 (P2) | SEC-IDX-07 status metadata validation | RM `validation.test.ts` › "rejects an unsafe, negative or non-decimal progress timestamp or block, and a negative or non-numeric head" — kills accepting an unsafe timestamp and a negative sourceBlock |
| 12 (P2) | Import allowlist sees every import form | IE `static.test.ts` › "SEC-IDX-03 handler sources import only envio, viem and each other"; "the import check sees every import form …" — kills a multi-line `node:https` import and a bare `import "node:https"` |
| 13 (P2) | Duplicate ClaimCreated naming new ids; EvidencePublished over a committed submission | IE `handlers.test.ts` › "duplicates, superseded reveals, …" (new edge events and explicit assertions) — kills both mutations |
| 14 (P2) | Lowercasing of mixed-case input | IE `handlers.test.ts` › "mixed-case ids, answers, hashes and checksummed addresses are stored lowercase, …"; RM `validation.test.ts` › "sends a checksummed submitter filter lowercased" — kills an identity `lower` and the unlowercased submitter |
| 15 (P2) | Query input and option validation | RM `validation.test.ts` › "rejects deadline filters that are not safe integers, before any request"; "refuses an invalid timeoutMs, chainId or maxResponseBytes …" |
| 16 (P2) | `test:live` refuses without URL (executed, not grepped) | RM `live-script.test.ts` › "refuses to run without ENVIO_GRAPHQL_URL instead of passing vacuously" (spawns the script; non-zero exit, the message, no passed test) plus the pass/fail runs against the fake over HTTP |
| 17 (P2) | SEC-IDX-03 reorg scenario | Not testable in-lane (`createTestIndexer` forces rollback off: "TestIndexer: Rollback is not supported", maxReorgDepth 0; the frozen suite has no reorg). Recorded as an operator-settled exception (choice 8 below) with a reorg/rollback drill added to the Envio launch gate next to `test:live` (`README.md`, "Launch gate"). In-lane the config pinning stays: IE `config.test.ts` › "SEC-IDX-03 indexes Gnosis with reorg rollback (depth 200), …" |
| 18 (P2) | SEC-IDX table; overstated rows corrected | the "SEC-IDX" table below; rows for untracked ids, domain halts, zod validation, cursors, question timeout and look-alikes rewritten above |

## SEC-IDX (docs/security/requirements.md section 8) for the Envio option

| Id | Envio lane coverage |
|---|---|
| SEC-IDX-01 finality | Envio does not track finality: `status().finalizedBlock` is `null` (RM `read-model.test.ts` › "reads _meta for the configured chain and the progress singleton"); rows are served `block_lag` ≥ 40 behind the head (IE `start.test.ts` › block-lag tests; IE `config.test.ts` › "SEC-IDX-03 …"). Per-record finality is not available: launch-gate item (README). |
| SEC-IDX-02 native reorg handling | native lane only |
| SEC-IDX-03 rollback_on_reorg, max_reorg_depth, no handler side effects | IE `config.test.ts` › "SEC-IDX-03 indexes Gnosis with reorg rollback (depth 200), …"; IE `static.test.ts` › "SEC-IDX-03 no handler source performs I/O, …", "SEC-IDX-03 handler sources import only envio, viem and each other". The reorg scenario itself: operator-settled exception + launch-gate drill (gap 17). |
| SEC-IDX-04 idempotent replay | IE `entities.test.ts` › "SEC-IDX-04 <scenario>: processing in several batches, or again from scratch, …"; "SEC-IDX-04 <scenario>: re-submitting an already processed range to the same store is refused and changes nothing …" |
| SEC-IDX-05 exact addresses, strict decoding, zod | IE `handlers.test.ts` look-alike tests (every source); IE `static.test.ts` › "… no `wildcard`"; IE `config.test.ts` signature/address pinning; RM `validation.test.ts` and `read-model.test.ts` row validation |
| SEC-IDX-06 eth_chainId at startup; ≥ 2 providers | chain id: IE `start.test.ts` › describe "start script: chain id (SEC-IDX-06)". Two providers / finalized-hash cross-check: not possible in Envio 3.12.1 (one source); documented single-source launch-gate item, with the runtime warning tested by IE `start.test.ts` › "warns that a run without HyperSync trusts one unverified source" |
| SEC-IDX-07 staleness | RM `read-model.test.ts` › "reads _meta …", "SEC-IDX-07 never reports an indexed block below the last applied event, …"; RM `validation.test.ts` › "rejects an unsafe, negative or non-decimal progress timestamp …". `lagSeconds`/`status: ok|lagging|stalled` are not fields of the frozen `IndexerStatus`; derived by the API (feature `assembly`) |
| SEC-IDX-08 NewMarket cross-verification | not in PRD-05 or the frozen `ChainEvent` set; not applicable to this lane |
| SEC-IDX-09 shared conformance suite | RM `conformance.test.ts` › `describeReadModelConformance("envio", …)`; the suite has no reorg scenario (gap 17) |
| SEC-IDX-10 block timestamps | IE `handlers.test.ts` › "SEC-IDX-10 createdAt, resolvedAt and arbitration times are block timestamps, …" |
| SEC-IDX-11 read-only role | Hasura select-only role for the API documented (`read-model-envio/README.md`, "Hasura access for the API"); no Hasura in tests: launch-gate item |
| SEC-IDX-12 cross-implementation digest | SHOULD, staging job; not in this lane |

## Operator-settled choices (kept from indexers-002 and indexers-003, plus the indexers-004 gap file)

1. `test:live` is live smoke only: every read-model query succeeds against `ENVIO_GRAPHQL_URL`, responses validate,
   `status()` parses, pagination is ordered and non-overlapping (a real deployment never indexed the frozen scenarios).
2. Handlers maintain the `IndexerProgress` singleton (last applied block and timestamp, updated by every event including
   ignored ones); `status()` reads it with `_meta`; Envio metadata names live only in `src/envio-meta.ts`, unverified until
   the live gate.
3. Errors are built from fixed text, the operation name, HTTP status and counts only; no `cause` is chained; tests assert
   the URL (with its query-string key) and the admin secret never appear.
4. `config.yaml` event signatures are checked against `@pine/shared/abi` (names, order, types, indexed, topic0); topic0
   verification against real logs is the native lane's job.
5. `createTestIndexer` test files take the cross-process lock (`test/lock.ts`, lock dir `pine-indexer-envio-tests.lock`,
   rules in `test/lock-core.ts`), enforced by a static test and unit-tested by `test/lock.test.ts`.
6. `block_lag: ${ENVIO_BLOCK_LAG:-40}` with `ENVIO_BLOCK_LAG=0` in `vitest.config.ts` only (simulate never reaches a
   lagged head); production lag ≥ 40 is now enforced by `scripts/start.mjs`.

7. `status()` never reports `halted: true`: Envio exposes no halt flag; an endpoint error makes `status()` throw, and a
   handler error (domain violation) stops `indexedBlock` from advancing (monitor lag).
8. (gap file, item 17) The SEC-IDX-03 reorg scenario cannot run in-lane (`createTestIndexer` has no rollback); it is an
   accepted exception, and a reorg/rollback drill against a real deployment is part of the Envio launch gate next to
   `test:live`.
9. (gap file, item 8) `scripts/start.mjs` verifies `eth_chainId` (100) of the RPC Envio will use before launching and
   refuses on a mismatch or an RPC failure; the second-provider requirement of SEC-IDX-06 stays a launch-gate item.
10. (gap file, items 1–7 and 9–16) Closed with tests only; no handler or read-model semantics changed.

## Untested here (and why)

- Reorg rollback: `createTestIndexer` disables rollback and the frozen suite has no reorg (operator-settled exception,
  launch-gate drill).
- `fetchChainId` against a real RPC (tests stub `fetch`); HyperSync's chain selection.
- A real Hasura endpoint: `_meta` names, numeric serialization, `<Entity>_bool_exp`/`_order_by` names, the read-only role
  and its row limit (≥ 10,001), Hasura permission behaviour. Covered only by `test:live` and the launch gate.
- `envio start` itself (needs Postgres/Hasura); the start script is tested up to the launch call, as a refusing process,
  and as a signal-forwarding process with a stub child instead of Envio. How Envio itself shuts down on SIGTERM/SIGINT
  is not tested.
- `test:live` against a real deployment: its run against the fake (over HTTP) proves the script, not Envio's real
  `_meta` names or Hasura behaviour.
- Envio decoding of real Gnosis logs (simulate passes decoded params); HyperSync/RPC fallback behaviour.
