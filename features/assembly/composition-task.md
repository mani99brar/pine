# Task: composition

## Goal

Wire and document the whole backend per `docs/prd/PRD-06-assembly.md` section 3: implement `packages/api/src/readmodel.ts` (native or Envio read model by configuration), the full-application end-to-end suite in `packages/api/test/e2e` driving the SPEC §3 customer journey and its negative paths, the deployment assets in `deploy/`, the root `README.md`, the operations runbooks in `docs/operations/`, and the CI workflow in `.github/workflows/ci.yml`.

## Context

- Rerun: run assembly-002 built this lane on a pre-merge base (claims-008 and markets-002 candidates) and stopped at verification only because `eslint packages` fails on 13 errors in two merged indexer-envio files. Its snapshot is commit `6e93b1288f9a9c42ce6a62c84eef07bd930c7348` (ref `keep/assembly-002-work`). Start from it with one `git checkout 6e93b1288f9a9c42ce6a62c84eef07bd930c7348 -- <path>` per owned path of this lane that exists there, then adapt to main, where claims-010, markets-004 and the contract hardening are merged (their code is final; report divergences instead of working around them). Fix the lint errors in `packages/indexer-envio/envio-env.d.ts` (triple-slash reference) and `packages/indexer-envio/scripts/start.mjs` (Node globals: import `process`, `Buffer` from `node:*` or declare the globals; no behaviour change), which this run adds to your owned paths. Keep the operator-settled choices and list them again.
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
