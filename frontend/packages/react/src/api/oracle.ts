'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { planFromWire, PlanVerificationError, type Address, type Hex32, type TxPlan } from '@pine/core/pine-shared'
import { FINAL_PLAN_STATES, ORACLE_PLAN_ROUTES, RetryLaterError, type MarketsPlanResponse, type OracleActionStatus, type OraclePlanRoute, type WriteErrorInfo } from '@pine/data'
import { useWallet } from '../wallet'
import type { ApiPlanRunner } from './use-plan-runner'
import { readCurrentQuestionId } from './plans'
import {
  actionNonce,
  requireWriteApi,
  runnerIsBusy,
  useOnChainClaim,
  usePinnedManifest,
  usePlanAction,
  usePolledStatus,
  useRegistryReader,
  useStoredRecord,
  useWriteApi,
  type OnChainClaim,
} from './publish-plan'

// Oracle actions on a claim's Reality.eth question (api mode): every argument of these plans is derived by the backend
// from chain facts, so the browser checks each plan against the action the user chose — the exact step kinds, the
// question it touches, the answer and the exact native value (the bond or bounty the user entered) — before verifyPlan
// and any wallet prompt. The question a plan may touch is read on the user's own RPC (ClaimRegistry's question and
// Reality's reopened replacement), never taken from the oracle status: a compromised API could otherwise direct a bond
// or bounty to a question it created. Pine never answers, bonds or funds arbitration itself.

const XDAI = 10n ** 18n
/** The backend's cap on oracle bonds and bounties (MARKETS_PLAN_LIMITS). */
export const ORACLE_MAX_VALUE_WEI = 10_000n * XDAI

const ANSWERS: Record<'yes' | 'no' | 'invalid', Hex32> = {
  yes: `0x${'0'.repeat(64)}`,
  no: `0x${'0'.repeat(63)}1`,
  invalid: `0x${'f'.repeat(64)}`,
}

/** The only calls each oracle route may contain. */
const ROUTE_STEPS: Record<OraclePlanRoute, { allowlistId: string; max: number }> = {
  'submit-answer': { allowlistId: 'realitio.submitAnswer', max: 1 },
  'fund-bounty': { allowlistId: 'realitio.fundAnswerBounty', max: 1 },
  resolve: { allowlistId: 'realityProxy.resolve', max: 1 },
  reopen: { allowlistId: 'realitio.reopenQuestion', max: 1 },
  'handle-notified-request': { allowlistId: 'klerosHomeProxy.handleNotifiedRequest', max: 1 },
  'handle-rejected-request': { allowlistId: 'klerosHomeProxy.handleRejectedRequest', max: 1 },
  'report-arbitration-answer': { allowlistId: 'klerosHomeProxy.reportArbitrationAnswer', max: 1 },
  'claim-winnings': { allowlistId: 'realitio.claimWinnings', max: 2 },
  withdraw: { allowlistId: 'realitio.withdraw', max: 1 },
}

export interface OracleActionBody {
  market?: Address
  outcome?: 'yes' | 'no' | 'invalid'
  /** Wei, decimal string. */
  bond?: string
  amount?: string
}

export interface OraclePlanCheck {
  route: OraclePlanRoute
  body: OracleActionBody
  account: Address
  market: Address
  /** The claim's original question id (ClaimRegistry, on chain). */
  claimQuestionId: Hex32
  /**
   * The current question id after reopens, read on chain (readCurrentQuestionId: Reality's reopened_questions of the
   * claim question). Never the oracle status's currentQuestionId.
   */
  currentQuestionId: Hex32
  /** Exact native value the plan must carry (the bond or bounty), else 0. */
  valueWei: bigint
}

const lower = (v: unknown) => String(v).toLowerCase()

