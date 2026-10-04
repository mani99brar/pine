'use client'

import { useCallback } from 'react'
import { planFromWire, PlanVerificationError, type Address, type DeploymentManifest, type TxPlan } from '@pine/core/pine-shared'
import type { FundingPlanView, WriteErrorInfo } from '@pine/data'
import type { ApiPlanRunner } from './use-plan-runner'
import { FUNDING_MAX_APPROVAL, useFundingPlanFlow, type FundingFlowOptions, type StoredFundingAction } from './funding'
import type { OnChainClaim } from './publish-plan'

// Exits (api mode): withdraw a liquidity position (decrease, collect to the wallet, burn), merge full outcome sets back
// to xDAI, and redeem winning outcome tokens after resolution. Each plan is bound to the market, the position or amount
// the user chose, outcome-token approvals of this market only, spent by the Seer router, and funds sent to the wallet.

const lower = (v: unknown) => String(v).toLowerCase()

export type ExitKind = 'withdraw' | 'merge' | 'redeem'

export interface ExitPlanCheck {
  kind: ExitKind
  market: Address
  account: Address
  claim: Pick<OnChainClaim, 'yesToken' | 'noToken' | 'invalidToken'>
  manifest: DeploymentManifest
  /** withdraw: the position NFT id (decimal string). */
  tokenId?: string
  /** merge: the amount of each outcome token. */
  amount?: bigint
}

const ALLOWED: Record<ExitKind, readonly string[]> = {
  withdraw: ['positionManager.decreaseLiquidity', 'positionManager.collect', 'positionManager.burn'],
  merge: ['outcomeToken.approve', 'gnosisRouter.mergeToBase'],
  redeem: ['outcomeToken.approve', 'gnosisRouter.redeemToBase'],
}

/** Checks an exit plan against the exit the user chose. Throws PlanVerificationError before any wallet prompt. */
export function checkExitPlan(wire: unknown, ctx: ExitPlanCheck): TxPlan {
  const plan = planFromWire(wire)
  if (plan.account !== lower(ctx.account)) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  const outcomeTokens = [ctx.claim.yesToken, ctx.claim.noToken, ctx.claim.invalidToken].map(lower)
  const router = lower(ctx.manifest.seer.gnosisRouter)
  const counts = new Map<string, number>()
  for (const step of plan.steps) {
    if (!ALLOWED[ctx.kind].includes(step.allowlistId)) throw new PlanVerificationError(step.id, `a ${ctx.kind} plan may not call ${step.allowlistId}`)
    if (step.value !== 0n) throw new PlanVerificationError(step.id, 'exit calls carry no value')
    counts.set(step.allowlistId, (counts.get(step.allowlistId) ?? 0) + 1)
    const a = step.args
    const params = (a[0] ?? {}) as { tokenId?: unknown; recipient?: unknown }
    switch (step.allowlistId) {
      case 'positionManager.decreaseLiquidity':
      case 'positionManager.collect':
        if (String(params.tokenId) !== ctx.tokenId) throw new PlanVerificationError(step.id, 'the plan touches another position')
        if (step.allowlistId === 'positionManager.collect' && lower(params.recipient) !== lower(ctx.account)) throw new PlanVerificationError(step.id, 'the position’s tokens would go to another address')
        break
      case 'positionManager.burn':
        if (String(a[0]) !== ctx.tokenId) throw new PlanVerificationError(step.id, 'the plan burns another position')
        break
      case 'outcomeToken.approve':
        if (!outcomeTokens.includes(lower(step.to))) throw new PlanVerificationError(step.id, 'the approval is for a token outside this market')
        if (lower(a[0]) !== router) throw new PlanVerificationError(step.id, 'the approval spender is not the Seer router')
        if (ctx.kind === 'merge' && a[1] !== ctx.amount) throw new PlanVerificationError(step.id, 'the approval differs from the amount to merge')
        break
      case 'gnosisRouter.mergeToBase':
        if (lower(a[0]) !== lower(ctx.market) || a[1] !== ctx.amount) throw new PlanVerificationError(step.id, 'the merge differs from the market or amount you chose')
        break
      case 'gnosisRouter.redeemToBase':
        if (lower(a[0]) !== lower(ctx.market)) throw new PlanVerificationError(step.id, 'the redemption is for another market')
        break
    }
  }
  const one = (id: string) => counts.get(id) === 1
  if (ctx.kind === 'withdraw' && (!one('positionManager.burn') || (counts.get('positionManager.collect') ?? 0) > 1 || (counts.get('positionManager.decreaseLiquidity') ?? 0) > 1)) {
    throw new PlanVerificationError(null, 'a withdrawal decreases and collects at most once and burns the position once')
  }
  if (ctx.kind === 'merge' && (!one('gnosisRouter.mergeToBase') || counts.get('outcomeToken.approve') !== 3)) throw new PlanVerificationError(null, 'a merge approves the three outcome tokens and merges once')
  if (ctx.kind === 'redeem' && (!one('gnosisRouter.redeemToBase') || (counts.get('outcomeToken.approve') ?? 0) > 3)) throw new PlanVerificationError(null, 'a redemption redeems once')
  return plan
}

