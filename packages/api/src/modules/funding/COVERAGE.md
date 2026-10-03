# funding lane — coverage matrix (PRD-04 sections 1, 3, 4, 4a, 4b; features/markets/decisions.md)

Every row names the test that fails if the behaviour is removed. Paths are relative to `packages/api/src/modules/funding`.
Checks: `typecheck`, `lint`, `forbidden` (`node scripts/check-forbidden.mjs`), `unit` (`vitest run src/modules/funding`).

## PRD-04 section 4 — funding tests

| Requirement | Test file › test name |
|---|---|
| Inline integrity gate: unavailable document → INTEGRITY_FAILED, no plan | integrity.test.ts › "SEC-IDX-08 an unavailable claim document is INTEGRITY_FAILED and no plan is stored" |
| Inline integrity gate: each mismatching field → INTEGRITY_FAILED naming fields, no plan | integrity.test.ts › "SEC-IDX-08 a mismatching on-chain record names the failed fields and returns no plan"; "detects a mismatching {creator, repository id, commit, policy sha256, evidence deadline, reveal deadline, min bond, title, claim registry, market name, unrenderable repository id}"; "detects a document {Seer market factory, collateral token, realitio, arbitrator, question timeout, market chain id, evidence chain id, evidence registry, claim registry} that differs from the deployment manifest"; "SEC-CLAIM-01 bytes that are not the canonical document for the digest are INTEGRITY_FAILED" |
| splitFromBase omitted when the YES balance covers S | ladder.test.ts › "omits splitFromBase when the YES balance already covers S, so a fresh plan never splits twice"; "keeps splitFromBase when the YES balance is one wei short of S" |
| Bounded positions paging (20 per page, 200 per wallet) | positions.test.ts › "pages 20 NFTs at a time and returns only the market's outcome/sDAI positions plus outcome balances"; "bounds the scan: at most 20 NFTs per request and 200 per wallet (truncated beyond)" |
| Tick/price conversion and orientation, both token orders (property: range never exceeds requested prices; single-sidedness) | math.test.ts › "property (YES = token0): the range never exceeds the requested prices and the initial price makes the mint YES-only"; "property (YES = token1): …"; "property: ceilTick is the smallest tick at or above the price and floorTick the largest at or below"; "YES = token0: [ceilTick(lower), floorTick(upper)] aligned inward (hand-computed for 0.20..0.95)"; "YES = token1: [ceilTick(1/upper), floorTick(1/lower)] aligned inward (hand-computed for 0.20..0.95)"; "matches the canonical boundary values" (describe "TickMath"); ladder.test.ts › "missing pool, YES = token0: …"; "missing pool, YES = token1: …" |
| Share margin S = shares − ceil(shares × 10 / 10000) | math.test.ts › "S = shares - ceil(shares x 10 / 10000)"; ladder.test.ts › "missing pool, YES = token0: …" (sets, sharesPreview, remainderShares) |
| Pool missing (created) | ladder.test.ts › "missing pool, YES = token0: split, exact approval, create at getSqrtRatioAtTick(tickLower) - 1, YES-only mint to the account" |
| Pool existing but uninitialised (initialised in the plan) | ladder.test.ts › "existing but uninitialised pool (price 0) is initialised by the plan, with the pool's own tick spacing" |
| Pool existing and correctly priced | ladder.test.ts › "existing pool priced below the range (YES = token0): no pool step, mint depends on the approval only"; "existing pool priced above the range (YES = token1) is correctly priced"; "accepts the YES = token1 pool exactly at tickUpper 6900 (YES-only) and YES = token0 one tick below tickLower" |
| Mispriced pool refused (inside the range) | ladder.test.ts › "refuses a mispriced existing pool (price inside the range) with an explanation; no plan is stored"; "refuses a mispriced existing pool for YES = token1 (YES priced inside the range)"; math.test.ts › "isYesOnlySide rejects a pool priced at or inside the range" |
| Mispriced pool refused (outside the range on the wrong side, YES dearer than upperPrice; both token orders; markets-002 coverage P1) | ladder.test.ts › "refuses an existing pool priced on the wrong side, outside the range: YES = token0, YES at ~0.98 (tick -200 >= tickUpper -540); no plan is stored"; "… YES = token0, pool exactly at tickUpper -540; …"; "… YES = token1, YES at ~0.98 (tick 200 < tickLower 540); …"; "… YES = token1, pool one tick below tickLower (539); …" |
| Idempotent plan retries (SEC-TX-08) | ladder.test.ts › "same key and body return the stored plan unchanged and consume one quota unit"; "same key with a different body is 409 CONFLICT"; "keys are scoped per user: …"; "a missing or malformed Idempotency-Key is 400 and stores nothing"; "QUOTA_EXCEEDED never leaves a stored plan"; reconcile.test.ts › "two first requests racing on one key store one plan and both return it"; "the atomic insert on a taken key keeps the winner's plan and steps (ON CONFLICT DO NOTHING)" |
| Exact approval equals the mint amount | ladder.test.ts › "SEC-TX-03 the approval equals the mint amount exactly; a larger approval or another recipient fails verifyPlan" |
| Recipient = account | ladder.test.ts › "SEC-TX-03 …"; "SEC-TX-01 binds the plan to the session wallet, never to a client-supplied account"; exits.test.ts › "decreases all liquidity … collects to the account …" |
| Max-loss formula against hand-computed values (final ticks) | math.test.ts › "matches the hand-computed value for [0.5, 0.98] with YES = token0"; "… [0.5, 0.98] with YES = token1"; "… [0.2, 0.95] with YES = token0"; "… [0.2, 0.95] with YES = token1"; "is zero when the ladder sells at par and S at most for a near-zero price"; ladder.test.ts › "missing pool, YES = token0: …" and "missing pool, YES = token1: …" (LOSS_HAND over ticks [-6900, -540]; differs from the requested-price value by ~1.2e16); "SEC-LEGAL-03 accepts an acknowledged maximum loss equal to or above the computed one (favourable drift is fine)" |
| Withdraw / merge / redeem plans verified | exits.test.ts › "decreases all liquidity with mins from a fresh quote (50 bps), collects to the account with max amounts, then burns"; "only collects and burns when no liquidity is left; only burns an empty NFT"; "three exact approvals to the GnosisRouter consumed by mergeToBase"; "approves exactly the winning tokens held and redeems them to xDAI"; "an Invalid resolution pays only the INVALID token; nothing held is refused" (each decodes with planFromWire and runs verifyPlan) |
| Quoter depth parsing | liquidity.test.ts › "average price is sDAI in / outcome out (rounded up) and impact is relative to spot, in bps"; "reads globalState, liquidity, spot prices in sDAI and xDAI and quoter depth at one pinned block (YES = token0)"; "inverts the price when the outcome is token1" |
| Cache (≤ 30 s per market) | liquidity.test.ts › "caches per market for 30 s (no chain reads inside the window)" |
| NOT_READY refusals | ladder.test.ts › "NOT_READY when the read model is halted or stale"; exits.test.ts › "SEC-IDX-07 {withdraw, merge, redeem}: NOT_READY when the read model is halted or stale; no plan is stored" |
| Compliance refusals | ladder.test.ts › "SEC-LEGAL-01 SEC-LEGAL-02 SEC-LEGAL-03 compliance refusals (blocked action, blocked wallet, missing terms) return no plan"; exits.test.ts › "SEC-LEGAL-01 {withdraw, merge, redeem}: compliance is asked for \"redeem\" and a refusal returns no plan"; "SEC-LEGAL-01 compliance refusal returns no plan" |
| Reconciliation transitions | reconcile.test.ts › "SEC-OPS-07 failed (partial execution) carries the fixed revert reason; expired writes one entry"; "confirms each step from a finalized successful receipt whose transaction matches, then the plan"; "waits for finality: a receipt above the finalized block does not confirm"; "SEC-TX-08 never confirms from a transaction whose {to, from, input, value} differs from the step"; "records a reverted attempt without confirming; a later replacement confirms"; "partial execution past expires_at + 1 h becomes failed and points to the merge plan"; "one plan's RPC failure does not stop the run" |

