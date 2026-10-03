# Task: composition

## Goal

Wire and document the whole backend per `docs/prd/PRD-06-assembly.md` section 3: implement `packages/api/src/readmodel.ts` (native or Envio read model by configuration), the full-application end-to-end suite in `packages/api/test/e2e` driving the SPEC §3 customer journey and its negative paths, the deployment assets in `deploy/`, the root `README.md`, the operations runbooks in `docs/operations/`, and the CI workflow in `.github/workflows/ci.yml`.

## Context

- Rerun: run assembly-004 produced a candidate (commit `4a32126b963155d80926730bf6071e3d501357f1`, ref `keep/assembly-004-candidate`) on the merged main that passed every check; the general reviewer approved and the coverage reviewer blocked on two untested requirements. Start from it with one `git checkout 4a32126b963155d80926730bf6071e3d501357f1 -- <path>` per owned path of this lane, implement PRD-06 section 3a (everything else is done in the candidate; keep it), re-check every coverage-matrix entry against the actual test, keep the operator-settled choices and list them again.
- The host is memory-constrained: run vitest with VITEST_MAX_WORKERS=1, one test command at a time, and the full e2e and api-unit suites at most twice each.

- Everything merged from features `platform`, `claims`, `markets`, `indexers`; ADR-0001 (decisions and launch gates); PRD-02..05; `docs/security/requirements.md`.
- The real `buildApp`, `createGateways` (with injected fake fetch/RPC transports), `routeModules`, `@pine/indexer-native` (`applyEvents`, `createNativeReadModel` on PGlite) and the scenario events of `@pine/shared/testing`.

## Constraints

- Only touch your owned paths; fix nothing in other lanes' code (report divergences as findings in your completion instead). No new dependencies; no network in tests.
- The e2e suite asserts no secret appears in any response or captured log line, and that every plan in a response verifies after `planFromWire`.
- The e2e suite supports real PostgreSQL 16 through `PINE_E2E_DATABASE_URL` (and fails without it when `PINE_E2E_REQUIRE_PG=1`), as PRD-06 section 3 describes; the operator runs your checks with both set; when you run them yourself, use the operator's local PostgreSQL 16 at `PINE_E2E_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres` (trust auth, disposable) with `PINE_E2E_REQUIRE_PG=1`, and also once without the URL (PGlite).

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `e2e`, `api-unit` in `features/assembly/policy.json` pass (run them yourself first).
- The journey and every negative path listed in PRD-06 section 3 are covered; deployment docs, runbooks, README and CI exist and match the code (commands verified by running them where possible).

## Stop

Stop and report `blocked` when merged code from another feature prevents the journey (describe the exact divergence and the file), or after three failed attempts at the same check failure with the same root cause (failures in different areas while you build area by area are normal progress).
