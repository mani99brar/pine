'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toScaled } from '@pine/core'
import { planFromWire, PlanVerificationError, type Address, type DeploymentManifest, type TxPlan } from '@pine/core/pine-shared'
import {
  describeWriteError,
  FINAL_PLAN_STATES,
  FUNDING_PLAN_KINDS,
  ladderFiguresFromIssues,
  newIdempotencyKey,
  PineBackendError,
  type FundingPlanKind,
  type FundingPlanView,
  type LadderPlanBody,
  type LadderRiskFigures,
  type WriteErrorInfo,
} from '@pine/data'
import { useWallet } from '../wallet'
import type { ApiPlanRunner } from './use-plan-runner'
import { getSqrtRatioAtTick, isValidTick, MAX_SQRT_RATIO, MIN_SQRT_RATIO, Q192 } from './tick-math'
import {
  actionNonce,
  requireWriteApi,
  runnerIsBusy,
  useOnChainClaim,
  usePinnedManifest,
  usePlanAction,
  usePolledStatus,
  useStoredRecord,
  useWriteApi,
  type OnChainClaim,
} from './publish-plan'

// Market funding (api mode): the YES sell-ladder (split xDAI into outcome tokens, approve exactly the YES amount to the
// Swapr position manager, create the pool if needed, mint a single-sided YES position to the wallet). The backend
// computes every amount; the browser binds the plan to what the user accepted (SEC-LEGAL-03): the native value equals
// the budget, the position sells YES only inside the requested price range, no more YES than the acknowledged sets is
// approved or deposited, the computed loss if YES resolves stays within the acknowledged figure, a new pool starts on
// the YES-only side of the range, and the position is minted to the wallet. Funding plans are PlanViews with ISO
// `expiresAt`, reported per step to /api/v1/funding/plans/:planId/submitted.

const XDAI = 10n ** 18n
const WAD = 10n ** 18n
/** Backend caps (FUNDING_PLAN_LIMITS). */
export const FUNDING_MAX_VALUE_WEI = 10_000n * XDAI
export const FUNDING_MAX_APPROVAL = 10n ** 30n
const PRICE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,18})?$/
const UINT = /^(?:0|[1-9][0-9]{0,77})$/
/** The mint's minimum may be at most this far below the deposited amount (the backend's 50 bps slippage). */
const SLIPPAGE_BPS = 50n
/** A mint deadline further ahead than this is refused (the backend sets now + 20 min; the rest is clock skew). */
const MAX_MINT_DEADLINE_SECONDS = 3_600

const lower = (v: unknown) => String(v).toLowerCase()

/** A YES price in sDAI as wad (18 decimals); null unless a plain decimal with at most 18 fractional digits. */
function priceWad(text: unknown): bigint | null {
  if (typeof text !== 'string' || !PRICE.test(text)) return null
  const scaled = toScaled(text, 18)
  return scaled?.exact ? scaled.value : null
}

/** What the user acknowledged for a ladder: the plan may sell YES no cheaper, no dearer and no more than this. */
export interface LadderPlanCheck {
  market: Address
  account: Address
  budgetWei: bigint
  yesToken: Address
  manifest: DeploymentManifest
  /** The YES price range the user requested (sDAI per YES, decimal strings, as sent in the plan request). */
  lowerPrice: string
  upperPrice: string
  /** The most YES the plan may approve and deposit: the acknowledged sets (capped by the spending limit). */
  maxYesAmount: bigint
  /** The acknowledged maximum loss if YES resolves, sDAI share base units. */
  maxLossIfYesShares: bigint
  /** Unix seconds: the mint deadline must lie ahead of it (by at most an hour). */
  now: number
}

interface MintParams {
  token0: unknown
  token1: unknown
  tickLower: unknown
  tickUpper: unknown
  amount0Desired: unknown
  amount1Desired: unknown
  amount0Min: unknown
  amount1Min: unknown
  recipient: unknown
  deadline: unknown
}

const isUint = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n