## PRD-04 section 4 — "both lanes" (plan store)

| Requirement | Test file › test name |
|---|---|
| Same-key retry | ladder.test.ts › "same key and body return the stored plan unchanged and consume one quota unit" |
| Different body 409 | ladder.test.ts › "same key with a different body is 409 CONFLICT" |
| `/submitted` owner-only and idempotent | reconcile.test.ts › "/submitted records the hint once (idempotent) and moves planned -> submitted"; "/submitted is owner-only: another user's plan, an unknown plan or an unknown step are NOT_FOUND"; "accepts at most 8 hashes per step (speed-ups and replacements)" |
| Reconcile transitions incl. partial execution → failed | reconcile.test.ts › "partial execution past expires_at + 1 h becomes failed and points to the merge plan" |
| Expiry per kind | reconcile.test.ts › "expiry per kind: ladder after 20 min + 1 h, merge after 1 h + 1 h; never before"; exits.test.ts › "expires_at = created + 20 min for withdraw and created + 1 h for merge and redeem"; ladder.test.ts › "missing pool, YES = token0: …" (expiresAt = created + 20 min) |
| Same-key retry after expiry returns the stored plan with its state | reconcile.test.ts › "a same-key retry after expiry returns the stored plan with its state; terminal plans ignore hints" |
| Every plan passes verifyPlan before it is returned | reconcile.test.ts › "SEC-TX-01 a built plan that fails verifyPlan is refused with 422 and nothing is stored" |
| claimWinnings / reportArbitrationAnswer history arguments | N/A for funding: the funding lane builds no oracle plans (markets lane) |
| Test app: multipart with core options + capturing logger; module never registers multipart | test/app.ts (every funding test file boots through it: a second multipart registration by the module would throw at boot); ladder.test.ts › "is JSON-only: a multipart body (core registers @fastify/multipart) is refused and stores nothing"; ladder.test.ts and liquidity.test.ts › "RPC failures are UPSTREAM_UNAVAILABLE without leaking the RPC URL …" (asserts the captured logs) |

