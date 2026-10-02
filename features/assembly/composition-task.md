# Task: composition

## Goal

Wire and document the whole backend per `docs/prd/PRD-06-assembly.md` section 3: implement `packages/api/src/readmodel.ts` (native or Envio read model by configuration), the full-application end-to-end suite in `packages/api/test/e2e` driving the SPEC §3 customer journey and its negative paths, the deployment assets in `deploy/`, the root `README.md`, the operations runbooks in `docs/operations/`, and the CI workflow in `.github/workflows/ci.yml`.

## Context

- Everything merged from features `platform`, `claims`, `markets`, `indexers`; ADR-0001 (decisions and launch gates); PRD-02..05; `docs/security/requirements.md`.
- The real `buildApp`, `createGateways` (with injected fake fetch/RPC transports), `routeModules`, `@pine/indexer-native` (`applyEvents`, `createNativeReadModel` on PGlite) and the scenario events of `@pine/shared/testing`.

## Constraints

- Only touch your owned paths; fix nothing in other lanes' code (report divergences as findings in your completion instead). No new dependencies; no network in tests.
- The e2e suite asserts no secret appears in any response or captured log line, and that every plan in a response verifies after `planFromWire`.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `e2e`, `api-unit` in `features/assembly/policy.json` pass (run them yourself first).
- The journey and every negative path listed in PRD-06 section 3 are covered; deployment docs, runbooks, README and CI exist and match the code (commands verified by running them where possible).

## Stop

Stop and report `blocked` when merged code from another feature prevents the journey (describe the exact divergence and the file), or after three failed attempts at the same check failure.
