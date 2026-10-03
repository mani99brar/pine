# @pine/indexer-native

The production read model (PRD-05 section 2): a finalized-only, dual-RPC log poller writing the `pine_index` schema, and
`createNativeReadModel`, the frozen `ReadModel` over it.

- `src/apply.ts` — `applyEvents(tx, events, { chainId, questionTimeout })`: the SQL form of `MemoryReadModel.applyOne`.
  Idempotent through a cursor-position guard: inside its transaction (cursor row locked) every event at or before the
  stored position is skipped (`blockNumber <= indexed_block`, or `(blockNumber, logIndex) <= (last_event_block,
  last_event_log_index)`); no per-event rows are kept (`0003_drop_applied_events.sql` removed the candidate's table).
- `src/read-model.ts` — `createNativeReadModel(executor, { chainId })`; `src/db.ts` adapts node-postgres or PGlite.
  Cursor key parts are bounded to int8/int4 in zod, so a crafted cursor is `InvalidCursorError`, never a database error.
- `src/decode.ts` — strict viem decoding plus zod domain checks; `src/rpc.ts` — the injectable `RpcProvider` and the HTTP
  JSON-RPC implementation (streamed responses capped at 16 MB / 20,000 logs, failures classified as size-type or
  transient, errors rebuilt from redacted safe fields).
- `src/poller.ts` — finalized agreement, the tracked-id-filtered request plan, size-type splitting down to one block with
  a plan shared by both providers, the adaptive processed range (50,000 logs / 32 MB), per-request cross-check with
  re-checks before a halt, header confirmation, ONE `applyEvents` call plus cursor in one transaction, halt on any
  integrity conflict. `src/app.ts` — the process wiring (injectable, tested); `src/main.ts` — the entry;
  `src/metrics.ts` — metrics and health endpoints. `COVERAGE.md` maps every requirement to its test.

## Request plan (why third-party spam cannot halt or stall the indexer)

Anyone can emit cheap Reality.eth and CTF logs, so those are never fetched by address alone. Per range the plan requests:
ClaimRegistry, EvidenceRegistry and Kleros home-proxy logs unfiltered (Pine and arbitration activity, costly to spam);
`LogReopenQuestion` filtered on topic2 ∈ tracked question ids (repeated for new replacement ids, at most 8 rounds; deeper
chains cut the range just before the earliest block of the last round's reopens, one block minimum); Reality logs filtered on topic1 ∈ tracked question ids and CTF
`ConditionResolution` on topic1 ∈ tracked condition ids, 100 ids per request. Volume on a TRACKED id (bounty loops) only
splits requests on size-type failures and cuts the processed range; it never halts. Providers must return at least
10,000 logs per response.

Active filter set (PRD-05 section 3b): the stored ids are pruned once per processed range, judged at CHAIN time (the stored
cursor block's timestamp, confirmed by both providers when that block ended a range; never the wall clock). A question
is dropped from every request once it is finalized (not pending arbitration, `finalizeTs <= cursor timestamp`) with a
real answer, or when it settled too soon (0xff..fe) and its latest replacement finalized with a real answer; resolved
conditions are dropped. Reality refuses every tracked action on a finalized question and block timestamps never
decrease, so no tracked log is missed; pruned ids stay in the database. The same set serves every sub-request, split
and re-check of the range on both providers. The request count per range therefore tracks live claims only (about
`3 × ceil(active ids / 100) + 3` per provider).

## Operations

- Migrate (DDL-capable role): `MIGRATION_DATABASE_URL=postgres://... pnpm --filter @pine/indexer-native migrate`
  (falls back to `DATABASE_URL`; prints `{"applied":[...],"skipped":[...]}`; exit 0, or 1 with one redacted line on an
  invalid URL, a refused migration set or a database error).
  Migrations create the NOLOGIN roles `pine_indexer` (DML on `pine_index`, no DDL) and `pine_readonly` (SELECT only) if
  missing; production pre-creates them WITH LOGIN. A concurrent migration run is refused (try-lock).
- Run: `pnpm --filter @pine/indexer-native start` with `DATABASE_URL` (as `pine_indexer`), `RPC_PRIMARY_URL`,
  `RPC_SECONDARY_URL`, `CHAIN_ID=100`, `CLAIM_REGISTRY_ADDRESS`, `EVIDENCE_REGISTRY_ADDRESS`, `DEPLOYMENT_BLOCK`; optional
  `REALITY_ADDRESS`, `CONDITIONAL_TOKENS_ADDRESS`, `KLEROS_HOME_PROXY_ADDRESS` (defaults from `GNOSIS_EXTERNAL`),
  `QUESTION_TIMEOUT` (302400), `POLL_INTERVAL_MS` (5000), `CHUNK_SIZE` (500, 50..2000), `METRICS_HOST` (127.0.0.1; set it
  to the pod address for probes), `METRICS_PORT` (9464), `LOG_LEVEL`.
- RPC providers: https only. `RPC_ALLOW_INSECURE_HTTP=true` allows http for local development and is honoured only
  together with the explicit marker `PINE_INDEXER_ENV=development` (never inferred from a missing `NODE_ENV`); it is
  refused otherwise and always with `NODE_ENV=production`. `PINE_INDEXER_ENV` accepts `development` or `production`. They must be independent: the last two DNS labels of their hostnames must differ. This is a
  registrable-domain HEURISTIC (no public-suffix list under the frozen dependencies): it rejects two endpoints of one
  provider domain but cannot tell two customers under a multi-label public suffix apart, so operations must still pick two
  different companies.
- Endpoints: `/healthz`, `/readyz` (503 when halted, not started or no recent successful cycle), `/metrics`.
- Halts: any integrity conflict inserts a row into `pine_index.halts` (`status().halted = true`, metric
  `pine_indexer_halted 1`) and ingestion stops. A provider difference, or a single-response anomaly of one provider (a log
  outside the requested range, a duplicate or `removed` log, a wrong-shape result, a strict-decode failure of a log not
  yet cross-checked), is re-checked 3 times, 10 s apart, on both providers before the `log_disagreement`,
  `invalid_rpc_data` or `decode_failure` halt. Header and finalized-hash disagreements halt at once. There is no automatic recovery: investigate, then remove the halt row.

## Fixtures

`test/fixtures/gnosis-logs.json` holds real Gnosis logs captured with `cast logs` (expected events derived independently
from the raw topics and `cast decode-abi`); `test/fixtures/topic0-verification.json` records that every requested external
topic0 occurs in the deployed bytecode (no EIP-1967 implementation behind any of the three contracts). The
`LogReopenQuestion` fixture also records the contract state (`reopened_questions`) that independently fixes its topic
order. Gap: no `LogFundAnswerBounty`, `LogAnswerReveal` or `LogCancelArbitration` log exists in the last 2,000,000 blocks
searched (2026-10-03); those three rely on the bytecode topic0 check and the shared-ABI round trip.
