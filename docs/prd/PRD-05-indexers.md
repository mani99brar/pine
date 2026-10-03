# PRD-05: Indexers (feature `indexers`)

Implements ADR-0001 D12 and SEC-IDX: two interchangeable read-model backends behind the frozen `ReadModel`
(`packages/shared/src/read-model.ts`), with the event semantics fixed by the executable reference
(`packages/shared/src/testing/memory-read-model.ts`) and the conformance suite (`testing/read-model-conformance.ts`) over the
frozen scenarios (`testing/read-model-scenarios.ts`). Event sources and tracked-id rules: `packages/shared/src/chain-events.ts`.
ABIs: `@pine/shared/abi/generated` (Pine), `@pine/shared/abi/external` (Reality v3, CTF, Kleros home proxy). Addresses:
`GNOSIS_EXTERNAL` plus the Pine deployment from configuration.

## 1. Lanes and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `indexer-native` | `packages/indexer-native` |
| `indexer-envio` | `packages/indexer-envio`, `packages/read-model-envio` |
Dependencies are frozen in each `package.json`; do not add any. Neither lane edits `packages/shared` or `packages/api`.

## 2. indexer-native (primary, production)
### 2.1 Layering
1. `apply` layer: `applyEvents(tx, events: ChainEvent[])` — pure SQL translation of the reference semantics (every case of
   `MemoryReadModel.applyOne`, including ignore rules for untracked ids, first-wins for duplicates, reveal/commit-id linking,
   arbitrator answers, reopen tracking, bounty, Kleros stages). Idempotent through a cursor-position guard: inside its
   transaction it skips every event at or before the stored cursor position (block, logIndex), so re-applying a range is a no-op;
   no per-event rows are persisted (a new `0002_` migration drops the candidate's `applied_events` table; never edit `0001`).
2. `read model`: `createNativeReadModel(pool | pglite)` implementing every `ReadModel` method with SQL (stable cursors,
   `InvalidCursorError`, `limit` 1..100) and `status()` from the cursor table (`halted`, `finalizedBlock`, `headBlock`).
3. `ingest`: the poller (RPC → decode → apply). It never writes except through `apply` and the cursor/halt tables.
### 2.2 Storage
Own Postgres schema `pine_index` with its own ordered, checksummed SQL migrations and a tiny runner (same rules as the API
runner: append-only, advisory lock, refuse modified/out-of-order/orphan files); a `migrate` script; runtime role needs DML only.
Roles (SEC-IDX-11), created idempotently by the migrations (`DO $$ ... IF NOT EXISTS (SELECT FROM pg_roles ...) THEN CREATE ROLE
... NOLOGIN`; production pre-creates them with LOGIN): `pine_indexer` gets USAGE on `pine_index` and SELECT/INSERT/UPDATE/DELETE on
its tables and sequences (by name plus `ALTER DEFAULT PRIVILEGES IN SCHEMA pine_index`), never DDL; `pine_readonly` (the API's
read-model connection) gets USAGE and SELECT only. Tests use `SET ROLE` on PGlite (verified to enforce grants): an INSERT as
`pine_readonly` fails with 42501, DML as `pine_indexer` works, `CREATE TABLE pine_index.x` as `pine_indexer` fails. Database
portability: tests run on PGlite, production on node-postgres, so code never reads `rowCount`/`affectedRows` and raw SQL casts
int8 and counts explicitly.
### 2.3 Ingestion (finalized only; SEC-IDX-01/02/04/05/06)
- Each cycle: read `finalized` block (number and hash) from both RPC providers; `target = min(numbers)`; both providers must
  report the same hash for `target`, else record a halt (`rpc_disagreement`) and stop advancing (alert via metrics and logs).
- Fetch `[cursor + 1, min(target, cursor + chunk)]` (chunk default 500) with a request PLAN filtered to what Pine tracks, so
  third-party spam on untracked questions is never requested (anyone can emit cheap Reality/CTF logs):
  1. ClaimRegistry, EvidenceRegistry and Kleros home-proxy logs of their known topic0s, unfiltered (only Pine and arbitration
     activity, which is costly to spam).
  2. The tracked-id set as of the range end: stored tracked questions/conditions + those of this range's ClaimCreated + reopen
     replacements found with `LogReopenQuestion` filtered on topic2 (the reopened, already tracked id; the NEW id is topic1);
     repeat the reopen query for newly found ids until nothing new appears, at most 8 rounds; if ids are still appearing, cut the
     processed range at the block of the last reopen found and continue in the next cycle.
  3. Reality logs of the needed topic0s filtered on topic1 ∈ tracked question ids, and CTF `ConditionResolution` filtered on
     topic1 ∈ tracked condition ids, with OR-lists chunked to 100 ids per request.
  Decode strictly with viem `decodeEventLog` (`strict: true`) and validate with zod (a log that does not decode under its topic0 is
  an integrity error: halt). Merge ALL logs of the range, sort by (blockNumber, logIndex) and apply them in ONE `applyEvents` call
  (never apply the registry part first: the cursor guard would then skip lower-logIndex Reality logs). Required poller tests: a
  range with ClaimCreated, then LogReopenQuestion, then an answer and a Kleros event on the replacement id ends with the replacement
  tracked and both events applied; spam answers on an untracked question are never requested.
- Volume on TRACKED ids (e.g. zero-value bounty loops on a Pine question, up to ~5k logs per 17M-gas block) never halts or stalls:
  only size-type failures split ("too many results", "range too large", response-size errors, timeouts, or a response above the
  parser caps of 16 MB / 20,000 logs, which exceed one block's worst case); the range is halved down to ONE block. Other errors
  (429, 5xx, network) retry the SAME request with capped backoff, and the cycle gives up at the first request still failing. The
  request plan is shared: when either provider forces a split, the refined plan is executed on BOTH providers and the
  cross-check compares the results of the same plan. Operations docs require providers returning ≥ 10,000 logs per response.
- The PROCESSED range is adaptive, so memory and transaction size stay bounded whatever the flood volume (spam on a tracked
  question can reach ~2.5k logs per block at the EIP-1559 gas target): the primary is read in sub-chunks until a cumulative cap
  of 50,000 logs or 32 MB is reached; the range is cut at the last whole block under the cap (minimum one block); the secondary
  runs exactly that truncated plan; the logs are applied and the cursor advanced to the cut block in one transaction. Test a flood
  range that is processed over several cycles with bounded memory.
- A difference between providers is re-checked before halting: wait 10 s and re-fetch the same plan from BOTH providers (at most
  3 times; load-balanced RPCs can briefly return `[]` from a lagging backend); halt only if the difference persists.
- Verify every log's `blockHash` against the canonical header of its block (headers fetched only for blocks that contain logs,
  plus the range end; they also give each event its `blockTimestamp`); re-run the same single-pass query on the secondary provider
  for EVERY range processed (every range of at least one block, whether or not the primary returned logs) and require the identical
  full set of `(blockHash, logIndex, topics, data)`; any difference, including the primary returning nothing where the secondary
  returns logs, → halt (`log_disagreement`). A faulty primary therefore cannot hide an oracle answer. Required tests: the primary
  omits a tracked Reality answer (halt) and the secondary omits one (halt).
- Validation scope: strict ABI decoding applies to every fetched log (a log the contract itself emitted cannot fail it, so a
  failure is a provider fault → halt). The zod schemas accept the full on-chain domain of each external field (bigint for uint256,
  no casing or string-content rules on third-party data; Reality `ts` is the block timestamp and CTF bounds outcome slots to 256),
  so no third-party event can halt the indexer through validation.
- Logs are requested only for the exact configured addresses; a log with a known topic0 from any other address is ignored
  (SEC-IDX-05). Decoded values must lie in the domain the frozen `ChainEvent` types allow; the ClaimRegistry guarantees that domain
  for Pine events (e.g. `1 <= repositoryId <= 2^53 - 1`, enforced on-chain by the chain hardening run), so a violation is a
  contract or provider fault and halts.
- Apply the range and advance the cursor (block number and hash) in **one** transaction; record per-block hashes for blocks
  that contained events. On startup, re-verify the stored cursor hash against both providers (mismatch → halt `finalized_conflict`).
- Back off on RPC errors (exponential, capped), redact every error string (RPC URLs embed keys), expose Prometheus metrics
  (indexed block, finalized block, lag seconds, cycles, errors, halted) and `/healthz` `/readyz` on a configurable internal port.
- `src/main.ts` process entry with zod-validated env (fail closed): database URL, two RPC URLs, chain id 100, Pine registry and
  evidence registry addresses and deployment block, Reality/CTF/home-proxy addresses (defaults from `GNOSIS_EXTERNAL`), question
  timeout (302400), poll interval, metrics port.
### 2.4 Tests
- `describeReadModelConformance("native", factory)` where the factory opens a fresh PGlite per call (the suite calls it several
  times per file; close each in teardown; the file holds the test lock throughout), runs migrations, applies the scenario events
  through `applyEvents` (the same function the poller uses) and advances the cursor to the last event's block with the same
  cursor function the poller uses (the suite asserts `status().indexedBlock`).
- Poller with a scripted RPC: both-provider agreement, disagreement halt, finalized lag, two-phase tracked ids within one range,
  range chunking, idempotent re-run of a range, crash between apply and cursor impossible (single transaction; simulate a throw),
  log/header hash mismatch halt, strict decoding failure halt, startup cursor re-verification, startup `eth_chainId` mismatch on
  either provider refused (SEC-IDX-06), a look-alike contract emitting an identical event ignored (SEC-IDX-05), the secondary
  omitting a tracked Reality answer → halt, and the role grants above (SEC-IDX-11).
- Decoding fixtures: real Gnosis logs (raw topics/data captured with `cast logs` during development and committed as JSON) for
  Reality `LogNewAnswer`, `LogNotifyOfArbitrationRequest`, `LogFinalize`, CTF `ConditionResolution` and a Kleros home-proxy event,
  decoded into the expected `ChainEvent`s (proves topic0 and field order against real chain data). Proxy events are rare (none in
  2000 recent blocks): search a bounded window (e.g. the last 2 million blocks in 50,000-block steps); if none is found, use a log
  ABI-encoded with viem from the shared ABI, marked synthetic in the fixture, and record the gap.

## 3. indexer-envio (option) and read-model-envio
### 3.1 indexer-envio (Envio HyperIndex v3, envio 3.12.1)
- `config.yaml` for chain 100: contracts ClaimRegistry, EvidenceRegistry (addresses and start block from env), RealityETH, CTF and
  KlerosHomeProxy (addresses from `GNOSIS_EXTERNAL`), the events of `chain-events.ts`, `field_selection` with block hash and
  transaction hash, `rollback_on_reorg: true`, a confirmation lag (`block_lag` ≈ 40 blocks) so served rows are effectively final,
  RPC fallback configured from env (HyperSync token optional).
- Types: every id, block number, log index, timestamp, amount, bond and `repositoryId` is `BigInt` (Envio maps `Int` to Postgres
  int4); `Int` only for small enums and counts. Lists that the read model returns (payout numerators, market lists) are stored as
  child entities or `Json`, never Postgres arrays, so the read-model fake does not depend on unverified Hasura array encoding.
- A test parses `config.yaml` and checks every event signature (names, parameter order, indexed flags) against
  `@pine/shared/abi/external` and `generated` (`simulate` passes decoded params, so nothing else would notice a mismatch).
- `schema.graphql` entities mirroring the read-model records (Claim, EvidenceSubmission, OracleQuestion, OracleAnswer,
  Arbitration + ArbitrationStage, ConditionResolution, TrackedQuestion/TrackedCondition), lowercase hex ids.
- Handlers implement the reference semantics exactly; they are deterministic, make no external calls (Envio runs handlers twice:
  preload and processing), and ignore events for untracked ids by entity lookup. `viem` is a direct dependency of
  `@pine/indexer-envio` (added by the operator for `keccak256`/`encodePacked`, e.g. the reveal's commitment id).
- `config.yaml` addresses: Pine registry addresses come from env with the scenario placeholder addresses as defaults so `envio
  codegen` and tests run without env; the README and deploy docs state that production must set them (a run with placeholders
  indexes nothing).
- Tests (vitest, `createTestIndexer()`, no Docker): for each frozen scenario, convert the `ChainEvent`s to simulated Envio events
  with explicit block numbers/log indexes, process them, and assert the resulting entities equal the records of
  `MemoryReadModel` for the same events (field by field, after mapping). The same tests compare the actual entity rows per
  scenario with a committed JSON snapshot (`packages/read-model-envio/test/fixtures/<scenario>.entities.json`: rows sorted by entity
  and id, bigints as decimal strings, plus the SHA-256 of the scenario's events); they rewrite it only when `UPDATE_SNAPSHOTS=1` is
  set, so a gate run never dirties the worktree and fails on any difference.
### 3.2 read-model-envio
- `createEnvioReadModel({ graphqlUrl, adminSecret?, fetch })` implementing `ReadModel` with Hasura GraphQL queries over the entities
  (where/order_by/limit, keyset pagination encoded in opaque cursors), zod-validated responses, 10 s timeouts, redacted errors, and
  `status()` from `_meta` / `chain_metadata` (indexed block, head, `halted: false` unless the endpoint reports errors).
- Tests: the conformance suite with a factory that builds a fake GraphQL endpoint (an in-test `fetch` serving the lane's own
  queries from the committed entity snapshots that the indexer-envio handlers actually produced, never from rows mapped by hand;
  the factory recomputes the SHA-256 of the events it receives and throws unless it equals the snapshot's recorded hash),
  with Hasura semantics stated and tested (numerics and bigints as strings, `_gt`/`_lt` on numerics, `order_by`, `limit`), plus
  unit tests of query construction and validation failures. A `test:live` script (excluded from the default test run) runs the conformance queries against a real Envio endpoint
  given `ENVIO_GRAPHQL_URL`; running it against a real deployment is a launch gate for choosing the Envio option.

## 3a. indexers-002 review fixes (carried by indexers-003)
indexer-native:
- Log volume, idempotency and the request plan: see section 2.1 and 2.3 (tracked-id-filtered plan, size-type splitting to one
  block with a plan shared by both providers, cursor-position guard, `applied_events` dropped by a `0002_` migration).
- `decodeCursor` bounds key parts to the int8/int4 ranges in the zod schema (crafted cursors → `InvalidCursorError`, never a
  database error).
- `main.ts`: every startup step, including `pool.connect()` and connection-string parsing, runs inside the try that logs through
  the redactor; the top-level call has a handler (no unhandled rejection prints a raw error).
- RPC providers must be independent: the last two DNS labels of their hostnames (a registrable-domain heuristic; no public-suffix
  list is available under the frozen dependencies) must differ, documented as a heuristic; production requires https.
- Decided (recorded): the zod domain checks run on every decoded external log before tracking is decided; they cannot fail for
  contract-emitted logs (Reality `ts` is the block timestamp, CTF bounds outcome slots to 256), so they cannot be used to halt.
- Required additional tests: a PRIMARY-side stored-cursor hash mismatch halts; the range-end header of a logless chunk is
  cross-checked; a secondary differing only in topics or only in blockHash halts; headers are fetched only for blocks with logs plus
  the range end (assert the recorded calls); `main.ts` wiring (DB errors redacted; the process advisory lock and the migration
  runner's advisory lock are tested with a stub executor that records the lock statements and reports "not acquired", because
  PGlite has one session and cannot show lock contention; real-Postgres behaviour is covered by the assembly e2e); the node-postgres executor rolls back and releases the client when the callback throws (stub
  Pool/PoolClient).
indexer-envio and read-model-envio:
- read-model-envio rejects a `graphqlUrl` with userinfo and refuses http:// when an admin secret is set unless the explicit option
  `allowInsecureTransport: true` is passed (tests only; never derived from NODE_ENV/VITEST); reads the response as a stream with a
  byte cap; documents a read-only Hasura role for the API; list queries without pagination send an explicit limit of 10,000 and
  request one extra row, throwing when exceeded (documented divergence from the native backend, which has no cap).
- indexer-envio: production must not run with the placeholder addresses or start block (fail-closed check in the package's start
  script, the only supported entry point; docs say never to invoke `envio start` directly); `ENVIO_BLOCK_LAG` has a lower bound
  (≥ 40) enforced by the same script; docs state that the
  Envio option trusts one data source unless HyperSync or a second verified RPC is configured, which is part of its launch gate.
- A test pins that `schema.graphql` has no list-typed fields.

## 3b. indexers-003 review fixes (carried by indexers-004)
indexer-native:
- The ACTIVE filter set is pruned: questions that are finalized, not pending arbitration and not settled too soon, and conditions
  already resolved, are excluded from every log request (they stay in the database), so the per-cycle request count tracks only
  live claims; test that a finalized question is no longer requested and a reopened or arbitrated one still is.
- Single-response anomalies from one provider (a log outside the requested range, a duplicate log, a `removed` log, a wrong-shape
  result, or a strict-decode failure of a log not yet cross-checked) are treated like a provider disagreement: re-fetch the same
  plan from BOTH providers (up to 3 times, 10 s apart) and halt only if the anomaly persists. The JSON-RPC envelope parser accepts
  extra fields (no `.strict()`); only the fields used are validated.
- `RPC_ALLOW_INSECURE_HTTP` is honoured only together with an explicit `PINE_INDEXER_ENV=development` (never inferred from a
  missing NODE_ENV); test the refusal without it.
- Accepted: `applied_events` is dropped by `0003_drop_applied_events.sql` because `0002_roles.sql` already existed.
- Required tests: `src/migrate-cli.ts` (export `main(env, io)`: URL validation, redacted fatal line, exit codes, applied ids);
  the production defaults are pinned (MAX_RANGE_LOGS 50,000; MAX_RANGE_BYTES 32 MiB; MAX_RESPONSE_BYTES 16 MiB;
  MAX_LOGS_PER_RESPONSE 20,000; MAX_REOPEN_ROUNDS 8) by tests that read the exported constants and fail if they change; the
  halving sequence (e.g. 64 → 32 → … → 1, and a sub-range that succeeds is not split further) is asserted step by step.
indexer-envio:
- `scripts/start.mjs` forwards SIGTERM/SIGINT to the `envio start` child and exits with its code; test it with a stub child.
Both lanes: an operator file `operator-coverage-gaps-<lane>.md` in the run directory lists further gaps found by an exhaustive
pre-check; close every one.

## 4. Checks (per lane)
- indexer-native: `pnpm --filter @pine/indexer-native typecheck` (typecheck), `pnpm exec eslint packages/indexer-native/src`
  (typecheck), `node scripts/check-forbidden.mjs` (unit), `pnpm --filter @pine/indexer-native test` (unit).
- indexer-envio: `pnpm --filter @pine/indexer-envio typecheck` and `pnpm --filter @pine/read-model-envio typecheck` (typecheck),
  `pnpm --filter @pine/indexer-envio test` and `pnpm --filter @pine/read-model-envio test` (unit), `node scripts/check-forbidden.mjs` (unit).
