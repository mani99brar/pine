/**
 * Envio entity → domain mappers. Time-dependent lifecycle status is derived here from indexed facts
 * (phase, deadline, finalizeTs) because an event-driven indexer cannot flip `open → awaiting_answer`
 * when a deadline passes.
 */
import {
  getChainOrDefault,
  klerosCaseUrl,
  normalizeDecimal,
  realityQuestionUrl,
  seerMarketUrl,
  type ActivityItem,
  type ActivityType,
  type ArbitrationState,
  type ClaimDetail,
  type ClaimManifest,
  type ClaimStatus,
  type ClaimSummary,
  type DepthLevel,
  type DepthSnapshot,
  type Evidence,
  type EvidenceAttachment,
  type EvidenceKind,
  type Hex,
  type MarketState,
  type OracleState,
  type Outcome,
  type PolicyFamilyId,
  type PricePoint,
  type RealityAnswer,
  type TimelineEvent,
} from '@pine/core'

// ---------------------------------------------------------------------------
// Envio response shapes (subset of docs/indexer/envio/schema.graphql)
// ---------------------------------------------------------------------------

type Num = string | number
export type EnvioPhase = 'open' | 'answered' | 'disputed' | 'arbitration' | 'finalized'

export interface EnvioClaimSummary {
  id: string
  chainId: number
  claimId: string
  number: number
  title: string
  violation: string
  policyId: string
  policyVersion: string
  policyFamily: string
  policyTitle: string
  repoOwner: string
  repoName: string
  commitSha: string
  prNumber?: number | null
  prTitle?: string | null
  evidenceDeadlineTs: Num
  creator: string
  sponsored: boolean
  phase: EnvioPhase
  currentAnswer?: string | null
  finalizeTs?: Num | null
  outcome?: Outcome | null
  yesPrice?: number | null
  noPrice?: number | null
  invalidPrice?: number | null
  yesPrice24hAgo?: number | null
  liquidity: Num
  volume: Num
  volume24h: Num
  openInterest: Num
  traders: number
  evidenceCount: number
  createdAt: Num
  lastActivityAt: Num
  createdTx: string
  manifestUri: string
  manifestHash: string
  market?: { address: string; collateralSymbol: string } | null
}

export interface EnvioEvidence {
  id: string
  questionId: string
  chainId: number
  party: string
  uri: string
  blockNumber: Num
  timestamp: Num
  txHash: string
  timely?: boolean | null
  hydrated: boolean
  kind: EvidenceKind | 'unknown'
  title?: string | null
  summary?: string | null
  contentHash?: string | null
  reproduction?: unknown
  attachments?: unknown
  commitment?: unknown
}

export interface EnvioClaimDetail extends EnvioClaimSummary {
  manifestValid: boolean
  manifest?: ClaimManifest | null
  market?:
    | (EnvioClaimSummary['market'] & {
        id: string
        chainId: number
        collateralToken: string
        conditionId: string
        questionId: string
        realityQuestionId: string
        templateId: number
        openingTs: Num
        payoutReported: boolean
        payoutNumerators: Num[]
        blockTimestamp: Num
        txHash: string
        outcomes: { index: number; label: string; token: string; price?: number | null; change24h?: number | null }[]
        pools: { address: string; dex: string; outcomeIndex: number; feeBps: number; tvlCollateral: Num }[]
      })
    | null
  question?: {
    questionId: string
    templateId: number
    openingTs: Num
    timeout: Num
    minBond: Num
    finalizeTs: Num
    isPendingArbitration: boolean
    bestAnswer?: string | null
    bond: Num
    finalizedByArbitrator: boolean
    answers: { answer: string; bond: Num; user: string; timestamp: Num; txHash: string }[]
    arbitration?: {
      requester: string
      requestedAt: Num
      disputeId?: Num | null
      court: string
      cost: Num
      status: 'requested' | 'created' | 'ruled' | 'failed'
      ruling?: string | null
      rulingAt?: Num | null
      appealPeriodEnd?: Num | null
    } | null
  } | null
  evidence: EnvioEvidence[]
  activity?: { id: string; type: string; actor: string; timestamp: Num; txHash: string; summary: string; amount?: Num | null; token?: string | null }[]
}

export interface EnvioActivity {
  id: string
  type: ActivityType
  claimNumber: number
  claimTitle: string
  actor: string
  timestamp: Num
  txHash: string
  chainId: number
  amount?: Num | null
  token?: string | null
  outcome?: string | null
  side?: 'buy' | 'sell' | null
  summary: string
  claim?: { claimId: string } | null
}

