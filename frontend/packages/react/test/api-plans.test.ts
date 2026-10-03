import { describe, expect, it } from 'vitest'
import {
  buildDeploymentManifest,
  buildStep,
  newPlan,
  planToWire,
  PlanVerificationError,
  type Address,
  type Hex32,
} from '@pine/core/pine-shared'
import { describePlanStep, planStepIdOf, planToTxSteps, verifyWirePlan, type RegistryReader } from '../src/api/plans'

const PINE = {
  claimRegistry: '0x1000000000000000000000000000000000000001' as Address,
  evidenceRegistry: '0x2000000000000000000000000000000000000002' as Address,
  deploymentBlock: 1,
}
const manifest = buildDeploymentManifest(PINE)
const ACCOUNT = '0x3000000000000000000000000000000000000003' as Address
const MARKET = '0x4000000000000000000000000000000000000004' as Address
const YES = '0x5000000000000000000000000000000000000005' as Address
const NO = '0x6000000000000000000000000000000000000006' as Address
const INVALID = '0x7000000000000000000000000000000000000007' as Address
const QUESTION = `0x${'99'.repeat(32)}` as Hex32
const limits = { maxTotalValueWei: 10n ** 19n, maxApprovalAmount: 10n ** 21n }

/** A ClaimRegistry that knows MARKET, and a Reality whose question for it was `reopenedAs` (records every read). */
function registry(registered = true, reopenedAs?: Hex32): RegistryReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readContract({ address, functionName, args }) {
      reads.push(`${address}:${functionName}:${args[0]}`)
      if (functionName === 'reopened_questions') {
        if (address !== manifest.seer.realitio) throw new Error('read from the wrong Reality contract')
        return args[0] === QUESTION && reopenedAs ? reopenedAs : `0x${'00'.repeat(32)}`
      }
      if (address !== PINE.claimRegistry) throw new Error('read from the wrong registry')
      const known = registered && args[0] === MARKET
      if (functionName === 'isRegistered') return known
      if (!known) throw new Error('not registered')
      return { questionId: QUESTION, yesToken: YES, noToken: NO, invalidToken: INVALID }
    },
  }
}

const redeemPlan = (account: Address = ACCOUNT) =>
  planToWire(
    newPlan(manifest, 'plan-redeem', account, [
      buildStep(manifest, { id: 'approve-yes', allowlistId: 'outcomeToken.approve', to: YES, args: [manifest.seer.gnosisRouter, 5n * 10n ** 18n] }),
      buildStep(manifest, { id: 'redeem', allowlistId: 'gnosisRouter.redeemToBase', args: [MARKET, [0n], [5n * 10n ** 18n]], dependsOn: ['approve-yes'] }),
    ]),
  )

describe('verifyWirePlan', () => {
  it('accepts a plan whose market and outcome tokens are registered on chain', async () => {
    const reader = registry()
    const { plan, totalValue } = await verifyWirePlan(redeemPlan(), { manifest, account: ACCOUNT, reader, markets: [MARKET], limits })
    expect(plan.steps.map((s) => s.id)).toEqual(['approve-yes', 'redeem'])
    expect(totalValue).toBe(0n)
    expect(reader.reads).toContain(`${PINE.claimRegistry}:getClaim:${MARKET}`)
  })

  it('SEC-TX-01 rejects outcome-token approvals for a market ClaimRegistry does not know', async () => {
    await expect(verifyWirePlan(redeemPlan(), { manifest, account: ACCOUNT, reader: registry(false), markets: [MARKET], limits })).rejects.toThrow(
      PlanVerificationError,
    )
  })

  it('rejects a plan built for another wallet', async () => {
    const other = '0x8000000000000000000000000000000000000008' as Address
    await expect(verifyWirePlan(redeemPlan(other), { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits })).rejects.toThrow(/another wallet/)
  })

  it('SEC-TX-03 rejects an approval larger than the user limit', async () => {
    await expect(
      verifyWirePlan(redeemPlan(), { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits: { ...limits, maxApprovalAmount: 10n ** 18n } }),
    ).rejects.toThrow(/approval amount/)
  })

  it('SEC-TX-11 rejects native value above the spending limit', async () => {
    const wire = planToWire(
      newPlan(manifest, 'plan-answer', ACCOUNT, [
        buildStep(manifest, { id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, `0x${'00'.repeat(32)}`, 0n], value: 20n * 10n ** 18n }),
      ]),
    )
    await expect(verifyWirePlan(wire, { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits })).rejects.toThrow(/spending limit/)
  })

  it('SEC-TX-01 accepts only the claim question or its replacement read from Reality, never a question named by the caller alone', async () => {
    const REPLACEMENT = `0x${'98'.repeat(32)}` as Hex32
    const FOREIGN = `0x${'a1'.repeat(32)}` as Hex32
    const bounty = (question: Hex32) =>
      planToWire(newPlan(manifest, 'plan-bounty', ACCOUNT, [buildStep(manifest, { id: 'bounty', allowlistId: 'realitio.fundAnswerBounty', args: [question], value: 10n ** 18n })]))
    const reader = registry(true, REPLACEMENT)
    await expect(verifyWirePlan(bounty(QUESTION), { manifest, account: ACCOUNT, reader, markets: [MARKET], limits })).resolves.toMatchObject({ totalValue: 10n ** 18n })
    await expect(verifyWirePlan(bounty(REPLACEMENT), { manifest, account: ACCOUNT, reader, markets: [MARKET], limits })).resolves.toMatchObject({ totalValue: 10n ** 18n })
    expect(reader.reads).toContain(`${manifest.seer.realitio}:reopened_questions:${QUESTION}`)
    await expect(verifyWirePlan(bounty(FOREIGN), { manifest, account: ACCOUNT, reader, markets: [MARKET], limits })).rejects.toThrow(/not a registered claim question/)
    await expect(verifyWirePlan(bounty(REPLACEMENT), { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits })).rejects.toThrow(/not a registered claim question/)
  })

  it('reads Reality only for plans that name a question', async () => {
    const reader = registry()
    await verifyWirePlan(redeemPlan(), { manifest, account: ACCOUNT, reader, markets: [MARKET], limits })
    expect(reader.reads.some((r) => r.includes('reopened_questions'))).toBe(false)
  })

  it('SEC-TX-03 rejects calldata that pulls more than the exact approval', async () => {
    const wire = redeemPlan()
    wire.steps[1]!.data = `${wire.steps[1]!.data.slice(0, -2)}01` as `0x${string}`
    await expect(verifyWirePlan(wire, { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits })).rejects.toThrow(PlanVerificationError)
  })
})

