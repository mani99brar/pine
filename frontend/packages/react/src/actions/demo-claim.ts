/**
 * Builds the ClaimDetail that a demo publication adds to the MockDataProvider, so a claim published
 * in demo mode shows up in explore, dashboards, the agent brief and activity like any other claim.
 */
import type {
  ActivityItem,
  Address,
  ClaimDetail,
  ClaimDraft,
  ClaimManifest,
  FundingInput,
  FundingPlan,
  Hex,
  IsoDate,
  PolicyVersion,
  TimelineEvent,
} from '@pine/core'
import { getChainOrDefault, realityQuestionUrl, seerMarketUrl } from '@pine/core/chains'
import { fakeAddress, fakeHash, fromUnits, isoNow, toUnits } from '../internal/util'

export interface DemoClaimInput {
  draft: ClaimDraft
  manifest: ClaimManifest
  manifestHash: Hex
  manifestUri: string
  policy: PolicyVersion
  funding: FundingInput
  plan?: FundingPlan
  number: number
  creator: Address
  creatorGithub?: string
  marketAddress?: Address
  txHashes: Partial<Record<string, Hex>>
  now?: Date
}

export function buildDemoClaimDetail(input: DemoClaimInput): ClaimDetail {
  const { draft, manifest, manifestHash, manifestUri, policy, funding, number, creator } = input
  const now = input.now ?? new Date()
  const at = isoNow(now)
  const spec = manifest.claim
  const chain = getChainOrDefault(funding.chainId)
  const claimId = manifest.claimId
  const market = input.marketAddress ?? fakeAddress('market', claimId)
  const conditionId = fakeHash('condition', claimId)
  const questionId = fakeHash('question', claimId)
  const createdTx = input.txHashes.create_market ?? fakeHash('create', claimId)
  const yes = clamp(funding.initialYesPrice, 0.01, 0.99)
  const half = halve(funding.liquidity)
  const arbitrationLine = input.plan?.costs.find((c) => c.key === 'arbitration_fee')

  const timeline: TimelineEvent[] = [
    { id: `${claimId}-drafted`, kind: 'drafted', at: draft.createdAt, title: 'Claim drafted' },
    {
      id: `${claimId}-pinned`,
      kind: 'manifest_pinned',
      at,
      title: 'Manifest pinned',
      detail: `${manifestUri} (keccak256 ${manifestHash})`,
    },
    { id: `${claimId}-market`, kind: 'market_created', at, title: 'Market created', txHash: createdTx, actor: creator },
    ...(input.txHashes.add_liquidity_yes || input.txHashes.add_liquidity_no
      ? [
          {
            id: `${claimId}-liquidity`,
            kind: 'liquidity_added' as const,
            at,
            title: `Liquidity added (${funding.liquidity} ${chain.collateral.symbol})`,
            txHash: input.txHashes.add_liquidity_yes ?? input.txHashes.add_liquidity_no,
            actor: creator,
          },
        ]
      : []),
    {
      id: `${claimId}-deadline`,
      kind: 'evidence_deadline',
      at: spec.evidence.deadline,
      title: 'Evidence deadline',
      scheduled: true,
    },
    { id: `${claimId}-oracle`, kind: 'oracle_opened', at: spec.oracle.openingTime, title: 'Oracle opens for answers', scheduled: true },
  ]

  return {
    id: claimId,
    number,
    title: spec.title || policy.title,
    violation: spec.violation,
    policy: { id: policy.id, version: policy.version, family: policy.family, title: policy.title },
    source: {
      owner: manifest.source.owner,
      repo: manifest.source.repo,
      commitSha: manifest.source.commit.sha,
      ...(manifest.source.pullRequest
        ? { prNumber: manifest.source.pullRequest.number, prTitle: manifest.source.pullRequest.title }
        : {}),
    },
    status: 'open',
    createdAt: at,
    evidenceDeadline: spec.evidence.deadline,
    chainId: chain.id,
    marketAddress: market,
    creator,
    creatorGithub: input.creatorGithub,
    yesPrice: yes,
    yesPrice24hAgo: yes,
    liquidity: funding.liquidity,
    volume: '0',
    collateralSymbol: chain.collateral.symbol,
    evidenceCount: 0,
    traders: 0,
    sponsored: Boolean(funding.sponsored),
    tags: [policy.family.toLowerCase(), policy.id, 'demo'],
    manifest,
    manifestUri,
    manifestHash,
    market: {
      chainId: chain.id,
      address: market,
      seerUrl: seerMarketUrl(chain.id, market),
      conditionId,
      questionId,
      collateral: chain.collateral,
      outcomes: [
        { index: 0, label: 'Yes', token: fakeAddress('yes', claimId), price: yes, change24h: 0 },
        { index: 1, label: 'No', token: fakeAddress('no', claimId), price: round4(1 - yes), change24h: 0 },
        { index: 2, label: 'Invalid result', token: fakeAddress('invalid', claimId), price: 0 },
      ],
      pools: [
        { address: fakeAddress('pool-yes', claimId), dex: 'Swapr (Algebra)', outcome: 'yes', tvl: half, feeBps: 100 },
        { address: fakeAddress('pool-no', claimId), dex: 'Swapr (Algebra)', outcome: 'no', tvl: half, feeBps: 100 },
      ],
      liquidity: funding.liquidity,
      volume24h: '0',
      volumeTotal: '0',
      traders: 0,
      openInterest: '0',
      createdAt: at,
      createdTx,
    },
    oracle: {
      chainId: chain.id,
      realityQuestionId: questionId,
      realityUrl: realityQuestionUrl(chain.id, questionId),
      templateId: 2,
      openingTime: spec.oracle.openingTime,
      timeoutSeconds: spec.oracle.timeoutSeconds,
      minBond: spec.oracle.minBond,
      bondToken: spec.oracle.bondToken,
      isFinalized: false,
      history: [],
      arbitration: { requested: false, cost: arbitrationLine?.amount ?? '0', status: 'not_requested' },
    },
    evidence: [],
    timeline,
    funding: { liquidity: funding.liquidity, spendingLimit: funding.spendingLimit, withdrawable: true },
  }
}

