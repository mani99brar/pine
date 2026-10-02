# Decisions: indexers

Settled by the operator from ADR-0001 D12 and the security requirements (SEC-IDX) on 2026-10-02.

## Decisions

- The native indexer is the production read model: finalized blocks only (no rollback logic), two RPC providers must agree on the finalized hash, Pine-registry log ranges are cross-checked on the secondary, strict decoding, single-transaction apply plus cursor, halt on any integrity conflict (`status().halted = true`).
- The reference semantics in `packages/shared/src/testing/memory-read-model.ts` are the specification for both backends; the frozen conformance suite is the acceptance oracle.
- Envio is the optional second backend (rollback on reorg, block lag ≈ 40); its GraphQL read model is proven against an in-test fake, and running the conformance queries against a real Envio deployment (`test:live`) is a launch gate for choosing it.
- Each indexer owns its own storage and migrations; nothing imports `@pine/api`.
- Native roles: `pine_indexer` (DML on `pine_index` only, no DDL) and `pine_readonly` (SELECT only, the API's read-model login),
  created idempotently by the indexer migrations and proven with `SET ROLE` on PGlite.
- The secondary-provider re-query covers Pine registry logs and logs of tracked Reality/CTF/Kleros ids; any difference halts.
- Decoded values outside the frozen `ChainEvent` domain halt (the ClaimRegistry enforces `repositoryId <= 2^53 - 1`).
- Driver portability: never read `rowCount`/`affectedRows`; explicit int8/count casts in raw SQL.

## Assumptions

- Reality.eth, CTF and Kleros home-proxy events are filtered to tracked ids in code (fetching their topic0s by address); volume on Gnosis is moderate.
- `https://rpc.gnosischain.com` serves archive state (verified 2026-10-02) for capturing real-log fixtures; tests never need the network.

## Deferred

- Wiring either read model into the API process (`packages/api/src/readmodel.ts`, feature `assembly`) and deployment manifests for the indexer processes.