/**
 * The ladder must be split → approve YES → (create pool) → mint YES, for this market, valued at exactly the budget, and
 * bound to the acknowledged figures (see LadderPlanCheck). Integer math only. Throws PlanVerificationError.
 */
export function checkLadderPlan(wire: unknown, ctx: LadderPlanCheck): TxPlan {
  const plan = planFromWire(wire)
  if (plan.account !== lower(ctx.account)) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  const lowerWad = priceWad(ctx.lowerPrice)
  const upperWad = priceWad(ctx.upperPrice)
  if (lowerWad === null || upperWad === null || lowerWad <= 0n || !(lowerWad < upperWad) || ctx.maxYesAmount <= 0n || ctx.maxLossIfYesShares < 0n) {
    throw new PlanVerificationError(null, 'the price range or figures you acknowledged are missing or malformed')
  }
  const yes = lower(ctx.yesToken)
  const collateral = lower(ctx.manifest.seer.collateralToken)
  // Pools order their tokens by address: with YES = token0 the pool price is sDAI per YES, otherwise YES per sDAI.
  const yesIsToken0 = yes < collateral
  const [token0, token1] = yesIsToken0 ? [yes, collateral] : [collateral, yes]
  const counts = new Map<string, number>()
  let total = 0n
  let approved: bigint | null = null
  let initialSqrtPrice: { stepId: string; value: unknown } | null = null
  let mint: { stepId: string; params: MintParams } | null = null
  for (const step of plan.steps) {
    counts.set(step.allowlistId, (counts.get(step.allowlistId) ?? 0) + 1)
    total += step.value
    const a = step.args
    switch (step.allowlistId) {
      case 'gnosisRouter.splitFromBase':
        if (lower(a[0]) !== lower(ctx.market)) throw new PlanVerificationError(step.id, 'the split is for another market')
        if (step.value !== ctx.budgetWei) throw new PlanVerificationError(step.id, 'the split value differs from your budget')
        break
      case 'outcomeToken.approve':
        if (lower(step.to) !== yes) throw new PlanVerificationError(step.id, 'the approval is not for this market’s YES token')
        if (lower(a[0]) !== lower(ctx.manifest.amm.positionManager)) throw new PlanVerificationError(step.id, 'the approval spender is not the Swapr position manager')
        if (!isUint(a[1]) || a[1] <= 0n || a[1] > ctx.maxYesAmount) throw new PlanVerificationError(step.id, 'the approval exceeds the YES amount you acknowledged')
        approved = a[1]
        break
      case 'positionManager.createAndInitializePoolIfNecessary':
        if (lower(a[0]) !== token0 || lower(a[1]) !== token1) throw new PlanVerificationError(step.id, 'the pool is not this market’s YES/sDAI pool')
        initialSqrtPrice = { stepId: step.id, value: a[2] }
        break
      case 'positionManager.mint': {
        const p = a[0] as MintParams
        if (lower(p.token0) !== token0 || lower(p.token1) !== token1) throw new PlanVerificationError(step.id, 'the position is not in this market’s YES/sDAI pool')
        if (lower(p.recipient) !== lower(ctx.account)) throw new PlanVerificationError(step.id, 'the position would be minted to another address')
        mint = { stepId: step.id, params: p }
        break
      }
      default:
        throw new PlanVerificationError(step.id, `a ladder may not call ${step.allowlistId}`)
    }
  }
  if ((counts.get('outcomeToken.approve') ?? 0) !== 1 || (counts.get('positionManager.mint') ?? 0) !== 1) throw new PlanVerificationError(null, 'a ladder has exactly one approval and one mint')
  if ((counts.get('gnosisRouter.splitFromBase') ?? 0) > 1 || (counts.get('positionManager.createAndInitializePoolIfNecessary') ?? 0) > 1) throw new PlanVerificationError(null, 'a ladder splits and creates the pool at most once')
  const expected = counts.has('gnosisRouter.splitFromBase') ? ctx.budgetWei : 0n
  if (total !== expected) throw new PlanVerificationError(null, 'the plan’s native value differs from your budget')
  if (!mint) throw new PlanVerificationError(null, 'a ladder has exactly one approval and one mint')

  const { stepId, params: p } = mint
  // A single-sided YES position: nothing of sDAI is deposited.
  const [yesDesired, yesMin, sdaiDesired, sdaiMin] = yesIsToken0
    ? [p.amount0Desired, p.amount0Min, p.amount1Desired, p.amount1Min]
    : [p.amount1Desired, p.amount1Min, p.amount0Desired, p.amount0Min]
  if (!isUint(yesDesired) || !isUint(yesMin) || !isUint(sdaiDesired) || !isUint(sdaiMin)) throw new PlanVerificationError(stepId, 'the position amounts are malformed')
  if (sdaiDesired !== 0n || sdaiMin !== 0n) throw new PlanVerificationError(stepId, 'the position would deposit sDAI; a ladder deposits YES only')
  if (yesDesired <= 0n || yesDesired > ctx.maxYesAmount) throw new PlanVerificationError(stepId, 'the position deposits more YES than you acknowledged')
  if (approved !== yesDesired) throw new PlanVerificationError(stepId, 'the approval differs from the YES the position deposits')
  if (yesMin > yesDesired || yesMin < yesDesired - (yesDesired * SLIPPAGE_BPS) / 10_000n) throw new PlanVerificationError(stepId, 'the position’s minimum YES deposit is outside the 0.5% slippage bound')

  // The range sells YES only between the requested prices.
  if (!isValidTick(p.tickLower) || !isValidTick(p.tickUpper) || !(p.tickLower < p.tickUpper)) throw new PlanVerificationError(stepId, 'the position’s price range is malformed')
  const sqrtLower = getSqrtRatioAtTick(p.tickLower)
  const sqrtUpper = getSqrtRatioAtTick(p.tickUpper)
  // Pool price at a tick = sqrt² / 2^192 (token1 per token0); YES price = that (YES = token0) or its inverse.
  const inside = yesIsToken0
    ? sqrtLower * sqrtLower * WAD >= lowerWad * Q192 && sqrtUpper * sqrtUpper * WAD <= upperWad * Q192
    : Q192 * WAD >= lowerWad * sqrtUpper * sqrtUpper && Q192 * WAD <= upperWad * sqrtLower * sqrtLower
  if (!inside) throw new PlanVerificationError(stepId, 'the position would sell YES outside the price range you chose')

  // Maximum loss if YES resolves, S × (1 − √(p_a·p_b)) at the range's prices (proceeds rounded down, as the backend).
  const proceeds = yesIsToken0 ? (yesDesired * sqrtLower * sqrtUpper) / Q192 : (yesDesired * Q192) / (sqrtLower * sqrtUpper)
  const loss = proceeds >= yesDesired ? 0n : yesDesired - proceeds
  if (loss > ctx.maxLossIfYesShares) throw new PlanVerificationError(stepId, 'the position’s maximum loss if YES resolves is above the figure you acknowledged')

  const now = BigInt(Math.floor(ctx.now))
  if (!isUint(p.deadline) || p.deadline <= now || p.deadline > now + BigInt(MAX_MINT_DEADLINE_SECONDS)) {
    throw new PlanVerificationError(stepId, 'the position’s deadline has passed or is too far ahead')
  }

  // A new pool starts strictly on the YES-only side of the range (below it when YES = token0, above it otherwise), so
  // the position holds YES only and sells it only as the price enters the range.
  if (initialSqrtPrice) {
    const v = initialSqrtPrice.value
    const yesOnlySide = isUint(v) && v >= MIN_SQRT_RATIO && v < MAX_SQRT_RATIO && (yesIsToken0 ? v < sqrtLower : v > sqrtUpper)
    if (!yesOnlySide) throw new PlanVerificationError(initialSqrtPrice.stepId, 'the new pool would start at a price inside or beyond your range')
  }
  return plan
}

