import type {
  ActivityItem,
  ActivityQuery,
  Address,
  ClaimDetail,
  ClaimQuery,
  ClaimSummary,
  DepthLevel,
  DepthSnapshot,
  Evidence,
  LiquidityPosition,
  OutcomePosition,
  Page,
  PlatformStats,
  PolicyVersion,
  Portfolio,
  PricePoint,
  PriceRange,
  TimelineEvent,
} from '@pine/core'
import { readMockLatencyEnabled } from '../env'
import { getPolicy as corePolicy, POLICIES } from '@pine/core'
import {
  clone,
  compareDecimal,
  fromUnits,
  hasLocalStorage,
  lower,
  mulberry32,
  mulDecimal,
  paginate,
  readStorage,
  removeStorage,
  round,
  sameAddress,
  sleep,
  sumDecimal,
  toUnits,
  writeStorage,
} from '../internal/util'
import type { DataSourceKind, PineDataProvider } from '../types'
import { getFixtures, type PineFixtures } from './fixtures'
import { emptyPortfolio } from './fixtures/portfolio'

const HOUR = 3_600_000
const RANGE_MS: Record<PriceRange, number> = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR, all: Infinity }

/** localStorage keys used by the mock provider's demo write paths. */
export const MOCK_STORAGE_KEYS = {
  claims: 'pine:mock:claims',
  patches: 'pine:mock:patches',
  evidence: 'pine:mock:evidence',
  activity: 'pine:mock:activity',
} as const

interface MockState {
  claims: ClaimDetail[]
  patches: Record<string, Partial<ClaimDetail>>
  evidence: Record<string, Evidence[]>
  activity: ActivityItem[]
}

export interface MockDataProviderOptions {
  /** Simulated latency per call. `false`/0 disables; default reads NEXT_PUBLIC_PINE_MOCK_LATENCY (on unless `0`). */
  latency?: boolean | [minMs: number, maxMs: number]
  /** Persist demo writes to localStorage in the browser (default true). */
  persist?: boolean
  fixtures?: PineFixtures
  /** Clock used for "now" in derived values (defaults to Date.now). */
  now?: () => number
}

const SUMMARY_KEYS: (keyof ClaimSummary)[] = [
  'id',
  'number',
  'title',
  'violation',
  'policy',
  'source',
  'status',
  'outcome',
  'createdAt',
  'evidenceDeadline',
  'chainId',
  'marketAddress',
  'creator',
  'creatorGithub',
  'yesPrice',
  'yesPrice24hAgo',
  'liquidity',
  'volume',
  'collateralSymbol',
  'evidenceCount',
  'traders',
  'sponsored',
  'tags',
]

export function toSummary(c: ClaimDetail): ClaimSummary {
  const out: Record<string, unknown> = {}
  for (const k of SUMMARY_KEYS) if (c[k] !== undefined) out[k] = c[k]
  return out as unknown as ClaimSummary
}

function normalizeClaimId(id: string): string {
  const s = id.trim().toLowerCase()
  const m = /^(?:pine-)?0*(\d+)$/.exec(s)
  return m ? `pine-${m[1]!.padStart(4, '0')}` : s
}

/**
 * Fixture-backed PineDataProvider with real filtering/sorting/pagination (cursor = offset string)
 * and demo write paths so demo publishing and evidence show up everywhere. Writes persist to
 * localStorage (`pine:mock:*`) in the browser and to memory on the server.
 */
export class MockDataProvider implements PineDataProvider {
  readonly kind: DataSourceKind = 'mock'
  private readonly fixedFixtures?: PineFixtures
  private readonly persist: boolean
  private readonly latency: [number, number] | null
  private readonly rand = mulberry32(0x9e3779b9)
  private readonly now: () => number
  private state: MockState | null = null
  private listeners = new Set<() => void>()
  private storageListener?: (e: StorageEvent) => void

