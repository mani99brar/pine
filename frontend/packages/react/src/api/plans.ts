import { formatUnits } from 'viem'
import type { DecimalString, Hex, TxStep, TxStepId } from '@pine/core'
import {
  buildDeploymentManifest,
  claimRegistryAbi,
  planFromWire,
  PlanVerificationError,
  verifyPlan,
  type Address,
  type DeploymentManifest,
  type Hex32,
  type PlanContext,
  type PlanLimits,
  type TxPlan,
  type TxStep as PlanStep,
} from '@pine/core/pine-shared'
import type { PineEnv } from '@pine/data'

// Client-side verification of backend transaction plans (SEC-TX-01..12). The backend proposes every transaction as a
// plan; before any wallet prompt the browser decodes it from the wire with its own copy of @pine/shared, checks it
// against the deployment manifest pinned at build time (never the one the server describes), against registered
// markets read from ClaimRegistry on the user's own RPC, and against the user's limits, then derives every label it
// shows from the decoded calldata (SEC-TX-10).

/** The deployment manifest pinned in this build (NEXT_PUBLIC_PINE_*). Throws when unconfigured or not Gnosis. */
export function pinnedManifest(env: Pick<PineEnv, 'deployment' | 'defaultChainId'>): DeploymentManifest {
  if (!env.deployment) {
    throw new Error('This build has no Pine deployment configured (NEXT_PUBLIC_PINE_CLAIM_REGISTRY, …), so it cannot verify transactions.')
  }
  return buildDeploymentManifest(env.deployment, env.defaultChainId)
}

/** The subset of a viem public client used to read ClaimRegistry. */
export interface RegistryReader {
  readContract(args: { address: Address; abi: typeof claimRegistryAbi; functionName: 'isRegistered' | 'getClaim'; args: readonly [Address] }): Promise<unknown>
}

interface OnChainClaim {
  questionId: Hex32
  yesToken: Address
  noToken: Address
  invalidToken: Address
}

/** Registered markets (outcome tokens) and their question ids, read from ClaimRegistry on chain. */
export async function buildPlanContext(
  reader: RegistryReader,
  manifest: DeploymentManifest,
  markets: readonly Address[],
): Promise<PlanContext & { questionIds: Set<Hex32> }> {
  const context = { markets: new Map<Address, readonly Address[]>(), questionIds: new Set<Hex32>() }
  for (const raw of new Set(markets.map((m) => m.toLowerCase() as Address))) {
    const registered = await reader.readContract({ address: manifest.pine.claimRegistry, abi: claimRegistryAbi, functionName: 'isRegistered', args: [raw] })
    if (registered !== true) continue
    const claim = (await reader.readContract({ address: manifest.pine.claimRegistry, abi: claimRegistryAbi, functionName: 'getClaim', args: [raw] })) as OnChainClaim
    context.markets.set(raw, [claim.yesToken, claim.noToken, claim.invalidToken].map((t) => t.toLowerCase() as Address))
    context.questionIds.add(claim.questionId.toLowerCase() as Hex32)
  }
  return context
}

export interface VerifyOptions {
  manifest: DeploymentManifest
  /** The connected wallet; every plan is built for exactly one sender. */
  account: Address
  reader: RegistryReader
  /** Markets the action is about (their registration and outcome tokens are read on chain). */
  markets?: readonly Address[]
  /**
   * Reality question ids that replaced a market's original question (reopened after "answered too soon"), as reported
   * by the read model. Registered questions themselves always come from ClaimRegistry.
   */
  reopenedQuestionIds?: readonly Hex32[]
  limits: PlanLimits
}

/** planFromWire + verifyPlan with the pinned manifest and on-chain context. Throws PlanVerificationError. */
export async function verifyWirePlan(wire: unknown, opts: VerifyOptions): Promise<{ plan: TxPlan; totalValue: bigint }> {
  const plan = planFromWire(wire)
  if (plan.account !== opts.account.toLowerCase()) {
    throw new PlanVerificationError(null, 'the plan was built for another wallet; reconnect the wallet you signed in with')
  }
  const context = await buildPlanContext(opts.reader, opts.manifest, opts.markets ?? [])
  for (const id of opts.reopenedQuestionIds ?? []) context.questionIds.add(id.toLowerCase() as Hex32)
  const totalValue = verifyPlan(plan, opts.manifest, context, opts.limits)
  return { plan, totalValue }
}

const TOKEN_DECIMALS = 18

function amount(value: unknown): DecimalString {
  return typeof value === 'bigint' ? formatUnits(value, TOKEN_DECIMALS) : '?'
}

function short(value: unknown): string {
  const s = String(value)
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s
}

function spenderName(manifest: DeploymentManifest, spender: unknown): string {
  const s = String(spender).toLowerCase()
  if (s === manifest.seer.gnosisRouter.toLowerCase()) return 'the Seer router'
  if (s === manifest.amm.positionManager.toLowerCase()) return 'the Swapr position manager'
  return short(spender)
}

const ANSWERS: Record<string, string> = {
  '0x0000000000000000000000000000000000000000000000000000000000000000': 'Yes',
  '0x0000000000000000000000000000000000000000000000000000000000000001': 'No',
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff': 'Invalid',
  '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe': 'Answered too soon',
}

