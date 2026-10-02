import {
  POLICIES,
  getChainOrDefault,
  getPolicy as corePolicy,
  hashJson,
  type ActivityItem,
  type ActivityQuery,
  type Address,
  type ClaimDetail,
  type ClaimManifest,
  type ClaimQuery,
  type ClaimSort,
  type ClaimSummary,
  type DepthSnapshot,
  type Evidence,
  type LiquidityPosition,
  type OutcomePosition,
  type Page,
  type PlatformStats,
  type PolicyVersion,
  type Portfolio,
  type PricePoint,
  type PriceRange,
} from '@pine/core'
import { DEFAULT_IPFS_GATEWAY } from '../env'
import { clone, mulDecimal, sumDecimal } from '../internal/util'
import { IpfsManifestStorage } from '../storage/manifest'
import { PineDataError, type DataSourceKind, type ManifestStorage, type PineDataProvider } from '../types'
import { envioQuery } from './client'
import {
  activityFromEnvio,
  claimDetailFromEnvio,
  claimSummaryFromEnvio,
  dec,
  depthFromPool,
  deriveEnvioStatus,
  evidenceFromEnvio,
  outcomeWhere,
  pricePointsFromEnvio,
  statusWhere,
  type EnvioActivity,
  type EnvioClaimDetail,
  type EnvioClaimSummary,
  type EnvioEvidence,
  type EnvioPhase,
  type EnvioPool,
} from './mappers'
import {
  CLAIM_DETAIL,
  CLAIM_REF,
  EVIDENCE_BY_QUESTION,
  LIST_ACTIVITY,
  LIST_CLAIMS,
  POOL_FOR_DEPTH,
  PORTFOLIO,
  PRICE_CANDLES,
  STATS,
} from './queries'

export interface EnvioDataProviderOptions {
  /** NEXT_PUBLIC_ENVIO_GRAPHQL_URL, e.g. https://indexer.hyperindex.xyz/<hash>/v1/graphql */
  url: string
  /** Gateway for manifest hydration when the indexer did not store the manifest JSON */
  ipfsGateway?: string
  fetch?: typeof fetch
  storage?: ManifestStorage
  now?: () => number
}