  constructor(opts: MockDataProviderOptions = {}) {
    this.fixedFixtures = opts.fixtures
    this.persist = opts.persist ?? true
    this.now = opts.now ?? (() => Date.now())
    const l = opts.latency ?? readMockLatencyEnabled()
    this.latency = l === false ? null : l === true ? [120, 420] : l[1] <= 0 ? null : l
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Fixtures for the current hour (rebuilt when the hour changes) unless fixed via options. */
  private get fx(): PineFixtures {
    return this.fixedFixtures ?? getFixtures(this.now())
  }

  private async delay(): Promise<void> {
    if (!this.latency) return
    const [min, max] = this.latency
    await sleep(Math.round(min + this.rand() * (max - min)))
  }

  private load(): MockState {
    if (this.state) return this.state
    const useStorage = this.persist && hasLocalStorage()
    // Persisted demo writes are shape-checked: corrupt or outdated values are ignored, never thrown.
    const arr = <T,>(v: unknown, ok: (x: T) => boolean): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => !!x && typeof x === 'object' && ok(x)) : [])
    const rec = <T,>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {})
    const isClaim = (c: ClaimDetail) => typeof c.id === 'string' && typeof c.number === 'number' && Array.isArray(c.evidence) && Array.isArray(c.timeline) && !!c.manifest
    const isActivity = (a: ActivityItem) => typeof a.id === 'string' && typeof a.claimId === 'string' && typeof a.at === 'string'
    const evidence = rec<unknown>(useStorage ? readStorage(MOCK_STORAGE_KEYS.evidence) : undefined)
    this.state = {
      claims: arr<ClaimDetail>(useStorage ? readStorage(MOCK_STORAGE_KEYS.claims) : undefined, isClaim),
      patches: rec<Partial<ClaimDetail>>(useStorage ? readStorage(MOCK_STORAGE_KEYS.patches) : undefined),
      evidence: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, arr<Evidence>(v, (e) => typeof e.id === 'string' && typeof e.submittedAt === 'string')])),
      activity: arr<ActivityItem>(useStorage ? readStorage(MOCK_STORAGE_KEYS.activity) : undefined, isActivity),
    }
    if (useStorage && !this.storageListener && typeof window !== 'undefined') {
      this.storageListener = (e: StorageEvent) => {
        // key === null means localStorage.clear()
        if (e.key === null || e.key.startsWith('pine:mock:')) {
          this.state = null
          this.emit()
        }
      }
      window.addEventListener('storage', this.storageListener)
    }
    return this.state
  }

  private save(): void {
    if (!this.persist || !this.state) return
    writeStorage(MOCK_STORAGE_KEYS.claims, this.state.claims)
    writeStorage(MOCK_STORAGE_KEYS.patches, this.state.patches)
    writeStorage(MOCK_STORAGE_KEYS.evidence, this.state.evidence)
    writeStorage(MOCK_STORAGE_KEYS.activity, this.state.activity)
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // listener errors must not break writes
      }
    }
  }

  /** All claims (fixtures + demo additions) with patches and added evidence merged in. Internal: shares fixture objects. */
  private allClaims(): ClaimDetail[] {
    const s = this.load()
    const added = new Set(s.claims.map((c) => c.id))
    const merged = [...s.claims, ...this.fx.claims.filter((c) => !added.has(c.id))].map((c) => {
      const patch = s.patches[c.id]
      const extra = s.evidence[c.id] ?? []
      if (!patch && extra.length === 0) return c
      const base: ClaimDetail = patch ? { ...c, ...patch } : c
      if (extra.length === 0) return base
      const known = new Set(base.evidence.map((e) => e.id))
      const fresh = extra.filter((e) => !known.has(e.id))
      const evidence = [...base.evidence, ...fresh]
      const timeline: TimelineEvent[] = [
        ...base.timeline,
        ...fresh.map(
          (e): TimelineEvent => ({
            id: `${base.id}-tl-ev-${e.id}`,
            kind: 'evidence_submitted',
            at: e.submittedAt,
            title: `${e.kind === 'commitment' ? 'Evidence commitment' : e.kind[0]?.toUpperCase() + e.kind.slice(1)} submitted${e.timely ? '' : ' after the deadline (not timely)'}`,
            detail: e.title,
            actor: e.submitter,
            txHash: e.txHash,
          }),
        ),
      ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      return { ...base, evidence, evidenceCount: evidence.length, timeline }
    })
    return merged.sort((a, b) => b.number - a.number)
  }

  private allActivity(): ActivityItem[] {
    const s = this.load()
    return [...s.activity, ...this.fx.activity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  }

  private findClaim(id: string): ClaimDetail | undefined {
    const key = normalizeClaimId(id)
    return this.allClaims().find((c) => c.id.toLowerCase() === key || c.id.toLowerCase() === id.toLowerCase())
  }

  // -------------------------------------------------------------------------
  // PineDataProvider
  // -------------------------------------------------------------------------

  async listClaims(q: ClaimQuery = {}): Promise<Page<ClaimSummary>> {
    await this.delay()
    let items = this.allClaims()
    if (q.status) {
      const statuses = new Set(Array.isArray(q.status) ? q.status : [q.status])
      if (statuses.size > 0) items = items.filter((c) => statuses.has(c.status))
    }
    if (q.outcome) items = items.filter((c) => c.outcome === q.outcome)
    if (q.policyId) items = items.filter((c) => lower(c.policy.id) === lower(q.policyId))
    if (q.family) items = items.filter((c) => c.policy.family === q.family)
    if (q.repo) items = items.filter((c) => lower(`${c.source.owner}/${c.source.repo}`) === lower(q.repo))
    if (q.creator) items = items.filter((c) => sameAddress(c.creator, q.creator))
    if (q.chainId !== undefined) items = items.filter((c) => c.chainId === q.chainId)
    if (q.search && q.search.trim()) {
      const terms = lower(q.search).split(/\s+/).filter(Boolean)
      items = items.filter((c) => {
        const hay = lower(
          [
            c.title,
            c.violation,
            c.manifest?.claim?.requirement,
            `${c.source.owner}/${c.source.repo}`,
            c.source.prTitle,
            c.source.prNumber !== undefined ? `#${c.source.prNumber}` : '',
            c.source.commitSha,
            c.policy.id,
            c.policy.title,
            `pine-${String(c.number).padStart(4, '0')}`,
            c.creatorGithub,
            ...c.tags,
          ]
            .filter(Boolean)
            .join(' \u0000 '),
        )
        return terms.every((t) => hay.includes(t))
      })
    }
    items = this.sortClaims(items, q.sort ?? 'newest')
    const page = paginate(items, q.cursor, q.limit ?? 20)
    return { ...page, items: page.items.map((c) => clone(toSummary(c))) }
  }

  private sortClaims(items: ClaimDetail[], sort: NonNullable<ClaimQuery['sort']>): ClaimDetail[] {
    const now = this.now()
    const by = [...items]
    switch (sort) {
      case 'deadline': {
        // Upcoming deadlines first (soonest), then past deadlines (most recent first).
        return by.sort((a, b) => {
          const da = Date.parse(a.evidenceDeadline)
          const db = Date.parse(b.evidenceDeadline)
          const fa = da >= now
          const fb = db >= now
          if (fa !== fb) return fa ? -1 : 1
          return fa ? da - db : db - da
        })
      }
      case 'liquidity':
        return by.sort((a, b) => compareDecimal(b.liquidity, a.liquidity) || b.number - a.number)
      case 'volume':
        return by.sort((a, b) => compareDecimal(b.volume, a.volume) || b.number - a.number)
      case 'yes_price':
        return by.sort((a, b) => (b.yesPrice ?? -1) - (a.yesPrice ?? -1) || b.number - a.number)
      case 'activity': {
        const latest = new Map<string, number>()
        for (const a of this.allActivity()) {
          const t = Date.parse(a.at)
          if (t > (latest.get(a.claimId) ?? 0)) latest.set(a.claimId, t)
        }
        return by.sort((a, b) => (latest.get(b.id) ?? Date.parse(b.createdAt)) - (latest.get(a.id) ?? Date.parse(a.createdAt)))
      }
      case 'newest':
      default:
        return by.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.number - a.number)
    }
  }

  async getClaim(id: string): Promise<ClaimDetail | null> {
    await this.delay()
    const c = this.findClaim(id)
    return c ? clone(c) : null
  }

  async getClaimByMarket(chainId: number, marketAddress: Address): Promise<ClaimDetail | null> {
    await this.delay()
    const c = this.allClaims().find((x) => x.chainId === chainId && sameAddress(x.marketAddress, marketAddress))
    return c ? clone(c) : null
  }

  async getPriceHistory(claimId: string, range: PriceRange): Promise<PricePoint[]> {
    await this.delay()
    const c = this.findClaim(claimId)
    if (!c) return []
    let points = this.fx.prices[c.id]
    if (!points || points.length === 0) points = this.syntheticHistory(c)
    const from = this.now() - RANGE_MS[range]
    return points.filter((p) => p.t >= from).map((p) => ({ ...p }))
  }

  /** Flat history for demo-added claims that have a market and a price. */
  private syntheticHistory(c: ClaimDetail): PricePoint[] {
    if (!c.market || c.yesPrice === undefined) return []
    const start = Math.ceil(Date.parse(c.market.createdAt) / HOUR) * HOUR
    const end = this.now()
    const inv = c.market.outcomes.find((o) => o.index === 2)?.price ?? 0.02
    const out: PricePoint[] = []
    for (let t = start; t <= end; t += HOUR) out.push({ t, yes: c.yesPrice, no: round(1 - c.yesPrice - inv, 4), volume: 0 })
    return out
  }

  async getDepth(claimId: string, outcome: 'yes' | 'no'): Promise<DepthSnapshot | null> {
    await this.delay()
    const c = this.findClaim(claimId)
    if (!c?.market || toUnits(c.liquidity) === 0n) return null
    return buildDepth(c, outcome, this.now())
  }

  async listEvidence(claimId: string): Promise<Evidence[]> {
    await this.delay()
    const c = this.findClaim(claimId)
    if (!c) return []
    return clone(c.evidence).sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))
  }

  async listActivity(q: ActivityQuery = {}): Promise<Page<ActivityItem>> {
    await this.delay()
    let items = this.allActivity()
    if (q.claimId) {
      const key = normalizeClaimId(q.claimId)
      items = items.filter((a) => a.claimId === key || a.claimId === q.claimId)
    }
    if (q.account) items = items.filter((a) => sameAddress(a.actor, q.account))
    if (q.types && q.types.length > 0) {
      const types = new Set(q.types)
      items = items.filter((a) => types.has(a.type))
    }
    const page = paginate(items, q.cursor, q.limit ?? 25, 200)
    return { ...page, items: clone(page.items) }
  }

  async getPortfolio(address: Address): Promise<Portfolio> {
    await this.delay()
    const base = this.fx.portfolios[address.toLowerCase()]
    const portfolio = base ? clone(base) : emptyPortfolio(address)
    return this.applyRuntimePortfolio(portfolio, address)
  }

  /** Reflect demo writes (trades, liquidity, redemptions recorded at runtime) in the portfolio. */
  private applyRuntimePortfolio(p: Portfolio, address: Address): Portfolio {
    const s = this.load()
    const mine = s.activity.filter((a) => sameAddress(a.actor, address)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    if (mine.length === 0) return p
    const claims = new Map(this.allClaims().map((c) => [c.id, c]))
    for (const a of mine) {
      const c = claims.get(a.claimId)
      if (!c) continue
      if (a.type === 'trade' && a.side === 'buy' && a.outcome && a.outcome !== 'invalid' && a.amount) {
        const quote = c.market?.outcomes.find((o) => o.label.toLowerCase() === a.outcome)
        const price = quote?.price || 0.5
        const spent = a.amount.replace('-', '')
        const balance = fromUnits((toUnits(spent) * 1_000_000n) / BigInt(Math.max(1, Math.round(price * 1_000_000))), 18, 2)
        const existing = p.positions.find((x) => x.claimId === c.id && x.outcome === a.outcome)
        if (existing) {
          existing.balance = sumDecimal([existing.balance, balance], 4)
          existing.value = mulDecimal(existing.balance, existing.markPrice, 4)
        } else {
          const pos: OutcomePosition = {
            claimId: c.id,
            claimNumber: c.number,
            claimTitle: c.title,
            status: c.status,
            outcome: a.outcome,
            balance,
            avgPrice: price,
            markPrice: price,
            value: mulDecimal(balance, price, 4),
            redeemable: false,
          }
          p.positions.push(pos)
        }
      } else if (a.type === 'liquidity_added' && a.outcome && a.outcome !== 'invalid') {
        const pool = c.market?.pools.find((x) => x.outcome === a.outcome)
        const deposited = a.amount ? a.amount.replace('-', '') : mulDecimal(c.funding?.liquidity ?? '0', 0.5, 4)
        const lp: LiquidityPosition = {
          claimId: c.id,
          claimNumber: c.number,
          claimTitle: c.title,
          tokenId: a.id,
          pool: pool?.address ?? (c.marketAddress as Address),
          outcome: a.outcome,
          deposited,
          currentValue: deposited,
          feesEarned: '0',
          withdrawable: true,
          inRange: true,
        }
        p.liquidity.push(lp)
      } else if (a.type === 'redeemed') {
        for (const pos of p.positions) {
          if (pos.claimId === c.id && pos.redeemable) {
            pos.redeemable = false
            pos.redeemableAmount = undefined
            pos.balance = '0'
            pos.value = '0'
          }
        }
        p.positions = p.positions.filter((x) => !(x.claimId === c.id && x.balance === '0'))
      } else if (a.type === 'liquidity_removed') {
        p.liquidity = p.liquidity.filter((l) => l.claimId !== c.id)
      }
    }
    const flows = s.activity.filter((a) => sameAddress(a.actor, address) && a.token === 'sDAI' && a.amount)
    p.totals = {
      positionsValue: sumDecimal(p.positions.map((x) => x.value), 4),
      liquidityValue: sumDecimal(p.liquidity.map((x) => x.currentValue), 4),
      redeemable: sumDecimal(p.positions.map((x) => x.redeemableAmount), 4),
      depositedAllTime: sumDecimal([p.totals.depositedAllTime, ...flows.filter((a) => a.amount!.startsWith('-')).map((a) => a.amount!.slice(1))], 4),
      withdrawnAllTime: sumDecimal([p.totals.withdrawnAllTime, ...flows.filter((a) => !a.amount!.startsWith('-')).map((a) => a.amount)], 4),
      feesPaidAllTime: p.totals.feesPaidAllTime,
    }
    return p
  }

  async listPolicies(): Promise<PolicyVersion[]> {
    await this.delay()
    return clone(POLICIES)
  }

  async getPolicy(id: string, version?: string): Promise<PolicyVersion | null> {
    await this.delay()
    const p = corePolicy(id.toUpperCase(), version)
    return p ? clone(p) : null
  }

  async getStats(): Promise<PlatformStats> {
    await this.delay()
    const claims = this.allClaims()
    const now = this.now()
    const since = now - 30 * 24 * HOUR
    const resolved = claims.filter((c) => c.status === 'resolved' || c.status === 'settled')
    // Hourly fixture volumes (calibrated to each market's total) plus trades recorded by demo writes.
    const volume30d = [
      ...claims.flatMap((c) => (this.fx.prices[c.id] ?? []).filter((p) => p.t >= since).map((p) => (p.volume ?? 0).toFixed(2))),
      ...this.load()
        .activity.filter((a) => a.type === 'trade' && Date.parse(a.at) >= since && a.amount)
        .map((a) => a.amount!.replace('-', '')),
    ]
    return {
      openClaims: claims.filter((c) => c.status === 'open').length,
      resolvedClaims: resolved.length,
      totalLiquidity: sumDecimal(claims.filter((c) => c.status !== 'settled').map((c) => c.liquidity), 2),
      volume30d: sumDecimal(volume30d, 2),
      evidenceSubmissions: claims.reduce((n, c) => n + c.evidence.length, 0),
      counterexamplesAccepted: resolved.filter((c) => c.outcome === 'yes').length,
      collateralSymbol: 'sDAI',
    }
  }

  // -------------------------------------------------------------------------
  // Demo write paths
  // -------------------------------------------------------------------------

  /** Subscribe to demo writes (and cross-tab storage changes). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Next free claim number (for demo publishing). */
  nextClaimNumber(): number {
    return this.allClaims().reduce((m, c) => Math.max(m, c.number), 0) + 1
  }

  addClaim(detail: ClaimDetail): void {
    const s = this.load()
    s.claims = [clone(detail), ...s.claims.filter((c) => c.id !== detail.id)]
    this.save()
    this.emit()
  }

  addEvidence(claimId: string, e: Evidence): void {
    const s = this.load()
    const key = this.findClaim(claimId)?.id ?? claimId
    const list = s.evidence[key] ?? []
    s.evidence[key] = [...list.filter((x) => x.id !== e.id), clone({ ...e, claimId: key })]
    this.save()
    this.emit()
  }

  recordActivity(a: ActivityItem): void {
    const s = this.load()
    s.activity = [clone(a), ...s.activity.filter((x) => x.id !== a.id)]
    this.save()
    this.emit()
  }

  updateClaim(id: string, patch: Partial<ClaimDetail>): void {
    const s = this.load()
    const key = this.findClaim(id)?.id ?? normalizeClaimId(id)
    const idx = s.claims.findIndex((c) => c.id === key)
    if (idx >= 0) {
      const current = s.claims[idx] as ClaimDetail
      s.claims[idx] = { ...current, ...clone(patch), id: current.id }
    } else {
      s.patches[key] = { ...(s.patches[key] ?? {}), ...clone(patch) }
    }
    this.save()
    this.emit()
  }

  /** Clear every demo write (memory and localStorage) and return to pristine fixtures. */
  reset(): void {
    this.state = { claims: [], patches: {}, evidence: {}, activity: [] }
    for (const k of Object.values(MOCK_STORAGE_KEYS)) removeStorage(k)
    this.emit()
  }
}

