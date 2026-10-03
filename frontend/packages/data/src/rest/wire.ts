/**
 * Wire format of the Pine REST indexer (docs/indexer/rest-api.openapi.yaml).
 *
 * Convention: read-model envelopes produced by the indexer are snake_case; optional values may be
 * `null` on the wire and map to absent (`undefined`) in the domain. Immutable or user-authored
 * documents are embedded verbatim in their domain (camelCase) shape because they are hashed or
 * contain user-defined keys: `manifest`, policy `parameters`, and draft `source`/`spec`/`funding`/`publication`.
 */
import type {
  Account,
  ActivityItem,
  ArbitrationState,
  ClaimDetail,
  ClaimDraft,
  ClaimManifest,
  ClaimSummary,
  DepthSnapshot,
  Evidence,
  LinkedWallet,
  MarketState,
  OracleState,
  Page,
  PlatformStats,
  PolicyVersion,
  Portfolio,
  PricePoint,
  TimelineEvent,
  TxStepId,
  TxStepStatus,
} from '@pine/core'

type Nullable<T> = T | null | undefined

/** null/undefined → undefined */
function opt<T>(v: Nullable<T>): T | undefined {
  return v === null || v === undefined ? undefined : v
}

/** Drop undefined keys so mapped objects compare cleanly and serialize compactly. */
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

