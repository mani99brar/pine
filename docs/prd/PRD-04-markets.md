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

Idempotency (SEC-TX-08): every plan-creating POST requires the header `Idempotency-Key` (1–64 characters of `[A-Za-z0-9_-]`,
otherwise 400). The key is scoped to (user, route); the first request stores the plan with the key and a SHA-256 of the
canonical request body in one `INSERT ... ON CONFLICT DO NOTHING RETURNING`; a retry with the same key and body returns the
stored plan unchanged (same plan id, same calldata) and consumes `plans_per_day` only once; the same key with a different body is
409 CONFLICT.

Plan store (identical contract in both lanes, each in its own tables `<lane>_plans` and `<lane>_plan_steps`):
- Row: id (uuid), user (FK `users`), route, idempotency key, body hash, kind, market, wire steps (`planToWire`), state,
  `expires_at`, timestamps; unique (user, route, idempotency key); per step: reported tx hashes (several allowed: speed-ups and
  replacements), step state, the redacted revert reason.
- Reveal plans are the exception: their wire steps are NOT stored (the calldata contains the salt) and their body hash covers only
  `(submissionId, contentSha256)`; a retry rebuilds the identical calldata from the request body in memory. No table, column or
  log ever holds the salt, with or without `0x` (tests cast every row of every module table to text and search both forms).
- `POST /api/v1/<lane>/plans/:planId/submitted {stepId, txHash}` (session, owner only, otherwise NOT_FOUND; idempotent; `<lane>` is
  `markets` or `funding`) records a hint and moves the plan `planned → submitted`.
- States: plan `planned → submitted → confirmed | failed | expired` (compare-and-set only). One uniform confirmation rule (no
  per-function event table: router, proxy and position-manager calls emit their events from other contracts or none at all): a
  step is `confirmed` when one of its reported hashes has a successful receipt at or below `ctx.chain.finalizedBlock()` and
  `eth_getTransactionByHash` shows `to == step.to`, `from == plan.account`, `input ==` the stored step calldata and `value ==`
  step value (sessions are EOA-only; speed-ups and replacements keep the calldata). Reveal steps (calldata not stored) and other
  evidence/oracle steps are confirmed from read-model facts instead (evidence committed/revealed/published by that submitter for
  that market and submission, oracle answers by answerer, question and bond). The plan is `confirmed` when every
  step is; when `expires_at` + 1 h passed without that, it becomes `expired` if no step was confirmed, else `failed` (partial
  execution; the response points to the merge plan as recovery).
- `expires_at` = min(created + 24 h, kind deadline): commit and publish `evidenceDeadline − 60 s`, reveal `revealDeadline − 60 s`,
  oracle helper plans created + 1 h (their arguments go stale), ladder created + 20 min (its mint deadline), withdraw created +
  20 min, merge and redeem created + 1 h. A same-key retry after expiry returns the stored plan with its state; a fresh plan
  needs a new key.
- Limits for `verifyPlan`: `maxTotalValueWei` = 10,000 xDAI in both lanes (client-supplied bonds, bounties and budgets above it are
  VALIDATION_FAILED); `maxApprovalAmount` = 0 in markets (no approvals) and 10^30 in funding (a sanity bound; exactness of every
  approval against the consuming step is what `verifyPlan` enforces).