## PRD-04 section 3 behaviours beyond the section 4 list

| Requirement | Test file › test name |
|---|---|
| Phase: evidence_open with ≥ 1 h before the evidence deadline | ladder.test.ts › "is offered until 1 hour before the evidence deadline, not at it" |
| Moderation hide/block refused | ladder.test.ts › "refuses hidden or blocked claims" |
| Price bounds [0.01, 0.95], ordering, 10,000 xDAI limit, strict body (incl. `salt`) | ladder.test.ts › "validates price bounds [0.01, 0.95], ordering, the 10,000 xDAI limit and unknown fields" |
| Mint minimum S − 50 bps; deadline now + 20 min | math.test.ts › "mint minimum = S - S x 50 / 10000"; ladder.test.ts › "missing pool, YES = token0: …" |
| Pool init strictly outside the range (tickLower sqrt − 1 / tickUpper sqrt + 1) | ladder.test.ts › "missing pool, YES = token0: …"; "missing pool, YES = token1: …"; math.test.ts › property tests |
| One pinned block per request | ladder.test.ts › "missing pool, YES = token0: …" (all eth_calls at 0x1388); liquidity.test.ts › "reads globalState … at one pinned block" |
| Withdrawability mentions liquidityCooldown() | ladder.test.ts › "existing pool priced below the range …", "existing pool priced above the range …" (currently 3600 s); exits.test.ts › "states a non-zero liquidityCooldown" |
| C7 disclosures, "not a probability" label | ladder.test.ts › "missing pool, YES = token0: …"; liquidity.test.ts › "reports null pools with a reason when none exist" |
| Step 6 disclosure fields: gasEstimate, lossIfNoOrInvalid, pool fee range (PRD-04 4a) | ladder.test.ts › "missing pool, YES = token0: …" (gas 7,810,000 units / 7.81e15 wei at 1 gwei; remainder 0.08 sDAI = 0.1 xDAI; fees 100..15,000, governance 65,535, currentFee null); "existing pool priced below the range (YES = token0): …" (gas 1,010,000 units without pool creation; currentFee 2,959) |
| Null pools with a reason | liquidity.test.ts › "reports null pools with a reason when none exist" |
| Withdraw checks ownerOf == account and a registered market's pair | exits.test.ts › "refuses a position the session wallet does not own (ownerOf by eth_call)"; "refuses a position whose pair is not this claim market's outcome token with sDAI" |
| Merge: three exact approvals + mergeToBase; short balance refused; amount ≤ 10^30 | exits.test.ts › "three exact approvals to the GnosisRouter consumed by mergeToBase"; "refuses when any outcome balance is short, and validates the amount" |
| Redeem only after ConditionResolution | exits.test.ts › "is refused before ConditionResolution" |
| History: owner's plans, keyset cursor | reconcile.test.ts › "history lists only the user's plans, newest first, with a keyset cursor" |
| funding.reconcile registered at 30 s | reconcile.test.ts › "is registered as a 30 s job" |
| Positions need `?market=` | positions.test.ts › "requires a registered market and a valid cursor" |
| Public positions route: 10 s server cache per (wallet, market, cursor) | positions.test.ts › "caches per (wallet, market, cursor) for 10 s: no chain reads inside the window (PRD-04 4a)" |
| RPC failures never leak the RPC URL (response and logs) | ladder.test.ts / liquidity.test.ts › "RPC failures are UPSTREAM_UNAVAILABLE without leaking the RPC URL …" |

