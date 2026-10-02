/**
 * Turns compact claim seeds into fully consistent ClaimDetail records, price histories and activity.
 * Everything is deterministic for a given anchor hour (see ANCHOR_MS).
 */
import type {
  ActivityItem,
  Address,
  ArbitrationState,
  ClaimDetail,
  ClaimSpec,
  ClaimStatus,
  EnvironmentPin,
  Evidence,
  EvidenceKind,
  EvidenceMechanismId,
  Hex,
  MarketState,
  OracleAnswerEntry,
  OracleState,
  Outcome,
  PricePoint,
  PublicationStep,
  RealityAnswer,
  SourceRef,
  TimelineEvent,
  TxStepId,
  TxStepStatus,
} from '@pine/core'
import { buildManifest, computeConfigHash, computeEnvHash, defaultOracleParams, getPolicy, hashJson } from '@pine/core'
import {
  ANCHOR_MS,
  fakeAddress,
  fakeCid,
  fakeHash,
  fromUnits,
  hoursFromNow,
  mulberry32,
  mulDecimal,
  round,
  toUnits,
} from '../../internal/util'
import { actors, contracts, githubByWallet, traderPool } from './actors'
import { commitsBySha, findPull, findRepo } from './github'

const HOUR = 3_600_000
export const FIXTURE_CHAIN_ID = 100
/** Kleros v1 General Court (31 jurors) fee for Gnosis markets, in ETH, read on 2026-10-03 */
export const ARBITRATION_COST = '0.1674'
/** Seer's official factory fixes the Reality timeout at 3.5 days */
export const REALITY_TIMEOUT_SECONDS = 302_400
/** Evidence (ERC-1497) and arbitration requests happen on Ethereum for Gnosis markets */
export const EVIDENCE_CHAIN_ID = 1

// ---------------------------------------------------------------------------
// Seed types
// ---------------------------------------------------------------------------

export interface EvidenceSeed {
  kind: EvidenceKind
  title: string
  summary: string
  by: Address
  h: number
  reproduction?: Evidence['reproduction']
  attachments?: { name: string; mime: string; size: number }[]
  commitment?: { revealed: boolean; revealedH?: number; hash?: Hex }
  /** effect on the YES price path, in logit units */
  jump?: number
}

export interface AnswerSeed {
  answer: RealityAnswer
  bond: string
  by: Address
  h: number
}

export interface TradeSeed {
  h: number
  by: Address
  outcome: 'yes' | 'no'
  side: 'buy' | 'sell'
  /** collateral amount */
  amount: string
}

export interface ClaimSeed {
  number: number
  repo: string
  pr: number
  withBase?: boolean
  creator: Address
  policyId: 'FUNC-001' | 'BOT-001'
  claimClass?: string
  title: string
  requirement: string
  violation: string
  scope: { inScope: string[]; outOfScope: string[] }
  parameters: Record<string, string | string[] | boolean>
  faultModel?: string
  allowedInputs?: string
  assumptions: string[]
  exclusions: string[]
  env: {
    runtime: string
    packageManager?: string
    lockPath?: string
    config: Record<string, string>
    containerImage?: string
    externalState?: string
    reproductionCommand: string
    setupSteps: string[]
    notes?: string
  }
  regressionOnly?: boolean
  mechanism?: EvidenceMechanismId
  specReference?: { label: string; url: string }
  createdH: number
  deadlineH: number
  openingH?: number
  timeoutSeconds?: number
  minBond: string
  status: ClaimStatus
  outcome?: Outcome
  market:
    | null
    | {
        /** initial YES price set by the creator */
        initial: number
        /** current YES price (or final, when resolved) */
        yes: number
        /** YES price just before resolution (resolved claims) */
        preResolution?: number
        invalid?: number
        liquidity: string
        volume: string
        volume24h: string
        traders: number
        trades?: number
        feeBps?: number
      }
  answers?: AnswerSeed[]
  arbitration?: Partial<ArbitrationState> & { requestedH?: number; appealDeadlineH?: number; rulingH?: number }
  finalizedH?: number
  resolutionNote?: string
  evidence: EvidenceSeed[]
  publication?: {
    steps: { id: TxStepId; status: TxStepStatus; h?: number; error?: string }[]
    resumable: boolean
    note: string
  }
  funding: { liquidity: string; spendingLimit: string; withdrawable?: boolean }
  /** creator withdrew liquidity at this time */
  withdrawnH?: number
  /** collateral received from that withdrawal */
  withdrawnAmount?: string
  /** creator redeemed outcome tokens at this time */
  redeemedH?: number
  /** collateral received by that redemption */
  redeemedAmount?: string
  demoTrades?: TradeSeed[]
  sponsored?: boolean
  tags: string[]
}

