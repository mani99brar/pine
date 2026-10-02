# Task: indexer-envio

## Goal

Implement the Envio option per `docs/prd/PRD-05-indexers.md` section 3: the Envio HyperIndex v3 project in `packages/indexer-envio` (config, schema, deterministic handlers reproducing the reference semantics, vitest tests with `createTestIndexer()` comparing entities to `MemoryReadModel` for the frozen scenarios) and `@pine/read-model-envio` (`createEnvioReadModel` over Hasura GraphQL with zod-validated responses, passing the conformance suite against an in-test GraphQL fake, plus a `test:live` script for a real endpoint).

## Context

- Envio v3 facts verified on this machine (vitest works, no Docker needed, codegen offline and deterministic, handlers run twice, `contractRegister` rules, tuple event params decode to named objects): `docs/research/envio-hyperindex.md`.
- Executable specification and fixtures: `packages/shared/src/testing/{memory-read-model,read-model-scenarios,read-model-conformance}.ts`; event shapes: `packages/shared/src/chain-events.ts`; ABIs: `packages/shared/src/abi/*`.

## Constraints

- Test memory: follow the cross-process test lock in `features/indexers/decisions.md` (the reference implementation is `git show 8b00834:packages/api/src/platform/gateways/testing/suite-lock.ts`, or `git show 6e46a26:packages/api/src/modules/claims/test/lock.ts`); your gate must pass as one full run.

- Only touch `packages/indexer-envio` and `packages/read-model-envio` (scripts may be adjusted; dependencies may not). envio is pinned at 3.12.1.
- Codegen output `.envio/` is gitignored; `envio-env.d.ts` is committed and must be byte-identical to what `envio codegen` produces (the verifier fails a check that leaves the worktree dirty). Run the checks from a clean tree before completing.
- Handlers are deterministic, make no network calls and ignore untracked ids by entity lookup; the read model never fetches anything but the configured GraphQL URL.

## Acceptance

- Checks `typecheck-envio`, `typecheck-read-model`, `forbidden`, `unit-envio`, `unit-read-model` in `features/indexers/policy.json` pass (run them yourself first, from a clean tree).
- Entity-equivalence tests cover every frozen scenario; `describeReadModelConformance("envio", ...)` passes against the GraphQL fake; validation failures and query construction are unit-tested; `test:live` exists and is excluded from `test`.
- Build order: config/schema/codegen → handlers + entity tests → GraphQL fake → read model + conformance → live script and README.

## Stop

Stop and report `blocked` if Envio 3.12.1 cannot express a required behaviour (describe it), or after three failed attempts at the same check failure with the same root cause (failures in different areas while you build area by area are normal progress; run the narrower test path while iterating and commit after each area passes). Ask a `question` before deviating from the reference semantics.