## PRD-04 section 4a — markets-002 review fixes (funding)

| Requirement | Test file › test name |
|---|---|
| Existing pool priced outside the range on the wrong side refused, both token orders (coverage P1) | ladder.test.ts › the four "refuses an existing pool priced on the wrong side, outside the range: …" tests (rows above) |
| Every step 6 disclosure field asserted | ladder.test.ts › "missing pool, YES = token0: …"; "existing pool priced below the range (YES = token0): …" |
| SEC-LEGAL-03 acknowledgement accepted at or above the computed maximum loss | ladder.test.ts › "SEC-LEGAL-03 accepts an acknowledged maximum loss equal to or above the computed one (favourable drift is fine)" |
| SEC-LEGAL-03 refused (409 with the fresh figures) when the computed loss exceeds the acknowledged value; nothing stored | ladder.test.ts › "SEC-LEGAL-03 refuses with 409 and the freshly computed figures when the computed loss exceeds the acknowledged one; nothing is stored" |
| SEC-LEGAL-03 acknowledgement required; `budgetWei` equals the request budget; fees are never acknowledged | ladder.test.ts › "SEC-LEGAL-03 the acknowledgement is required: missing, a budget other than the request's, malformed values or an acknowledged fee are VALIDATION_FAILED" |
| SEC-LEGAL-03 acknowledgement stored with the plan (and part of the idempotency body hash) | ladder.test.ts › "SEC-LEGAL-03 stores the acknowledgement with the plan and binds it into the idempotency body hash" |
| `withdraw` requires `{market, tokenId}` | exits.test.ts › "requires {market, tokenId}: a body without market is VALIDATION_FAILED and reads nothing (PRD-04 4a)" |
| Reconcile bumps `reconciled_at` on every attempt, including errors | reconcile.test.ts › "bumps reconciled_at on every attempt, errors included, so failing plans cannot starve the batch (PRD-04 4a)" |
| `requireClaim` checks `claim.registry === manifest.pine.claimRegistry` | integrity.test.ts › "a claim created by another ClaimRegistry is NOT_FOUND on every funding route, before any chain read or integrity check" |
| `/funding/positions/:wallet` 10 s per-key server cache | positions.test.ts › "caches per (wallet, market, cursor) for 10 s: no chain reads inside the window (PRD-04 4a)" |

Each 4a row was mutation-checked in markets-003: removing the behaviour (no reconciled_at bump on errors, no registry check,
no positions cache, no acknowledgement comparison, refusing only pools inside the range) made exactly the listed tests fail.
(Those 4a mutations were not re-run in markets-004; the 4b mutations below were.)

## PRD-04 section 4b — markets-003 review fixes (funding)

Audit rule (SEC-OPS-07): `ctx.audit.record` is called exactly once per write that actually happened — the plan insert that
won `INSERT ... ON CONFLICT DO NOTHING RETURNING` (`funding.plan.created`: actor, plan id, route, kind, market, step count,
client IP), a tx-hash hint whose append returned a row (`funding.plan.tx_reported`: actor, plan id, stepId, txHash, client IP),
and each plan compare-and-set in reconcile that returned a row (`funding.plan.confirmed` / `.failed` / `.expired`, actor null,
with `from`, kind, step counts and, for failed/expired, the fixed-vocabulary revert reasons). An audited tx-hash hint is a NEW
{stepId, txHash}; an identical repeated hint (sequential or concurrent) is an idempotent replay and is not audited (same rule
as markets/plans.ts). Replays, refusals and lost races write nothing.

