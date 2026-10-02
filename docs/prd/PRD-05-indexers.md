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
   arbitrator answers, reopen tracking, bounty, Kleros stages). Idempotent: every event row is keyed by `(chain_id, block_hash,
   log_index)` and re-applying a range is a no-op.
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
- Fetch `[cursor + 1, min(target, cursor + 2000)]` in ONE pass: every log of the five exact addresses (ClaimRegistry,
  EvidenceRegistry, Reality.eth, CTF, Kleros home proxy) whose topic0 is one of the topic0s listed in `chain-events.ts` (topic0
  OR-list per address; no tracked-id filtering in the request). Decode strictly with viem `decodeEventLog` (`strict: true`),
  validate with zod (a log that does not decode under its topic0 is an integrity error: halt, never skipped), merge-sort ALL
  logs by (blockNumber, logIndex) and pass the whole ordered list to `applyEvents`, which ignores untracked ids by row lookup
  exactly as the reference does. This keeps tracking correct whatever the order of ClaimCreated, LogReopenQuestion (whose new
  id is in topic1 and tracked id in topic2) and later answers within one range. Measured on 2026-10-02 over 2000 recent blocks:
  Reality 2 logs, Kleros proxy 0, CTF 1504 logs of all topics (only ConditionResolution is requested), so the volume is small.
  Required poller test: a range containing ClaimCreated, then LogReopenQuestion, then an answer and a Kleros event on the
  replacement id ends with the replacement tracked and both events applied (as `scenarioOracle` does through `applyEvents`).
- Verify every log's `blockHash` against the canonical header of its block (headers fetched only for blocks that contain logs,
  plus the range end; they also give each event its `blockTimestamp`); re-run the same single-pass query on the secondary provider
  for EVERY range processed (every range of at least one block, whether or not the primary returned logs) and require the identical
  full set of `(blockHash, logIndex, topics, data)`; any difference, including the primary returning nothing where the secondary
  returns logs, → halt (`log_disagreement`). A faulty primary therefore cannot hide an oracle answer. Required tests: the primary
  omits a tracked Reality answer (halt) and the secondary omits one (halt).
- Range size: chunk length is configurable (default 500 blocks, not 2000: many providers cap `eth_getLogs` ranges or result
  counts); a provider error saying the range or result is too large halves the chunk (down to 50) and retries; it never halts.
- Validation scope: strict ABI decoding applies to every fetched log (a log the contract itself emitted cannot fail it, so a
  failure is a provider fault → halt). Domain validation beyond the ABI types (zod) applies only to Pine registry events and to
  events of tracked ids; events of untracked ids are dropped BEFORE any such validation, and for tracked external events the zod
  schemas accept the full on-chain domain of each field (bigint for uint256, no casing or string-content rules on third-party
  data). Anyone can emit Reality/CTF events, so no third-party event may be able to halt the indexer.
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
- Log volume is attacker-controlled (anyone can emit cheap Reality/CTF logs, e.g. zero-value `fundAnswerBounty` loops; ~5k logs
  of one address and topic0 fit in one 17M-gas block, ~3.5 MB of JSON), so volume must never halt or stall the indexer:
  1. Only size-type failures split: "too many results"/"range too large"/response-size errors, timeouts, and a response above the
     parser's caps. The range is halved down to ONE block. Every other error (429, 5xx, network) retries the SAME request with
     capped backoff, and the cycle gives up at the first request that still fails after its retries (no split storm).
  2. The parser's caps derive from the gas bound: response size 16 MB and 20,000 logs, comfortably above one block's worst case.
  3. Bounded fallback when a single block still exceeds a provider's cap: fetch that block's ClaimRegistry, EvidenceRegistry and
     Kleros-proxy logs unfiltered, compute the tracked-id set as of the end of that block (including ClaimCreated and reopens in
     it), and fetch that block's Reality and CTF logs with topic filters on the tracked ids (OR-lists chunked to 100 ids per
     request), on both providers. Untracked spam is then never requested.
  Only integrity conflicts halt. Operations docs require providers that return at least 10,000 logs per response. Tests: a
  log-dense range above the cap is fetched by splitting and applied; a provider that answers "too many results" above one block
  still progresses; a single block above the provider cap progresses through the fallback; a 429 is retried without splitting.
- Idempotency comes from a cursor-position guard: inside its transaction `applyEvents` skips every event at or before the stored
  cursor position (block, logIndex), as `MemoryReadModel` refuses out-of-order events, so re-applying a range is a no-op even when
  an event that was ignored on the first pass would now be tracked. No per-event rows are persisted (an `applied_events` table, if
  the candidate has one, is dropped or limited to tracked state changes), so neither untracked nor tracked spam grows storage.
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
  the range end (assert the recorded calls); `main.ts` wiring (process advisory lock refuses a second writer, DB errors redacted);
  the migration runner's advisory lock; the node-postgres executor rolls back and releases the client when the callback throws (stub
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

## 4. Checks (per lane)
- indexer-native: `pnpm --filter @pine/indexer-native typecheck` (typecheck), `pnpm exec eslint packages/indexer-native/src`
  (typecheck), `node scripts/check-forbidden.mjs` (unit), `pnpm --filter @pine/indexer-native test` (unit).
- indexer-envio: `pnpm --filter @pine/indexer-envio typecheck` and `pnpm --filter @pine/read-model-envio typecheck` (typecheck),
  `pnpm --filter @pine/indexer-envio test` and `pnpm --filter @pine/read-model-envio test` (unit), `node scripts/check-forbidden.mjs` (unit).