/** Checks an oracle plan against the action the user chose. Throws PlanVerificationError before any wallet prompt. */
export function checkOraclePlan(wire: unknown, ctx: OraclePlanCheck): TxPlan {
  const plan = planFromWire(wire)
  if (plan.account !== lower(ctx.account)) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  const rule = ROUTE_STEPS[ctx.route]
  if (plan.steps.length < 1 || plan.steps.length > rule.max) throw new PlanVerificationError(null, `a ${ctx.route} plan has 1..${rule.max} steps`)
  let total = 0n
  for (const step of plan.steps) {
    if (step.allowlistId !== rule.allowlistId) throw new PlanVerificationError(step.id, `${ctx.route} plans may only call ${rule.allowlistId}`)
    total += step.value
    const a = step.args
    switch (ctx.route) {
      case 'submit-answer':
        if (lower(a[0]) !== ctx.currentQuestionId) throw new PlanVerificationError(step.id, 'the answer is for another question')
        if (!ctx.body.outcome || lower(a[1]) !== ANSWERS[ctx.body.outcome]) throw new PlanVerificationError(step.id, 'the answer differs from the outcome you chose')
        break
      case 'fund-bounty':
      case 'handle-notified-request':
      case 'handle-rejected-request':
      case 'report-arbitration-answer':
        if (lower(a[0]) !== ctx.currentQuestionId) throw new PlanVerificationError(step.id, 'the call is for another question')
        break
      case 'resolve':
        if (lower(a[0]) !== lower(ctx.market)) throw new PlanVerificationError(step.id, 'the resolution is for another market')
        break
      case 'reopen':
        if (lower(a[7]) !== ctx.claimQuestionId) throw new PlanVerificationError(step.id, 'the reopened question is not this claim’s question')
        break
      case 'claim-winnings':
        if (lower(a[0]) !== ctx.currentQuestionId && lower(a[0]) !== ctx.claimQuestionId) throw new PlanVerificationError(step.id, 'the winnings are for another question')
        break
      case 'withdraw':
        break
    }
  }
  if (total !== ctx.valueWei) throw new PlanVerificationError(null, `the plan sends ${total} wei instead of the ${ctx.valueWei} wei you entered`)
  return plan
}

/**
 * Replacement question ids (reopens) the oracle status names that the chain confirms: only the current question read
 * on the user's RPC (`chainCurrentQuestionId`, from readCurrentQuestionId) is returned, and nothing without it. The
 * status alone never vouches for a question.
 */
export function reopenedQuestionIdsOf(status: OracleActionStatus | null, claimQuestionId: Hex32 | undefined, chainCurrentQuestionId?: Hex32 | null): Hex32[] {
  if (!status || !chainCurrentQuestionId) return []
  const chain = chainCurrentQuestionId.toLowerCase() as Hex32
  if (chain === claimQuestionId?.toLowerCase()) return []
  const named = [status.currentQuestionId, status.question?.reopenedBy, status.originalQuestion?.reopenedBy].filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase())
  return named.includes(chain) ? [chain] : []
}

/** The smallest bond Reality accepts for the next answer: max(minBond, 2 × current bond). */
export function minimumBondOf(status: OracleActionStatus | null, claim: OnChainClaim | null): bigint | null {
  const q = status?.question
  if (!q) return claim?.minBond ?? null
  const doubled = 2n * BigInt(q.bond)
  const floor = BigInt(q.minBond) > (claim?.minBond ?? 0n) ? BigInt(q.minBond) : (claim?.minBond ?? 0n)
  return doubled > floor ? doubled : floor
}

interface StoredOracleAction {
  v: 1
  route: OraclePlanRoute
  body: OracleActionBody
  /** Exact native value of the plan, wei. */
  valueWei: string
  nonce: string
  planId?: string
}

function isStoredOracleAction(value: unknown): value is StoredOracleAction {
  const v = value as Partial<StoredOracleAction> | null
  return Boolean(
    v && v.v === 1 && typeof v.route === 'string' && (ORACLE_PLAN_ROUTES as readonly string[]).includes(v.route) && typeof v.nonce === 'string' && /^[0-9a-f]{1,32}$/.test(v.nonce) && typeof v.valueWei === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(v.valueWei) && v.body && typeof v.body === 'object',
  )
}

export interface UseApiOracleOptions {
  pollIntervalMs?: number
  sleep?(ms: number): Promise<void>
  /** Clock (tests): plan offers are not sent after they expire. */
  now?: () => Date
}

