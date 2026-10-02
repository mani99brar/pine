// Placeholder — full implementation lands with the Envio contract (docs/indexer/envio/schema.graphql).
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
import { PineDataError, type DataSourceKind, type PineDataProvider } from '../types'

export interface EnvioDataProviderOptions {
  url: string
  ipfsGateway?: string
  fetch?: typeof fetch
}

export class EnvioDataProvider implements PineDataProvider {
  readonly kind: DataSourceKind = 'envio'
  constructor(readonly opts: EnvioDataProviderOptions) {}
  private todo(): never {
    throw new PineDataError('Envio provider not implemented yet', 'unsupported')
  }
  listClaims(_q?: ClaimQuery): Promise<Page<ClaimSummary>> { return this.todo() }
  getClaim(_id: string): Promise<ClaimDetail | null> { return this.todo() }
  getClaimByMarket(_c: number, _a: Address): Promise<ClaimDetail | null> { return this.todo() }
  getPriceHistory(_id: string, _r: PriceRange): Promise<PricePoint[]> { return this.todo() }
  getDepth(_id: string, _o: 'yes' | 'no'): Promise<DepthSnapshot | null> { return this.todo() }
  listEvidence(_id: string): Promise<Evidence[]> { return this.todo() }
  listActivity(_q?: ActivityQuery): Promise<Page<ActivityItem>> { return this.todo() }
  getPortfolio(_a: Address): Promise<Portfolio> { return this.todo() }
  listPolicies(): Promise<PolicyVersion[]> { return this.todo() }
  getPolicy(_id: string, _v?: string): Promise<PolicyVersion | null> { return this.todo() }
  getStats(): Promise<PlatformStats> { return this.todo() }
}