/** Activity rows recorded for a demo publication (reconciliation/history views). */
export function buildDemoPublishActivity(detail: ClaimDetail, txHashes: Partial<Record<string, Hex>>, at: IsoDate): ActivityItem[] {
  const base = {
    claimId: detail.id,
    claimNumber: detail.number,
    claimTitle: detail.title,
    actor: detail.creator,
    at,
    chainId: detail.chainId,
    status: 'confirmed' as const,
  }
  const items: ActivityItem[] = [
    {
      ...base,
      id: `${detail.id}-act-pinned`,
      type: 'manifest_pinned',
      txHash: fakeHash('pin', detail.id),
      summary: `Pinned claim manifest ${detail.manifestUri}`,
    },
    {
      ...base,
      id: `${detail.id}-act-market`,
      type: 'market_created',
      txHash: txHashes.create_market ?? fakeHash('create', detail.id),
      summary: `Created market for ${detail.title}`,
    },
  ]
  if (txHashes.approve_collateral) {
    items.push({
      ...base,
      id: `${detail.id}-act-approve`,
      type: 'approval',
      txHash: txHashes.approve_collateral,
      amount: detail.funding?.liquidity,
      token: detail.collateralSymbol,
      summary: `Approved exactly ${detail.funding?.liquidity ?? '0'} ${detail.collateralSymbol}`,
    })
  }
  if (txHashes.add_liquidity_yes || txHashes.add_liquidity_no) {
    items.push({
      ...base,
      id: `${detail.id}-act-liquidity`,
      type: 'liquidity_added',
      txHash: (txHashes.add_liquidity_yes ?? txHashes.add_liquidity_no) as Hex,
      amount: `-${detail.funding?.liquidity ?? '0'}`,
      token: detail.collateralSymbol,
      summary: `Added ${detail.funding?.liquidity ?? '0'} ${detail.collateralSymbol} liquidity`,
    })
  }
  return items
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

function halve(amount: string): string {
  const v = toUnits(amount)
  return v === null ? '0' : fromUnits(v / 2n)
}
