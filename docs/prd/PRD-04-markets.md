# PRD-04: Markets, evidence, oracle and funding modules (feature `markets`)

Implements SPEC §3 steps 5–9 and §7, §8 (evidence submission and browsing, resolution/dispute navigation, funding/redemption
reconciliation, transaction history, explicit loading/pending/disputed/invalid/resolved states) for ADR-0001 D4, D6–D8, D11, D13
and SEC-EVID, SEC-TX, SEC-IDX-07. Both lanes are `RouteModule`s using only `AppContext` and the frozen shared packages.

## 1. Lanes and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `markets` | `packages/api/src/modules/markets`, `packages/api/migrations/markets` |
| `funding` | `packages/api/src/modules/funding`, `packages/api/migrations/funding` |

Shared rules: responses carrying plans use `planToWire` and tests decode them with `planFromWire` before `verifyPlan`; time comes
from `ctx.clock` as a bound parameter; inside transactions helpers use the transaction handle only. Build every plan with
`@pine/shared/tx-plan` `buildStep`/`newPlan` and run `verifyPlan` (with a `PlanContext` built
from the read model: market → `[yesToken, noToken, invalidToken]`, question ids including reopened replacements) before returning
it; refuse plans with `NOT_READY` when the read model is stale or halted; call `ctx.compliance.assertAllowed` with the matching
action (`submit_evidence`, `answer_oracle`, `fund_market`, `redeem`); consume `plans_per_day`; persist each plan with an
idempotency key and a compare-and-set state machine `planned → submitted → confirmed | failed | expired`, reconciled by a job from
receipts (logs must come from the expected contracts with the expected arguments). Values are `bigint` base units; API strings are
decimal. All text from chain or uploads is returned as data and labelled untrusted where it originates from users.

## 2. markets lane
### 2.1 Evidence content (SEC-EVID)
- `POST /api/v1/evidence/manifests` (session, JSON): body is the manifest object; validate with `evidenceManifestSchema`, require
  `submitter == session.wallet`, the claim's market registered in the read model, `claim.claimDocumentSha256`/`commit` equal to the
  claim's, every listed artifact already stored (`contentStore.has`) with matching size; encode canonically
  (`encodeEvidenceManifest`), `contentStore.put` (≤ 256 KiB); return `{ sha256, cid }`. Quotas `evidence_uploads_per_day`,
  `evidence_bytes_per_day`. Idempotent by digest.
- `POST /api/v1/evidence/artifacts` (session, `config.pine.multipart`, single file ≤ `config.evidence.maxUploadBytes` ≤ 262144):
  stream with a hard byte limit (abort beyond it), media type checked against the allowlist by the declared type only (never
  sniffed/executed/extracted), store, return `{ sha256, cid, size }`. File names are never used for storage.
- Pine never accepts a salt. Commitments are computed client-side; the API documents the formula and returns plan steps that take
  the commitment (commit) or the preimage parts (reveal) as client-supplied arguments.
### 2.2 Evidence plans and browsing
- `POST /api/v1/evidence/plans/commit {market, commitment}` → one step `evidenceRegistry.commitEvidence`; refused when
  `now >= evidenceDeadline − 60 s` (submission margin; the contract is authoritative).
- `POST /api/v1/evidence/plans/reveal {submissionId, contentSha256, salt}` → one step `revealEvidence`; the salt is used only to
  build calldata in the response and is never persisted or logged (assert in tests); requires the manifest to be stored (so it is
  available to adjudicators) unless the user explicitly acknowledges `unavailableContentAcknowledged: true`, and warns that an
  unobtainable manifest is inadmissible (policy C4). Refused when `now >= revealDeadline − 60 s`.
- `POST /api/v1/evidence/plans/publish {market, contentSha256}` → `publishEvidence` (manifest must be stored).
- `GET /api/v1/markets/:market/evidence?status&cursor` (public): read-model submissions joined with stored manifests (parsed with
  `parseEvidenceManifestBytes`; unparsable → `manifest: null, manifestError`), timeliness flags computed from the claim deadlines and
  the frozen operators, availability (`stored`, `retrievable` via `contentStore.retrieve`), moderation state, `contentTrust: "untrusted"`.