// ---------------------------------------------------------------------------------------------------------------
// Shared funding-plan flow (ladder and exits)
// ---------------------------------------------------------------------------------------------------------------

export interface StoredFundingAction {
  v: 1
  kind: FundingPlanKind
  /** The strict request body. */
  body: Record<string, unknown>
  /** Exact native value the plan may carry, wei. */
  valueWei: string
  /** Upper bound of each approval, base units. */
  approvalWei: string
  nonce: string
  planId?: string
}

function isStoredFundingAction(value: unknown): value is StoredFundingAction {
  const v = value as Partial<StoredFundingAction> | null
  const uint = (s: unknown) => typeof s === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(s)
  return Boolean(v && v.v === 1 && (FUNDING_PLAN_KINDS as readonly string[]).includes(String(v.kind)) && v.body && typeof v.body === 'object' && uint(v.valueWei) && uint(v.approvalWei) && typeof v.nonce === 'string' && /^[0-9a-f]{1,32}$/.test(v.nonce))
}

export interface FundingFlowContext {
  market: Address
  account: Address
  claim: OnChainClaim
  manifest: DeploymentManifest
  /** Unix seconds (the flow's clock). */
  now: number
}

/** The earliest deadline (ms since the epoch) of a plan's position calls (mint, decreaseLiquidity), if any. */
function positionDeadlineMs(wire: unknown): number | undefined {
  let earliest: bigint | undefined
  for (const step of planFromWire(wire).steps) {
    if (step.allowlistId !== 'positionManager.mint' && step.allowlistId !== 'positionManager.decreaseLiquidity') continue
    const deadline = (step.args[0] as { deadline?: unknown } | undefined)?.deadline
    if (typeof deadline === 'bigint' && (earliest === undefined || deadline < earliest)) earliest = deadline
  }
  return earliest === undefined ? undefined : Number(earliest) * 1000
}

