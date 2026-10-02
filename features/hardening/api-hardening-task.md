# Task: api-hardening

## Goal

Land the API hardening of `docs/prd/PRD-07-hardening.md` section 3 in the merged claims, markets and funding modules: cooperative job abort, policy-text pinning, and the findings the operator appends before launch.

## Context

- Merged modules under `packages/api/src/modules/`, their PRDs (PRD-03, PRD-04) and decisions; PRD-02 section 2.5 (jobs and `signal`).
- Tests use the frozen harness on PGlite; PGlite-heavy test files are serialized with each module's cross-process lock.

## Constraints

- Only touch your owned paths; new migrations only as new files. No new dependencies. Keep every existing test passing.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/hardening/policy.json` pass (run them yourself first).
- Every item has a test that fails when the behaviour is removed; the completion includes that coverage matrix.

## Stop

Stop and report `blocked` when a frozen contract prevents an item, or after three failed attempts at the same check failure with the same root cause.