- Order with quotas: look up (user, route, key) → if found return it; else consume `plans_per_day`, then `INSERT ... ON CONFLICT DO
  NOTHING RETURNING` (on conflict return the winner's plan; two racing first requests may consume two units — accepted). A
  QUOTA_EXCEEDED therefore never leaves a stored plan.
- Reconciliation jobs `markets.reconcile` and `funding.reconcile` (30 s) implement these transitions idempotently. Database portability: tests run on PGlite but production uses node-postgres, so compare-and-set success is read
only from drizzle `.returning()` rows (never `rowCount`/`affectedRows`) and raw SQL casts int8 and counts explicitly; inside a
transaction every query uses the transaction handle.

## 2. markets lane
### 2.1 Evidence content (SEC-EVID)
- `POST /api/v1/evidence/manifests` (session, JSON): body is the manifest object; validate with `evidenceManifestSchema`, require
  `submitter == session.wallet`, the claim's market registered in the read model, `claim.claimDocumentSha256`/`commit` equal to the
  claim's, every listed artifact already stored (`contentStore.has`) with matching size; encode canonically
  (`encodeEvidenceManifest`), `contentStore.put` (≤ 256 KiB); return `{ sha256, cid }`. Quotas `evidence_uploads_per_day`,
  `evidence_bytes_per_day`. Idempotent by digest.
- `POST /api/v1/evidence/artifacts` (session, `config.pine.multipart`, single file ≤ `config.evidence.maxUploadBytes` ≤ 262144):
  stream with a hard byte limit (abort beyond it: 413, nothing stored, no quota consumed — quotas are consumed only after the
  stream completed within limits), media type checked against the allowlist by the declared type only (never
  sniffed/executed/extracted), store, return `{ sha256, cid, size }`. An optional form field `expectedSha256` is only compared with
  the server-computed digest (mismatch: 422, nothing stored; SEC-EVID-03). File names are never used for storage or returned
  (SEC-EVID-08).
- Pine never accepts a salt. Commitments are computed client-side; the API documents the formula and returns plan steps that take
  the commitment (commit) or the preimage parts (reveal) as client-supplied arguments.
### 2.2 Evidence plans and browsing
- `POST /api/v1/evidence/plans/commit {market, commitment}` → one step `evidenceRegistry.commitEvidence`; refused when
  `now >= evidenceDeadline − 60 s` (submission margin; the contract is authoritative).
- `POST /api/v1/evidence/plans/reveal {submissionId, contentSha256, salt}` → one step `revealEvidence`; the salt is used only to
  build calldata in the response and is never persisted or logged (assert in tests); the submission must be indexed with
  `submitter == session.wallet` and `computeEvidenceCommitment(chainId, registry, market, session.wallet, contentSha256, salt)`
  must equal its indexed commitment (in memory only; mismatch → UNPROCESSABLE, so a wrong salt never costs the user gas); requires the manifest to be stored (so it is
  available to adjudicators) unless the user explicitly acknowledges `unavailableContentAcknowledged: true`, and warns that an
  unobtainable manifest is inadmissible (policy C4). Refused when `now >= revealDeadline − 60 s`.
- `POST /api/v1/evidence/plans/publish {market, contentSha256}` → `publishEvidence` (manifest must be stored).
- `GET /api/v1/markets/:market/evidence?status&cursor` (public): read-model submissions joined with stored manifests (parsed with
  `parseEvidenceManifestBytes`; unparsable → `manifest: null, manifestError`), timeliness flags computed from the claim deadlines and
  the frozen operators, availability `stored` (local `contentStore.has` only: a public listing never triggers remote gateway
  fetches), moderation state, `contentTrust: "untrusted"`. `retrievable` (via `contentStore.retrieve`) is computed only on the
  single-submission detail route and cached for 10 minutes.
- `GET /api/v1/markets/:market/evidence/:registry/:submissionId/erc1497.json` (public): ERC-1497 evidence JSON
  (`name`, `description` = fixed text + manifest title as data, `fileURI` = `ipfs://<manifest cid>`, `fileHash` = sha256) for parties
  to submit to the Kleros foreign proxy on Ethereum themselves, with instructions (address, `submitEvidence(uint256 questionId, string uri)`).
### 2.3 Oracle and arbitration (ADR D7)
- `GET /api/v1/markets/:market/oracle?account` (public): question record, answers, `deriveOracleStatus(question, now)`, arbitration
  record and stages, condition resolution and payouts, phase, staleness, and `dueActions(...)`: a pure function over read-model facts
  plus values read by `eth_call` at request time (Reality `getHistoryHash(questionId)` once finalized: zero means winnings were
  already claimed; with `account`, Reality `balanceOf(account)` for `withdraw`; account-specific actions appear only when `account`
  is given), returning the permissionless actions currently possible (`answer` after opening, `fund_bounty`, `request_arbitration_on_ethereum` (instructions only),
  `handle_notified_request`, `handle_rejected_request`, `report_arbitration_answer` (needs the last history hash/answer/answerer from
  the answer list), `reopen_question` after "answered too soon", `resolve_market` after finalization, `claim_winnings`, `withdraw`).
- Plans (session; `answer_oracle`): `submitAnswer {market, outcome: yes|no|invalid, bond}` with `maxPrevious = current bond` and
  `bond >= max(minBond, 2 × current bond)`; `fundAnswerBounty {market, amount}`; `resolve`, `reopen`, `handleNotifiedRequest`,
  `handleRejectedRequest`, `reportArbitrationAnswer`, `claimWinnings` (arguments reconstructed from the answer history in reverse
  order exactly as Reality requires, starting from the current on-chain `getHistoryHash` so only still-unclaimed entries are
  included after a partial claim; a reopened market also offers the claim on its original settled-too-soon question), `withdraw`. `reopenQuestion` re-creates the original content exactly: template 2, question =
  `marketName` ␟ `"Yes","No"` ␟ `config.claims.questionCategory` ␟ `config.claims.questionLanguage` (asserted at registration to
  equal the ClaimRegistry constants `misc` and `en_US`), the original arbitrator, timeout, opening time and min bond from the
  question record. `reopens_question_id` is always the ORIGINAL claim question (`ClaimRecord.questionId`; Reality v3 refuses to
  reopen a reopener, and the module checks this explicitly because `verifyPlan` accepts replacement ids too). The nonce is the
  smallest `n` in `0..15` whose question id `keccak256(abi.encodePacked(content_hash, arbitrator, timeout, min_bond, realitio,
  account, n))` does not exist yet (`eth_call getTimeout(id) == 0`; the frozen read model cannot count prior reopens), so a
  repeated reopen by the same account never collides; none free → CONFLICT. Test the derived id against a hand-computed value. Each plan is verified and its arguments re-derived from the read model at request
  time (never from client-supplied history).
### 2.4 Notifications and history
- Job `markets.watch` (60 s): for each open claim compute due actions and deadline proximity (evidence closes in 24 h, reveal
  closes in 6 h, answers open, finalization in 24 h, arbitration stage changes, resolution) and insert idempotent notification rows
  (unique per claim, kind and target block/time) for the claim creator and evidence submitters; never notify on data the read model
  has not indexed.
- `GET /api/v1/notifications` / `POST /api/v1/notifications/:id/read` (session, owner-only).
- `GET /api/v1/accounts/:wallet/activity` (public): claims created (`listClaims({creator})`) and evidence submitted
  (`listEvidence({submitter})`) from the read model, with cursor pagination. Oracle answers by wallet are deferred: the frozen
  `ReadModel` has no lookup by answerer.

## 3. funding lane (ADR D8)
### 3.1 Market liquidity state (public, cached ≤ 30 s per market)
`GET /api/v1/markets/:market/liquidity`: for YES and NO, the Algebra pool (`factory.poolByPair(token, sDAI)`), `globalState`
(price, tick, fee), `liquidity`, price of the outcome in sDAI and in xDAI (`sDAI.convertToAssets`), and executable depth: the
Quoter (`quoteExactInputSingle`, eth_call at a pinned block) for buying 1, 10 and 100 xDAI worth, reporting average price and
price impact; `null` values with a reason when no pool exists. Spot prices are labelled "not a probability that the code is correct".
### 3.2 YES sell-ladder funding plan
`POST /api/v1/funding/plans/ladder {market, budgetWei, lowerPrice, upperPrice}` (session; `fund_market`; prices as decimal strings
in sDAI per YES with `0.01 <= lowerPrice < upperPrice <= 0.95`):
1. The claim must be in `evidence_open` phase with at least 1 hour before the evidence deadline, not hidden or blocked by
   moderation (`ctx.moderation.states`), and pass an inline integrity check (the claims lane's `claims_index` is not available to
   this lane): `ctx.contentStore.retrieve(claimDocumentSha256, 262144)`, `parseClaimDocumentBytes(bytes, digest)`, and the PRD-03
   section 7 field comparison against the read-model `ClaimRecord` (creator, repository id, commit, policy sha256, deadlines, min
   bond, registries, title, `marketName == renderQuestion(...)`, constant fields equal `buildDeploymentManifest(config.contracts)`);
   unavailable or mismatching → `INTEGRITY_FAILED` (409) naming the failed fields, never a plan.
2. `shares = sDAI.previewDeposit(budgetWei)` (eth_call), `S = shares − ceil(shares × 10 / 10000)` (10 bps margin for interest
   accrual between plan and execution; the remainder stays in the wallet as full sets).
3. Orientation: tokens sorted (`token0 < token1`). If YES is token0, Algebra price = sDAI per YES: the ladder is a token0-only
   range above the current price, ticks `[ceilTick(lowerPrice), floorTick(upperPrice)]`; else price = YES per sDAI: a token1-only
   range below the current price, ticks `[ceilTick(1/upperPrice), floorTick(1/lowerPrice)]`. Ticks are aligned to the pool's tick
   spacing (60 for new pools; read `tickSpacing()` for existing ones) inward so the range never exceeds the requested prices.
4. Pool state: if the pool does not exist, or exists but is not initialised (`globalState().price == 0`), include
   `createAndInitializePoolIfNecessary(token0, token1, sqrtPriceX96)` (it initialises an existing uninitialised pool), with the
   initial price strictly outside the range on the YES-cheaper side so the mint is single-sided: YES = token0 →
   `getSqrtRatioAtTick(tickLower) − 1`; YES = token1 → `getSqrtRatioAtTick(tickUpper) + 1` (integer TickMath; property-tested). If it exists, its current price must lie outside the range on the correct side (YES cheaper than
   `lowerPrice`) so the position is single-sided; otherwise refuse with an explanation (no re-pricing swaps in v1).
5. Steps: `gnosisRouter.splitFromBase{value: budgetWei}(market)` — omitted when the account already holds at least `S` YES
   (`balanceOf` at the pinned block), so a fresh plan after a partially executed one never splits twice;
   `outcomeToken.approve(positionManager, S)` on the YES token;
   (optional pool creation); `positionManager.mint({token0, token1, tickLower, tickUpper, amount(YES side) = S, other side 0,
   amountMin(YES side) = S − S×50/10000, other min 0, recipient = account, deadline = now + 20 min})`.
6. Response also gives: maximum loss if YES resolves `S × (1 − sqrt(lowerPrice × upperPrice))` in sDAI and xDAI (+ gas estimate),
   loss if NO or Invalid resolves (gas only, plus the 10 bps remainder is kept as full sets), the fee range of the pool, the
   withdrawability statement (positions can be withdrawn at any time; liquidity is not a bounty), and the disclosures of policy C7.
### 3.3 Positions, withdrawal, merge and redemption
- `GET /api/v1/funding/positions/:wallet?cursor&market` (public, bounded): the wallet's Algebra positions (`balanceOf`,
  `tokenOfOwnerByIndex`, `positions`) in Pine market pools, 20 NFTs per page and at most 200 scanned per wallet (`truncated: true`
  beyond); outcome token balances only for the `market` given.