export interface BuiltClaim {
  detail: ClaimDetail
  prices: PricePoint[]
  activity: ActivityItem[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove keys whose value is undefined (keeps JSON and canonical hashes clean). */
export function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as T
}

export function claimIdOf(n: number): string {
  return `pine-${String(n).padStart(4, '0')}`
}

/** Gnosis produces a block every ~5 s; anchor block is arbitrary but stable. */
export function blockAt(h: number): number {
  return 42_610_000 + Math.round(h * 720)
}

/** Ethereum produces a block every 12 s; anchor block is arbitrary but stable. */
export function ethBlockAt(h: number): number {
  return 26_118_000 + Math.round(h * 300)
}

const logit = (p: number) => Math.log(p / (1 - p))
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-9)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function realityUrl(questionId: Hex): string {
  return `https://reality.eth.limo/app/#!/network/${FIXTURE_CHAIN_ID}/question/${contracts.reality.toLowerCase()}-${questionId}`
}

// ---------------------------------------------------------------------------
// Price path
// ---------------------------------------------------------------------------

function buildPricePath(seed: ClaimSeed, marketCreatedMs: number, evidenceJumps: { t: number; d: number }[]): PricePoint[] {
  const m = seed.market
  if (!m || toUnits(m.liquidity) === 0n && seed.status === 'publishing') return []
  const rand = mulberry32(seed.number * 7919 + 17)
  const resolvedAt = seed.finalizedH !== undefined ? ANCHOR_MS + seed.finalizedH * HOUR : undefined
  const walkEnd = resolvedAt ?? ANCHOR_MS
  const start = Math.ceil(marketCreatedMs / HOUR) * HOUR
  const n = Math.max(1, Math.round((walkEnd - start) / HOUR))
  const sigma = toUnits(m.liquidity) < toUnits('50') ? 0.06 : toUnits(m.liquidity) > toUnits('1000') ? 0.022 : 0.035
  const xs: number[] = []
  let x = logit(m.initial)
  for (let i = 0; i <= n; i++) {
    const t = start + i * HOUR
    x += gauss(rand) * sigma
    for (const j of evidenceJumps) if (j.t > t - HOUR && j.t <= t) x += j.d
    xs.push(x)
  }
  const target = logit(Math.min(0.97, Math.max(0.01, resolvedAt !== undefined ? (m.preResolution ?? m.yes) : m.yes)))
  const last = xs[xs.length - 1] ?? target
  const inv = m.invalid ?? 0.02
  const points: PricePoint[] = xs.map((v, i) => {
    const bridged = v + ((target - last) * i) / n
    const yes = Math.min(0.97, Math.max(0.01, sigmoid(bridged)))
    const invNow = resolvedAt !== undefined && seed.outcome === 'invalid' ? Math.min(0.5, inv * (1 + i / n)) : inv
    return {
      t: start + i * HOUR,
      yes: round(yes, 4),
      no: round(Math.max(0.005, 1 - yes - invNow), 4),
      volume: round(rand() < 0.35 ? rand() * Math.max(1, Number(m.volume) / Math.max(n, 24)) * 3 : 0, 2),
    }
  })
  if (resolvedAt !== undefined) {
    const finalYes = m.yes
    const finalNo = round(Math.max(0.002, 1 - finalYes - (m.invalid ?? 0.004)), 4)
    for (let t = start + (n + 1) * HOUR; t <= ANCHOR_MS; t += HOUR) {
      points.push({ t, yes: finalYes, no: finalNo, volume: 0 })
    }
  } else {
    // make sure the final point is exactly the current price
    const lastPoint = points[points.length - 1]
    if (lastPoint) {
      lastPoint.yes = m.yes
      lastPoint.no = round(1 - m.yes - inv, 4)
    }
  }
  return points
}

