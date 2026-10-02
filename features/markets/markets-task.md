# Task: markets

## Goal

Replace the stub `packages/api/src/modules/markets/index.ts` with the markets `RouteModule` of `docs/prd/PRD-04-markets.md` section 2: evidence manifest and artifact intake, commit/reveal/publish evidence plans, public evidence browsing with timeliness and availability, ERC-1497 output for Kleros jurors, oracle and arbitration status with `dueActions`, verified oracle helper plans, idempotent notifications and public account activity.

## Context

- Frozen building blocks: `@pine/shared/evidence` (manifest schema, `encodeEvidenceManifest`, `parseEvidenceManifestBytes`, `computeEvidenceCommitment`), `@pine/shared/tx-plan` (`buildStep`, `newPlan`, `verifyPlan`), `@pine/shared/deployment` (`buildDeploymentManifest`), `@pine/shared/read-model` (`deriveOracleStatus`, `classifyAnswer`, records), `@pine/shared/abi/external` (Reality, Kleros home proxy), `@pine/shared/testing/*` (scenarios, `MemoryReadModel` with `markIndexed`/`setHalted`).
- API contracts and harness: `packages/api/src/contracts/*.ts` (RouteSecurityConfig `multipart`/`public`, ContentStore `put`/`retrieve`, ComplianceGateway, QuotaGateway, `createTestContext`, `buildTestApp`).
- Reality.eth semantics (claimWinnings history order, commitments, arbitration): `docs/research/reality-kleros.md`; requirements: `docs/security/requirements.md` sections 3 (SEC-TX) and 5 (SEC-EVID).

## Constraints

- Only touch your owned paths; migrations in `packages/api/migrations/markets` from `0001_`; foreign keys only to `users`. No new dependencies.
- Never persist or log a salt; never fetch a URL from a manifest; never render or extract content; every plan passes `verifyPlan` and is refused with NOT_READY when the read model is stale or halted.
- Concurrency-sensitive writes are single atomic SQL statements; state transitions are compare-and-set; jobs are idempotent.
- Plan arguments for oracle helpers are re-derived from the read model at request time, never taken from the client.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/markets/policy.json` pass (run them yourself first).
- Every markets test in PRD-04 section 4 exists in area-specific test files and asserts the behaviour (including salt never stored or logged, streaming size limit, exact-deadline timeliness, `dueActions` for every oracle state, `claimWinnings` reconstruction against a hand-computed history).
- Build order: evidence content → evidence plans → evidence browsing/ERC-1497 → oracle status and dueActions → oracle plans → notifications job → account activity.

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour, or after three failed attempts at the same check failure with the same root cause (failures in different areas while you build area by area are normal progress; run the narrower test path while iterating and commit after each area passes). Ask a `question` before choosing a behaviour PRD-04 leaves open that changes what a plan does.
