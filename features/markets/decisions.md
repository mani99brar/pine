# Decisions: markets

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) and the wave-1 design challenges on 2026-10-02.

## Decisions

- Funding is a single-sided YES sell ladder executed by the user's wallet directly (splitFromBase, exact approval, optional pool creation at the lower price, mint with recipient = account); no orchestrator contract, no re-pricing swaps, no LP lock; a mispriced existing pool is refused with an explanation.
- `S = previewDeposit(budget) − 10 bps` (interest-accrual margin); mint minimum on the YES side is `S − 50 bps`; ladder prices within [0.01, 0.95] sDAI per YES; maximum loss if YES resolves is reported as `S × (1 − sqrt(lower × upper))` plus gas.
- Evidence: Pine stores manifests (≤ 256 KiB, canonical, submitter-bound) and artifacts (≤ 262144 bytes each) but never receives salts before reveal and never stores them; reveal plans warn and require acknowledgement when the manifest is not available to adjudicators.
- Oracle: Pine never answers or bonds; it exposes `dueActions` and verified helper plans for permissionless steps; Kleros mainnet steps (requestArbitration, submitEvidence) are instructions plus ERC-1497 JSON only.
- Every plan is verified with `verifyPlan`, persisted with an idempotency key, and reconciled from receipts whose logs come from the expected contracts; plans are refused (NOT_READY) when the read model is stale or halted.
- Concurrency-sensitive writes are single atomic SQL statements; jobs are idempotent and compare-and-set.

## Assumptions

- The deployment manifest is `buildDeploymentManifest(config.contracts)`; `GNOSIS_EXTERNAL.amm` holds the verified Algebra addresses (factory, position manager, quoter; tick spacing 60 for new pools).
- `MemoryReadModel` claims carry `yesToken`/`noToken`/`invalidToken`; twin markets may share outcome tokens, so nothing keys solely on a token address.
- Quotes and pool state are read at one pinned block per request; a 30 s cache per market is acceptable.

## Deferred

- Atomic create-and-fund, LP locks, re-pricing swaps, NO-side ladders, mainnet Kleros transaction plans, email/webhook notifications (ADR-0001 Deferred).