export function priceAt(points: PricePoint[], t: number): PricePoint | undefined {
  if (points.length === 0) return undefined
  let lo = 0
  let hi = points.length - 1
  const first = points[0]
  if (first && t <= first.t) return first
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const p = points[mid]
    if (p && p.t <= t) lo = mid
    else hi = mid - 1
  }
  return points[lo]
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildClaim(seed: ClaimSeed): BuiltClaim {
  const id = claimIdOf(seed.number)
  const pr = findPull(seed.repo, seed.pr)
  const repo = findRepo(seed.repo)
  if (!pr || !repo) throw new Error(`fixture PR missing: ${seed.repo}#${seed.pr}`)
  const head = commitsBySha[pr.headSha]
  if (!head) throw new Error(`fixture head commit missing: ${pr.headSha}`)
  const policy = getPolicy(seed.policyId)
  if (!policy) throw new Error(`policy missing: ${seed.policyId}`)
  const creatorGithub = githubByWallet[seed.creator.toLowerCase()]

  // -- source -----------------------------------------------------------------
  const prMergedMs = pr.state === 'merged' ? Date.parse(pr.updatedAt) : Infinity
  const createdMs = ANCHOR_MS + seed.createdH * HOUR
  const source: SourceRef = compact({
    provider: 'github' as const,
    owner: repo.owner,
    repo: repo.name,
    repoId: repo.id,
    pullRequest: {
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.htmlUrl,
      author: pr.author.login,
      state: createdMs >= prMergedMs ? ('merged' as const) : ('open' as const),
    },
    commit: {
      sha: pr.headSha,
      message: head.message,
      author: head.author.login ?? head.author.name,
      committedAt: head.author.date,
      htmlUrl: head.htmlUrl,
    },
    baseCommit: seed.withBase ? { sha: pr.baseSha, htmlUrl: `https://github.com/${repo.fullName}/commit/${pr.baseSha}` } : undefined,
    license: repo.license,
  })

  // -- environment & spec -------------------------------------------------------
  const configHash = computeConfigHash(seed.env.config)
  const pin: Omit<EnvironmentPin, 'envHash'> = compact({
    runtime: seed.env.runtime,
    packageManager: seed.env.packageManager,
    dependencyLock: seed.env.lockPath
      ? { path: seed.env.lockPath, hash: fakeHash(`lock:${repo.fullName}:${pr.headSha}:${seed.env.lockPath}`) }
      : undefined,
    config: seed.env.config,
    configHash,
    containerImage: seed.env.containerImage,
    externalState: seed.env.externalState,
    reproductionCommand: seed.env.reproductionCommand,
    setupSteps: seed.env.setupSteps,
    notes: seed.env.notes,
  })
  const environment: EnvironmentPin = { ...pin, envHash: computeEnvHash(pin) }
  const deadline = hoursFromNow(seed.deadlineH)
  const openingTime = hoursFromNow(seed.openingH ?? seed.deadlineH)
  const timeoutSeconds = seed.timeoutSeconds ?? REALITY_TIMEOUT_SECONDS
  const spec: ClaimSpec = compact({
    title: seed.title,
    policyId: policy.id,
    policyVersion: policy.version,
    claimClass: seed.claimClass,
    requirement: seed.requirement,
    violation: seed.violation,
    scope: seed.scope,
    parameters: seed.parameters,
    faultModel: seed.faultModel,
    allowedInputs: seed.allowedInputs,
    assumptions: seed.assumptions,
    exclusions: seed.exclusions,
    environment,
    regressionOnly: seed.regressionOnly ?? false,
    evidence: { mechanism: seed.mechanism ?? 'erc1497-arbitrator-proxy', deadline },
    oracle: { ...defaultOracleParams(FIXTURE_CHAIN_ID, deadline, { openingTime, minBond: seed.minBond }), timeoutSeconds },
    specReference: seed.specReference,
  })

  const pinnedH = seed.createdH - 0.4
  const { manifest, hash: manifestHash } = buildManifest({
    claimId: id,
    creator: seed.creator,
    source,
    spec,
    policy,
    createdAt: hoursFromNow(pinnedH),
  })
  const manifestUri = `ipfs://${fakeCid(manifestHash)}`

  // -- evidence -------------------------------------------------------------------
  const deadlineMs = Date.parse(deadline)
  const evidence: Evidence[] = seed.evidence.map((e, i) => {
    const submittedAt = hoursFromNow(e.h)
    const content = { claimId: id, kind: e.kind, title: e.title, summary: e.summary, reproduction: e.reproduction ?? null }
    const contentHash = e.kind === 'commitment' && e.commitment?.hash ? e.commitment.hash : hashJson(content)
    return compact({
      id: `ev-${String(seed.number).padStart(4, '0')}-${i + 1}`,
      claimId: id,
      kind: e.kind,
      title: e.title,
      summary: e.summary,
      submitter: e.by,
      submittedAt,
      blockNumber: ethBlockAt(e.h),
      txHash: fakeHash(`tx:evidence:${seed.number}:${i}`),
      chainId: EVIDENCE_CHAIN_ID,
      uri: `ipfs://${fakeCid(contentHash)}`,
      contentHash,
      timely: Date.parse(submittedAt) <= deadlineMs,
      reproduction: e.reproduction,
      attachments: (e.attachments ?? []).map((a, k) => {
        const h = fakeHash(`attachment:${seed.number}:${i}:${k}`)
        return { name: a.name, mime: a.mime, size: a.size, hash: h, uri: `ipfs://${fakeCid(h)}` }
      }),
      commitment: e.commitment
        ? compact({
            hash: e.commitment.hash ?? contentHash,
            revealed: e.commitment.revealed,
            revealedAt: e.commitment.revealedH !== undefined ? hoursFromNow(e.commitment.revealedH) : undefined,
          })
        : undefined,
    })
  })

  // -- market ------------------------------------------------------------------------
  const marketAddress = fakeAddress(`market:${seed.number}`)
  const questionId = fakeHash(`reality-question:${seed.number}`)
  const marketCreatedH = seed.createdH
  let market: MarketState | undefined
  let prices: PricePoint[] = []
  if (seed.market) {
    const m = seed.market
    const jumps = seed.evidence.filter((e) => e.jump).map((e) => ({ t: ANCHOR_MS + e.h * HOUR, d: e.jump ?? 0 }))
    prices = buildPricePath(seed, ANCHOR_MS + marketCreatedH * HOUR, jumps)
    const inv = m.invalid ?? 0.02
    const yes = m.yes
    const no = round(Math.max(0, 1 - yes - inv), 4)
    const ago = priceAt(prices, ANCHOR_MS - 24 * HOUR)
    const hasLiquidity = toUnits(m.liquidity) > 0n
    const yesPool = mulDecimal(m.liquidity, 0.5, 4)
    const noPool = fromUnits(toUnits(m.liquidity) - toUnits(yesPool), 18, 4)
    market = {
      chainId: FIXTURE_CHAIN_ID,
      address: marketAddress,
      seerUrl: `https://app.seer.pm/markets/${FIXTURE_CHAIN_ID}/${marketAddress}`,
      conditionId: fakeHash(`condition:${seed.number}`),
      questionId,
      collateral: { address: contracts.sDAI, symbol: 'sDAI', decimals: 18, name: 'Savings xDAI' },
      outcomes: [
        compact({ index: 0, label: 'Yes', token: fakeAddress(`token:${seed.number}:yes`), price: hasLiquidity ? yes : 0, change24h: hasLiquidity && ago ? round(yes - ago.yes, 4) : undefined }),
        compact({ index: 1, label: 'No', token: fakeAddress(`token:${seed.number}:no`), price: hasLiquidity ? no : 0, change24h: hasLiquidity && ago ? round(no - ago.no, 4) : undefined }),
        { index: 2, label: 'Invalid result', token: fakeAddress(`token:${seed.number}:invalid`), price: hasLiquidity ? inv : 0 },
      ],
      pools: hasLiquidity
        ? [
            { address: fakeAddress(`pool:${seed.number}:yes`), dex: 'Swapr (Algebra)', outcome: 'yes', tvl: yesPool, feeBps: m.feeBps ?? 100 },
            { address: fakeAddress(`pool:${seed.number}:no`), dex: 'Swapr (Algebra)', outcome: 'no', tvl: noPool, feeBps: m.feeBps ?? 100 },
          ]
        : [],
      liquidity: m.liquidity,
      volume24h: m.volume24h,
      volumeTotal: m.volume,
      traders: m.traders,
      openInterest: mulDecimal(m.volume, 0.38, 2),
      createdAt: hoursFromNow(marketCreatedH),
      createdTx: fakeHash(`tx:create-market:${seed.number}`),
    }
  }

  // -- oracle --------------------------------------------------------------------------
  let oracle: OracleState | undefined
  if (market) {
    const history: OracleAnswerEntry[] = (seed.answers ?? []).map((a, i) => ({
      answer: a.answer,
      bond: a.bond,
      answerer: a.by,
      at: hoursFromNow(a.h),
      txHash: fakeHash(`tx:answer:${seed.number}:${i}`),
    }))
    const last = seed.answers?.[seed.answers.length - 1]
    const arb = seed.arbitration
    const arbitration: ArbitrationState = compact({
      requested: arb?.requested ?? false,
      requestedAt: arb?.requestedH !== undefined ? hoursFromNow(arb.requestedH) : arb?.requestedAt,
      requester: arb?.requester,
      disputeId: arb?.disputeId,
      court: arb?.court,
      cost: arb?.cost ?? ARBITRATION_COST,
      status: arb?.status ?? 'not_requested',
      ruling: arb?.ruling,
      appealDeadline: arb?.appealDeadlineH !== undefined ? hoursFromNow(arb.appealDeadlineH) : arb?.appealDeadline,
      klerosUrl: arb?.disputeId ? `https://resolve.kleros.io/cases/${arb.disputeId}?requiredChainId=1` : undefined,
    })
    const isFinalized = seed.finalizedH !== undefined
    const finalAnswer: RealityAnswer | undefined = isFinalized ? seed.outcome : undefined
    oracle = compact({
      chainId: FIXTURE_CHAIN_ID,
      realityQuestionId: questionId,
      realityUrl: realityUrl(questionId),
      templateId: 2,
      openingTime,
      timeoutSeconds,
      minBond: seed.minBond,
      bondToken: 'xDAI',
      currentAnswer: isFinalized ? finalAnswer : last?.answer,
      currentBond: last?.bond,
      finalizesAt: isFinalized
        ? hoursFromNow(seed.finalizedH ?? 0)
        : last && !arbitration.requested
          ? hoursFromNow(last.h + timeoutSeconds / 3600)
          : undefined,
      isFinalized,
      finalAnswer,
      history,
      arbitration,
    })
  }

  // -- timeline ----------------------------------------------------------------------------
  const now = ANCHOR_MS
  const at = (h: number) => hoursFromNow(h)
  const timeline: TimelineEvent[] = []
  const push = (e: Omit<TimelineEvent, 'id'>) =>
    timeline.push(compact({ ...e, id: `${id}-tl-${timeline.length + 1}` }))
  push({ kind: 'drafted', at: at(seed.createdH - 5), title: 'Claim drafted', detail: `Draft started from ${repo.fullName}#${pr.number}.`, actor: seed.creator })
  push({ kind: 'manifest_pinned', at: at(pinnedH), title: 'Manifest pinned to IPFS', detail: `${manifestUri} · keccak256 ${manifestHash}`, actor: seed.creator })
  const steps = seed.publication?.steps
  const marketConfirmed = !steps || steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')
  if (market && marketConfirmed) {
    push({ kind: 'market_created', at: market.createdAt, title: 'Seer market created — terms frozen', detail: `Market ${market.address} and Reality.eth question ${questionId}.`, actor: seed.creator, txHash: market.createdTx })
    if (toUnits(seed.market?.liquidity ?? '0') > 0n || seed.withdrawnH !== undefined) {
      push({ kind: 'liquidity_added', at: at(seed.createdH + 0.2), title: `Liquidity added: ${seed.funding.liquidity} sDAI`, detail: 'Collateral split into outcome tokens and deposited into the YES and NO pools. Withdrawable; not a bounty.', actor: seed.sponsored ? actors.sponsor : seed.creator, txHash: fakeHash(`tx:liquidity:${seed.number}`) })
    }
  }
  evidence.forEach((e) => {
    push({
      kind: 'evidence_submitted',
      at: e.submittedAt,
      title: `${e.kind === 'commitment' ? 'Evidence commitment' : e.kind[0]?.toUpperCase() + e.kind.slice(1)} submitted${e.timely ? '' : ' after the deadline (not timely)'}`,
      detail: e.title,
      actor: e.submitter,
      txHash: e.txHash,
    })
  })
  if (market) {
    push({ kind: 'evidence_deadline', at: deadline, title: 'Evidence deadline', detail: 'Submissions after this time are not timely. This is not a trading cutoff; outcome tokens stay transferable.', scheduled: Date.parse(deadline) > now })
    push({ kind: 'oracle_opened', at: openingTime, title: 'Reality.eth question opens for answers', scheduled: Date.parse(openingTime) > now })
  }
  ;(oracle?.history ?? []).forEach((a, i) => {
    push({
      kind: i === 0 ? 'answer_posted' : 'answer_challenged',
      at: a.at,
      title: i === 0 ? `Answer posted: ${answerLabel(a.answer)}` : `Answer challenged: ${answerLabel(a.answer)}`,
      detail: `Bond ${a.bond} xDAI${i > 0 ? ' (doubled)' : ''}.`,
      actor: a.answerer,
      txHash: a.txHash,
    })
  })
  if (oracle?.arbitration.requested) {
    push({ kind: 'arbitration_requested', at: oracle.arbitration.requestedAt ?? at(0), title: 'Arbitration requested (Kleros)', detail: `Kleros dispute #${oracle.arbitration.disputeId} (${oracle.arbitration.court}). The requester paid ${oracle.arbitration.cost} ETH on Ethereum; the Reality.eth question is frozen until the ruling is relayed back.`, actor: oracle.arbitration.requester, txHash: fakeHash(`tx:arbitration:${seed.number}`) })
    if (seed.arbitration?.rulingH !== undefined) {
      push({ kind: 'ruling', at: at(seed.arbitration.rulingH), title: `Jurors voted: ${answerLabel(oracle.arbitration.ruling ?? 'invalid')}${oracle.arbitration.status === 'appeal_period' ? ' (appealable)' : ''}`, detail: oracle.arbitration.status === 'appeal_period' ? `Appeal period ends ${oracle.arbitration.appealDeadline}. The ruling becomes final if not appealed; it is then relayed to Gnosis and answers the Reality.eth question.` : undefined, actor: contracts.klerosLiquid })
    }
  }
  if (oracle) {
    if (oracle.isFinalized && seed.finalizedH !== undefined) {
      push({ kind: 'finalized', at: at(seed.finalizedH), title: `Finalized: ${outcomeLabel(seed.outcome ?? 'invalid')}`, detail: seed.resolutionNote, actor: actors.resolver, txHash: fakeHash(`tx:finalize:${seed.number}`) })
    } else if (oracle.finalizesAt) {
      push({ kind: 'finalized', at: oracle.finalizesAt, title: `Expected finalization if unchallenged: ${answerLabel(oracle.currentAnswer ?? 'invalid')}`, detail: 'A new answer with a doubled bond, or an arbitration request, resets or suspends this.', scheduled: true })
    } else if (oracle.arbitration.requested && oracle.arbitration.appealDeadline) {
      push({ kind: 'finalized', at: oracle.arbitration.appealDeadline, title: 'Earliest finalization (end of appeal period)', scheduled: true })
    }
  }
  if (seed.withdrawnH !== undefined) {
    push({ kind: 'liquidity_removed', at: at(seed.withdrawnH), title: 'Creator withdrew liquidity', actor: seed.creator, txHash: fakeHash(`tx:withdraw:${seed.number}`) })
  }
  if (seed.redeemedH !== undefined) {
    push({ kind: 'redeemed', at: at(seed.redeemedH), title: 'Creator redeemed outcome tokens', actor: seed.creator, txHash: fakeHash(`tx:redeem:${seed.number}`) })
  }
  timeline.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  timeline.forEach((e, i) => (e.id = `${id}-tl-${i + 1}`))

  // -- publication ----------------------------------------------------------------------------
  const publication = seed.publication
    ? {
        steps: seed.publication.steps.map(
          (s): PublicationStep =>
            compact({
              id: s.id,
              status: s.status,
              txHash: s.status === 'confirmed' && s.id !== 'upload_manifest' ? fakeHash(`tx:publish:${seed.number}:${s.id}`) : undefined,
              error: s.error,
              at: s.h !== undefined ? at(s.h) : undefined,
            }),
        ),
        resumable: seed.publication.resumable,
        note: seed.publication.note,
      }
    : undefined

  // -- summary fields ---------------------------------------------------------------------------
  const ago = prices.length ? priceAt(prices, ANCHOR_MS - 24 * HOUR) : undefined
  const hasPrice = !!market && toUnits(seed.market?.liquidity ?? '0') > 0n || (!!market && seed.finalizedH !== undefined)
  const detail: ClaimDetail = compact({
    id,
    number: seed.number,
    title: seed.title,
    violation: seed.violation,
    policy: { id: policy.id, version: policy.version, family: policy.family, title: policy.title },
    source: compact({ owner: repo.owner, repo: repo.name, commitSha: pr.headSha, prNumber: pr.number, prTitle: pr.title }),
    status: seed.status,
    outcome: seed.outcome,
    createdAt: hoursFromNow(seed.createdH),
    evidenceDeadline: deadline,
    chainId: FIXTURE_CHAIN_ID,
    marketAddress: market?.address,
    creator: seed.creator,
    creatorGithub,
    yesPrice: hasPrice ? seed.market?.yes : undefined,
    yesPrice24hAgo: hasPrice ? ago?.yes ?? seed.market?.yes : undefined,
    liquidity: seed.market?.liquidity ?? '0',
    volume: seed.market?.volume ?? '0',
    collateralSymbol: 'sDAI',
    evidenceCount: evidence.length,
    traders: seed.market?.traders ?? 0,
    sponsored: seed.sponsored ?? false,
    tags: seed.tags,
    manifest,
    manifestUri,
    manifestHash,
    market,
    oracle,
    evidence,
    timeline,
    publication,
    funding: { liquidity: seed.funding.liquidity, spendingLimit: seed.funding.spendingLimit, withdrawable: seed.funding.withdrawable ?? true },
  })

  return { detail, prices, activity: buildActivity(seed, detail, prices) }
}

