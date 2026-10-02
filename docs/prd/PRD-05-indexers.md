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
### 2.3 Ingestion (finalized only; SEC-IDX-01/02/04/05/06)
- Each cycle: read `finalized` block (number and hash) from both RPC providers; `target = min(numbers)`; both providers must
  report the same hash for `target`, else record a halt (`rpc_disagreement`) and stop advancing (alert via metrics and logs).
- Fetch `[cursor + 1, min(target, cursor + 2000)]` in two phases: (a) logs of the ClaimRegistry and EvidenceRegistry (all their
  event topic0s); apply ClaimCreated first so newly tracked question/condition ids are known; (b) logs of Reality.eth, CTF and the
  Kleros home proxy for the topic0s listed in `chain-events.ts`, filtered to tracked ids in code (or with topic OR-lists when the
  provider supports them). Decode strictly with viem `decodeEventLog` (`strict: true`) and validate with zod; a log that does not
  decode under its topic0 is an integrity error (halt), never silently skipped.
- Verify every log's `blockHash` against the canonical header hash for its block number (fetched once per block in the range); for
  ranges containing Pine registry logs, re-query those logs from the secondary provider and require identical
  `(blockHash, logIndex, topics, data)`; mismatch → halt (`log_disagreement`).
- Apply the range and advance the cursor (block number and hash) in **one** transaction; record per-block hashes for blocks
  that contained events. On startup, re-verify the stored cursor hash against both providers (mismatch → halt `finalized_conflict`).
- Back off on RPC errors (exponential, capped), redact every error string (RPC URLs embed keys), expose Prometheus metrics
  (indexed block, finalized block, lag seconds, cycles, errors, halted) and `/healthz` `/readyz` on a configurable internal port.
- `src/main.ts` process entry with zod-validated env (fail closed): database URL, two RPC URLs, chain id 100, Pine registry and
  evidence registry addresses and deployment block, Reality/CTF/home-proxy addresses (defaults from `GNOSIS_EXTERNAL`), question
  timeout (302400), poll interval, metrics port.
### 2.4 Tests
- `describeReadModelConformance("native", factory)` where the factory runs migrations on PGlite and applies the scenario events
  through `applyEvents` (the same function the poller uses).
- Poller with a scripted RPC: both-provider agreement, disagreement halt, finalized lag, two-phase tracked ids within one range,
  range chunking, idempotent re-run of a range, crash between apply and cursor impossible (single transaction; simulate a throw),
  log/header hash mismatch halt, strict decoding failure halt, startup cursor re-verification.
- Decoding fixtures: real Gnosis logs (raw topics/data captured with `cast logs` during development and committed as JSON) for
  Reality `LogNewAnswer`, `LogNotifyOfArbitrationRequest`, `LogFinalize`, CTF `ConditionResolution` and a Kleros home-proxy event,
  decoded into the expected `ChainEvent`s (proves topic0 and field order against real chain data).

## 3. indexer-envio (option) and read-model-envio
### 3.1 indexer-envio (Envio HyperIndex v3, envio 3.12.1)
- `config.yaml` for chain 100: contracts ClaimRegistry, EvidenceRegistry (addresses and start block from env), RealityETH, CTF and
  KlerosHomeProxy (addresses from `GNOSIS_EXTERNAL`), the events of `chain-events.ts`, `field_selection` with block hash and
  transaction hash, `rollback_on_reorg: true`, a confirmation lag (`block_lag` ≈ 40 blocks) so served rows are effectively final,
  RPC fallback configured from env (HyperSync token optional).
- `schema.graphql` entities mirroring the read-model records (Claim, EvidenceSubmission, OracleQuestion, OracleAnswer,
  Arbitration + ArbitrationStage, ConditionResolution, TrackedQuestion/TrackedCondition), lowercase hex ids.
- Handlers implement the reference semantics exactly; they are deterministic, make no external calls (Envio runs handlers twice:
  preload and processing), and ignore events for untracked ids by entity lookup.
- Tests (vitest, `createTestIndexer()`, no Docker): for each frozen scenario, convert the `ChainEvent`s to simulated Envio events
  with explicit block numbers/log indexes, process them, and assert the resulting entities equal the records of
  `MemoryReadModel` for the same events (field by field, after mapping).
### 3.2 read-model-envio
- `createEnvioReadModel({ graphqlUrl, adminSecret?, fetch })` implementing `ReadModel` with Hasura GraphQL queries over the entities
  (where/order_by/limit, keyset pagination encoded in opaque cursors), zod-validated responses, 10 s timeouts, redacted errors, and
  `status()` from `_meta` / `chain_metadata` (indexed block, head, `halted: false` unless the endpoint reports errors).
- Tests: the conformance suite with a factory that builds a fake GraphQL endpoint (an in-test `fetch` serving the lane's own
  queries from entity rows produced by mapping the reference records), plus unit tests of query construction and validation
  failures. A `test:live` script (excluded from the default test run) runs the conformance queries against a real Envio endpoint
  given `ENVIO_GRAPHQL_URL`; running it against a real deployment is a launch gate for choosing the Envio option.

## 4. Checks (per lane)
- indexer-native: `pnpm --filter @pine/indexer-native typecheck` (typecheck), `pnpm exec eslint packages/indexer-native/src`
  (typecheck), `node scripts/check-forbidden.mjs` (unit), `pnpm --filter @pine/indexer-native test` (unit).
- indexer-envio: `pnpm --filter @pine/indexer-envio typecheck` and `pnpm --filter @pine/read-model-envio typecheck` (typecheck),
  `pnpm --filter @pine/indexer-envio test` and `pnpm --filter @pine/read-model-envio test` (unit), `node scripts/check-forbidden.mjs` (unit).
