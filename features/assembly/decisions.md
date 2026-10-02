# Decisions: assembly

Settled by the operator from ADR-0001 on 2026-10-02.

## Decisions

- This feature only composes, proves and documents: it never edits contracts, interfaces, shared packages, modules or indexers; divergences found are reported, and fixed in a follow-up hardening run.
- The real contract pair is exercised only on a Gnosis fork (pinned block, archive RPC, no broadcast); production deployment is an operator action with a hardware wallet after the launch gates.
- The read model is selected by `secrets.readModel.kind` (`native` default); the Envio option is wired but its live conformance run is a launch gate.
- CI runs every controller check plus `pnpm audit --prod` and the forbidden-pattern gate, with pinned action SHAs and read-only permissions.
- Two runs of this feature: `deploy-e2e` right after `chain` merges (plan vectors from `@pine/shared/tx-plan` only), `composition`
  after every other feature merges.
- The e2e suite runs on real PostgreSQL 16 with the production driver when `PINE_E2E_DATABASE_URL` is set (required in the
  operator's verification and in CI via `PINE_E2E_REQUIRE_PG=1`), else on PGlite.
- No filesystem cheatcodes (foundry.toml keeps `fs_permissions = []`): plan vectors are generated into
  `contracts/test/e2e/generated/PlanVectors.sol` from committed fork observations; the deploy record is printed with
  `vm.serializeJson`.
- The vector script is TypeScript run with `pnpm --filter @pine/api exec node --import tsx ../../scripts/fixtures/export-plan-vectors.mts`.
- Residual allowance after a mint: at most 10 wei, only toward the position manager (Algebra rounding).
- CI adds gitleaks secret scanning; the release checklist lists every launch gate of PRD-06 section 3.

## Assumptions

- deploy-e2e: feature chain is merged into the base of its run. composition: features chain, platform, claims, markets and
  indexers are merged into the base of its run.

## Deferred

- Production deployment, external audit, legal review and the other ADR-0001 launch gates.