function answerLabel(a: RealityAnswer): string {
  return a === 'yes' ? 'Yes' : a === 'no' ? 'No' : a === 'invalid' ? 'Invalid' : 'Answered too soon'
}

function outcomeLabel(o: Outcome): string {
  return o === 'yes' ? 'Counterexample demonstrated' : o === 'no' ? 'No qualifying counterexample submitted' : 'Resolved invalid'
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function buildActivity(seed: ClaimSeed, claim: ClaimDetail, prices: PricePoint[]): ActivityItem[] {
  const items: ActivityItem[] = []
  const base = { claimId: claim.id, claimNumber: claim.number, claimTitle: claim.title, chainId: FIXTURE_CHAIN_ID }
  const add = (a: Omit<ActivityItem, 'id' | 'claimId' | 'claimNumber' | 'claimTitle' | 'chainId'> & { chainId?: number }) =>
    items.push(compact({ ...base, ...a, id: `act-${String(seed.number).padStart(4, '0')}-${items.length + 1}` }))
  const L = seed.funding.liquidity
  const funder = seed.sponsored ? actors.sponsor : seed.creator
  const steps = seed.publication?.steps
  const stepStatus = (id: TxStepId) => (steps ? steps.find((s) => s.id === id)?.status : 'confirmed')
  const stepH = (id: TxStepId, fallback: number) => steps?.find((s) => s.id === id)?.h ?? fallback

  add({ type: 'manifest_pinned', actor: seed.creator, at: hoursFromNow(seed.createdH - 0.4), txHash: fakeHash(`tx:pin:${seed.number}`), summary: `Pinned manifest ${claim.manifestUri.slice(0, 22)}… for ${claim.source.owner}/${claim.source.repo}@${claim.source.commitSha.slice(0, 7)}`, status: 'confirmed' })
  const createStatus = stepStatus('create_market')
  if (createStatus === 'confirmed' || createStatus === 'failed') {
    add({ type: 'market_created', actor: seed.creator, at: hoursFromNow(stepH('create_market', seed.createdH)), txHash: fakeHash(`tx:create-market:${seed.number}`), summary: createStatus === 'failed' ? 'Market creation transaction reverted; nothing was created' : `Created Seer market and Reality.eth question for ${policyTag(seed)}`, status: createStatus === 'failed' ? 'failed' : 'confirmed' })
  }
  if (stepStatus('approve_collateral') === 'confirmed') {
    add({ type: 'approval', actor: funder, at: hoursFromNow(stepH('approve_collateral', seed.createdH + 0.1)), txHash: fakeHash(`tx:publish:${seed.number}:approve_collateral`), token: 'sDAI', summary: `Approved exactly ${L} sDAI for the Seer router (no unlimited allowance)`, status: 'confirmed' })
  }
  const splitStatus = stepStatus('split_position')
  if (splitStatus === 'confirmed') {
    add({ type: 'split', actor: funder, at: hoursFromNow(seed.createdH + 0.15), txHash: fakeHash(`tx:split:${seed.number}`), amount: `-${L}`, token: 'sDAI', summary: `Split ${L} sDAI into YES, NO and Invalid outcome tokens`, status: 'confirmed' })
  } else if (splitStatus === 'failed') {
    add({ type: 'split', actor: funder, at: hoursFromNow(stepH('split_position', seed.createdH + 0.15)), txHash: fakeHash(`tx:split:${seed.number}`), token: 'sDAI', summary: 'Split rejected in wallet — no collateral moved', status: 'failed' })
  }
  if (stepStatus('add_liquidity_yes') === 'confirmed') {
    const half = mulDecimal(L, 0.5, 4)
    add({ type: 'liquidity_added', actor: funder, at: hoursFromNow(seed.createdH + 0.2), txHash: fakeHash(`tx:liquidity:${seed.number}`), outcome: 'yes', token: 'sDAI', summary: `Added liquidity to the YES pool (≈${half} sDAI of tokens, range ${seed.market?.initial ?? 0.15} ± band)`, status: 'confirmed' })
    add({ type: 'liquidity_added', actor: funder, at: hoursFromNow(seed.createdH + 0.22), txHash: fakeHash(`tx:liquidity-no:${seed.number}`), outcome: 'no', token: 'sDAI', summary: `Added liquidity to the NO pool (≈${half} sDAI of tokens)`, status: 'confirmed' })
  }

  // trades
  const m = seed.market
  if (m && toUnits(m.liquidity) + toUnits(m.volume) > 0n && prices.length > 2) {
    const rand = mulberry32(seed.number * 104729 + 3)
    const count = m.trades ?? Math.min(9, Math.max(3, Math.round(m.traders / 4)))
    const first = (prices[1] ?? prices[0])?.t ?? ANCHOR_MS
    const lastT = seed.finalizedH !== undefined ? ANCHOR_MS + (seed.finalizedH - 1) * HOUR : ANCHOR_MS - 0.25 * HOUR
    for (let i = 0; i < count; i++) {
      const t = first + ((lastT - first) * (i + rand() * 0.8)) / count
      const p = priceAt(prices, t)
      if (!p) continue
      const outcome: 'yes' | 'no' = rand() < 0.58 ? 'yes' : 'no'
      const side: 'buy' | 'sell' = rand() < 0.72 ? 'buy' : 'sell'
      const scale = Math.max(1.5, Math.min(Number(m.liquidity) * 0.09, 220))
      const amount = round(1 + rand() * scale, 2)
      const price = outcome === 'yes' ? p.yes : p.no
      const tokens = round(amount / Math.max(price, 0.01), 2)
      const actor = traderPool[Math.floor(rand() * traderPool.length)] ?? actors.quill
      add({
        type: 'trade',
        actor,
        at: new Date(Math.round(t / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        txHash: fakeHash(`tx:trade:${seed.number}:${i}`),
        amount: side === 'buy' ? `-${amount}` : `${amount}`,
        token: 'sDAI',
        outcome,
        side,
        summary: `${side === 'buy' ? 'Bought' : 'Sold'} ${tokens} ${outcome.toUpperCase()} at ${price.toFixed(3)} for ${amount} sDAI`,
        status: 'confirmed',
      })
    }
  }
  for (const t of seed.demoTrades ?? []) {
    const p = priceAt(prices, ANCHOR_MS + t.h * HOUR)
    const price = p ? (t.outcome === 'yes' ? p.yes : p.no) : 0.5
    const tokens = round(Number(t.amount) / Math.max(price, 0.01), 2)
    add({ type: 'trade', actor: t.by, at: hoursFromNow(t.h), txHash: fakeHash(`tx:demo-trade:${seed.number}:${t.h}`), amount: t.side === 'buy' ? `-${t.amount}` : t.amount, token: 'sDAI', outcome: t.outcome, side: t.side, summary: `${t.side === 'buy' ? 'Bought' : 'Sold'} ${tokens} ${t.outcome.toUpperCase()} at ${price.toFixed(3)} for ${t.amount} sDAI`, status: 'confirmed' })
  }

  for (const e of claim.evidence) {
    add({ type: 'evidence_submitted', actor: e.submitter, at: e.submittedAt, txHash: e.txHash, chainId: EVIDENCE_CHAIN_ID, summary: `${e.kind === 'commitment' ? 'Committed evidence hash' : `Submitted ${e.kind}`}${e.timely ? '' : ' (after the deadline — not timely)'}: ${truncate(e.title, 80)}`, status: 'confirmed' })
  }
  for (const a of claim.oracle?.history ?? []) {
    add({ type: 'answer_posted', actor: a.answerer, at: a.at, txHash: a.txHash, amount: `-${a.bond}`, token: 'xDAI', outcome: a.answer === 'too_soon' ? undefined : a.answer, summary: `Answered ${answerLabel(a.answer)} with a ${a.bond} xDAI bond`, status: 'confirmed' })
  }
  const arb = claim.oracle?.arbitration
  if (arb?.requested && arb.requester) {
    add({ type: 'arbitration_requested', actor: arb.requester, at: arb.requestedAt ?? hoursFromNow(0), txHash: fakeHash(`tx:arbitration:${seed.number}`), chainId: EVIDENCE_CHAIN_ID, amount: `-${arb.cost}`, token: 'ETH', summary: `Requested Kleros arbitration on Ethereum (dispute #${arb.disputeId}, ${arb.court}), paid ${arb.cost} ETH`, status: 'confirmed' })
    if (seed.arbitration?.rulingH !== undefined) {
      add({ type: 'ruling', actor: contracts.klerosLiquid, at: hoursFromNow(seed.arbitration.rulingH), txHash: fakeHash(`tx:ruling:${seed.number}`), chainId: EVIDENCE_CHAIN_ID, outcome: arb.ruling === 'too_soon' ? undefined : arb.ruling, summary: `Kleros jurors voted ${answerLabel(arb.ruling ?? 'invalid')}${arb.status === 'appeal_period' ? ' — appeal period open' : ''}`, status: 'confirmed' })
    }
  }
  if (seed.finalizedH !== undefined) {
    add({ type: 'finalized', actor: actors.resolver, at: hoursFromNow(seed.finalizedH), txHash: fakeHash(`tx:finalize:${seed.number}`), outcome: seed.outcome, summary: `Market resolved: ${outcomeLabel(seed.outcome ?? 'invalid')}`, status: 'confirmed' })
    // winners redeem
    const rand = mulberry32(seed.number * 31337)
    const redeemers = traderPool.slice(0, 2 + Math.floor(rand() * 2))
    redeemers.forEach((r, i) => {
      const amt = round(5 + rand() * 60, 2)
      add({ type: 'redeemed', actor: r, at: hoursFromNow((seed.finalizedH ?? 0) + 3 + i * 9), txHash: fakeHash(`tx:redeem:${seed.number}:${i}`), amount: `${amt}`, token: 'sDAI', outcome: seed.outcome, summary: `Redeemed ${amt} sDAI from ${seed.outcome === 'yes' ? 'YES' : seed.outcome === 'no' ? 'NO' : 'Invalid-result'} tokens`, status: 'confirmed' })
    })
  }
  if (seed.withdrawnH !== undefined) {
    add({ type: 'liquidity_removed', actor: seed.creator, at: hoursFromNow(seed.withdrawnH), txHash: fakeHash(`tx:withdraw:${seed.number}`), amount: seed.withdrawnAmount, token: 'sDAI', summary: `Withdrew all liquidity positions (YES and NO pools)${seed.withdrawnAmount ? ` for ${seed.withdrawnAmount} sDAI` : ''}`, status: 'confirmed' })
  }
  if (seed.redeemedH !== undefined) {
    add({ type: 'redeemed', actor: seed.creator, at: hoursFromNow(seed.redeemedH), txHash: fakeHash(`tx:redeem:${seed.number}`), amount: seed.redeemedAmount, token: 'sDAI', outcome: seed.outcome, summary: 'Redeemed remaining outcome tokens after resolution', status: 'confirmed' })
  }
  return items
}

function policyTag(seed: ClaimSeed): string {
  return `${seed.policyId}${seed.claimClass ? ` (${seed.claimClass})` : ''}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