export interface ApiOracle {
  /** GET /api/v1/markets/:market/oracle?account=<wallet>: question, status, phase and the actions due now. */
  status: OracleActionStatus | null
  loading: boolean
  claim: OnChainClaim | null
  dueActions: OracleActionStatus['dueActions']
  /** max(minBond, 2 × current bond) in wei; the bond you enter must be at least this. */
  minimumBondWei: bigint | null
  action: { route: OraclePlanRoute; body: OracleActionBody; valueWei: bigint } | null
  runner: ApiPlanRunner
  planState: MarketsPlanResponse['planState'] | null
  error: WriteErrorInfo | null
  busy: boolean
  /** Answers with an explicit bond the user chose; the plan must carry exactly that value. */
  submitAnswer(outcome: 'yes' | 'no' | 'invalid', bondWei: bigint): Promise<void>
  fundBounty(amountWei: bigint): Promise<void>
  resolve(): Promise<void>
  reopen(): Promise<void>
  handleNotifiedRequest(): Promise<void>
  handleRejectedRequest(): Promise<void>
  reportArbitrationAnswer(): Promise<void>
  claimWinnings(): Promise<void>
  /** Withdraws the wallet's whole Reality.eth balance. */
  withdraw(): Promise<void>
  refresh(): Promise<void>
  abandon(): void
}

