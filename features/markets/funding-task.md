# Task: funding

## Goal

Replace the stub `packages/api/src/modules/funding/index.ts` with the funding `RouteModule` of `docs/prd/PRD-04-markets.md` section 3: market liquidity state (pool lookup, spot price, quoter depth), the YES sell-ladder funding plan with exact approvals and the maximum-loss disclosure, positions, withdrawal/merge/redemption plans, and a reconciled funding history.

## Context

- Frozen building blocks: `@pine/shared/abi/algebra` (factory, pool, position manager, quoter ABIs — Algebra V1.9: `globalState`, MintParams without fee), `@pine/shared/abi/external` (Seer GnosisRouter, ERC20), `@pine/shared/tx-plan` (allowlist covers splitFromBase, approvals, createAndInitializePoolIfNecessary, mint, decreaseLiquidity, collect, burn, mergeToBase, redeemToBase), `@pine/shared/deployment` (`buildDeploymentManifest`, `GNOSIS_EXTERNAL.amm`).
- Pricing, orientation, tick spacing (60), pool-initialisation griefing and the ladder economics: `docs/research/liquidity-amm.md` sections 2, 3 and 7.
- API harness: `createScriptedChain` (script `eth_call` responses for factory, pool, quoter, sDAI `previewDeposit`/`convertToAssets`), `MemoryReadModel` (claims with outcome tokens), `FakeCompliance`, `FakeQuotas`.

## Constraints

- Only touch your owned paths; migrations in `packages/api/migrations/funding` from `0001_`. No new dependencies.
- Prices and amounts use bigint fixed-point math (no floating point for amounts; tick math may use a vetted integer/`Math.log` hybrid only for tick selection, then verify the resulting sqrt prices with integer arithmetic and round inward so the range never exceeds the requested prices).
- Never re-price a pool with swaps; refuse when an existing pool's price is on the wrong side of the ladder. Every plan passes `verifyPlan` (exact approvals consumed by the mint/merge/redeem steps, recipient = account).
- Concurrency-sensitive writes are single atomic SQL statements; state transitions are compare-and-set.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/markets/policy.json` pass (run them yourself first).
- Every funding test in PRD-04 section 4 exists in area-specific test files, including property tests of tick/price conversion for both token orders, the share margin, mispriced-pool refusal, and the maximum-loss formula against hand-computed values.
- Build order: price/tick math → liquidity state → ladder plan → positions → withdraw/merge/redeem plans → history and reconciliation.

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour, or after three failed attempts at the same check failure. Ask a `question` before changing the economic parameters (margin, slippage, price bounds) of PRD-04.