| Requirement | Test file › test name |
|---|---|
| Plan insert writes exactly one audit entry with actor, plan id, route, kind, market, step count, client IP | ladder.test.ts › "SEC-OPS-07 a stored plan writes exactly one redacted audit entry (actor, plan id, route, kind, market, step count, IP); a same-key replay writes none" |
| Same-key replay writes no audit entry | ladder.test.ts › same test; reconcile.test.ts › "two first requests racing on one key store one plan and both return it" (one created entry) |
| Lost insert race (ON CONFLICT) writes no audit entry and returns the winner's plan | reconcile.test.ts › "SEC-OPS-07 a request that loses the insert race returns the winner's plan and writes no audit entry" |
| Refused requests (409 different body, NOT_READY, QUOTA_EXCEEDED) write no audit entry | ladder.test.ts › "SEC-OPS-07 a refused request (409 different body, NOT_READY, QUOTA_EXCEEDED) writes no audit entry" |
| A NEW {stepId, txHash} hint writes exactly one entry; identical repeats (sequential and concurrent) write none; same hash for another step is new | reconcile.test.ts › "SEC-OPS-07 a NEW {stepId, txHash} hint writes exactly one audit entry; an identical repeat (also concurrent) writes none" |
| Hints for another user's plan or a terminal plan write no audit entry | reconcile.test.ts › "SEC-OPS-07 a hint for another user's plan or a terminal plan writes no audit entry" |
| Reconcile `confirmed` CAS writes exactly one entry; later runs none | reconcile.test.ts › "SEC-OPS-07 confirmed: the winning CAS writes exactly one entry; later runs write none" |
| Reconcile `failed` (with the redacted revert reason) and `expired` CAS write exactly one entry each | reconcile.test.ts › "SEC-OPS-07 failed (partial execution) carries the fixed revert reason; expired writes one entry" |
| A lost reconcile CAS race writes no audit entry | reconcile.test.ts › "SEC-OPS-07 a lost CAS race writes no audit entry (another reconciler moved the plan first)"; "two concurrent runs write one audit entry per transition" |
| expired/failed decided only while the read model is fresh (lagging and halted keep the plan for a retry) | reconcile.test.ts › "decides expired/failed only while the read model is fresh: a lagging or halted read model keeps the plan for a retry" |
| expired/failed (and confirmation) decided only when finalizedBlock() succeeded in this run | reconcile.test.ts › "decides nothing when finalizedBlock() fails in this run: no confirmation, no expiry; the next run retries" |
| Confirmation from finalized receipts does not depend on freshness | reconcile.test.ts › "a lagging read model still confirms from finalized receipts (confirmation does not depend on freshness)" |
| createOrReplayPlan order lookup → readiness → quota → build → insert: a same-key replay succeeds while halted (no quota, no RPC); NOT_READY burns no quota | ladder.test.ts › "a same-key replay is answered from the store while the read model is halted: no quota, no chain read" |
| An exhausted quota makes no RPC call and stores nothing | ladder.test.ts › "an exhausted plans_per_day quota is refused before any chain read and stores nothing" |
| `/funding/positions/:wallet` caps RPC fan-out at 4 in flight per process, checked after the 10 s cache; a 5th concurrent miss is 429 RATE_LIMITED with Retry-After at once (never queued); cached keys are still served | positions.test.ts › "caps RPC fan-out at 4 concurrent cache misses: a 5th is 429 RATE_LIMITED at once, never queued (PRD-04 4b)" |
| A failing chain read releases its slot | positions.test.ts › "releases a slot when the chain read fails, so errors cannot exhaust the limiter" |

Mutation-checked in markets-004 (each made the named test fail, then was reverted): auditing every hint regardless of the
append result; auditing an insert that lost the conflict; auditing a lost confirmed CAS; dropping `revertReasons`; expiring
without the freshness gate; expiring without the finalizedBlock gate; readiness check before the same-key lookup; quota
after build; calling readPositions without the limiter (5th request queued → timeout); a limiter that never releases.

