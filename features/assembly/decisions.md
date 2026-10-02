# Decisions: assembly

Settled by the operator from ADR-0001 on 2026-10-02.

## Decisions

- This feature only composes, proves and documents: it never edits contracts, interfaces, shared packages, modules or indexers; divergences found are reported, and fixed in a follow-up hardening run.
- The real contract pair is exercised only on a Gnosis fork (pinned block, archive RPC, no broadcast); production deployment is an operator action with a hardware wallet after the launch gates.
- The read model is selected by `secrets.readModel.kind` (`native` default); the Envio option is wired but its live conformance run is a launch gate.
- CI runs every controller check plus `pnpm audit --prod` and the forbidden-pattern gate, with pinned action SHAs and read-only permissions.

## Assumptions

- Features chain, platform, claims, markets and indexers are merged into the base of this run.

## Deferred

- Production deployment, external audit, legal review and the other ADR-0001 launch gates.
