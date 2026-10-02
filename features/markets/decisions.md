# Decisions: markets

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) and the wave-1 design challenges on 2026-10-02.

## Decisions

- Funding is a single-sided YES sell ladder executed by the user's wallet directly (splitFromBase, exact approval, optional pool creation at the lower price, mint with recipient = account); no orchestrator contract, no re-pricing swaps, no LP lock; a mispriced existing pool is refused with an explanation.
- `S = previewDeposit(budget) − 10 bps` (interest-accrual margin); mint minimum on the YES side is `S − 50 bps`; ladder prices within [0.01, 0.95] sDAI per YES; maximum loss if YES resolves is reported as `S × (1 − sqrt(lower × upper))` plus gas.
- Evidence: Pine stores manifests (≤ 256 KiB, canonical, submitter-bound) and artifacts (≤ 262144 bytes each) but never receives salts before reveal and never stores them; reveal plans warn and require acknowledgement when the manifest is not available to adjudicators.
- Oracle: Pine never answers or bonds; it exposes `dueActions` and verified helper plans for permissionless steps; Kleros mainnet steps (requestArbitration, submitEvidence) are instructions plus ERC-1497 JSON only.
- Every plan is verified with `verifyPlan`, persisted with an idempotency key, and reconciled from receipts whose logs come from the expected contracts; plans are refused (NOT_READY) when the read model is stale or halted.
- Concurrency-sensitive writes are single atomic SQL statements; jobs are idempotent and compare-and-set.
- Plan idempotency is a client-supplied `Idempotency-Key` header scoped to (user, route) with a body hash: same key and body →
  the stored plan; different body → 409; one quota unit per key.
- Driver portability: compare-and-set success only from drizzle `.returning()` rows; explicit int8/count casts in raw SQL; inside a
  transaction only the transaction handle (PGlite deadlocks on nested `ctx.db` calls).
- An existing but uninitialised Algebra pool (price 0) is initialised by the plan like a missing pool.
- `reopenQuestion` nonce = number of questions already in the market's reopen chain.
- Artifact uploads: 413 before any store or quota consumption; optional `expectedSha256` is only compared (422 on mismatch).
- One plan-store contract for both lanes (PRD-04 section 1): `<lane>_plans`/`<lane>_plan_steps`, `POST /api/v1/<lane>/plans/:planId/submitted`,
  per-kind expiry, confirmation from finalized receipts (markets also from read-model facts), partial execution = `failed`.
- Reveal plans never store calldata or any form of the salt; retries rebuild the calldata from the request.
- Funding's "claim verified" gate is an inline integrity check with the frozen shared parsers (INTEGRITY_FAILED, 409), because the
  claims lane's index is outside this feature.
- Account activity lists claims and evidence only; oracle answers by wallet are deferred (no frozen lookup by answerer).
- verifyPlan limits: maxTotalValueWei 10,000 xDAI; maxApprovalAmount 0 (markets) and 10,000e18 (funding).
- Positions paging: 20 NFTs per page, 200 scanned per wallet; outcome balances only for a given market.
- Lane-local test apps add @fastify/multipart (core options) and a capturing logger; modules never register multipart.
- Coverage matrix (lesson from the platform and claims reviews): each lane's completion maps every required test of its PRD section
  and every decision/operator clarification to the test file and test name that would fail if the behaviour were removed, and
  closes every gap before completing (the independent coverage reviewer blocks on any untested requirement).

## Assumptions

- The deployment manifest is `buildDeploymentManifest(config.contracts)`; `GNOSIS_EXTERNAL.amm` holds the verified Algebra addresses (factory, position manager, quoter; tick spacing 60 for new pools).
- `MemoryReadModel` claims carry `yesToken`/`noToken`/`invalidToken`; twin markets may share outcome tokens, so nothing keys solely on a token address.
- Quotes and pool state are read at one pinned block per request; a 30 s cache per market is acceptable.

## Deferred

- Atomic create-and-fund, LP locks, re-pricing swaps, NO-side ladders, mainnet Kleros transaction plans, email/webhook notifications (ADR-0001 Deferred).