export interface FundingFlowOptions {
  pollIntervalMs?: number
  now?: () => Date
  sleep?(ms: number): Promise<void>
}

export interface FundingFlow {
  claim: OnChainClaim | null
  action: StoredFundingAction | null
  /** The latest view of the action's plan (from its creation, its reports and polling). */
  plan: FundingPlanView | null
  runner: ApiPlanRunner
  error: WriteErrorInfo | null
  setError(e: WriteErrorInfo | null): void
  busy: boolean
  start(kind: FundingPlanKind, body: Record<string, unknown>, limits: { valueWei: bigint; approvalWei: bigint }): Promise<void>
  abandon(): void
}

/** One funding-lane plan at a time per scope and market, keyed by a per-attempt nonce. */
export function useFundingPlanFlow(
  market: Address,
  scope: 'ladder' | 'exit',
  options: FundingFlowOptions,
  check: (wire: unknown, action: StoredFundingAction, ctx: FundingFlowContext) => void,
  onCreateError?: (e: unknown) => void,
): FundingFlow {
  const api = useWriteApi()
  const wallet = useWallet()
  const manifest = usePinnedManifest()
  const { claim } = useOnChainClaim(market)
  const m = market.toLowerCase() as Address
  const account = wallet.address?.toLowerCase() as Address | undefined
  const [error, setError] = useState<WriteErrorInfo | null>(null)
  const [view, setView] = useState<FundingPlanView | null>(null)
  const [action, setAction] = useStoredRecord<StoredFundingAction>(account ? `pine:api-funding-action:${scope}:${m}:${account}` : null, isStoredFundingAction)
  const checkRef = useRef(check)
  const onErrorRef = useRef(onCreateError)
  const clockRef = useRef(options.now)
  const latest = useRef({ action, account, claim, manifest })
  useEffect(() => {
    checkRef.current = check
    onErrorRef.current = onCreateError
    clockRef.current = options.now
    latest.current = { action, account, claim, manifest }
  })
  const nowMs = useCallback(() => (clockRef.current?.() ?? new Date()).getTime(), [])

  const keyOf = useCallback((a: StoredFundingAction | null) => (a && account ? `api-funding:${scope}:${m}:${account}:${a.kind}:${a.nonce}` : null), [account, m, scope])
  const plan = usePlanAction({
    key: keyOf(action),
    idleKey: `api-funding-idle:${scope}:${m}`,
    markets: [m],
    limits: { maxTotalValueWei: action ? BigInt(action.valueWei) : 0n, maxApprovalAmount: action ? BigInt(action.approvalWei) : 0n },
    sleep: options.sleep,
    now: nowMs,
    async create(idempotencyKey) {
      const client = requireWriteApi(api)
      const { action: act, account: acct, claim: c, manifest: pinned } = latest.current
      if (!act || !acct || !c || !pinned) throw new Error('Connect your wallet and wait for the claim to load.')
      let res: FundingPlanView
      try {
        res =
          act.kind === 'ladder'
            ? await client.ladderPlan(act.body as unknown as LadderPlanBody, idempotencyKey)
            : await client.exitPlan(act.kind, act.body as never, idempotencyKey)
      } catch (e) {
        onErrorRef.current?.(e)
        throw e
      }
      if (res.kind !== act.kind || lower(res.market) !== m || lower(res.account) !== acct) throw new PlanVerificationError(null, 'Pine answered with a plan for another action')
      const now = nowMs()
      const offer = Date.parse(res.expiresAt)
      if (!Number.isFinite(offer) || offer <= now) throw new Error('This funding offer expired. Start again for fresh amounts.')
      checkRef.current(res.plan, act, { market: m, account: acct, claim: c, manifest: pinned, now: Math.floor(now / 1000) })
      setView(res)
      setAction({ ...act, planId: res.planId })
      // Nothing of the plan is sent once its offer or a position deadline (e.g. the ladder mint's) has passed: a split
      // whose mint can no longer succeed would only leave outcome tokens and an approval behind.
      const deadline = positionDeadlineMs(res.plan)
      return { wire: res.plan, planId: res.planId, expiresAt: deadline === undefined ? offer : Math.min(offer, deadline) }
    },
    async submitted(planId, stepId, txHash) {
      const view = await requireWriteApi(api).reportFundingPlanTx(planId, stepId, txHash)
      // A run that continues after another action was started reports its own plan without replacing the view shown.
      if (latest.current.action?.planId === planId) setView(view)
    },
  })
  const { runner } = plan

  // After the wallet steps, follow Pine's confirmation (finalized receipts) until the plan is final.
  const followPlanId = action?.planId && runner.runner.state === 'done' ? action.planId : undefined
  usePolledStatus<FundingPlanView>({
    key: followPlanId ? `funding-plan:${followPlanId}` : null,
    load: () => requireWriteApi(api).getFundingPlan(followPlanId ?? ''),
    done: (v) => FINAL_PLAN_STATES.includes(v.state),
    onValue: setView,
    intervalMs: options.pollIntervalMs ?? 10_000,
    sleep: options.sleep ? (ms) => options.sleep?.(ms) ?? Promise.resolve() : undefined,
  })

  const inFlight = useCallback(() => runnerIsBusy(runner) || runner.runner.steps.some((s) => s.status === 'pending' || s.status === 'awaiting_signature'), [runner])

  const start = useCallback(
    async (kind: FundingPlanKind, body: Record<string, unknown>, limits: { valueWei: bigint; approvalWei: bigint }) => {
      setError(null)
      if (!latest.current.account) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Connect the wallet you signed in with.' })
        return
      }
      if (!latest.current.claim) {
        setError({ code: 'UNKNOWN', action: 'retry_later', message: 'The claim is not loaded from the chain yet.' })
        return
      }
      if (inFlight()) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Another funding transaction is in progress. Wait for it to finish.' })
        return
      }
      setView(null)
      const next: StoredFundingAction = { v: 1, kind, body, valueWei: limits.valueWei.toString(10), approvalWei: limits.approvalWei.toString(10), nonce: actionNonce() }
      setAction(next)
      await plan.runWhenReady(keyOf(next))
    },
    [inFlight, setAction, plan, keyOf],
  )

  const abandon = useCallback(() => {
    if (inFlight()) return
    runner.discard()
    setAction(null)
    setView(null)
  }, [inFlight, runner, setAction])

  return {
    claim,
    action,
    plan: view,
    runner,
    error: error ?? plan.lastError ?? (runner.error ? { code: 'UNKNOWN', action: 'none', message: runner.error } : null),
    setError,
    busy: runnerIsBusy(runner),
    start,
    abandon,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------------------------------

export interface LadderRequest {
  /** xDAI to split into outcome tokens, wei. */
  budgetWei: bigint
  /** YES price range in sDAI, decimal strings (0.01 ≤ lower < upper ≤ 0.95). */
  lowerPrice: string
  upperPrice: string
}

/** The backend's figures for a ladder request: what the user must acknowledge before a plan is offered. */
export interface LadderQuote extends LadderRiskFigures {
  market: Address
  /** The prices the user asked for (the figures carry the final, tick-rounded range). */
  requestedLowerPrice: string
  requestedUpperPrice: string
}

/**
 * SEC-LEGAL-03: the identity of the figures a risk acknowledgement is given for. Key the acknowledgement by it, so a
 * tick never carries over to other figures (a requote, or the larger loss Pine returns when the pool moved).
 */
export function ladderQuoteKey(q: LadderQuote): string {
  return [q.market.toLowerCase(), q.budgetWei, q.sets, q.finalLowerPrice, q.finalUpperPrice, q.maxLossIfYesShares, q.maxLossIfYesXdaiWei].join('|')
}

/** Pine offers ladders only until this long before the evidence deadline (packages/api funding LADDER_MIN_TIME_BEFORE_DEADLINE). */
export const LADDER_CLOSES_BEFORE_DEADLINE_SECONDS = 3_600

/** The ladder inputs a refused quote names (from this app's checks or the backend's field issues). */
export interface LadderInvalidFields {
  budget: boolean
  lowerPrice: boolean
  upperPrice: boolean
}

export interface ApiFunding {
  claim: OnChainClaim | null
  /**
   * The latest figures to acknowledge (also refreshed when the loss grew between quote and plan). They belong to the
   * inputs they were quoted for: a new quote (failed or not) and discardQuote() drop them.
   */
  quote: LadderQuote | null
  /** Asks the backend for the ladder figures (no plan is created; it costs one plan unit of the daily quota). */
  quoteLadder(request: LadderRequest): Promise<LadderQuote | null>
  /** The inputs changed: forget the figures, the error and the highlighted fields of the old ones. */
  discardQuote(): void
  /** The inputs the last refused quote names. */
  invalid: LadderInvalidFields
  /**
   * Builds and runs the ladder the user acknowledged. `spendingLimitWei` is the user's limit in sDAI base units: the budget
   * must not exceed it and no approval may exceed it.
   */
  fund(input: { quote: LadderQuote; spendingLimitWei: bigint }): Promise<void>
  /** The ladder plan (PlanView): details, step states and, after a partial run, the recovery hint. */
  plan: FundingPlanView | null
  runner: ApiPlanRunner
  error: WriteErrorInfo | null
  busy: boolean
  abandon(): void
}

const MIN_PRICE = 10n ** 16n // 0.01
const MAX_PRICE = 95n * 10n ** 16n // 0.95

const VALID: LadderInvalidFields = { budget: false, lowerPrice: false, upperPrice: false }
const BAD_BUDGET: LadderInvalidFields = { ...VALID, budget: true }
const BAD_RANGE: LadderInvalidFields = { ...VALID, lowerPrice: true, upperPrice: true }

function validLadder(r: LadderRequest): { message: string; fields: LadderInvalidFields } | null {
  if (r.budgetWei <= 0n || r.budgetWei > FUNDING_MAX_VALUE_WEI) return { message: 'Enter a budget between 0 and 10,000 xDAI.', fields: BAD_BUDGET }
  if (!PRICE.test(r.lowerPrice) || !PRICE.test(r.upperPrice)) return { message: 'Enter prices as decimals, e.g. 0.05.', fields: BAD_RANGE }
  const lo = toScaled(r.lowerPrice, 18)?.value ?? -1n
  const hi = toScaled(r.upperPrice, 18)?.value ?? -1n
  if (lo < MIN_PRICE || hi > MAX_PRICE || !(lo < hi)) return { message: 'Choose a YES price range with 0.01 ≤ lower < upper ≤ 0.95.', fields: BAD_RANGE }
  return null
}

/** The inputs a backend refusal of a quote names (`budgetWei`, `riskAcknowledgement.budgetWei`, `lowerPrice`, …). */
function invalidFieldsOf(e: unknown): LadderInvalidFields {
  if (!(e instanceof PineBackendError) || e.apiCode === 'CONFLICT') return VALID
  const named = new Set((e.issues ?? []).map((i) => String(i.path.at(-1))))
  return { budget: named.has('budgetWei'), lowerPrice: named.has('lowerPrice'), upperPrice: named.has('upperPrice') }
}

export function useApiFunding(market: Address, options: FundingFlowOptions = {}): ApiFunding {
  const api = useWriteApi()
  const m = market.toLowerCase() as Address
  const [quote, setQuoteState] = useState<LadderQuote | null>(null)
  const [invalid, setInvalid] = useState<LadderInvalidFields>(VALID)
  const [quoting, setQuoting] = useState(false)
  // Read by fund() and the conflict handler in the same tick as a change, so kept in step with the state by hand.
  const quoteRef = useRef(quote)
  const setQuote = useCallback((q: LadderQuote | null) => {
    quoteRef.current = q
    setQuoteState(q)
  }, [])
  // Bumped whenever the inputs change: figures answered for older inputs are dropped.
  const inputsRef = useRef(0)

  const flow = useFundingPlanFlow(
    m,
    'ladder',
    options,
    (wire, action, ctx) => {
      // The request body the user acknowledged (stored with the action; re-validated by checkLadderPlan).
      const body = action.body as { lowerPrice?: unknown; upperPrice?: unknown; riskAcknowledgement?: { maxLossIfYesShares?: unknown } }
      const loss = body.riskAcknowledgement?.maxLossIfYesShares
      checkLadderPlan(wire, {
        market: ctx.market,
        account: ctx.account,
        budgetWei: BigInt(action.valueWei),
        yesToken: ctx.claim.yesToken,
        manifest: ctx.manifest,
        lowerPrice: String(body.lowerPrice),
        upperPrice: String(body.upperPrice),
        maxYesAmount: BigInt(action.approvalWei),
        maxLossIfYesShares: typeof loss === 'string' && UINT.test(loss) ? BigInt(loss) : -1n,
        now: ctx.now,
      })
    },
    (e) => {
      // The loss grew since the quote: show the new figures; the user acknowledges again (a new attempt and key).
      if (e instanceof PineBackendError && e.apiCode === 'CONFLICT') {
        const figures = ladderFiguresFromIssues(e.issues)
        const q = quoteRef.current
        if (figures && q) setQuote({ ...q, ...figures })
      }
    },
  )

  const quoteLadder = useCallback(
    async (request: LadderRequest): Promise<LadderQuote | null> => {
      flow.setError(null)
      // A quote (whatever its outcome) replaces the figures of earlier inputs: they can no longer be acknowledged.
      setQuote(null)
      setInvalid(VALID)
      const inputs = inputsRef.current
      const refused = validLadder(request)
      if (refused) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: refused.message })
        setInvalid(refused.fields)
        return null
      }
      setQuoting(true)
      const budget = request.budgetWei.toString(10)
      try {
        // An acknowledgement of 0 is always below the computed loss, so the backend answers 409 with the figures and
        // builds no plan.
        await requireWriteApi(api).ladderPlan(
          { market: m, budgetWei: budget, lowerPrice: request.lowerPrice, upperPrice: request.upperPrice, riskAcknowledgement: { budgetWei: budget, maxLossIfYesShares: '0' } },
          newIdempotencyKey(),
        )
        if (inputs === inputsRef.current) flow.setError({ code: 'BAD_RESPONSE', action: 'retry_later', message: 'Pine did not return the ladder figures to acknowledge.' })
        return null
      } catch (e) {
        // Inputs edited while Pine answered: neither the figures nor the error belong to what is on screen.
        if (inputs !== inputsRef.current) return null
        const figures = e instanceof PineBackendError && e.apiCode === 'CONFLICT' ? ladderFiguresFromIssues(e.issues) : null
        if (!figures || figures.budgetWei !== budget) {
          flow.setError(describeWriteError(e))
          setInvalid(invalidFieldsOf(e))
          return null
        }
        const q: LadderQuote = { ...figures, market: m, requestedLowerPrice: request.lowerPrice, requestedUpperPrice: request.upperPrice }
        setQuote(q)
        return q
      } finally {
        setQuoting(false)
      }
    },
    [api, m, flow, setQuote],
  )

  const discardQuote = useCallback(() => {
    inputsRef.current += 1
    setQuote(null)
    setInvalid(VALID)
    flow.setError(null)
  }, [flow, setQuote])

  const fund = useCallback(
    async ({ quote: q, spendingLimitWei }: { quote: LadderQuote; spendingLimitWei: bigint }) => {
      if (q.market !== m) {
        flow.setError({ code: 'UNKNOWN', action: 'none', message: 'These figures are for another market.' })
        return
      }
      // SEC-LEGAL-03: only the figures on screen for the current inputs may be funded, never ones a requote or an edit
      // replaced.
      const current = quoteRef.current
      if (!current || ladderQuoteKey(current) !== ladderQuoteKey(q)) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Ask for the ladder figures again before funding.' })
        return
      }
      if (!UINT.test(q.budgetWei) || !UINT.test(q.sets) || !UINT.test(q.maxLossIfYesShares) || BigInt(q.sets) <= 0n) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Ask for the ladder figures again before funding.' })
        return
      }
      const budget = BigInt(q.budgetWei)
      const refused = validLadder({ budgetWei: budget, lowerPrice: q.requestedLowerPrice, upperPrice: q.requestedUpperPrice })
      if (refused) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: refused.message })
        return
      }
      if (spendingLimitWei <= 0n || budget > spendingLimitWei) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: 'The budget is above your spending limit. Lower the budget or raise the limit.' })
        return
      }
      const body: LadderPlanBody = {
        market: m,
        budgetWei: q.budgetWei,
        lowerPrice: q.requestedLowerPrice,
        upperPrice: q.requestedUpperPrice,
        riskAcknowledgement: { budgetWei: q.budgetWei, maxLossIfYesShares: q.maxLossIfYesShares },
      }
      // The plan may approve and deposit at most the acknowledged sets (S), and never more than the spending limit. Pine
      // recomputes S when it builds the plan; sDAI only appreciates, so the planned S is never above the quoted one.
      const sets = BigInt(q.sets)
      const approval = [sets, spendingLimitWei, FUNDING_MAX_APPROVAL].reduce((a, b) => (b < a ? b : a))
      await flow.start('ladder', body as unknown as Record<string, unknown>, { valueWei: budget, approvalWei: approval })
    },
    [m, flow],
  )

  return {
    claim: flow.claim,
    quote,
    quoteLadder,
    discardQuote,
    invalid,
    fund,
    plan: flow.plan,
    runner: flow.runner,
    error: flow.error,
    busy: quoting || flow.busy,
    abandon: flow.abandon,
  }
}
