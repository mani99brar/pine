# Task: claims-hardening

## Goal

Land the claims hardening of `docs/prd/PRD-07-hardening.md` section 3b in the merged claims module (markets and funding are not part of this lane; section 3 describes the shared audit-outbox design).

## Context

- Rerun: run hardening-cl-003 produced a candidate (commit `aab20c5d36c31b6692205445f604e4fdd88d9b17`, ref `keep/hardening-cl-003-candidate`) that passed every check; the general reviewer approved and the coverage reviewer blocked on one missing test. Start from it with one `git checkout aab20c5d36c31b6692205445f604e4fdd88d9b17 -- <path>` per owned path, implement PRD-07 section 3g (section 3f is done in the candidate; keep it), re-check every coverage-matrix entry against the actual test, keep the operator-settled choices and list them again.
- The merged module under `packages/api/src/modules/claims`, PRD-03 (including sections 8a-8d) and features/claims/decisions.md; PRD-02 section 2.5 (jobs and `signal`); the module's COVERAGE.md.
- The host is memory-constrained: run tests with VITEST_MAX_WORKERS=1, one test command at a time, single files while iterating and the full lane suite at most twice.
- Tests use the frozen harness on PGlite; PGlite-heavy test files are serialized with each module's cross-process lock.

## Constraints

- Only touch your owned paths; new migrations only as new files. No new dependencies. Keep every existing test passing.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/hardening/policy.json` pass (run them yourself first).
- Every item has a test that fails when the behaviour is removed; the completion includes that coverage matrix.

## Stop

Stop and report `blocked` when a frozen contract prevents an item, or after three failed attempts at the same check failure with the same root cause.
