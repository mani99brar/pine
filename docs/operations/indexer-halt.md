# Indexer halt

The native indexer stops ingesting a chain on any integrity conflict and **never recovers by itself**: a row in
`pine_index.halts` freezes it (SEC-IDX-02/05/06). While halted, the API keeps serving reads (marked stale/halted on every
response) but refuses every transaction plan with `503 NOT_READY` (SEC-IDX-07), `/readyz` answers 503 with
`readModel: "halted"`, and the `markets.watch` job sends no notifications.

## Signals

- `pine_indexer_halted` = 1 (alert immediately, page on-call); indexer `/readyz` 503.
- Log line `indexer halted on an integrity conflict` with `reason`, `detail`, `block`.
- API: `/readyz` `{"checks":{"readModel":"halted"}}`; plan routes answer `NOT_READY` "indexer halted".

## Steps

1. Read the halt (as `pine_migrator` or an admin role; the API's role cannot read `pine_index`):
   ```sql
   SELECT id, chain_id, reason, detail, block_number, created_at FROM pine_index.halts ORDER BY id;
   SELECT indexed_block, indexed_block_timestamp, finalized_block, head_block, updated_at FROM pine_index.cursor;
   ```
2. Classify by `reason`:
   - `rpc_disagreement`, `log_disagreement`, `header_disagreement`, `finalized_conflict`, `invalid_rpc_data`,
     `decode_failure`: the two providers disagree or one returned malformed data. Follow
     [rpc-disagreement.md](rpc-disagreement.md).
   - `log_hash_mismatch`, `apply_conflict`: the stored index disagrees with the canonical chain (a reorg below
     finality, a corrupted row, or a bug). Treat as an incident ([incident-response.md](incident-response.md)); do not
     delete the halt before the cause is understood.
3. Decide with a second person. Write the decision, the evidence (block numbers, which provider said what) and the fix in
   the operations log.
4. Fix the cause: replace or remove the faulty provider (`RPC_PRIMARY_URL`/`RPC_SECONDARY_URL`, keep two independent
   companies), or rebuild the index (below).
5. Resume: delete the halt row(s). The poller checks every poll interval and resumes from its cursor; no restart needed.
   ```sql
   DELETE FROM pine_index.halts WHERE id = <id>;
   ```
6. Verify: `pine_indexer_halted` 0, `pine_indexer_lag_seconds` falling, API `/readyz` `ready` within the cache window,
   a plan route answers again.

## Rebuilding the index

Only finalized data is ever indexed, so a rebuild from `DEPLOYMENT_BLOCK` reproduces the same facts:

1. `systemctl stop pine-indexer-native`.
2. As `pine_migrator`: `TRUNCATE` the data tables of `pine_index` (claims, evidence, questions, question_markets,
   answers, arbitrations, arbitration_history, tracked_conditions, condition_resolutions, condition_payouts, blocks,
   halts) and `DELETE FROM pine_index.cursor;`. Never touch `pine_index.schema_migrations`.
3. `systemctl start pine-indexer-native`; the API stays NOT_READY for plans until the cursor is within
   `PINE_MAX_INDEXER_LAG_SECONDS` of now.
4. Claims already verified in the API (`claims_index`) keep their verdicts; the integrity job re-checks only new claims.