describe('plan step presentation (SEC-TX-10: labels come from decoded calldata)', () => {
  it('turns verified steps into runner steps with exact amounts', async () => {
    const { plan } = await verifyWirePlan(redeemPlan(), { manifest, account: ACCOUNT, reader: registry(), markets: [MARKET], limits })
    const steps = planToTxSteps(plan, manifest)
    expect(steps.map((s) => s.id)).toEqual(['plan:approve-yes', 'plan:redeem'])
    expect(steps[0]!.label).toBe('Approve exactly 5 outcome tokens')
    expect(steps[0]!.description).toContain('the Seer router')
    expect(steps[1]!.request).toMatchObject({ chainId: 100, to: manifest.seer.gnosisRouter, value: '0' })
    // Every step may only be sent from the plan account.
    expect(steps.map((s) => s.request?.from)).toEqual([ACCOUNT, ACCOUNT])
    expect(planStepIdOf(steps[1]!.id)).toBe('redeem')
  })

  it('names the price range a liquidity position sells at and a new pool’s starting price, in both token orders', () => {
    const COLLATERAL = manifest.seer.collateralToken
    const mint = (token0: Address, token1: Address, tickLower: number, tickUpper: number, amounts: [bigint, bigint]) =>
      buildStep(manifest, {
        id: 'mint-yes',
        allowlistId: 'positionManager.mint',
        args: [{ token0, token1, tickLower, tickUpper, amount0Desired: amounts[0], amount1Desired: amounts[1], amount0Min: 0n, amount1Min: 0n, recipient: ACCOUNT, deadline: 1n }],
      })
    expect(describePlanStep(mint(YES, COLLATERAL, -29_940, -6_960, [79n * 10n ** 18n, 0n]), manifest)).toEqual({
      label: 'Add liquidity: up to 79 outcome tokens between 0.05009 and 0.4986 sDAI',
      description: 'Deposits up to 79 outcome tokens and 0 sDAI into a position owned by your wallet; its outcome tokens are sold only while their price is between 0.05009 and 0.4986 sDAI.',
    })
    const YES1 = '0xc000000000000000000000000000000000000c0c' as Address
    expect(describePlanStep(mint(COLLATERAL, YES1, 6_960, 29_940, [0n, 79n * 10n ** 18n]), manifest).label).toBe('Add liquidity: up to 79 outcome tokens between 0.05009 and 0.4986 sDAI')
    const pool = buildStep(manifest, { id: 'create-pool', allowlistId: 'positionManager.createAndInitializePoolIfNecessary', args: [YES, COLLATERAL, 17_732_633_948_828_052_598_660_473_722n] })
    expect(describePlanStep(pool, manifest).description).toMatch(/with the outcome token at 0\.05009 sDAI\.$/)
  })

  it('names the oracle answer and its bond', () => {
    const step = buildStep(manifest, { id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, `0x${'00'.repeat(31)}01`, 0n], value: 10n ** 19n })
    expect(describePlanStep(step, manifest).label).toBe('Answer “No” with a 10 xDAI bond')
  })
})