Existing expiry tests (`partial execution …`, `expiry per kind …`, `a same-key retry after expiry …`) now refresh the read model
after moving the clock, because expiry is decided only while it is fresh.

## decisions.md and operator-settled clarifications

| Decision / clarification | Covered by |
|---|---|
| Single-sided YES ladder by the user's wallet; no re-pricing swaps; mispriced pool refused | ladder.test.ts pool-state tests above (the only steps are split/approve/create/mint) |
| S − 10 bps, mint min S − 50 bps, prices in [0.01, 0.95], max loss S × (1 − sqrt(lower × upper)) at final ticks | math.test.ts and ladder.test.ts rows above |
| Every plan verified, persisted with an idempotency key, reconciled; NOT_READY when stale/halted | rows above |
| Concurrency-sensitive writes atomic; CAS transitions | reconcile.test.ts › "the atomic insert on a taken key …", "two first requests racing …", "a same-key retry after expiry … terminal plans ignore hints" |
| Idempotency-Key per (user, route) with body hash, one quota unit per key | ladder.test.ts idempotency describe |
| Driver portability (RETURNING rows only, explicit casts, tx handle only) | Code review only (store.ts/reconcile.ts read RETURNING rows; no transactions are used). node-postgres not exercised: listed as untested |
| Existing uninitialised pool initialised like a missing one | ladder.test.ts › "existing but uninitialised pool (price 0) …" |
| One plan-store contract; per-kind expiry; partial execution = failed | "both lanes" table |
| Funding's "claim verified" gate is inline (INTEGRITY_FAILED 409) | integrity.test.ts |
| verifyPlan limits 10,000 xDAI / approvals ≤ 10^30 | ladder.test.ts › "validates price bounds … the 10,000 xDAI limit …"; exits.test.ts › "refuses when any outcome balance is short, and validates the amount" |
| Step confirmation: finalized successful receipt + to/from/input/value equality | reconcile.test.ts confirmation/tamper tests |
| Modules bind ownerOf(tokenId) == account for LP steps | exits.test.ts › "refuses a position the session wallet does not own (ownerOf by eth_call)" |
| Max loss uses final tick prices; withdrawability mentions liquidityCooldown(); positions need ?market= | rows above |
| Pool initialisation price strictly outside the range | rows above |
| Positions paging 20 / 200; balances only for the given market | positions.test.ts |
| Lane-local test app with multipart (core options) and capturing logger | test/app.ts; rows above |
| Literal bidi/zero-width characters never in test files | `forbidden` check (Trojan Source rule) |
| Operator clarification 1: cross-process test lock, one context per file | test/lock.ts imported first by every test file; test/harness.ts createHarness in beforeAll |
| Operator clarification 2: bidi/zero-width only as \u escapes | `forbidden` check |
| Operator clarification 3: module-local sDAI ABI (previewDeposit, convertToAssets) | chain.ts sdaiAbi; ladder.test.ts › "missing pool, YES = token0: …" (sharesPreview 80 sDAI, xDAI loss at 1.25) |
| Operator clarification 4: range narrower than one tick spacing → VALIDATION_FAILED | ladder.test.ts › "refuses a range narrower than one tick spacing with VALIDATION_FAILED (operator clarification 4)"; math.test.ts › "refuses a range narrower than one tick spacing (operator clarification 4)" |
| Operator clarification 5: approval exactly S; residual allowance ≤ 10 wei disclosed | ladder.test.ts › "missing pool, YES = token0: …" (approve args [NPM, S]; residualAllowance /10 wei/) |
| Operator security fix (markets-002, P1): every BigInt refinement guarded by `isUintString` (zod 4 runs refinements after a failed regex) | ladder.test.ts › "malformed budgetWei (\"abc\", \"1.5\", \"-1\", \"\", 79 digits) is 400 VALIDATION_FAILED, never 500, with or without a session"; exits.test.ts › "merge amount: \"abc\", \"1.5\", \"-1\", \"\" and 79 digits are VALIDATION_FAILED with or without a session; no plan is stored"; "withdraw tokenId: …" (same) |