- `GET /api/v1/markets/:market/evidence/:registry/:submissionId/erc1497.json` (public): ERC-1497 evidence JSON
  (`name`, `description` = fixed text + manifest title as data, `fileURI` = `ipfs://<manifest cid>`, `fileHash` = sha256) for parties
  to submit to the Kleros foreign proxy on Ethereum themselves, with instructions (address, `submitEvidence(uint256 questionId, string uri)`).
### 2.3 Oracle and arbitration (ADR D7)
- `GET /api/v1/markets/:market/oracle` (public): question record, answers, `deriveOracleStatus(question, now)`, arbitration record
  and stages, condition resolution and payouts, phase, staleness, and `dueActions(...)`: a pure function returning the permissionless
  actions currently possible (`answer` after opening, `fund_bounty`, `request_arbitration_on_ethereum` (instructions only),
  `handle_notified_request`, `handle_rejected_request`, `report_arbitration_answer` (needs the last history hash/answer/answerer from
  the answer list), `reopen_question` after "answered too soon", `resolve_market` after finalization, `claim_winnings`, `withdraw`).
- Plans (session; `answer_oracle`): `submitAnswer {market, outcome: yes|no|invalid, bond}` with `maxPrevious = current bond` and
  `bond >= max(minBond, 2 × current bond)`; `fundAnswerBounty {market, amount}`; `resolve`, `reopen`, `handleNotifiedRequest`,
  `handleRejectedRequest`, `reportArbitrationAnswer`, `claimWinnings` (arguments reconstructed from the answer history in reverse
  order exactly as Reality requires), `withdraw`. Each plan is verified and its arguments re-derived from the read model at request
  time (never from client-supplied history).
### 2.4 Notifications and history
- Job `markets.watch` (60 s): for each open claim compute due actions and deadline proximity (evidence closes in 24 h, reveal
  closes in 6 h, answers open, finalization in 24 h, arbitration stage changes, resolution) and insert idempotent notification rows
  (unique per claim, kind and target block/time) for the claim creator and evidence submitters; never notify on data the read model
  has not indexed.
- `GET /api/v1/notifications` / `POST /api/v1/notifications/:id/read` (session, owner-only).
- `GET /api/v1/accounts/:wallet/activity` (public): claims created, evidence submitted, oracle answers (from the read model), with
  cursor pagination.

## 3. funding lane (ADR D8)
### 3.1 Market liquidity state (public, cached ≤ 30 s per market)
`GET /api/v1/markets/:market/liquidity`: for YES and NO, the Algebra pool (`factory.poolByPair(token, sDAI)`), `globalState`
(price, tick, fee), `liquidity`, price of the outcome in sDAI and in xDAI (`sDAI.convertToAssets`), and executable depth: the
Quoter (`quoteExactInputSingle`, eth_call at a pinned block) for buying 1, 10 and 100 xDAI worth, reporting average price and
price impact; `null` values with a reason when no pool exists. Spot prices are labelled "not a probability that the code is correct".
### 3.2 YES sell-ladder funding plan
`POST /api/v1/funding/plans/ladder {market, budgetWei, lowerPrice, upperPrice}` (session; `fund_market`; prices as decimal strings
in sDAI per YES with `0.01 <= lowerPrice < upperPrice <= 0.95`):
1. Claim must be verified (integrity), in `evidence_open` phase, with at least 1 hour before the evidence deadline.
2. `shares = sDAI.previewDeposit(budgetWei)` (eth_call), `S = shares − ceil(shares × 10 / 10000)` (10 bps margin for interest
   accrual between plan and execution; the remainder stays in the wallet as full sets).