const RANGE_SECONDS: Record<PriceRange, number> = { '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400, all: Number.POSITIVE_INFINITY }

// Each ordering ends with the unique id so offset pagination is stable across ties.
const ORDER_BY: Record<ClaimSort, Record<string, string>[]> = {
  newest: [{ createdAt: 'desc' }, { id: 'asc' }],
  deadline: [{ evidenceDeadlineTs: 'asc' }, { id: 'asc' }],
  liquidity: [{ liquidity: 'desc' }, { id: 'asc' }],
  volume: [{ volume: 'desc' }, { id: 'asc' }],
  yes_price: [{ yesPrice: 'desc_nulls_last' }, { id: 'asc' }],
  activity: [{ lastActivityAt: 'desc' }, { id: 'asc' }],
}

const isEnvioId = (id: string) => /^\d+:0x[0-9a-fA-F]{40}$/.test(id)

function normalizeClaimId(id: string): string {
  const s = id.trim().toLowerCase()
  const m = /^(?:pine-)?0*(\d+)$/.exec(s)
  return m ? `pine-${m[1]!.padStart(4, '0')}` : s
}

/**
 * Reads on-chain state from an Envio HyperIndex built on docs/indexer/envio/schema.graphql.
 * - Lifecycle status is derived client-side from indexed facts at the current time.
 * - Manifests come from the indexer's `manifest` JSON when present, otherwise from IPFS.
 * - Policies come from the @pine/core catalog (policies are versioned in code, not on-chain).
 * - Drafts, accounts and partial publications are not on-chain: use the local stores in envio mode.
 */
export class EnvioDataProvider implements PineDataProvider {
  readonly kind: DataSourceKind = 'envio'
  private readonly fetcher: typeof fetch
  private readonly storage: ManifestStorage
  private readonly now: () => number
  private readonly manifestCache = new Map<string, ClaimManifest>()

  constructor(private readonly opts: EnvioDataProviderOptions) {
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
    this.storage = opts.storage ?? new IpfsManifestStorage({ ipfsGateway: opts.ipfsGateway ?? DEFAULT_IPFS_GATEWAY }, { fetch: this.fetcher })
    this.now = opts.now ?? (() => Date.now())
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  private q<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return envioQuery<T>(this.opts.url, query, variables, this.fetcher)
  }

  /** Hasura `where` for a ClaimQuery (exported for tests and the README). */
  buildClaimWhere(q: ClaimQuery, nowSec = this.nowSec()): Record<string, unknown> | null {
    const and: Record<string, unknown>[] = []
    if (q.status !== undefined) {
      const statuses = Array.isArray(q.status) ? q.status : [q.status]
      if (statuses.length > 0) {
        const ors = statuses.map((s) => statusWhere(s, nowSec)).filter((w): w is Record<string, unknown> => w !== null)
        if (ors.length === 0) return null // only off-chain statuses requested
        and.push(ors.length === 1 ? (ors[0] as Record<string, unknown>) : { _or: ors })
      }
    }
    if (q.outcome) and.push(outcomeWhere(q.outcome, nowSec))
    if (q.policyId) and.push({ policyId: { _eq: q.policyId.toUpperCase() } })
    if (q.family) and.push({ policyFamily: { _eq: q.family } })
    if (q.repo) and.push({ repo: { _eq: q.repo.toLowerCase() } })
    if (q.creator) and.push({ creator: { _eq: q.creator.toLowerCase() } })
    if (q.chainId !== undefined) and.push({ chainId: { _eq: q.chainId } })
    for (const term of (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      and.push({ searchText: { _ilike: `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%` } })
    }
    return and.length === 0 ? {} : and.length === 1 ? (and[0] as Record<string, unknown>) : { _and: and }
  }

  async listClaims(q: ClaimQuery = {}): Promise<Page<ClaimSummary>> {
    const nowSec = this.nowSec()
    const where = this.buildClaimWhere(q, nowSec)
    if (where === null) return { items: [], total: 0 }
    const limit = Math.min(Math.max(1, q.limit ?? 20), 100)
    const offset = Math.max(0, Number.parseInt(q.cursor ?? '0', 10) || 0)
    const data = await this.q<{ Claim: EnvioClaimSummary[] }>(LIST_CLAIMS, {
      where,
      orderBy: ORDER_BY[q.sort ?? 'newest'],
      limit: limit + 1,
      offset,
    })
    const rows = data.Claim ?? []
    const hasMore = rows.length > limit
    return { items: rows.slice(0, limit).map((c) => claimSummaryFromEnvio(c, nowSec)), nextCursor: hasMore ? String(offset + limit) : undefined }
  }

  /**
   * The claim's terms: the indexer-stored manifest or the IPFS document. Either way it must hash to the
   * on-chain manifestHash; otherwise the content is not the published terms and is rejected.
   */
  private async hydrateManifest(c: EnvioClaimDetail): Promise<ClaimManifest> {
    if (c.manifestValid === false) {
      throw new PineDataError(`The indexer could not verify the manifest of ${c.claimId}; its terms cannot be shown`, 'bad_response')
    }
    const expected = c.manifestHash.toLowerCase()
    const verified = (m: unknown): m is ClaimManifest =>
      !!m && typeof m === 'object' && (m as ClaimManifest).manifestVersion === '1' && hashJson(m).toLowerCase() === expected
    if (verified(c.manifest)) return c.manifest
    const cached = this.manifestCache.get(expected)
    if (cached) return cached
    const m = await this.storage.getManifest(c.manifestUri)
    if (!verified(m)) {
      throw new PineDataError(`Manifest at ${c.manifestUri} does not match keccak256 ${c.manifestHash}`, 'bad_response')
    }
    this.manifestCache.set(expected, m)
    return m
  }

  private async detailBy(where: Record<string, unknown>): Promise<ClaimDetail | null> {
    const data = await this.q<{ Claim: Omit<EnvioClaimDetail, 'evidence'>[] }>(CLAIM_DETAIL, { where })
    const row = data.Claim?.[0]
    if (!row) return null
    // Evidence is matched by Reality question id: it can be indexed before the claim link exists.
    const questionId = row.market?.realityQuestionId ?? row.question?.questionId
    const [manifest, evidence] = await Promise.all([
      this.hydrateManifest({ ...row, evidence: [] }),
      questionId
        ? this.q<{ Evidence: EnvioEvidence[] }>(EVIDENCE_BY_QUESTION, { questionId: questionId.toLowerCase() }).then((d) => d.Evidence ?? [])
        : Promise.resolve([] as EnvioEvidence[]),
    ])
    return claimDetailFromEnvio({ ...row, evidence }, manifest, this.nowSec())
  }

  getClaim(id: string): Promise<ClaimDetail | null> {
    return this.detailBy(isEnvioId(id) ? { id: { _eq: id.toLowerCase() } } : { claimId: { _eq: normalizeClaimId(id) } })
  }

  getClaimByMarket(chainId: number, marketAddress: Address): Promise<ClaimDetail | null> {
    return this.detailBy({ id: { _eq: `${chainId}:${marketAddress.toLowerCase()}` } })
  }

  private async claimRef(id: string): Promise<{ id: string; claimId: string; deadline: number; questionId?: string } | null> {
    const where = isEnvioId(id) ? { id: { _eq: id.toLowerCase() } } : { claimId: { _eq: normalizeClaimId(id) } }
    const data = await this.q<{ Claim: { id: string; claimId: string; evidenceDeadlineTs: string; market?: { realityQuestionId: string } | null }[] }>(CLAIM_REF, { where })
    const c = data.Claim?.[0]
    return c ? { id: c.id, claimId: c.claimId, deadline: Number(c.evidenceDeadlineTs), questionId: c.market?.realityQuestionId } : null
  }

  async getPriceHistory(claimId: string, range: PriceRange): Promise<PricePoint[]> {
    const ref = await this.claimRef(claimId)
    if (!ref) return []
    const span = RANGE_SECONDS[range]
    const from = Number.isFinite(span) ? Math.max(0, this.nowSec() - span) : 0
    const data = await this.q<{ PriceCandle: { periodStart: string; yesClose: number; noClose: number; volume?: string | null }[] }>(PRICE_CANDLES, {
      claim: ref.id,
      from: String(from),
    })
    // newest first from the indexer (so the 5000-row cap drops the oldest), oldest first to callers
    return pricePointsFromEnvio([...(data.PriceCandle ?? [])].reverse())
  }

  async getDepth(claimId: string, outcome: 'yes' | 'no'): Promise<DepthSnapshot | null> {
    const ref = await this.claimRef(claimId)
    if (!ref) return null
    const data = await this.q<{ Pool: EnvioPool[] }>(POOL_FOR_DEPTH, { claim: ref.id, outcomeIndex: outcome === 'yes' ? 0 : 1 })
    const pool = data.Pool?.[0]
    return pool ? depthFromPool(pool, outcome, this.nowSec()) : null
  }

  async listEvidence(claimId: string): Promise<Evidence[]> {
    const ref = await this.claimRef(claimId)
    if (!ref?.questionId) return []
    const data = await this.q<{ Evidence: EnvioEvidence[] }>(EVIDENCE_BY_QUESTION, { questionId: ref.questionId.toLowerCase() })
    return (data.Evidence ?? []).map((e) => evidenceFromEnvio(e, ref.claimId, ref.deadline))
  }

  async listActivity(q: ActivityQuery = {}): Promise<Page<ActivityItem>> {
    const and: Record<string, unknown>[] = []
    if (q.claimId) and.push(isEnvioId(q.claimId) ? { claim_id: { _eq: q.claimId.toLowerCase() } } : { claim: { claimId: { _eq: normalizeClaimId(q.claimId) } } })
    if (q.account) and.push({ actor: { _eq: q.account.toLowerCase() } })
    if (q.types && q.types.length > 0) and.push({ type: { _in: q.types } })
    const where = and.length === 0 ? {} : and.length === 1 ? and[0] : { _and: and }
    const limit = Math.min(Math.max(1, q.limit ?? 25), 200)
    const offset = Math.max(0, Number.parseInt(q.cursor ?? '0', 10) || 0)
    const data = await this.q<{ ActivityEvent: EnvioActivity[] }>(LIST_ACTIVITY, { where, limit: limit + 1, offset })
    const rows = data.ActivityEvent ?? []
    return { items: rows.slice(0, limit).map(activityFromEnvio), nextCursor: rows.length > limit ? String(offset + limit) : undefined }
  }

  async getPortfolio(address: Address): Promise<Portfolio> {
    const nowSec = this.nowSec()
    type Row = {
      Account_by_pk: {
        depositedAllTime: string
        withdrawnAllTime: string
        feesPaidAllTime: string
        positions: {
          outcomeIndex: number
          balance: string
          avgPrice?: number | null
          claim: {
            claimId: string
            number: number
            title: string
            phase: EnvioPhase
            finalizeTs?: string | null
            currentAnswer?: string | null
            outcome?: 'yes' | 'no' | 'invalid' | null
            evidenceDeadlineTs: string
            yesPrice?: number | null
            noPrice?: number | null
            invalidPrice?: number | null
          }
        }[]
        liquidityPositions: {
          tokenId: string
          outcomeIndex: number
          depositedCollateral: string
          currentValue: string
          feesEarned: string
          inRange: boolean
          pool: { address: string }
          claim: { claimId: string; number: number; title: string }
        }[]
      } | null
    }
    const data = await this.q<Row>(PORTFOLIO, { id: address.toLowerCase() })
    const acc = data.Account_by_pk
    if (!acc) {
      return { address, positions: [], liquidity: [], totals: { positionsValue: '0', liquidityValue: '0', redeemable: '0', depositedAllTime: '0', withdrawnAllTime: '0', feesPaidAllTime: '0' } }
    }
    const outcomes = ['yes', 'no', 'invalid'] as const
    const positions: OutcomePosition[] = acc.positions
      .filter((p) => p.outcomeIndex >= 0 && p.outcomeIndex <= 2)
      .map((p) => {
        const outcome = outcomes[p.outcomeIndex] as 'yes' | 'no' | 'invalid'
        const { status, outcome: final } = deriveEnvioStatus(p.claim, nowSec)
        const live = outcome === 'yes' ? p.claim.yesPrice : outcome === 'no' ? p.claim.noPrice : p.claim.invalidPrice
        const mark = final ? (final === outcome ? 1 : 0) : (live ?? 0)
        const balance = dec(p.balance)
        const value = mulDecimal(balance, mark, 6)
        const redeemable = !!final && final === outcome
        return {
          claimId: p.claim.claimId,
          claimNumber: p.claim.number,
          claimTitle: p.claim.title,
          status,
          outcome,
          balance,
          ...(p.avgPrice !== null && p.avgPrice !== undefined ? { avgPrice: p.avgPrice } : {}),
          markPrice: mark,
          value,
          redeemable,
          ...(redeemable ? { redeemableAmount: balance } : {}),
        }
      })
    const liquidity: LiquidityPosition[] = acc.liquidityPositions
      .filter((l) => l.outcomeIndex === 0 || l.outcomeIndex === 1) // Invalid-result pools are not shown as YES/NO liquidity
      .map((l) => ({
      claimId: l.claim.claimId,
      claimNumber: l.claim.number,
      claimTitle: l.claim.title,
      tokenId: String(l.tokenId),
      pool: l.pool.address.toLowerCase() as Address,
      outcome: l.outcomeIndex === 0 ? 'yes' : 'no',
      deposited: dec(l.depositedCollateral),
      currentValue: dec(l.currentValue),
      feesEarned: dec(l.feesEarned),
      withdrawable: true,
      inRange: l.inRange,
    }))
    const sum = (xs: string[]) => sumDecimal(xs, 6)
    return {
      address,
      positions,
      liquidity,
      totals: {
        positionsValue: sum(positions.map((p) => p.value)),
        liquidityValue: sum(liquidity.map((l) => l.currentValue)),
        redeemable: sum(positions.map((p) => p.redeemableAmount ?? '0')),
        depositedAllTime: dec(acc.depositedAllTime),
        withdrawnAllTime: dec(acc.withdrawnAllTime),
        feesPaidAllTime: dec(acc.feesPaidAllTime),
      },
    }
  }

  async listPolicies(): Promise<PolicyVersion[]> {
    return clone(POLICIES)
  }

  async getPolicy(id: string, version?: string): Promise<PolicyVersion | null> {
    const p = corePolicy(id.toUpperCase(), version)
    return p ? clone(p) : null
  }

  async getStats(): Promise<PlatformStats> {
    const nowSec = this.nowSec()
    const data = await this.q<{
      PlatformStats_by_pk: {
        claimCount: number
        resolvedClaims: number
        counterexamplesAccepted: number
        evidenceSubmissions: number
        totalLiquidity: string
        volumeTotal: string
        collateralSymbol: string
      } | null
      DailyStats: { dayStart: string; volume: string }[]
      open: { id: string }[]
    }>(STATS, { since: String(nowSec - 30 * 86_400), openWhere: statusWhere('open', nowSec) })
    // A fresh indexer has no PlatformStats row yet: report zeros rather than failing the page.
    const s = data.PlatformStats_by_pk ?? {
      claimCount: 0,
      resolvedClaims: 0,
      counterexamplesAccepted: 0,
      evidenceSubmissions: 0,
      totalLiquidity: '0',
      volumeTotal: '0',
      collateralSymbol: getChainOrDefault(undefined).collateral.symbol,
    }
    const vol = sumDecimal((data.DailyStats ?? []).map((d) => dec(d.volume)), 6)
    return {
      openClaims: data.open?.length ?? 0,
      resolvedClaims: s.resolvedClaims,
      totalLiquidity: dec(s.totalLiquidity),
      volume30d: vol,
      evidenceSubmissions: s.evidenceSubmissions,
      counterexamplesAccepted: s.counterexamplesAccepted,
      collateralSymbol: s.collateralSymbol,
    }
  }
}