export interface EnvioPool {
  address: string
  sqrtPriceX96: Num
  liquidity: Num
  outcomeIsToken0: boolean
  price?: number | null
  tvlCollateral: Num
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hx = (s: string) => s.toLowerCase() as Hex

export function dec(v: Num | null | undefined): string {
  if (v === null || v === undefined || v === '') return '0'
  return normalizeDecimal(typeof v === 'number' ? v : String(v), 18) ?? '0'
}

export function secToIso(v: Num | null | undefined): string {
  const n = Number(v ?? 0)
  return new Date(n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v
  return out as T
}

function asAnswer(a: string | null | undefined): RealityAnswer | undefined {
  return a === 'yes' || a === 'no' || a === 'invalid' || a === 'too_soon' ? a : undefined
}

function asOutcome(a: string | null | undefined): Outcome | undefined {
  return a === 'yes' || a === 'no' || a === 'invalid' ? a : undefined
}

function asFamily(f: string): PolicyFamilyId {
  return f === 'BOT' || f === 'SC' ? f : 'FUNC'
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Lifecycle status from indexed facts at `nowSec` (same semantics as @pine/core deriveStatus). */
export function deriveEnvioStatus(
  c: Pick<EnvioClaimSummary, 'phase' | 'evidenceDeadlineTs' | 'finalizeTs' | 'currentAnswer' | 'outcome'>,
  nowSec: number,
): { status: ClaimStatus; outcome?: Outcome } {
  const finalizeTs = Number(c.finalizeTs ?? 0)
  switch (c.phase) {
    case 'finalized': {
      const o = asOutcome(c.outcome) ?? asOutcome(c.currentAnswer)
      return o ? { status: 'resolved', outcome: o } : { status: 'awaiting_answer' }
    }
    case 'arbitration':
      return { status: 'arbitration' }
    case 'answered':
    case 'disputed': {
      if (finalizeTs > 0 && finalizeTs <= nowSec) {
        const o = asOutcome(c.currentAnswer)
        // "answered too soon" must be reopened before resolution
        return o ? { status: 'resolved', outcome: o } : { status: 'awaiting_answer' }
      }
      return { status: c.phase === 'answered' ? 'answer_proposed' : 'disputed' }
    }
    case 'open':
    default:
      return { status: Number(c.evidenceDeadlineTs) > nowSec ? 'open' : 'awaiting_answer' }
  }
}

type Where = Record<string, unknown>

/** Hasura `where` fragment selecting claims in `status` at `nowSec`. Statuses that never exist on-chain match nothing. */
export function statusWhere(status: ClaimStatus, nowSec: number): Where | null {
  const now = String(nowSec)
  switch (status) {
    case 'open':
      return { phase: { _eq: 'open' }, evidenceDeadlineTs: { _gt: now } }
    case 'awaiting_answer':
      return {
        _or: [
          { phase: { _eq: 'open' }, evidenceDeadlineTs: { _lte: now } },
          // answered too soon (must be reopened) or finalized without a usable answer
          { phase: { _in: ['answered', 'disputed'] }, finalizeTs: { _lte: now }, _or: [{ currentAnswer: { _eq: 'too_soon' } }, { currentAnswer: { _is_null: true } }] },
          { phase: { _eq: 'finalized' }, outcome: { _is_null: true }, _or: [{ currentAnswer: { _is_null: true } }, { currentAnswer: { _nin: ['yes', 'no', 'invalid'] } }] },
        ],
      }
    case 'answer_proposed':
      return { phase: { _eq: 'answered' }, finalizeTs: { _gt: now } }
    case 'disputed':
      return { phase: { _eq: 'disputed' }, finalizeTs: { _gt: now } }
    case 'arbitration':
      return { phase: { _eq: 'arbitration' } }
    case 'resolved':
      return {
        _or: [
          { phase: { _eq: 'finalized' }, outcome: { _is_null: false } },
          { phase: { _eq: 'finalized' }, currentAnswer: { _in: ['yes', 'no', 'invalid'] } },
          { phase: { _in: ['answered', 'disputed'] }, finalizeTs: { _lte: now }, currentAnswer: { _in: ['yes', 'no', 'invalid'] } },
        ],
      }
    // draft/publishing/failed exist only off-chain; settled is viewer-specific
    default:
      return null
  }
}

/** Hasura `where` for an outcome (explicit outcome, or a timed-out answer). */
export function outcomeWhere(outcome: Outcome, nowSec: number): Where {
  return {
    _or: [
      { outcome: { _eq: outcome } },
      { phase: { _eq: 'finalized' }, outcome: { _is_null: true }, currentAnswer: { _eq: outcome } },
      { phase: { _in: ['answered', 'disputed'] }, finalizeTs: { _lte: String(nowSec) }, currentAnswer: { _eq: outcome } },
    ],
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export function claimSummaryFromEnvio(c: EnvioClaimSummary, nowSec: number): ClaimSummary {
  const { status, outcome } = deriveEnvioStatus(c, nowSec)
  return compact({
    id: c.claimId,
    number: c.number,
    title: c.title,
    violation: c.violation,
    policy: { id: c.policyId, version: c.policyVersion, family: asFamily(c.policyFamily), title: c.policyTitle },
    source: compact({ owner: c.repoOwner, repo: c.repoName, commitSha: c.commitSha, prNumber: c.prNumber ?? undefined, prTitle: c.prTitle ?? undefined }),
    status,
    outcome,
    createdAt: secToIso(c.createdAt),
    evidenceDeadline: secToIso(c.evidenceDeadlineTs),
    chainId: c.chainId,
    marketAddress: c.market?.address ? hx(c.market.address) : hx(c.id.split(':')[1] ?? ''),
    creator: hx(c.creator),
    creatorGithub: undefined,
    yesPrice: c.yesPrice ?? undefined,
    yesPrice24hAgo: c.yesPrice24hAgo ?? undefined,
    liquidity: dec(c.liquidity),
    volume: dec(c.volume),
    collateralSymbol: c.market?.collateralSymbol ?? getChainOrDefault(c.chainId).collateral.symbol,
    evidenceCount: c.evidenceCount,
    traders: c.traders,
    sponsored: c.sponsored,
    tags: [c.policyFamily.toLowerCase()],
  }) as ClaimSummary
}

export function marketFromEnvio(c: EnvioClaimDetail): MarketState | undefined {
  const m = c.market
  if (!m || !('outcomes' in m)) return undefined
  const yesNo = (i: number): 'yes' | 'no' | undefined => (i === 0 ? 'yes' : i === 1 ? 'no' : undefined)
  return {
    chainId: m.chainId,
    address: hx(m.address),
    seerUrl: seerMarketUrl(m.chainId, hx(m.address)),
    conditionId: hx(m.conditionId),
    questionId: hx(m.questionId),
    collateral: { address: hx(m.collateralToken), symbol: m.collateralSymbol, decimals: 18 },
    outcomes: m.outcomes.map((o) =>
      compact({
        index: o.index,
        label: o.index === 2 && /invalid/i.test(o.label) ? 'Invalid result' : o.label,
        token: hx(o.token),
        price: o.price ?? (o.index === 0 ? c.yesPrice : o.index === 1 ? c.noPrice : c.invalidPrice) ?? 0,
        change24h: o.change24h ?? undefined,
      }),
    ),
    pools: m.pools
      .filter((p) => yesNo(p.outcomeIndex))
      .map((p) => ({ address: hx(p.address), dex: p.dex, outcome: yesNo(p.outcomeIndex) as 'yes' | 'no', tvl: dec(p.tvlCollateral), feeBps: p.feeBps })),
    liquidity: dec(c.liquidity),
    volume24h: dec(c.volume24h),
    volumeTotal: dec(c.volume),
    traders: c.traders,
    openInterest: dec(c.openInterest),
    createdAt: secToIso(m.blockTimestamp),
    createdTx: hx(m.txHash),
  }
}

export function oracleFromEnvio(c: EnvioClaimDetail, nowSec: number): OracleState | undefined {
  const q = c.question
  if (!q) return undefined
  const chain = getChainOrDefault(c.chainId)
  const finalizeTs = Number(q.finalizeTs ?? 0)
  const answers = q.answers ?? []
  const best = asAnswer(c.currentAnswer) ?? asAnswer(q.bestAnswer ?? undefined)
  const isFinalized = c.phase === 'finalized' || (!q.isPendingArbitration && finalizeTs > 0 && finalizeTs <= nowSec)
  const a = q.arbitration
  let arbitration: ArbitrationState = { requested: false, cost: chain.arbitration.feeEstimate, status: 'not_requested' }
  if (a && a.status !== 'failed') {
    const appealEnd = a.appealPeriodEnd ? Number(a.appealPeriodEnd) : undefined
    arbitration = compact({
      requested: true,
      requestedAt: secToIso(a.requestedAt),
      requester: hx(a.requester),
      disputeId: a.disputeId !== undefined && a.disputeId !== null ? String(a.disputeId) : undefined,
      court: a.court,
      cost: dec(a.cost),
      status: a.status === 'ruled' ? (appealEnd && appealEnd > nowSec ? 'appeal_period' : 'ruled') : 'pending',
      ruling: asAnswer(a.ruling ?? undefined),
      appealDeadline: appealEnd ? secToIso(appealEnd) : undefined,
      klerosUrl: a.disputeId !== undefined && a.disputeId !== null ? klerosCaseUrl(String(a.disputeId), chain.arbitration.chainId) : undefined,
    }) as ArbitrationState
  } else if (a) {
    arbitration = { requested: false, cost: dec(a.cost), status: 'not_requested' }
  }
  const finalAnswer = isFinalized ? (asAnswer(c.outcome ?? undefined) ?? best) : undefined
  return compact({
    chainId: c.chainId,
    realityQuestionId: hx(q.questionId),
    realityUrl: realityQuestionUrl(c.chainId, hx(q.questionId)),
    templateId: q.templateId,
    openingTime: secToIso(q.openingTs),
    timeoutSeconds: Number(q.timeout),
    minBond: dec(q.minBond),
    bondToken: chain.nativeSymbol,
    currentAnswer: best,
    currentBond: answers.length > 0 ? dec(q.bond) : undefined,
    finalizesAt: finalizeTs > 0 && !q.isPendingArbitration ? secToIso(finalizeTs) : undefined,
    isFinalized,
    finalAnswer,
    history: answers
      .map((x) => ({ answer: asAnswer(x.answer), bond: dec(x.bond), answerer: hx(x.user), at: secToIso(x.timestamp), txHash: hx(x.txHash) }))
      .filter((x): x is OracleState['history'][number] => !!x.answer),
    arbitration,
  }) as OracleState
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Placeholder for hashes the indexer could not compute; never presented as verified integrity data. */
export const UNVERIFIED_HASH = `0x${'0'.repeat(64)}` as Hex

export function evidenceFromEnvio(e: EnvioEvidence, claimId: string, deadlineSec?: number): Evidence {
  const repro = e.reproduction && typeof e.reproduction === 'object' ? (e.reproduction as Record<string, unknown>) : undefined
  const attachments: EvidenceAttachment[] = Array.isArray(e.attachments)
    ? (e.attachments as Record<string, unknown>[])
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
          name: str(a.name) ?? 'attachment',
          uri: str(a.uri) ?? '',
          mime: str(a.mime) ?? 'application/octet-stream',
          size: typeof a.size === 'number' ? a.size : 0,
          hash: /^0x[0-9a-fA-F]{64}$/.test(str(a.hash) ?? '') ? hx(str(a.hash) as string) : UNVERIFIED_HASH,
        }))
    : []
  const commitment = e.commitment && typeof e.commitment === 'object' ? (e.commitment as Record<string, unknown>) : undefined
  const ts = Number(e.timestamp)
  // An unread or unparseable package is never presented as a counterexample.
  const readable = e.hydrated && e.kind !== 'unknown'
  const kind: EvidenceKind = readable ? (e.kind as EvidenceKind) : 'clarification'
  return compact({
    id: e.id,
    claimId,
    kind,
    title: readable ? (e.title ?? 'Untitled evidence') : e.hydrated ? 'Unreadable evidence package' : 'Evidence package not yet read by the indexer',
    summary: readable
      ? (e.summary ?? '')
      : `The indexer could not read this submission's package, so its kind and content are unknown. Inspect ${e.uri} directly and treat it as untrusted content.`,
    submitter: hx(e.party),
    submittedAt: secToIso(ts),
    blockNumber: Number(e.blockNumber),
    txHash: hx(e.txHash),
    chainId: e.chainId,
    uri: e.uri,
    contentHash: /^0x[0-9a-fA-F]{64}$/.test(e.contentHash ?? '') ? hx(e.contentHash as string) : UNVERIFIED_HASH,
    timely: e.timely ?? (deadlineSec !== undefined ? ts <= deadlineSec : true),
    reproduction:
      readable && repro && str(repro.command)
        ? compact({
            command: str(repro.command) ?? '',
            environment: str(repro.environment) ?? '',
            expected: str(repro.expected) ?? '',
            actual: str(repro.actual) ?? '',
            steps: Array.isArray(repro.steps) ? repro.steps.filter((s): s is string => typeof s === 'string') : undefined,
          })
        : undefined,
    attachments: readable ? attachments : [],
    commitment:
      commitment && str(commitment.hash)
        ? compact({ hash: hx(str(commitment.hash) ?? ''), revealed: commitment.revealed === true, revealedAt: str(commitment.revealedAt) })
        : undefined,
  }) as Evidence
}

function answerLabel(a: RealityAnswer): string {
  return a === 'yes' ? 'Yes' : a === 'no' ? 'No' : a === 'invalid' ? 'Invalid' : 'Answered too soon'
}

/** Timeline from indexed events plus scheduled deadline / opening / finalization. */
export function timelineFromEnvio(c: EnvioClaimDetail, detail: Pick<ClaimDetail, 'evidence' | 'oracle' | 'market'>, nowSec: number): TimelineEvent[] {
  const t: Omit<TimelineEvent, 'id'>[] = []
  const deadline = Number(c.evidenceDeadlineTs)
  if (detail.market) {
    t.push({ kind: 'market_created', at: detail.market.createdAt, title: 'Seer market created — terms frozen', actor: hx(c.creator), txHash: detail.market.createdTx })
  }
  for (const a of c.activity ?? []) {
    if (a.type === 'liquidity_added' || a.type === 'liquidity_removed' || a.type === 'redeemed') {
      t.push({ kind: a.type, at: secToIso(a.timestamp), title: a.summary, actor: hx(a.actor), txHash: hx(a.txHash) })
    }
  }
  for (const e of detail.evidence) {
    const label = e.contentHash === UNVERIFIED_HASH ? 'Evidence' : `${e.kind[0]?.toUpperCase()}${e.kind.slice(1)}`
    t.push({ kind: 'evidence_submitted', at: e.submittedAt, title: `${label} submitted${e.timely ? '' : ' after the deadline (not timely)'}`, detail: e.title, actor: e.submitter, txHash: e.txHash })
  }
  t.push({ kind: 'evidence_deadline', at: secToIso(deadline), title: 'Evidence deadline', detail: 'This is not a trading cutoff; outcome tokens stay transferable.', scheduled: deadline > nowSec })
  const o = detail.oracle
  if (o) {
    t.push({ kind: 'oracle_opened', at: o.openingTime, title: 'Reality.eth question opens for answers', scheduled: Date.parse(o.openingTime) / 1000 > nowSec })
    o.history.forEach((h, i) =>
      t.push({ kind: i === 0 ? 'answer_posted' : 'answer_challenged', at: h.at, title: `${i === 0 ? 'Answer posted' : 'Answer challenged'}: ${answerLabel(h.answer)}`, detail: `Bond ${h.bond} ${o.bondToken}.`, actor: h.answerer, txHash: h.txHash }),
    )
    if (o.arbitration.requested && o.arbitration.requestedAt) {
      t.push({ kind: 'arbitration_requested', at: o.arbitration.requestedAt, title: 'Arbitration requested (Kleros)', detail: o.arbitration.disputeId ? `Kleros dispute #${o.arbitration.disputeId}, fee ${o.arbitration.cost} ETH.` : undefined, actor: o.arbitration.requester })
    }
    const ruled = c.question?.arbitration?.rulingAt
    if (ruled && o.arbitration.ruling) {
      t.push({ kind: 'ruling', at: secToIso(ruled), title: `Jurors voted: ${answerLabel(o.arbitration.ruling)}${o.arbitration.status === 'appeal_period' ? ' (appealable)' : ''}` })
    }
    if (o.isFinalized) {
      const fin = (c.activity ?? []).find((a) => a.type === 'finalized')
      t.push({ kind: 'finalized', at: fin ? secToIso(fin.timestamp) : o.finalizesAt ?? secToIso(nowSec), title: `Finalized: ${answerLabel(o.finalAnswer ?? 'invalid')}` })
    } else if (o.finalizesAt) {
      t.push({ kind: 'finalized', at: o.finalizesAt, title: `Expected finalization if unchallenged: ${answerLabel(o.currentAnswer ?? 'invalid')}`, scheduled: true })
    }
  }
  return t
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((e, i) => compact({ ...e, id: `${c.claimId}-tl-${i + 1}` }) as TimelineEvent)
}

export function claimDetailFromEnvio(c: EnvioClaimDetail, manifest: ClaimManifest, nowSec: number): ClaimDetail {
  const summary = claimSummaryFromEnvio(c, nowSec)
  const deadline = Number(c.evidenceDeadlineTs)
  const market = marketFromEnvio(c)
  const oracle = oracleFromEnvio(c, nowSec)
  const evidence = (c.evidence ?? []).map((e) => evidenceFromEnvio(e, c.claimId, deadline))
  const detail: ClaimDetail = {
    ...summary,
    tags: [c.policyFamily.toLowerCase(), ...(manifest.claim.claimClass ? [manifest.claim.claimClass] : [])],
    manifest,
    manifestUri: c.manifestUri,
    manifestHash: hx(c.manifestHash),
    evidence,
    evidenceCount: Math.max(c.evidenceCount, evidence.length),
    timeline: [],
  }
  if (market) detail.market = market
  if (oracle) detail.oracle = oracle
  detail.timeline = timelineFromEnvio(c, detail, nowSec)
  return detail
}

// ---------------------------------------------------------------------------
// Prices, depth, activity
// ---------------------------------------------------------------------------

export function pricePointsFromEnvio(rows: { periodStart: Num; yesClose: number; noClose: number; volume?: Num | null }[]): PricePoint[] {
  return rows.map((r) => compact({ t: Number(r.periodStart) * 1000, yes: r.yesClose, no: r.noClose, volume: r.volume !== undefined && r.volume !== null ? Number(r.volume) : undefined }) as PricePoint)
}

/**
 * Approximate depth from a concentrated-liquidity pool's active liquidity, assuming L stays constant
 * across the levels shown (true inside the active tick range). Outcome tokens available between the
 * current outcome price p and a level p' are L·|1/√p − 1/√p'| for either token order (both tokens use
 * 18 decimals). Use quotes (Seer Lens) for executable sizes.
 */
export function depthFromPool(pool: EnvioPool, outcome: 'yes' | 'no', nowSec: number, levels = 10): DepthSnapshot | null {
  const L = Number(pool.liquidity) / 1e18
  const sqrtRaw = Number(pool.sqrtPriceX96) / 2 ** 96
  const poolPrice = sqrtRaw * sqrtRaw // token1 per token0
  const mid = pool.price ?? (pool.outcomeIsToken0 ? poolPrice : poolPrice > 0 ? 1 / poolPrice : 0)
  if (!(L > 0) || !(mid > 0 && mid < 1)) return null
  const step = Math.max(0.004, Math.min(0.02, mid * 0.06))
  // Outcome tokens between outcome prices a and b. With outcome = token0, pool price P = p and x = L/√P;
  // with outcome = token1, P = 1/p and y = L·√P = L/√p. Both give L·(1/√lo − 1/√hi).
  const tokensBetween = (a: number, b: number) => L * (1 / Math.sqrt(Math.min(a, b)) - 1 / Math.sqrt(Math.max(a, b)))
  const out: DepthLevel[] = []
  for (let k = 1; k <= levels; k++) {
    const bid = mid - k * step
    const ask = mid + k * step
    if (bid > 0.001) out.push({ price: Math.round(bid * 1e4) / 1e4, size: Math.round(tokensBetween(bid, mid) * 100) / 100, side: 'bid' })
    if (ask < 0.999) out.push({ price: Math.round(ask * 1e4) / 1e4, size: Math.round(tokensBetween(mid, ask) * 100) / 100, side: 'ask' })
  }
  return {
    outcome,
    mid: Math.round(mid * 1e4) / 1e4,
    levels: [...out.filter((l) => l.side === 'bid'), ...out.filter((l) => l.side === 'ask')],
    at: secToIso(nowSec),
  }
}

export function activityFromEnvio(a: EnvioActivity): ActivityItem {
  const outcome = a.outcome === 'yes' || a.outcome === 'no' || a.outcome === 'invalid' ? a.outcome : undefined
  return compact({
    id: a.id,
    type: a.type,
    claimId: a.claim?.claimId ?? '',
    claimNumber: a.claimNumber,
    claimTitle: a.claimTitle,
    actor: hx(a.actor),
    at: secToIso(a.timestamp),
    txHash: hx(a.txHash),
    chainId: a.chainId,
    amount: a.amount !== undefined && a.amount !== null ? dec(a.amount) : undefined,
    token: a.token ?? undefined,
    outcome,
    side: a.side ?? undefined,
    summary: a.summary,
    status: 'confirmed' as const,
  }) as ActivityItem
}