/** Label and description of one verified step, derived only from its decoded calldata. */
export function describePlanStep(step: PlanStep, manifest: DeploymentManifest): { label: string; description: string } {
  const a = step.args
  switch (step.allowlistId) {
    case 'claimRegistry.createClaim':
      return {
        label: 'Publish the claim and create its market',
        description: 'ClaimRegistry records the claim document digest and creates the Seer market. The claim terms are frozen once this confirms.',
      }
    case 'evidenceRegistry.commitEvidence':
      return { label: 'Commit sealed evidence', description: `Records commitment ${short(a[1])} for market ${short(a[0])}. The evidence stays sealed until you reveal it.` }
    case 'evidenceRegistry.revealEvidence':
      return { label: 'Reveal evidence', description: `Reveals submission #${String(a[0])} with content ${short(a[1])}.` }
    case 'evidenceRegistry.publishEvidence':
      return { label: 'Publish evidence', description: `Publishes content ${short(a[1])} for market ${short(a[0])} in the clear.` }
    case 'collateralToken.approve':
      return { label: `Approve exactly ${amount(a[1])} sDAI`, description: `Allows ${spenderName(manifest, a[0])} to move exactly ${amount(a[1])} sDAI, consumed by the next steps.` }
    case 'outcomeToken.approve':
      return {
        label: `Approve exactly ${amount(a[1])} outcome tokens`,
        description: `Allows ${spenderName(manifest, a[0])} to move exactly ${amount(a[1])} of token ${short(step.to)}, consumed by the next steps.`,
      }
    case 'gnosisRouter.splitFromBase':
      return { label: `Split ${formatUnits(step.value, 18)} xDAI into outcome tokens`, description: `Mints Yes, No and Invalid tokens of market ${short(a[0])}.` }
    case 'gnosisRouter.splitPosition':
      return { label: `Split ${amount(a[2])} sDAI into outcome tokens`, description: `Mints ${amount(a[2])} each of the Yes, No and Invalid tokens of market ${short(a[1])}.` }
    case 'gnosisRouter.mergeToBase':
      return { label: `Merge ${amount(a[1])} of each outcome back to xDAI`, description: `Burns a full set of outcome tokens of market ${short(a[0])}.` }
    case 'gnosisRouter.redeemToBase':
      return { label: 'Redeem winning outcome tokens', description: `Redeems resolved tokens of market ${short(a[0])} for xDAI to your wallet.` }
    case 'positionManager.createAndInitializePoolIfNecessary':
      return { label: 'Create the Swapr pool if missing', description: `Initialises the ${short(a[0])}/${short(a[1])} pool at the planned price.` }
    case 'positionManager.mint': {
      const p = a[0] as { amount0Desired?: bigint; amount1Desired?: bigint } | undefined
      return { label: 'Add liquidity', description: `Deposits up to ${amount(p?.amount0Desired)} and ${amount(p?.amount1Desired)} tokens into a position owned by your wallet.` }
    }
    case 'positionManager.decreaseLiquidity':
      return { label: 'Remove liquidity', description: 'Removes liquidity from your Swapr position.' }
    case 'positionManager.collect':
      return { label: 'Collect tokens and fees', description: 'Sends the position’s tokens and fees to your wallet.' }
    case 'positionManager.burn':
      return { label: 'Close the empty position', description: 'Burns the empty Swapr position NFT.' }
    case 'realitio.submitAnswer':
      return {
        label: `Answer “${ANSWERS[String(a[1]).toLowerCase()] ?? short(a[1])}” with a ${formatUnits(step.value, 18)} xDAI bond`,
        description: 'Posts an answer to the Reality.eth question. The bond is lost if a later, higher-bonded answer wins.',
      }
    case 'realitio.fundAnswerBounty':
      return { label: `Fund the answer bounty with ${formatUnits(step.value, 18)} xDAI`, description: 'Adds a bounty for whoever answers the question.' }
    case 'realitio.claimWinnings':
      return { label: 'Claim oracle bonds and bounty', description: 'Credits your Reality.eth balance with the bonds and bounty you won.' }
    case 'realitio.withdraw':
      return { label: 'Withdraw your Reality.eth balance', description: 'Sends your Reality.eth balance to your wallet.' }
    case 'realitio.reopenQuestion':
      return { label: 'Reopen the question', description: 'Asks the same question again after it settled as “answered too soon”.' }
    case 'realityProxy.resolve':
      return { label: 'Resolve the market', description: `Reports the final oracle answer to market ${short(a[0])} so tokens can be redeemed.` }
    case 'klerosHomeProxy.handleNotifiedRequest':
      return { label: 'Relay the arbitration request', description: 'Completes the Kleros arbitration request on Gnosis.' }
    case 'klerosHomeProxy.handleRejectedRequest':
      return { label: 'Relay the rejected arbitration request', description: 'Returns the arbitration request to the oracle after Kleros rejected it.' }
    case 'klerosHomeProxy.reportArbitrationAnswer':
      return { label: 'Report the arbitration answer', description: 'Reports Kleros’ ruling to Reality.eth on Gnosis.' }
    default:
      return { label: step.allowlistId, description: `Calls ${step.allowlistId}.` }
  }
}

/** The runner step id of a plan step. */
export function planStepId(stepId: string): TxStepId {
  return `plan:${stepId}`
}

/** Plan step id of a runner step id (`plan:<id>`), or null. */
export function planStepIdOf(id: string): string | null {
  return id.startsWith('plan:') ? id.slice(5) : null
}

/** Verified plan → runner steps (transactions in plan order; the machine runs them sequentially). */
export function planToTxSteps(plan: TxPlan, manifest: DeploymentManifest): TxStep[] {
  return plan.steps.map((step) => {
    const { label, description } = describePlanStep(step, manifest)
    return {
      id: planStepId(step.id),
      label,
      description,
      kind: 'transaction',
      request: { chainId: step.chainId, to: step.to as Hex, data: step.data as Hex, value: step.value.toString(10) },
      freezesTerms: step.allowlistId === 'claimRegistry.createClaim' ? true : undefined,
      estimatedCost: step.value > 0n ? { amount: formatUnits(step.value, 18), currency: 'xDAI' } : undefined,
    } satisfies TxStep
  })
}
