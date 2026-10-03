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
// computes every amount; the browser binds the plan to what the user accepted: the native value equals the budget,
// approvals stay within the user's spending limit and go only to the position manager for this market's YES token, and
// the position is minted to the wallet. Funding plans are PlanViews with ISO `expiresAt`, reported per step to
// /api/v1/funding/plans/:planId/submitted.

const XDAI = 10n ** 18n
/** Backend caps (FUNDING_PLAN_LIMITS). */
export const FUNDING_MAX_VALUE_WEI = 10_000n * XDAI
export const FUNDING_MAX_APPROVAL = 10n ** 30n
const PRICE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,18})?$/

const lower = (v: unknown) => String(v).toLowerCase()

/** The ladder must be split → approve YES → (create pool) → mint YES, for this market, valued at exactly the budget. */
export function checkLadderPlan(
  wire: unknown,
  ctx: { market: Address; account: Address; budgetWei: bigint; yesToken: Address; manifest: DeploymentManifest },
): TxPlan {
  const plan = planFromWire(wire)
  if (plan.account !== lower(ctx.account)) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  const counts = new Map<string, number>()
  let total = 0n
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
        if (lower(step.to) !== lower(ctx.yesToken)) throw new PlanVerificationError(step.id, 'the approval is not for this market’s YES token')
        if (lower(a[0]) !== lower(ctx.manifest.amm.positionManager)) throw new PlanVerificationError(step.id, 'the approval spender is not the Swapr position manager')
        break
      case 'positionManager.createAndInitializePoolIfNecessary': {
        const pair = [lower(a[0]), lower(a[1])]
        if (!pair.includes(lower(ctx.yesToken)) || !pair.includes(lower(ctx.manifest.seer.collateralToken))) throw new PlanVerificationError(step.id, 'the pool is not this market’s YES/sDAI pool')
        break
      }
      case 'positionManager.mint': {
        const p = a[0] as { token0?: unknown; token1?: unknown; recipient?: unknown }
        const pair = [lower(p.token0), lower(p.token1)]
        if (!pair.includes(lower(ctx.yesToken)) || !pair.includes(lower(ctx.manifest.seer.collateralToken))) throw new PlanVerificationError(step.id, 'the position is not in this market’s YES/sDAI pool')
        if (lower(p.recipient) !== lower(ctx.account)) throw new PlanVerificationError(step.id, 'the position would be minted to another address')
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

  const keyOf = useCallback((a: StoredFundingAction | null) => (a && account ? `api-funding:${scope}:${m}:${account}:${a.kind}:${a.nonce}` : null), [account, m, scope])
  const plan = usePlanAction({
    key: keyOf(action),
    idleKey: `api-funding-idle:${scope}:${m}`,
    markets: [m],
    limits: { maxTotalValueWei: action ? BigInt(action.valueWei) : 0n, maxApprovalAmount: action ? BigInt(action.approvalWei) : 0n },
    sleep: options.sleep,
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
      const expires = Date.parse(res.expiresAt)
      if (!Number.isFinite(expires) || expires <= (clockRef.current?.() ?? new Date()).getTime()) throw new Error('This funding offer expired. Start again for fresh amounts.')
      checkRef.current(res.plan, act, { market: m, account: acct, claim: c, manifest: pinned })
      setView(res)
      setAction({ ...act, planId: res.planId })
      return { wire: res.plan, planId: res.planId }
    },
    async submitted(planId, stepId, txHash) {
      setView(await requireWriteApi(api).reportFundingPlanTx(planId, stepId, txHash))
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

export interface ApiFunding {
  claim: OnChainClaim | null
  /** The latest figures to acknowledge (also refreshed when the loss grew between quote and plan). */
  quote: LadderQuote | null
  /** Asks the backend for the ladder figures (no plan is created; it costs one plan unit of the daily quota). */
  quoteLadder(request: LadderRequest): Promise<LadderQuote | null>
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

function validLadder(r: LadderRequest): string | null {
  if (r.budgetWei <= 0n || r.budgetWei > FUNDING_MAX_VALUE_WEI) return 'Enter a budget between 0 and 10,000 xDAI.'
  if (!PRICE.test(r.lowerPrice) || !PRICE.test(r.upperPrice)) return 'Enter prices as decimals, e.g. 0.05.'
  const lo = toScaled(r.lowerPrice, 18)?.value ?? -1n
  const hi = toScaled(r.upperPrice, 18)?.value ?? -1n
  if (lo < MIN_PRICE || hi > MAX_PRICE || !(lo < hi)) return 'Choose a YES price range with 0.01 ≤ lower < upper ≤ 0.95.'
  return null
}

export function useApiFunding(market: Address, options: FundingFlowOptions = {}): ApiFunding {
  const api = useWriteApi()
  const m = market.toLowerCase() as Address
  const [quote, setQuote] = useState<LadderQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const quoteRef = useRef(quote)
  useEffect(() => {
    quoteRef.current = quote
  })

  const flow = useFundingPlanFlow(
    m,
    'ladder',
    options,
    (wire, action, ctx) => {
      checkLadderPlan(wire, { market: ctx.market, account: ctx.account, budgetWei: BigInt(action.valueWei), yesToken: ctx.claim.yesToken, manifest: ctx.manifest })
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
      const invalid = validLadder(request)
      if (invalid) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: invalid })
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
        flow.setError({ code: 'BAD_RESPONSE', action: 'retry_later', message: 'Pine did not return the ladder figures to acknowledge.' })
        return null
      } catch (e) {
        const figures = e instanceof PineBackendError && e.apiCode === 'CONFLICT' ? ladderFiguresFromIssues(e.issues) : null
        if (!figures || figures.budgetWei !== budget) {
          flow.setError(describeWriteError(e))
          return null
        }
        const q: LadderQuote = { ...figures, market: m, requestedLowerPrice: request.lowerPrice, requestedUpperPrice: request.upperPrice }
        setQuote(q)
        return q
      } finally {
        setQuoting(false)
      }
    },
    [api, m, flow],
  )

  const fund = useCallback(
    async ({ quote: q, spendingLimitWei }: { quote: LadderQuote; spendingLimitWei: bigint }) => {
      const budget = BigInt(q.budgetWei)
      if (q.market !== m) {
        flow.setError({ code: 'UNKNOWN', action: 'none', message: 'These figures are for another market.' })
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
      const approval = spendingLimitWei < FUNDING_MAX_APPROVAL ? spendingLimitWei : FUNDING_MAX_APPROVAL
      await flow.start('ladder', body as unknown as Record<string, unknown>, { valueWei: budget, approvalWei: approval })
    },
    [m, flow],
  )

  return {
    claim: flow.claim,
    quote,
    quoteLadder,
    fund,
    plan: flow.plan,
    runner: flow.runner,
    error: flow.error,
    busy: quoting || flow.busy,
    abandon: flow.abandon,
  }
}
