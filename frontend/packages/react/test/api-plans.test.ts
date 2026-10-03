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

/** A ClaimRegistry that knows MARKET (and records every read). */
function registry(registered = true): RegistryReader & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readContract({ address, functionName, args }) {
      reads.push(`${address}:${functionName}:${args[0]}`)
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
    expect(planStepIdOf(steps[1]!.id)).toBe('redeem')
  })

  it('names the oracle answer and its bond', () => {
    const step = buildStep(manifest, { id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, `0x${'00'.repeat(31)}01`, 0n], value: 10n ** 19n })
    expect(describePlanStep(step, manifest).label).toBe('Answer “No” with a 10 xDAI bond')
  })
})