export function useApiOracle(market: Address, options: UseApiOracleOptions = {}): ApiOracle {
  const api = useWriteApi()
  const qc = useQueryClient()
  const wallet = useWallet()
  const reader = useRegistryReader()
  const manifest = usePinnedManifest()
  const { claim } = useOnChainClaim(market)
  const m = market.toLowerCase() as Address
  const account = wallet.address?.toLowerCase() as Address | undefined
  const [error, setError] = useState<WriteErrorInfo | null>(null)
  const clockRef = useRef(options.now)
  useEffect(() => {
    clockRef.current = options.now
  })
  const nowMs = useCallback(() => (clockRef.current?.() ?? new Date()).getTime(), [])

  const statusKey = ['pine', 'oracle-actions', m, account ?? null] as const
  const statusQ = useQuery({
    queryKey: statusKey,
    enabled: api !== null,
    staleTime: 5_000,
    queryFn: () => requireWriteApi(api).oracleStatus(m, account),
  })
  const status = statusQ.data ?? null

  const [action, setAction] = useStoredRecord<StoredOracleAction>(account ? `pine:api-oracle-action:${m}:${account}` : null, isStoredOracleAction)
  const latest = useRef({ action, account, claim, status, reader, manifest })
  useEffect(() => {
    latest.current = { action, account, claim, status, reader, manifest }
  })

  const keyOf = useCallback((a: StoredOracleAction | null) => (a && account ? `api-oracle:${m}:${account}:${a.route}:${a.nonce}` : null), [account, m])
  const plan = usePlanAction({
    key: keyOf(action),
    idleKey: `api-oracle-idle:${m}`,
    // Question ids are read on chain during verification (ClaimRegistry and Reality); none come from the status.
    markets: [m],
    limits: { maxTotalValueWei: action ? BigInt(action.valueWei) : 0n, maxApprovalAmount: 0n },
    sleep: options.sleep,
    now: nowMs,
    async create(idempotencyKey) {
      const client = requireWriteApi(api)
      const { action: act, account: acct, claim: c, status: s, reader: rpc, manifest: pinned } = latest.current
      if (!act || !acct || !c || !s) throw new Error('The oracle status is not loaded yet.')
      if (!rpc || !pinned) throw new Error('This build cannot read the chain, so it cannot check oracle transactions.')
      // The question the action targets, from the user's RPC now. Pine's status must agree before anything is planned.
      const currentQuestionId = await readCurrentQuestionId(rpc, pinned, c.questionId)
      if (s.currentQuestionId.toLowerCase() !== currentQuestionId) {
        void qc.invalidateQueries({ queryKey: ['pine', 'oracle-actions', m] })
        throw new RetryLaterError('Pine’s oracle status does not match the question on chain yet (it may have just been reopened). Nothing was sent; try again in a minute.', 30)
      }
      const res = await client.oraclePlan(act.route, act.body as never, idempotencyKey)
      if (res.planState.offerExpired) throw new Error('This oracle plan offer expired. Start the action again.')
      checkOraclePlan(res.plan, {
        route: act.route,
        body: act.body,
        account: acct,
        market: m,
        claimQuestionId: c.questionId,
        currentQuestionId,
        valueWei: BigInt(act.valueWei),
      })
      setAction({ ...act, planId: res.planState.id })
      return { wire: res.plan, planId: res.planState.id, expiresAt: res.planState.expiresAt * 1000 }
    },
    async submitted(planId, stepId, txHash) {
      await requireWriteApi(api).reportMarketsPlanTx(planId, stepId, txHash)
    },
    async onDone() {
      await qc.invalidateQueries({ queryKey: ['pine', 'oracle-actions', m] })
    },
  })
  const { runner } = plan

  const followPlanId = action?.planId && runner.runner.state === 'done' ? action.planId : undefined
  const polled = usePolledStatus<MarketsPlanResponse>({
    key: followPlanId ? `markets-plan:${followPlanId}` : null,
    load: () => requireWriteApi(api).getMarketsPlan(followPlanId ?? ''),
    done: (v) => FINAL_PLAN_STATES.includes(v.planState.state),
    intervalMs: options.pollIntervalMs ?? 10_000,
    sleep: options.sleep ? (ms) => options.sleep?.(ms) ?? Promise.resolve() : undefined,
  })

  const inFlight = useCallback(() => runnerIsBusy(runner) || runner.runner.steps.some((s) => s.status === 'pending' || s.status === 'awaiting_signature'), [runner])

  const start = useCallback(
    async (route: OraclePlanRoute, body: OracleActionBody, valueWei: bigint) => {
      setError(null)
      if (!latest.current.account) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Connect the wallet you signed in with.' })
        return
      }
      if (!latest.current.status || !latest.current.claim) {
        setError({ code: 'UNKNOWN', action: 'retry_later', message: 'The oracle status is still loading.' })
        return
      }
      if (inFlight()) {
        setError({ code: 'UNKNOWN', action: 'none', message: 'Another oracle transaction is in progress. Wait for it to finish.' })
        return
      }
      const next: StoredOracleAction = { v: 1, route, body, valueWei: valueWei.toString(10), nonce: actionNonce() }
      setAction(next)
      await plan.runWhenReady(keyOf(next))
    },
    [inFlight, setAction, plan, keyOf],
  )

  const minimumBondWei = minimumBondOf(status, claim)

  const submitAnswer = useCallback(
    async (outcome: 'yes' | 'no' | 'invalid', bondWei: bigint) => {
      if (bondWei <= 0n || bondWei > ORACLE_MAX_VALUE_WEI) {
        setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Enter a bond between 0 and 10,000 xDAI.' })
        return
      }
      if (minimumBondWei !== null && bondWei < minimumBondWei) {
        setError({ code: 'UNKNOWN', action: 'fix_input', message: 'The bond must be at least twice the current bond (and at least the minimum bond).' })
        return
      }
      await start('submit-answer', { market: m, outcome, bond: bondWei.toString(10) }, bondWei)
    },
    [minimumBondWei, start, m],
  )

  const fundBounty = useCallback(
    async (amountWei: bigint) => {
      if (amountWei <= 0n || amountWei > ORACLE_MAX_VALUE_WEI) {
        setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Enter a bounty between 0 and 10,000 xDAI.' })
        return
      }
      await start('fund-bounty', { market: m, amount: amountWei.toString(10) }, amountWei)
    },
    [start, m],
  )

  const simple = useCallback((route: OraclePlanRoute) => () => start(route, route === 'withdraw' ? {} : { market: m }, 0n), [start, m])

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['pine', 'oracle-actions', m] })
  }, [qc, m])

  const abandon = useCallback(() => {
    if (inFlight()) return
    runner.discard()
    setAction(null)
  }, [inFlight, runner, setAction])

  return {
    status,
    loading: statusQ.isLoading,
    claim,
    dueActions: status?.dueActions ?? [],
    minimumBondWei,
    action: action ? { route: action.route, body: action.body, valueWei: BigInt(action.valueWei) } : null,
    runner,
    planState: polled.value?.planState ?? null,
    error: error ?? plan.lastError ?? (runner.error ? { code: 'UNKNOWN', action: 'none', message: runner.error } : null),
    busy: runnerIsBusy(runner),
    submitAnswer,
    fundBounty,
    resolve: simple('resolve'),
    reopen: simple('reopen'),
    handleNotifiedRequest: simple('handle-notified-request'),
    handleRejectedRequest: simple('handle-rejected-request'),
    reportArbitrationAnswer: simple('report-arbitration-answer'),
    claimWinnings: simple('claim-winnings'),
    withdraw: simple('withdraw'),
    refresh,
    abandon,
  }
}
