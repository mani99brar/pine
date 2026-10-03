import { formatUnits } from 'viem'
import type { DecimalString, Hex, TxStep, TxStepId } from '@pine/core'
import {
  buildDeploymentManifest,
  claimRegistryAbi,
  planFromWire,
  PlanVerificationError,
  realityV3Abi,
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
import { getSqrtRatioAtTick, isValidTick, Q192 } from './tick-math'

// Client-side verification of backend transaction plans (SEC-TX-01..12). The backend proposes every transaction as a
// plan; before any wallet prompt the browser decodes it from the wire with its own copy of @pine/shared, checks it
// against the deployment manifest pinned at build time (never the one the server describes), against registered
// markets and their oracle questions read on the user's own RPC (ClaimRegistry, Reality), and against the user's
// limits, then derives every label it shows from the decoded calldata (SEC-TX-10).

/** The deployment manifest pinned in this build (NEXT_PUBLIC_PINE_*). Throws when unconfigured or not Gnosis. */
export function pinnedManifest(env: Pick<PineEnv, 'deployment' | 'defaultChainId'>): DeploymentManifest {
  if (!env.deployment) {
    throw new Error('This build has no Pine deployment configured (NEXT_PUBLIC_PINE_CLAIM_REGISTRY, …), so it cannot verify transactions.')
  }
  return buildDeploymentManifest(env.deployment, env.defaultChainId)
}

/** The reads plan verification makes on the user's RPC: ClaimRegistry, and Reality's reopened question of a claim. */
export type RegistryRead =
  | { address: Address; abi: typeof claimRegistryAbi; functionName: 'isRegistered' | 'getClaim'; args: readonly [Address] }
  | { address: Address; abi: typeof realityV3Abi; functionName: 'reopened_questions'; args: readonly [Hex32] }

/** The subset of a viem public client used to read ClaimRegistry and Reality. */
export interface RegistryReader {
  readContract(args: RegistryRead): Promise<unknown>
}

interface OnChainClaim {
  questionId: Hex32
  yesToken: Address
  noToken: Address
  invalidToken: Address
}

const HEX32 = /^0x[0-9a-f]{64}$/
const ZERO_HASH = `0x${'0'.repeat(64)}`

/**
 * The claim's current Reality question, read on the user's RPC: reopened_questions(original) when the original was
 * reopened after settling "answered too soon" (Reality keeps the latest replacement there), else the original.
 */
export async function readCurrentQuestionId(reader: RegistryReader, manifest: DeploymentManifest, questionId: Hex32): Promise<Hex32> {
  const original = questionId.toLowerCase() as Hex32
  const raw = await reader.readContract({ address: manifest.seer.realitio, abi: realityV3Abi, functionName: 'reopened_questions', args: [original] })
  const replacement = String(raw).toLowerCase()
  if (!HEX32.test(replacement)) throw new PlanVerificationError(null, 'Reality returned a malformed question id')
  return replacement === ZERO_HASH ? original : (replacement as Hex32)
}

/**
 * Registered markets (outcome tokens) and their question ids, read from ClaimRegistry on chain. With
 * `currentQuestions`, each market's current Reality question (after reopens) is read from Reality too.
 */
export async function buildPlanContext(
  reader: RegistryReader,
  manifest: DeploymentManifest,
  markets: readonly Address[],
  opts: { currentQuestions?: boolean } = {},
): Promise<PlanContext & { questionIds: Set<Hex32> }> {
  const context = { markets: new Map<Address, readonly Address[]>(), questionIds: new Set<Hex32>() }
  for (const raw of new Set(markets.map((m) => m.toLowerCase() as Address))) {
    const registered = await reader.readContract({ address: manifest.pine.claimRegistry, abi: claimRegistryAbi, functionName: 'isRegistered', args: [raw] })
    if (registered !== true) continue
    const claim = (await reader.readContract({ address: manifest.pine.claimRegistry, abi: claimRegistryAbi, functionName: 'getClaim', args: [raw] })) as OnChainClaim
    context.markets.set(raw, [claim.yesToken, claim.noToken, claim.invalidToken].map((t) => t.toLowerCase() as Address))
    const questionId = claim.questionId.toLowerCase() as Hex32
    context.questionIds.add(questionId)
    if (opts.currentQuestions) context.questionIds.add(await readCurrentQuestionId(reader, manifest, questionId))
  }
  return context
}

/** Calls whose arguments name a Reality question (verifyPlan requires it to be a registered claim question). */
const QUESTION_CALLS = new Set([
  'realitio.submitAnswer',
  'realitio.fundAnswerBounty',
  'realitio.claimWinnings',
  'realitio.reopenQuestion',
  'klerosHomeProxy.handleNotifiedRequest',
  'klerosHomeProxy.handleRejectedRequest',
  'klerosHomeProxy.reportArbitrationAnswer',
])

export interface VerifyOptions {
  manifest: DeploymentManifest
  /** The connected wallet; every plan is built for exactly one sender. */
  account: Address
  reader: RegistryReader
  /**
   * Markets the action is about. Their registration, outcome tokens and question come from ClaimRegistry, and for plans
   * that name a question, the current (reopened) question comes from Reality, all on the user's RPC.
   */
  markets?: readonly Address[]
  /**
   * Further question ids the caller derived ON CHAIN itself. Never pass ids from the Pine API (the oracle status): a
   * compromised API could point answers and bounties at a question it controls.
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
  const currentQuestions = plan.steps.some((s) => QUESTION_CALLS.has(s.allowlistId))
  const context = await buildPlanContext(opts.reader, opts.manifest, opts.markets ?? [], { currentQuestions })
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

/** The outcome token's price in sDAI at a pool square-root price, for display (4 significant digits). */
function outcomePrice(sqrtPriceX96: unknown, outcomeIsToken0: boolean): string {
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 <= 0n) return '?'
  const squared = sqrtPriceX96 * sqrtPriceX96
  const wad = outcomeIsToken0 ? (squared * 10n ** 18n) / Q192 : (Q192 * 10n ** 18n) / squared
  return String(Number(Number(formatUnits(wad, 18)).toPrecision(4)))
}

/** The outcome-token price range (sDAI) a position over [tickLower, tickUpper] covers, lowest first. */
function outcomePriceRange(tickLower: unknown, tickUpper: unknown, outcomeIsToken0: boolean): [string, string] {
  if (!isValidTick(tickLower) || !isValidTick(tickUpper)) return ['?', '?']
  const atLower = outcomePrice(getSqrtRatioAtTick(tickLower), outcomeIsToken0)
  const atUpper = outcomePrice(getSqrtRatioAtTick(tickUpper), outcomeIsToken0)
  return outcomeIsToken0 ? [atLower, atUpper] : [atUpper, atLower]
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
    case 'positionManager.createAndInitializePoolIfNecessary': {
      const outcomeIsToken0 = String(a[1]).toLowerCase() === manifest.seer.collateralToken.toLowerCase()
      return {
        label: 'Create the Swapr pool if missing',
        description: `Initialises the ${short(a[0])}/${short(a[1])} pool, if it does not exist yet, with the outcome token at ${outcomePrice(a[2], outcomeIsToken0)} sDAI.`,
      }
    }
    case 'positionManager.mint': {
      const p = a[0] as { token1?: unknown; tickLower?: unknown; tickUpper?: unknown; amount0Desired?: bigint; amount1Desired?: bigint } | undefined
      const outcomeIsToken0 = String(p?.token1).toLowerCase() === manifest.seer.collateralToken.toLowerCase()
      const [low, high] = outcomePriceRange(p?.tickLower, p?.tickUpper, outcomeIsToken0)
      const [outcome, sdai] = outcomeIsToken0 ? [p?.amount0Desired, p?.amount1Desired] : [p?.amount1Desired, p?.amount0Desired]
      return {
        label: `Add liquidity: up to ${amount(outcome)} outcome tokens between ${low} and ${high} sDAI`,
        description: `Deposits up to ${amount(outcome)} outcome tokens and ${amount(sdai)} sDAI into a position owned by your wallet; its outcome tokens are sold only while their price is between ${low} and ${high} sDAI.`,
      }
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

/**
 * Verified plan → runner steps (transactions in plan order; the machine runs them sequentially). Every request names
 * the plan account as `from`: the executor sends nothing from another account.
 */
export function planToTxSteps(plan: TxPlan, manifest: DeploymentManifest): TxStep[] {
  return plan.steps.map((step) => {
    const { label, description } = describePlanStep(step, manifest)
    return {
      id: planStepId(step.id),
      label,
      description,
      kind: 'transaction',
      request: { chainId: step.chainId, to: step.to as Hex, data: step.data as Hex, value: step.value.toString(10), from: plan.account as Hex },
      freezesTerms: step.allowlistId === 'claimRegistry.createClaim' ? true : undefined,
      estimatedCost: step.value > 0n ? { amount: formatUnits(step.value, 18), currency: 'xDAI' } : undefined,
    } satisfies TxStep
  })
}
