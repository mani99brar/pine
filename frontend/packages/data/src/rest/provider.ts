import type {
  ActivityItem,
  ActivityQuery,
  Address,
  ClaimDetail,
  ClaimQuery,
  ClaimSummary,
  DepthSnapshot,
  Evidence,
  Page,
  PlatformStats,
  PolicyVersion,
  Portfolio,
  PricePoint,
  PriceRange,
} from '@pine/core'
import type { DataSourceKind, PineDataProvider } from '../types'
import { RestClient, type TokenGetter } from './http'
import {
  activityFromWire,
  claimDetailFromWire,
  claimSummaryFromWire,
  depthFromWire,
  evidenceFromWire,
  pageFromWire,
  policyFromWire,
  portfolioFromWire,
  pricesFromWire,
  statsFromWire,
  type WireActivity,
  type WireClaimDetail,
  type WireClaimSummary,
  type WireDepth,
  type WireEvidence,
  type WirePage,
  type WirePolicy,
  type WirePortfolio,
  type WirePriceHistory,
  type WireStats,
} from './wire'

export interface RestDataProviderOptions {
  /** e.g. https://api.pine.example/v1 (NEXT_PUBLIC_PINE_API_URL) */
  baseUrl: string
  fetch?: typeof fetch
  headers?: Record<string, string>
  getToken?: TokenGetter
}

const enc = encodeURIComponent

/**
 * Reads the Pine REST indexer described by docs/indexer/rest-api.openapi.yaml and maps its
 * snake_case wire format to domain types. Transport/HTTP failures throw PineDataError; 404 on
 * single-resource endpoints resolves to `null`.
 */
export class RestDataProvider implements PineDataProvider {
  readonly kind: DataSourceKind = 'rest'
  readonly client: RestClient

  constructor(opts: RestDataProviderOptions) {
    this.client = new RestClient(opts)
  }

  async listClaims(q: ClaimQuery = {}): Promise<Page<ClaimSummary>> {
    const status = q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status]
    const page = await this.client.get<WirePage<WireClaimSummary>>('/claims', {
      status,
      outcome: q.outcome,
      policy_id: q.policyId,
      family: q.family,
      repo: q.repo,
      creator: q.creator,
      chain_id: q.chainId,
      search: q.search?.trim() || undefined,
      sort: q.sort,
      cursor: q.cursor,
      limit: q.limit,
    })
    return pageFromWire(page, claimSummaryFromWire)
  }

  async getClaim(id: string): Promise<ClaimDetail | null> {
    const w = await this.client.getOrNull<WireClaimDetail>(`/claims/${enc(id)}`)
    return w ? claimDetailFromWire(w) : null
  }

  async getClaimByMarket(chainId: number, marketAddress: Address): Promise<ClaimDetail | null> {
    const w = await this.client.getOrNull<WireClaimDetail>(`/markets/${chainId}/${enc(marketAddress.toLowerCase())}/claim`)
    return w ? claimDetailFromWire(w) : null
  }

  async getPriceHistory(claimId: string, range: PriceRange): Promise<PricePoint[]> {
    const w = await this.client.getOrNull<WirePriceHistory>(`/claims/${enc(claimId)}/prices`, { range })
    return w ? pricesFromWire(w) : []
  }

  async getDepth(claimId: string, outcome: 'yes' | 'no'): Promise<DepthSnapshot | null> {
    const w = await this.client.getOrNull<WireDepth>(`/claims/${enc(claimId)}/depth`, { outcome })
    return w ? depthFromWire(w) : null
  }

  async listEvidence(claimId: string): Promise<Evidence[]> {
    const w = await this.client.getOrNull<{ items: WireEvidence[] }>(`/claims/${enc(claimId)}/evidence`)
    return (w?.items ?? []).map(evidenceFromWire)
  }

  async listActivity(q: ActivityQuery = {}): Promise<Page<ActivityItem>> {
    const page = await this.client.get<WirePage<WireActivity>>('/activity', {
      claim_id: q.claimId,
      account: q.account,
      types: q.types && q.types.length > 0 ? q.types : undefined,
      cursor: q.cursor,
      limit: q.limit,
    })
    return pageFromWire(page, activityFromWire)
  }

  async getPortfolio(address: Address): Promise<Portfolio> {
    return portfolioFromWire(await this.client.get<WirePortfolio>(`/portfolio/${enc(address.toLowerCase())}`))
  }

  async listPolicies(): Promise<PolicyVersion[]> {
    const w = await this.client.get<{ items: WirePolicy[] }>('/policies')
    return (w.items ?? []).map(policyFromWire)
  }

  async getPolicy(id: string, version?: string): Promise<PolicyVersion | null> {
    const w = await this.client.getOrNull<WirePolicy>(`/policies/${enc(id)}`, { version })
    return w ? policyFromWire(w) : null
  }

  async getStats(): Promise<PlatformStats> {
    return statsFromWire(await this.client.get<WireStats>('/stats'))
  }
}