export interface ApiExits {
  claim: OnChainClaim | null
  /** Withdraws a liquidity position (NFT id as a decimal string) to the wallet. */
  withdrawPosition(tokenId: string): Promise<void>
  /** Merges `amountWei` full sets (YES + NO + INVALID) back to xDAI. */
  merge(amountWei: bigint): Promise<void>
  /** Redeems the wallet's winning outcome tokens after resolution. */
  redeem(): Promise<void>
  action: { kind: ExitKind } | null
  plan: FundingPlanView | null
  runner: ApiPlanRunner
  error: WriteErrorInfo | null
  busy: boolean
  abandon(): void
}

function checkFor(wire: unknown, action: StoredFundingAction, ctx: { market: Address; account: Address; claim: OnChainClaim; manifest: DeploymentManifest }): void {
  const kind = action.kind as ExitKind
  const body = action.body as { tokenId?: string; amount?: string }
  checkExitPlan(wire, { kind, market: ctx.market, account: ctx.account, claim: ctx.claim, manifest: ctx.manifest, tokenId: body.tokenId, amount: body.amount !== undefined ? BigInt(body.amount) : undefined })
}

export function useApiExits(market: Address, options: FundingFlowOptions = {}): ApiExits {
  const m = market.toLowerCase() as Address
  const flow = useFundingPlanFlow(m, 'exit', options, checkFor)

  const withdrawPosition = useCallback(
    async (tokenId: string) => {
      if (!/^(?:0|[1-9][0-9]{0,77})$/.test(tokenId) || BigInt(tokenId) >= 1n << 256n) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Choose a position.' })
        return
      }
      await flow.start('withdraw', { market: m, tokenId }, { valueWei: 0n, approvalWei: 0n })
    },
    [flow, m],
  )

  const merge = useCallback(
    async (amountWei: bigint) => {
      if (amountWei <= 0n || amountWei > FUNDING_MAX_APPROVAL) {
        flow.setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Enter how many full sets to merge.' })
        return
      }
      await flow.start('merge', { market: m, amount: amountWei.toString(10) }, { valueWei: 0n, approvalWei: amountWei })
    },
    [flow, m],
  )

  // Redemption approvals are the wallet's winning balances (unknown here); verifyPlan still requires each approval to be
  // consumed exactly by the redemption in the same plan, and the router pays the wallet that sends it.
  const redeem = useCallback(() => flow.start('redeem', { market: m }, { valueWei: 0n, approvalWei: FUNDING_MAX_APPROVAL }), [flow, m])

  return {
    claim: flow.claim,
    withdrawPosition,
    merge,
    redeem,
    action: flow.action && flow.action.kind !== 'ladder' ? { kind: flow.action.kind } : null,
    plan: flow.plan,
    runner: flow.runner,
    error: flow.error,
    busy: flow.busy,
    abandon: flow.abandon,
  }
}
