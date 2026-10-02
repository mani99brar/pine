# Decisions: indexers

Settled by the operator from ADR-0001 D12 and the security requirements (SEC-IDX) on 2026-10-02.

## Decisions

- The native indexer is the production read model: finalized blocks only (no rollback logic), two RPC providers must agree on the finalized hash, Pine-registry log ranges are cross-checked on the secondary, strict decoding, single-transaction apply plus cursor, halt on any integrity conflict (`status().halted = true`).
- The reference semantics in `packages/shared/src/testing/memory-read-model.ts` are the specification for both backends; the frozen conformance suite is the acceptance oracle.
- Envio is the optional second backend (rollback on reorg, block lag ≈ 40); its GraphQL read model is proven against an in-test fake, and running the conformance queries against a real Envio deployment (`test:live`) is a launch gate for choosing it.
- Each indexer owns its own storage and migrations; nothing imports `@pine/api`.
- Native roles: `pine_indexer` (DML on `pine_index` only, no DDL) and `pine_readonly` (SELECT only, the API's read-model login),
  created idempotently by the indexer migrations and proven with `SET ROLE` on PGlite.
- Native poller: one pass per range over the five exact addresses and the known topic0s (no tracked-id request filtering),
  merge-sorted by (block, logIndex), `applyEvents` ignores untracked ids; the secondary re-runs the same query for every non-empty
  range and any difference halts. Headers only for blocks with logs plus the range end.
- `viem` is a direct dependency of `@pine/indexer-envio` (operator change for keccak).
- Envio read-model fake serves the committed entity snapshots produced by the real handlers (sorted, decimal bigints, event-hash
  bound, rewritten only with UPDATE_SNAPSHOTS=1).
- The secondary cross-check runs for every processed range, including ranges where the primary returned no logs.
- Chunk default 500 blocks, halved on "range too large" errors, never a halt.
- Untracked third-party events: the zod domain checks run before tracking is decided but cannot fail for contract-emitted logs;
  no per-event rows are persisted (idempotency = cursor-position guard). Log volume never halts or stalls the native indexer: only
  size-type failures split (down to one block), other errors retry the same request, parser caps derive from the gas bound, and a
  single oversized block uses the tracked-id-filtered fallback. Further indexers-002 review fixes in PRD-05 section 3a.
- Envio schema uses BigInt for every id/block/amount/timestamp and avoids Postgres arrays; a test pins config.yaml event
  signatures to the shared ABIs.
- Decoded values outside the frozen `ChainEvent` domain halt (the ClaimRegistry enforces `repositoryId <= 2^53 - 1`).
- Driver portability: never read `rowCount`/`affectedRows`; explicit int8/count casts in raw SQL.
- Test memory: a PGlite instance takes several hundred MB on this host and vitest runs test files in parallel fork processes; the
  platform and claims gates were OOM-killed until their PGlite-heavy test files were serialized with a cross-process lock (an
  atomic `fs.mkdir` lock directory under `os.tmpdir()` with a lane-specific name, the owner pid inside, imported first by every
  such test file, released in `afterAll`, a dead or same-process owner taken over). Use one database per test file and the same
  lock; each lane's gate must pass as ONE full run of its argv. Envio's `createTestIndexer` runs are serialized the same way if
  they use much memory.
- Coverage matrix (lesson from the platform and claims reviews): each lane's completion maps every required test of its PRD section
  and every decision/operator clarification to the test file and test name that would fail if the behaviour were removed, and
  closes every gap before completing (the independent coverage reviewer blocks on any untested requirement).

## Assumptions

- Reality.eth, CTF and Kleros home-proxy events are filtered to tracked ids in code (fetching their topic0s by address); volume on Gnosis is moderate.
- `https://rpc.gnosischain.com` serves archive state (verified 2026-10-02) for capturing real-log fixtures; tests never need the network.

## Deferred

- Wiring either read model into the API process (`packages/api/src/readmodel.ts`, feature `assembly`) and deployment manifests for the indexer processes.