/** Synthetic order-book style depth around the mid price, scaled by pool liquidity. Deterministic per claim. */
export function buildDepth(c: ClaimDetail, outcome: 'yes' | 'no', now: number): DepthSnapshot {
  const quote = c.market?.outcomes.find((o) => o.label.toLowerCase() === outcome)
  const mid = quote?.price ?? (outcome === 'yes' ? (c.yesPrice ?? 0.5) : 1 - (c.yesPrice ?? 0.5))
  const L = Number(c.liquidity) || 0
  const rand = mulberry32(c.number * 1000 + (outcome === 'yes' ? 1 : 2))
  const step = Math.max(0.004, Math.min(0.02, mid * 0.06))
  const unit = (L * 0.5) / Math.max(mid, 0.05) / 40
  const bids: DepthLevel[] = []
  const asks: DepthLevel[] = []
  let cumBid = 0
  let cumAsk = 0
  for (let k = 1; k <= 10; k++) {
    const bp = mid - k * step
    const ap = mid + k * step
    if (bp > 0.001) {
      cumBid += unit * (0.6 + rand()) * (1 + k * 0.18)
      bids.push({ price: round(bp, 4), size: round(cumBid, 2), side: 'bid' })
    }
    if (ap < 0.999) {
      cumAsk += unit * (0.6 + rand()) * (1 + k * 0.18)
      asks.push({ price: round(ap, 4), size: round(cumAsk, 2), side: 'ask' })
    }
  }
  return {
    outcome,
    mid: round(mid, 4),
    levels: [...bids, ...asks],
    at: new Date(Math.floor(now / 60_000) * 60_000).toISOString(),
  }
}