3. Orientation: tokens sorted (`token0 < token1`). If YES is token0, Algebra price = sDAI per YES: the ladder is a token0-only
   range above the current price, ticks `[ceilTick(lowerPrice), floorTick(upperPrice)]`; else price = YES per sDAI: a token1-only
   range below the current price, ticks `[ceilTick(1/upperPrice), floorTick(1/lowerPrice)]`. Ticks are aligned to the pool's tick
   spacing (60 for new pools; read `tickSpacing()` for existing ones) inward so the range never exceeds the requested prices.
4. Pool state: if the pool does not exist, include `createAndInitializePoolIfNecessary(token0, token1, sqrtPriceX96 at lowerPrice
   in the pool's orientation)`. If it exists, its current price must lie outside the range on the correct side (YES cheaper than
   `lowerPrice`) so the position is single-sided; otherwise refuse with an explanation (no re-pricing swaps in v1).
5. Steps: `gnosisRouter.splitFromBase{value: budgetWei}(market)`; `outcomeToken.approve(positionManager, S)` on the YES token;
   (optional pool creation); `positionManager.mint({token0, token1, tickLower, tickUpper, amount(YES side) = S, other side 0,
   amountMin(YES side) = S − S×50/10000, other min 0, recipient = account, deadline = now + 20 min})`.
6. Response also gives: maximum loss if YES resolves `S × (1 − sqrt(lowerPrice × upperPrice))` in sDAI and xDAI (+ gas estimate),
   loss if NO or Invalid resolves (gas only, plus the 10 bps remainder is kept as full sets), the fee range of the pool, the
   withdrawability statement (positions can be withdrawn at any time; liquidity is not a bounty), and the disclosures of policy C7.
### 3.3 Positions, withdrawal, merge and redemption
- `GET /api/v1/funding/positions/:wallet` (public): the wallet's Algebra positions (`balanceOf`, `tokenOfOwnerByIndex`, `positions`)
  in Pine market pools, with amounts, plus outcome token balances per claim market.
- Plans: `withdraw {tokenId}` → `decreaseLiquidity(all, mins from a fresh quote with 50 bps slippage, deadline)`, `collect(recipient =
  account, max)`, `burn` (only when liquidity becomes zero); `merge {market, amount}` → three exact approvals (YES, NO, INVALID to the
  GnosisRouter) + `mergeToBase(market, amount)`; `redeem {market}` (after `ConditionResolution`) → exact approvals of the winning
  outcome tokens held + `redeemToBase(market, indexes, amounts)`.
- Funding history: plans with states and confirmed receipts per wallet; reconciliation job `funding.reconcile` (30 s).

## 4. Required tests (vitest with the frozen harness, scripted chain responses; name SEC ids in negative tests)
- markets: manifest validation (wrong submitter, wrong claim, missing artifact, non-canonical), artifact size limit enforced while
  streaming, multipart only on that route, no salt persisted or logged (inspect DB rows and captured logs), deadline margins, every
  plan passes `verifyPlan` and binds to the registered market/question, reveal with unavailable content requires acknowledgement,
  evidence listing timeliness at the exact deadline second, ERC-1497 output, `dueActions` for every oracle state including
  answered-too-soon/reopen, arbitration stages and finalization, `claimWinnings` argument reconstruction against a hand-computed
  history, notification idempotency, NOT_READY when stale, compliance refusals.
- funding: tick/price conversion and orientation for both token orders (property tests: the range never exceeds the requested
  prices; single-sidedness), share margin, pool missing vs existing correctly priced vs mispriced (refused), exact approval equals
  the mint amount, recipient = account, max-loss formula against hand-computed values, withdraw/merge/redeem plans verified, quoter
  depth parsing, cache, NOT_READY and compliance refusals, reconciliation transitions.

## 5. Checks (per lane)
`pnpm --filter @pine/api typecheck`, `pnpm exec eslint packages/api/src` (typecheck), `node scripts/check-forbidden.mjs` (unit),
`pnpm --filter @pine/api exec vitest run src/modules/<lane-dir>` (unit).
