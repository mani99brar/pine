# Task: indexer-native

## Goal

Implement `@pine/indexer-native` per `docs/prd/PRD-05-indexers.md` section 2: the `applyEvents` SQL layer reproducing the reference semantics, `createNativeReadModel` implementing the frozen `ReadModel` and passing `describeReadModelConformance`, the finalized-only dual-RPC poller with strict decoding, header-hash and cross-provider log verification and halt-on-conflict, its own checksummed migrations and migrate script, and the process entry with metrics and health endpoints.

## Context

- Rerun: run indexers-003 produced a candidate (commit `1f465e7a56e08201f23273f11d6a2e7999f7ca8f`, ref `keep/indexers-003-candidate`) that passed every check and was approved by the general reviewer; the coverage reviewer blocked it. Start from it with one `git checkout 1f465e7a56e08201f23273f11d6a2e7999f7ca8f -- <path>` per owned path (packages/indexer-native), implement PRD-05 section 3b for this lane, read the operator gap file named there (it appears in the run directory during your run; check for it before completing), re-check every coverage-matrix entry against the actual test, keep the operator-settled choices and list them again.

- Executable specification: `packages/shared/src/testing/memory-read-model.ts`; conformance suite and scenarios: `testing/read-model-conformance.ts`, `testing/read-model-scenarios.ts`; event shapes and tracked-id rules: `src/chain-events.ts`; ABIs: `src/abi/generated.ts`, `src/abi/external.ts`; addresses: `GNOSIS_EXTERNAL` in `src/deployment.ts`.
- Reality/Kleros event semantics: `docs/research/reality-kleros.md`; Gnosis finality (~2 epochs) and RPC behaviour: `docs/security/requirements.md` section 8 (SEC-IDX).
- Dependencies available (frozen): viem, drizzle-orm, pg, zod, pino, prom-client, tsx, @electric-sql/pglite (dev), @pine/shared.

## Constraints

- Test memory: follow the cross-process test lock in `features/indexers/decisions.md` (the reference implementation is `git show 8b00834:packages/api/src/platform/gateways/testing/suite-lock.ts`, or `git show 6e46a26:packages/api/src/modules/claims/test/lock.ts`); your gate must pass as one full run.

- Only touch `packages/indexer-native` (its `package.json` scripts may be adjusted, dependencies may not). Never import from `@pine/api`.
- Finalized blocks only; no rollback path; any integrity conflict halts and is reported through `status().halted`.
- Apply and cursor advance in one transaction; event rows keyed by (chain id, block hash, log index) so re-applying a range is a no-op.
- Every RPC/DB error string redacted before logging (RPC URLs embed keys); RPC access is injectable for tests (no network in tests except committed fixtures captured from Gnosis).

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/indexers/policy.json` pass (run them yourself first).
- `describeReadModelConformance("native", ...)` passes through `applyEvents` on PGlite; the poller tests of PRD-05 section 2.4 exist (agreement/disagreement halt, two-phase tracked ids, chunking, idempotent re-run, single-transaction apply, hash mismatch halt, strict decode halt, startup re-verification) and real-log decoding fixtures prove topic0 and field order.
- Build order: migrations → applyEvents + conformance → read model queries → decoder + fixtures → poller → main/metrics.

## Stop

Stop and report `blocked` when the frozen read-model semantics cannot be reproduced in SQL as specified, or after three failed attempts at the same check failure with the same root cause (failures in different areas while you build area by area are normal progress; run the narrower test path while iterating and commit after each area passes). Ask a `question` before deviating from the reference semantics.
