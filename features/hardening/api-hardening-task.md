# Task: api-hardening

## Goal

Land the API hardening of `docs/prd/PRD-07-hardening.md` section 3 in the merged markets and funding modules (claims is not part of this lane).

## Context

- Rerun: run hardening-a-001 produced a candidate (commit `28d99b0e13a8930ee4875f470f78b33e80d1baf0`, ref `keep/hardening-a-001-candidate`) that passed every check; the general reviewer approved and the coverage reviewer blocked on two missing tests. Start from it with one `git checkout 28d99b0e13a8930ee4875f470f78b33e80d1baf0 -- <path>` per owned path, implement PRD-07 section 3c (section 3 is done in the candidate; keep it), re-check every coverage-matrix entry against the actual test, keep the operator-settled choices and list them again.
- Merged modules under `packages/api/src/modules/{markets,funding}`, PRD-04 (including sections 4a and 4b) and features/markets/decisions.md; PRD-02 section 2.5 (jobs and `signal`); each module's COVERAGE.md.
- The host is memory-constrained: run tests with VITEST_MAX_WORKERS=1, one test command at a time, single files while iterating and the full lane suite at most twice.
- Tests use the frozen harness on PGlite; PGlite-heavy test files are serialized with each module's cross-process lock.

## Constraints

- Only touch your owned paths; new migrations only as new files. No new dependencies. Keep every existing test passing.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/hardening/policy.json` pass (run them yourself first).
- Every item has a test that fails when the behaviour is removed; the completion includes that coverage matrix.

## Stop

Stop and report `blocked` when a frozen contract prevents an item, or after three failed attempts at the same check failure with the same root cause.