/** undefined → null (domain → wire) */
function nul<T>(v: T | undefined): T | null {
  return v === undefined ? null : v
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface WirePage<T> {
  items: T[]
  next_cursor?: string | null
  total?: number | null
}

export interface WireClaimSummary {
  id: string
  number: number
  title: string
  violation: string
  policy: { id: string; version: string; family: 'FUNC' | 'BOT' | 'SC'; title: string }
  source: { owner: string; repo: string; commit_sha: string; pr_number?: number | null; pr_title?: string | null }
  status: ClaimSummary['status']
  outcome?: ClaimSummary['outcome'] | null
  created_at: string
  evidence_deadline: string
  chain_id: number
  market_address?: string | null
  creator: string
  creator_github?: string | null
  yes_price?: number | null
  yes_price_24h_ago?: number | null
  liquidity: string
  volume: string
  collateral_symbol: string
  evidence_count: number
  traders: number
  sponsored: boolean
  tags: string[]
}

export interface WireMarket {
  chain_id: number
  address: string
  seer_url: string
  condition_id: string
  question_id: string
  collateral: { address: string; symbol: string; decimals: number; name?: string | null }
  outcomes: { index: number; label: string; token: string; price: number; change_24h?: number | null }[]
  pools: { address: string; dex: string; outcome: 'yes' | 'no'; tvl: string; fee_bps: number }[]
  liquidity: string
  volume_24h: string
  volume_total: string
  traders: number
  open_interest: string
  created_at: string
  created_tx: string
}

export interface WireArbitration {
  requested: boolean
  requested_at?: string | null
  requester?: string | null
  dispute_id?: string | null
  court?: string | null
  cost: string
  status: ArbitrationState['status']
  ruling?: ArbitrationState['ruling'] | null
  appeal_deadline?: string | null
  kleros_url?: string | null
}

export interface WireOracle {
  chain_id: number
  reality_question_id: string
  reality_url: string
  template_id: number
  opening_time: string
  timeout_seconds: number
  min_bond: string
  bond_token: string
  current_answer?: OracleState['currentAnswer'] | null
  current_bond?: string | null
  finalizes_at?: string | null
  is_finalized: boolean
  final_answer?: OracleState['finalAnswer'] | null
  history: { answer: OracleState['history'][number]['answer']; bond: string; answerer: string; at: string; tx_hash: string }[]
  arbitration: WireArbitration
}

export interface WireEvidence {
  id: string
  claim_id: string
  kind: Evidence['kind']
  title: string
  summary: string
  submitter: string
  submitted_at: string
  block_number: number
  tx_hash: string
  chain_id: number
  uri: string
  content_hash: string
  timely: boolean
  reproduction?: { command: string; environment: string; expected: string; actual: string; steps?: string[] | null } | null
  attachments: { name: string; uri: string; mime: string; size: number; hash: string }[]
  commitment?: { hash: string; revealed: boolean; revealed_at?: string | null } | null
}

export interface WireTimelineEvent {
  id: string
  kind: TimelineEvent['kind']
  at: string
  title: string
  detail?: string | null
  actor?: string | null
  tx_hash?: string | null
  scheduled?: boolean | null
}

export interface WireClaimDetail extends WireClaimSummary {
  manifest: ClaimManifest
  manifest_uri: string
  manifest_hash: string
  market?: WireMarket | null
  oracle?: WireOracle | null
  evidence: WireEvidence[]
  timeline: WireTimelineEvent[]
  publication?: {
    steps: { id: string; status: string; tx_hash?: string | null; error?: string | null; at?: string | null }[]
    resumable: boolean
    note?: string | null
  } | null
  funding?: { liquidity: string; spending_limit: string; withdrawable: boolean } | null
}

/** `points` are `[t (unix ms), yes, no, volume]` tuples, oldest first. */
export interface WirePriceHistory {
  claim_id: string
  range: string
  points: [number, number, number, number | null][]
}

/** `bids` descending and `asks` ascending, each `[price, cumulative_size]`. */
export interface WireDepth {
  claim_id: string
  outcome: 'yes' | 'no'
  mid: number
  at: string
  bids: [number, number][]
  asks: [number, number][]
}

export interface WireActivity {
  id: string
  type: ActivityItem['type']
  claim_id: string
  claim_number: number
  claim_title: string
  actor: string
  at: string
  tx_hash: string
  chain_id: number
  amount?: string | null
  token?: string | null
  outcome?: ActivityItem['outcome'] | null
  side?: ActivityItem['side'] | null
  summary: string
  status?: ActivityItem['status'] | null
}

export interface WirePortfolio {
  address: string
  positions: {
    claim_id: string
    claim_number: number
    claim_title: string
    status: ClaimSummary['status']
    outcome: 'yes' | 'no' | 'invalid'
    balance: string
    avg_price?: number | null
    mark_price: number
    value: string
    redeemable: boolean
    redeemable_amount?: string | null
  }[]
  liquidity: {
    claim_id: string
    claim_number: number
    claim_title: string
    token_id: string
    pool: string
    outcome: 'yes' | 'no'
    deposited: string
    current_value: string
    fees_earned: string
    withdrawable: boolean
    in_range: boolean
  }[]
  totals: {
    positions_value: string
    liquidity_value: string
    redeemable: string
    deposited_all_time: string
    withdrawn_all_time: string
    fees_paid_all_time: string
  }
}

export interface WirePolicy {
  id: string
  family: PolicyVersion['family']
  version: string
  title: string
  summary: string
  status: PolicyVersion['status']
  gate_reason?: string | null
  content_hash: string
  uri: string
  text: string
  intended_use: string[]
  examples: string[]
  claim_classes: { id: string; label: string; description: string }[]
  /** Verbatim domain `PolicyParameterSpec[]` */
  parameters: PolicyVersion['parameters']
  evidence_requirements: string[]
  exclusions: string[]
  outcome_rules: { yes: string; no: string; invalid: string }
  published_at: string
  supersedes?: string | null
}

export interface WireStats {
  open_claims: number
  resolved_claims: number
  total_liquidity: string
  volume_30d: string
  evidence_submissions: number
  counterexamples_accepted: number
  collateral_symbol: string
}

export interface WireDraft {
  id: string
  owner: string
  created_at: string
  updated_at: string
  stage: ClaimDraft['stage']
  source?: ClaimDraft['source'] | null
  spec: ClaimDraft['spec']
  funding?: ClaimDraft['funding'] | null
  publication?: ClaimDraft['publication'] | null
}

export interface WireAccount {
  id: string
  github: { login: string; id: number; name?: string | null; avatar_url: string; html_url: string; scopes: string[] }
  wallets: { address: string; chain_id: number; verified_at: string; label?: string | null; primary: boolean }[]
  preferences: {
    default_chain_id: number
    default_spending_limit: string
    notify_on_evidence: boolean
    notify_on_answer: boolean
    notify_on_deadline: boolean
    notification_email?: string | null
    display_currency: 'collateral' | 'usd'
  }
  created_at: string
  demo: boolean
}

// ---------------------------------------------------------------------------
// Wire → domain
// ---------------------------------------------------------------------------

type H = `0x${string}`
const hx = (s: string) => s as H

export function pageFromWire<W, D>(p: WirePage<W>, map: (w: W) => D): Page<D> {
  return compact({ items: (p.items ?? []).map(map), nextCursor: opt(p.next_cursor), total: opt(p.total) })
}

export function claimSummaryFromWire(w: WireClaimSummary): ClaimSummary {
  return compact({
    id: w.id,
    number: w.number,
    title: w.title,
    violation: w.violation,
    policy: { id: w.policy.id, version: w.policy.version, family: w.policy.family, title: w.policy.title },
    source: compact({ owner: w.source.owner, repo: w.source.repo, commitSha: w.source.commit_sha, prNumber: opt(w.source.pr_number), prTitle: opt(w.source.pr_title) }),
    status: w.status,
    outcome: opt(w.outcome),
    createdAt: w.created_at,
    evidenceDeadline: w.evidence_deadline,
    chainId: w.chain_id,
    marketAddress: w.market_address ? hx(w.market_address) : undefined,
    creator: hx(w.creator),
    creatorGithub: opt(w.creator_github),
    yesPrice: opt(w.yes_price),
    yesPrice24hAgo: opt(w.yes_price_24h_ago),
    liquidity: w.liquidity,
    volume: w.volume,
    collateralSymbol: w.collateral_symbol,
    evidenceCount: w.evidence_count,
    traders: w.traders,
    sponsored: w.sponsored,
    tags: w.tags ?? [],
  })
}

export function marketFromWire(w: WireMarket): MarketState {
  return {
    chainId: w.chain_id,
    address: hx(w.address),
    seerUrl: w.seer_url,
    conditionId: hx(w.condition_id),
    questionId: hx(w.question_id),
    collateral: compact({ address: hx(w.collateral.address), symbol: w.collateral.symbol, decimals: w.collateral.decimals, name: opt(w.collateral.name) }),
    outcomes: w.outcomes.map((o) => compact({ index: o.index, label: o.label, token: hx(o.token), price: o.price, change24h: opt(o.change_24h) })),
    pools: w.pools.map((p) => ({ address: hx(p.address), dex: p.dex, outcome: p.outcome, tvl: p.tvl, feeBps: p.fee_bps })),
    liquidity: w.liquidity,
    volume24h: w.volume_24h,
    volumeTotal: w.volume_total,
    traders: w.traders,
    openInterest: w.open_interest,
    createdAt: w.created_at,
    createdTx: hx(w.created_tx),
  }
}

export function oracleFromWire(w: WireOracle): OracleState {
  const a = w.arbitration
  return compact({
    chainId: w.chain_id,
    realityQuestionId: hx(w.reality_question_id),
    realityUrl: w.reality_url,
    templateId: w.template_id,
    openingTime: w.opening_time,
    timeoutSeconds: w.timeout_seconds,
    minBond: w.min_bond,
    bondToken: w.bond_token,
    currentAnswer: opt(w.current_answer),
    currentBond: opt(w.current_bond),
    finalizesAt: opt(w.finalizes_at),
    isFinalized: w.is_finalized,
    finalAnswer: opt(w.final_answer),
    history: w.history.map((h) => ({ answer: h.answer, bond: h.bond, answerer: hx(h.answerer), at: h.at, txHash: hx(h.tx_hash) })),
    arbitration: compact({
      requested: a.requested,
      requestedAt: opt(a.requested_at),
      requester: a.requester ? hx(a.requester) : undefined,
      disputeId: opt(a.dispute_id),
      court: opt(a.court),
      cost: a.cost,
      status: a.status,
      ruling: opt(a.ruling),
      appealDeadline: opt(a.appeal_deadline),
      klerosUrl: opt(a.kleros_url),
    }),
  })
}

export function evidenceFromWire(w: WireEvidence): Evidence {
  return compact({
    id: w.id,
    claimId: w.claim_id,
    kind: w.kind,
    title: w.title,
    summary: w.summary,
    submitter: hx(w.submitter),
    submittedAt: w.submitted_at,
    blockNumber: w.block_number,
    txHash: hx(w.tx_hash),
    chainId: w.chain_id,
    uri: w.uri,
    contentHash: hx(w.content_hash),
    timely: w.timely,
    reproduction: w.reproduction
      ? compact({ command: w.reproduction.command, environment: w.reproduction.environment, expected: w.reproduction.expected, actual: w.reproduction.actual, steps: opt(w.reproduction.steps) })
      : undefined,
    attachments: (w.attachments ?? []).map((a) => ({ name: a.name, uri: a.uri, mime: a.mime, size: a.size, hash: hx(a.hash) })),
    commitment: w.commitment ? compact({ hash: hx(w.commitment.hash), revealed: w.commitment.revealed, revealedAt: opt(w.commitment.revealed_at) }) : undefined,
  })
}

export function timelineFromWire(w: WireTimelineEvent): TimelineEvent {
  return compact({
    id: w.id,
    kind: w.kind,
    at: w.at,
    title: w.title,
    detail: opt(w.detail),
    actor: w.actor ? hx(w.actor) : undefined,
    txHash: w.tx_hash ? hx(w.tx_hash) : undefined,
    scheduled: opt(w.scheduled),
  })
}

export function claimDetailFromWire(w: WireClaimDetail): ClaimDetail {
  return compact({
    ...claimSummaryFromWire(w),
    manifest: w.manifest,
    manifestUri: w.manifest_uri,
    manifestHash: hx(w.manifest_hash),
    market: w.market ? marketFromWire(w.market) : undefined,
    oracle: w.oracle ? oracleFromWire(w.oracle) : undefined,
    evidence: (w.evidence ?? []).map(evidenceFromWire),
    timeline: (w.timeline ?? []).map(timelineFromWire),
    publication: w.publication
      ? compact({
          steps: w.publication.steps.map((s) =>
            compact({
              id: s.id as TxStepId,
              status: s.status as TxStepStatus,
              txHash: s.tx_hash ? hx(s.tx_hash) : undefined,
              error: opt(s.error),
              at: opt(s.at),
            }),
          ),
          resumable: w.publication.resumable,
          note: opt(w.publication.note),
        })
      : undefined,
    funding: w.funding ? { liquidity: w.funding.liquidity, spendingLimit: w.funding.spending_limit, withdrawable: w.funding.withdrawable } : undefined,
  })
}

export function pricesFromWire(w: WirePriceHistory): PricePoint[] {
  return (w.points ?? []).map(([t, yes, no, volume]) => compact({ t, yes, no, volume: opt(volume) }))
}

export function depthFromWire(w: WireDepth): DepthSnapshot {
  return {
    outcome: w.outcome,
    mid: w.mid,
    at: w.at,
    levels: [
      ...w.bids.map(([price, size]) => ({ price, size, side: 'bid' as const })),
      ...w.asks.map(([price, size]) => ({ price, size, side: 'ask' as const })),
    ],
  }
}

export function activityFromWire(w: WireActivity): ActivityItem {
  return compact({
    id: w.id,
    type: w.type,
    claimId: w.claim_id,
    claimNumber: w.claim_number,
    claimTitle: w.claim_title,
    actor: hx(w.actor),
    at: w.at,
    txHash: hx(w.tx_hash),
    chainId: w.chain_id,
    amount: opt(w.amount),
    token: opt(w.token),
    outcome: opt(w.outcome),
    side: opt(w.side),
    summary: w.summary,
    status: opt(w.status),
  })
}

export function portfolioFromWire(w: WirePortfolio): Portfolio {
  return {
    address: hx(w.address),
    positions: w.positions.map((p) =>
      compact({
        claimId: p.claim_id,
        claimNumber: p.claim_number,
        claimTitle: p.claim_title,
        status: p.status,
        outcome: p.outcome,
        balance: p.balance,
        avgPrice: opt(p.avg_price),
        markPrice: p.mark_price,
        value: p.value,
        redeemable: p.redeemable,
        redeemableAmount: opt(p.redeemable_amount),
      }),
    ),
    liquidity: w.liquidity.map((l) => ({
      claimId: l.claim_id,
      claimNumber: l.claim_number,
      claimTitle: l.claim_title,
      tokenId: l.token_id,
      pool: hx(l.pool),
      outcome: l.outcome,
      deposited: l.deposited,
      currentValue: l.current_value,
      feesEarned: l.fees_earned,
      withdrawable: l.withdrawable,
      inRange: l.in_range,
    })),
    totals: {
      positionsValue: w.totals.positions_value,
      liquidityValue: w.totals.liquidity_value,
      redeemable: w.totals.redeemable,
      depositedAllTime: w.totals.deposited_all_time,
      withdrawnAllTime: w.totals.withdrawn_all_time,
      feesPaidAllTime: w.totals.fees_paid_all_time,
    },
  }
}

export function policyFromWire(w: WirePolicy): PolicyVersion {
  return compact({
    id: w.id,
    family: w.family,
    version: w.version,
    title: w.title,
    summary: w.summary,
    status: w.status,
    gateReason: opt(w.gate_reason),
    contentHash: hx(w.content_hash),
    uri: w.uri,
    text: w.text,
    intendedUse: w.intended_use ?? [],
    examples: w.examples ?? [],
    claimClasses: w.claim_classes ?? [],
    parameters: w.parameters ?? [],
    evidenceRequirements: w.evidence_requirements ?? [],
    exclusions: w.exclusions ?? [],
    outcomeRules: w.outcome_rules,
    publishedAt: w.published_at,
    supersedes: opt(w.supersedes),
  })
}

export function statsFromWire(w: WireStats): PlatformStats {
  return {
    openClaims: w.open_claims,
    resolvedClaims: w.resolved_claims,
    totalLiquidity: w.total_liquidity,
    volume30d: w.volume_30d,
    evidenceSubmissions: w.evidence_submissions,
    counterexamplesAccepted: w.counterexamples_accepted,
    collateralSymbol: w.collateral_symbol,
  }
}

export function draftFromWire(w: WireDraft): ClaimDraft {
  return compact({
    id: w.id,
    owner: w.owner,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    stage: w.stage,
    source: opt(w.source),
    spec: w.spec ?? {},
    funding: opt(w.funding),
    publication: opt(w.publication),
  })
}

export function walletFromWire(w: WireAccount['wallets'][number]): LinkedWallet {
  return compact({ address: hx(w.address), chainId: w.chain_id, verifiedAt: w.verified_at, label: opt(w.label), primary: w.primary })
}

export function accountFromWire(w: WireAccount): Account {
  const p = w.preferences
  return {
    id: w.id,
    github: { login: w.github.login, id: w.github.id, name: w.github.name ?? null, avatarUrl: w.github.avatar_url, htmlUrl: w.github.html_url, scopes: w.github.scopes ?? [] },
    wallets: (w.wallets ?? []).map(walletFromWire),
    preferences: compact({
      defaultChainId: p.default_chain_id,
      defaultSpendingLimit: p.default_spending_limit,
      notifyOnEvidence: p.notify_on_evidence,
      notifyOnAnswer: p.notify_on_answer,
      notifyOnDeadline: p.notify_on_deadline,
      notificationEmail: opt(p.notification_email),
      displayCurrency: p.display_currency,
    }),
    createdAt: w.created_at,
    demo: w.demo,
  }
}

// ---------------------------------------------------------------------------
// Domain → wire (used for request bodies, OpenAPI examples and reference servers)
// ---------------------------------------------------------------------------

export function claimSummaryToWire(c: ClaimSummary): WireClaimSummary {
  return {
    id: c.id,
    number: c.number,
    title: c.title,
    violation: c.violation,
    policy: { ...c.policy },
    source: { owner: c.source.owner, repo: c.source.repo, commit_sha: c.source.commitSha, pr_number: nul(c.source.prNumber), pr_title: nul(c.source.prTitle) },
    status: c.status,
    outcome: nul(c.outcome),
    created_at: c.createdAt,
    evidence_deadline: c.evidenceDeadline,
    chain_id: c.chainId,
    market_address: nul(c.marketAddress),
    creator: c.creator,
    creator_github: nul(c.creatorGithub),
    yes_price: nul(c.yesPrice),
    yes_price_24h_ago: nul(c.yesPrice24hAgo),
    liquidity: c.liquidity,
    volume: c.volume,
    collateral_symbol: c.collateralSymbol,
    evidence_count: c.evidenceCount,
    traders: c.traders,
    sponsored: c.sponsored,
    tags: [...c.tags],
  }
}

export function marketToWire(m: MarketState): WireMarket {
  return {
    chain_id: m.chainId,
    address: m.address,
    seer_url: m.seerUrl,
    condition_id: m.conditionId,
    question_id: m.questionId,
    collateral: { address: m.collateral.address, symbol: m.collateral.symbol, decimals: m.collateral.decimals, name: nul(m.collateral.name) },
    outcomes: m.outcomes.map((o) => ({ index: o.index, label: o.label, token: o.token, price: o.price, change_24h: nul(o.change24h) })),
    pools: m.pools.map((p) => ({ address: p.address, dex: p.dex, outcome: p.outcome, tvl: p.tvl, fee_bps: p.feeBps })),
    liquidity: m.liquidity,
    volume_24h: m.volume24h,
    volume_total: m.volumeTotal,
    traders: m.traders,
    open_interest: m.openInterest,
    created_at: m.createdAt,
    created_tx: m.createdTx,
  }
}

export function oracleToWire(o: OracleState): WireOracle {
  const a = o.arbitration
  return {
    chain_id: o.chainId,
    reality_question_id: o.realityQuestionId,
    reality_url: o.realityUrl,
    template_id: o.templateId,
    opening_time: o.openingTime,
    timeout_seconds: o.timeoutSeconds,
    min_bond: o.minBond,
    bond_token: o.bondToken,
    current_answer: nul(o.currentAnswer),
    current_bond: nul(o.currentBond),
    finalizes_at: nul(o.finalizesAt),
    is_finalized: o.isFinalized,
    final_answer: nul(o.finalAnswer),
    history: o.history.map((h) => ({ answer: h.answer, bond: h.bond, answerer: h.answerer, at: h.at, tx_hash: h.txHash })),
    arbitration: {
      requested: a.requested,
      requested_at: nul(a.requestedAt),
      requester: nul(a.requester),
      dispute_id: nul(a.disputeId),
      court: nul(a.court),
      cost: a.cost,
      status: a.status,
      ruling: nul(a.ruling),
      appeal_deadline: nul(a.appealDeadline),
      kleros_url: nul(a.klerosUrl),
    },
  }
}

export function evidenceToWire(e: Evidence): WireEvidence {
  return {
    id: e.id,
    claim_id: e.claimId,
    kind: e.kind,
    title: e.title,
    summary: e.summary,
    submitter: e.submitter,
    submitted_at: e.submittedAt,
    block_number: e.blockNumber,
    tx_hash: e.txHash,
    chain_id: e.chainId,
    uri: e.uri,
    content_hash: e.contentHash,
    timely: e.timely,
    reproduction: e.reproduction ? { ...e.reproduction, steps: nul(e.reproduction.steps) } : null,
    attachments: e.attachments.map((a) => ({ ...a })),
    commitment: e.commitment ? { hash: e.commitment.hash, revealed: e.commitment.revealed, revealed_at: nul(e.commitment.revealedAt) } : null,
  }
}

export function timelineToWire(t: TimelineEvent): WireTimelineEvent {
  return { id: t.id, kind: t.kind, at: t.at, title: t.title, detail: nul(t.detail), actor: nul(t.actor), tx_hash: nul(t.txHash), scheduled: nul(t.scheduled) }
}

export function claimDetailToWire(c: ClaimDetail): WireClaimDetail {
  return {
    ...claimSummaryToWire(c),
    manifest: c.manifest,
    manifest_uri: c.manifestUri,
    manifest_hash: c.manifestHash,
    market: c.market ? marketToWire(c.market) : null,
    oracle: c.oracle ? oracleToWire(c.oracle) : null,
    evidence: c.evidence.map(evidenceToWire),
    timeline: c.timeline.map(timelineToWire),
    publication: c.publication
      ? {
          steps: c.publication.steps.map((s) => ({ id: s.id, status: s.status, tx_hash: nul(s.txHash), error: nul(s.error), at: nul(s.at) })),
          resumable: c.publication.resumable,
          note: nul(c.publication.note),
        }
      : null,
    funding: c.funding ? { liquidity: c.funding.liquidity, spending_limit: c.funding.spendingLimit, withdrawable: c.funding.withdrawable } : null,
  }
}

export function pricesToWire(claimId: string, range: string, points: PricePoint[]): WirePriceHistory {
  return { claim_id: claimId, range, points: points.map((p) => [p.t, p.yes, p.no, p.volume ?? null]) }
}

export function depthToWire(claimId: string, d: DepthSnapshot): WireDepth {
  return {
    claim_id: claimId,
    outcome: d.outcome,
    mid: d.mid,
    at: d.at,
    bids: d.levels.filter((l) => l.side === 'bid').map((l) => [l.price, l.size]),
    asks: d.levels.filter((l) => l.side === 'ask').map((l) => [l.price, l.size]),
  }
}

export function activityToWire(a: ActivityItem): WireActivity {
  return {
    id: a.id,
    type: a.type,
    claim_id: a.claimId,
    claim_number: a.claimNumber,
    claim_title: a.claimTitle,
    actor: a.actor,
    at: a.at,
    tx_hash: a.txHash,
    chain_id: a.chainId,
    amount: nul(a.amount),
    token: nul(a.token),
    outcome: nul(a.outcome),
    side: nul(a.side),
    summary: a.summary,
    status: nul(a.status),
  }
}

export function portfolioToWire(p: Portfolio): WirePortfolio {
  return {
    address: p.address,
    positions: p.positions.map((x) => ({
      claim_id: x.claimId,
      claim_number: x.claimNumber,
      claim_title: x.claimTitle,
      status: x.status,
      outcome: x.outcome,
      balance: x.balance,
      avg_price: nul(x.avgPrice),
      mark_price: x.markPrice,
      value: x.value,
      redeemable: x.redeemable,
      redeemable_amount: nul(x.redeemableAmount),
    })),
    liquidity: p.liquidity.map((l) => ({
      claim_id: l.claimId,
      claim_number: l.claimNumber,
      claim_title: l.claimTitle,
      token_id: l.tokenId,
      pool: l.pool,
      outcome: l.outcome,
      deposited: l.deposited,
      current_value: l.currentValue,
      fees_earned: l.feesEarned,
      withdrawable: l.withdrawable,
      in_range: l.inRange,
    })),
    totals: {
      positions_value: p.totals.positionsValue,
      liquidity_value: p.totals.liquidityValue,
      redeemable: p.totals.redeemable,
      deposited_all_time: p.totals.depositedAllTime,
      withdrawn_all_time: p.totals.withdrawnAllTime,
      fees_paid_all_time: p.totals.feesPaidAllTime,
    },
  }
}

export function policyToWire(p: PolicyVersion): WirePolicy {
  return {
    id: p.id,
    family: p.family,
    version: p.version,
    title: p.title,
    summary: p.summary,
    status: p.status,
    gate_reason: nul(p.gateReason),
    content_hash: p.contentHash,
    uri: p.uri,
    text: p.text,
    intended_use: p.intendedUse,
    examples: p.examples,
    claim_classes: p.claimClasses,
    parameters: p.parameters,
    evidence_requirements: p.evidenceRequirements,
    exclusions: p.exclusions,
    outcome_rules: p.outcomeRules,
    published_at: p.publishedAt,
    supersedes: nul(p.supersedes),
  }
}

export function statsToWire(s: PlatformStats): WireStats {
  return {
    open_claims: s.openClaims,
    resolved_claims: s.resolvedClaims,
    total_liquidity: s.totalLiquidity,
    volume_30d: s.volume30d,
    evidence_submissions: s.evidenceSubmissions,
    counterexamples_accepted: s.counterexamplesAccepted,
    collateral_symbol: s.collateralSymbol,
  }
}

export function draftToWire(d: ClaimDraft): WireDraft {
  return {
    id: d.id,
    owner: d.owner,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    stage: d.stage,
    source: nul(d.source),
    spec: d.spec,
    funding: nul(d.funding),
    publication: nul(d.publication),
  }
}

export function walletToWire(w: LinkedWallet): WireAccount['wallets'][number] {
  return { address: w.address, chain_id: w.chainId, verified_at: w.verifiedAt, label: nul(w.label), primary: w.primary }
}

export function accountToWire(a: Account): WireAccount {
  const p = a.preferences
  return {
    id: a.id,
    github: { login: a.github.login, id: a.github.id, name: a.github.name ?? null, avatar_url: a.github.avatarUrl, html_url: a.github.htmlUrl, scopes: a.github.scopes },
    wallets: a.wallets.map(walletToWire),
    preferences: {
      default_chain_id: p.defaultChainId,
      default_spending_limit: p.defaultSpendingLimit,
      notify_on_evidence: p.notifyOnEvidence,
      notify_on_answer: p.notifyOnAnswer,
      notify_on_deadline: p.notifyOnDeadline,
      notification_email: nul(p.notificationEmail),
      display_currency: p.displayCurrency,
    },
    created_at: a.createdAt,
    demo: a.demo,
  }
}

/** Domain preference patch → wire patch (only provided keys). */
export function preferencesPatchToWire(p: Partial<Account['preferences']>): Partial<WireAccount['preferences']> {
  const out: Partial<WireAccount['preferences']> = {}
  if (p.defaultChainId !== undefined) out.default_chain_id = p.defaultChainId
  if (p.defaultSpendingLimit !== undefined) out.default_spending_limit = p.defaultSpendingLimit
  if (p.notifyOnEvidence !== undefined) out.notify_on_evidence = p.notifyOnEvidence
  if (p.notifyOnAnswer !== undefined) out.notify_on_answer = p.notifyOnAnswer
  if (p.notifyOnDeadline !== undefined) out.notify_on_deadline = p.notifyOnDeadline
  if ('notificationEmail' in p) out.notification_email = p.notificationEmail ?? null
  if (p.displayCurrency !== undefined) out.display_currency = p.displayCurrency
  return out
}
