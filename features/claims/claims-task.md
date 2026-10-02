# Task: claims

## Goal

Replace the stub `packages/api/src/modules/claims/index.ts` with the claims `RouteModule` specified in `docs/prd/PRD-03-claims.md`: the verified policy catalog and its public routes, GitHub browsing, owner-only drafts, immutable previews that freeze a canonical claim document and its on-chain question, idempotent publication plans with a crash-safe state machine and reconciliation job, integrity verification of every on-chain claim, public claim listings, and the agent-facing discovery endpoints and schemas.

## Context

- Rerun: run claims-006 produced a candidate (commit `91c4c4284d9e39774e7352def541b49396c498ef`, ref `keep/claims-006-candidate`) that passed every check; its review was approved by the general reviewer and blocked by the coverage reviewer (one P1 test gap plus P2s). Start from it with one `git checkout 91c4c4284d9e39774e7352def541b49396c498ef -- <path>` per owned path (`packages/api/src/modules/claims`, `packages/api/migrations/claims`), implement PRD-03 section 8b, then write the coverage matrix decisions.md asks for (every required test of PRD-03 sections 8a, 8b and 9 and every decision → the test that fails without it) and close every gap before completing. Keep the operator-settled choices and list them again.

- Frozen building blocks (use, do not re-implement): `@pine/shared/claim-document` (`claimDocumentSchema`, `encodeClaimDocument`, `parseClaimDocumentBytes`, `safeText`), `@pine/shared/question` (`renderQuestion`, `validateTitle`), `@pine/shared/tx-plan` (`buildStep`, `newPlan`, `verifyPlan`), `@pine/shared/deployment` (manifest types; build the manifest from `ctx.config`), `@pine/shared/read-model` (`ReadModel`, `deriveOracleStatus`), `@pine/shared/canonical`, `@pine/shared/testing/fixtures` (`exampleClaimDocument`).
- API contracts and harness: `packages/api/src/contracts/*.ts` (RouteModule, RouteSecurityConfig, AppContext gateways, ApiError codes, `createTestContext`, `buildTestApp`, `insertTestUser`, `FakeGitHubGateway`, `MemoryContentStore`, `FakeCompliance`, `FakeQuotas`, `MemoryReadModel`, scripted chain).
- Policy texts and catalog: `policies/catalog/catalog.json` and the files it lists. Requirements: `docs/security/requirements.md` sections 3 (SEC-TX), 4 (SEC-CLAIM), 6 (SEC-AGENT), 8 (SEC-IDX-08).
- `features/claims/decisions.md` settles reconciliation, expiry, window bounds, SC-001 gating, the listing index, the module factory and the helper functions to use; `MemoryReadModel` has `markIndexed(...)` (call it relative to the FakeClock) and `setHalted(true)` for NOT_READY tests.
- PRD-03 section 7a fixes the two-phase integrity job (discovery inserts atomically, verification per claim) and section 6 the exact order and race handling of `POST /publications`.
- Build in this order with separate test files per area so a failure points at one area: catalog → drafts → preview → publication → reconciliation → integrity and index → public listings → agent endpoints and schemas. Commit after each area passes.

## Constraints

- Only touch your owned paths; migrations in `packages/api/migrations/claims` from `0001_`; cross-group foreign keys only to `users`. No new dependencies.
- Never return a transaction plan that `verifyPlan` rejects, never return a plan before the document is stored, and never build plans while the read model is stale or halted (`NOT_READY`).
- Public routes set `config: { pine: { public: true } }` and must not depend on `request.session`. All user-supplied text is returned as data, labelled untrusted in agent endpoints, never rendered.
- State transitions are compare-and-set updates; jobs are idempotent and safe to run concurrently.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/claims/policy.json` pass (run them yourself first).
- Every test in PRD-03 section 9 exists and asserts the behaviour through `buildTestApp`/`createTestContext` (catalog tampering, SC-001 disabled, draft-policy gating, IDOR, preview freezing, publication idempotency and plan verification, compliance/quota/NOT_READY refusals, reconciliation including wrong creator and concurrent runs, integrity results including a copycat market, public endpoints ignoring cookies).

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour, or after three failed attempts at the same check failure with the same root cause (failures in different test areas while you build area by area are normal progress, not a stop condition; run the narrower `vitest run src/modules/claims/<area>` while iterating). Ask a `question` when PRD-03 is ambiguous about something that changes what the immutable document or plan contains.