- Plans: `withdraw {tokenId}` → `decreaseLiquidity(all, mins from a fresh quote with 50 bps slippage, deadline)`, `collect(recipient =
  account, max)`, `burn` (only when liquidity becomes zero); `merge {market, amount}` → three exact approvals (YES, NO, INVALID to the
  GnosisRouter) + `mergeToBase(market, amount)`; `redeem {market}` (after `ConditionResolution`) → exact approvals of the winning
  outcome tokens held + `redeemToBase(market, indexes, amounts)`.
- Funding history: plans with states and confirmed receipts per wallet; reconciliation job `funding.reconcile` (30 s).

## 4. Required tests (vitest with the frozen harness, scripted chain responses; name SEC ids in negative tests)
Test apps: the frozen `buildTestApp` registers no `@fastify/multipart` and logs nothing, so each lane writes a local test-app helper
that mirrors it and additionally registers `@fastify/multipart` with exactly the core options of PRD-02 section 2.2 and a logger
writing to an in-memory stream (for the "never logged" assertions). The module itself never registers multipart (core does, once;
a second registration throws at boot). Uploads are read with `request.parts()` so `expectedSha256` may come before or after the
file part.
- markets: manifest validation (wrong submitter, wrong claim, missing artifact, non-canonical), artifact size limit enforced while
  streaming (413, nothing stored, no quota consumed; SEC-EVID-01), `expectedSha256` mismatch 422 (SEC-EVID-03), a filename like
  `../../etc/passwd` with bidi characters never reaching storage or responses (SEC-EVID-08), idempotent plan retries (same key and
  body → identical plan, one quota unit; different body → 409; SEC-TX-08), reopen nonce for a second reopen, multipart only on that route, no salt persisted or logged (inspect DB rows and captured logs), deadline margins, every
  plan passes `verifyPlan` and binds to the registered market/question, reveal with unavailable content requires acknowledgement,
  evidence listing timeliness at the exact deadline second, ERC-1497 output, `dueActions` for every oracle state including
  answered-too-soon/reopen, arbitration stages and finalization, `claimWinnings` argument reconstruction against a hand-computed
  history, notification idempotency, NOT_READY when stale, compliance refusals.
- both lanes: the plan store (same-key retry, different body 409, `/submitted` owner-only and idempotent, reconcile transitions
  including partial execution → failed, expiry per kind), reveal plans never storing the salt in any form.
- funding: the inline integrity gate (unavailable document and each mismatching field → INTEGRITY_FAILED, no plan), splitFromBase
  omitted when the YES balance already covers S, bounded positions paging, tick/price conversion and orientation for both token orders (property tests: the range never exceeds the requested
  prices; single-sidedness), share margin, pool missing vs existing-uninitialised (initialised in the plan) vs existing correctly
  priced vs mispriced (refused), idempotent plan retries (SEC-TX-08), exact approval equals
  the mint amount, recipient = account, max-loss formula against hand-computed values, withdraw/merge/redeem plans verified, quoter
  depth parsing, cache, NOT_READY and compliance refusals, reconciliation transitions.

## 5. Checks (per lane)
`pnpm --filter @pine/api typecheck`, `pnpm exec eslint packages/api/src` (typecheck), `node scripts/check-forbidden.mjs` (unit),
`pnpm --filter @pine/api exec vitest run src/modules/<lane-dir>` (unit).
