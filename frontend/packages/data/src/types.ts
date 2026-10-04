import type {
  Account,
  AccountPreferences,
  ActivityItem,
  ActivityQuery,
  Address,
  ClaimDetail,
  ClaimDraft,
  ClaimManifest,
  ClaimQuery,
  ClaimSummary,
  CommitSummary,
  DepthSnapshot,
  Evidence,
  GitHubUser,
  Hex,
  LinkedWallet,
  Page,
  PlatformStats,
  PolicyVersion,
  Portfolio,
  PricePoint,
  PriceRange,
  PullSummary,
  RepoSummary,
} from '@pine/core'

/** Which indexer backs reads. `api` is the Pine backend (`packages/api`), served same-origin under /api/v1. */
export type DataSourceKind = 'mock' | 'rest' | 'envio' | 'api'

/**
 * Read-side contract for indexed chain + off-chain state.
 * Implemented by MockDataProvider, RestDataProvider, EnvioDataProvider.
 * All methods resolve `null`/empty for missing data and throw `PineDataError` on transport failure.
 */
export interface PineDataProvider {
  readonly kind: DataSourceKind
  listClaims(q?: ClaimQuery): Promise<Page<ClaimSummary>>
  getClaim(id: string): Promise<ClaimDetail | null>
  getClaimByMarket(chainId: number, marketAddress: Address): Promise<ClaimDetail | null>
  getPriceHistory(claimId: string, range: PriceRange): Promise<PricePoint[]>
  getDepth(claimId: string, outcome: 'yes' | 'no'): Promise<DepthSnapshot | null>
  listEvidence(claimId: string): Promise<Evidence[]>
  listActivity(q?: ActivityQuery): Promise<Page<ActivityItem>>
  getPortfolio(address: Address): Promise<Portfolio>
  listPolicies(): Promise<PolicyVersion[]>
  getPolicy(id: string, version?: string): Promise<PolicyVersion | null>
  getStats(): Promise<PlatformStats>
}

/** GitHub read access. Live implementation calls api.github.com (optionally with the user's token via server proxy). */
export interface GitHubSource {
  readonly kind: 'live' | 'mock'
  getViewer(): Promise<GitHubUser | null>
  listViewerRepos(opts?: { cursor?: string; limit?: number }): Promise<Page<RepoSummary>>
  searchRepos(query: string): Promise<RepoSummary[]>
  getRepo(owner: string, repo: string): Promise<RepoSummary | null>
  listPulls(owner: string, repo: string, opts?: { state?: 'open' | 'closed' | 'all' }): Promise<PullSummary[]>
  getPull(owner: string, repo: string, number: number): Promise<PullSummary | null>
  listPullCommits(owner: string, repo: string, number: number): Promise<CommitSummary[]>
  listCommits(owner: string, repo: string, opts?: { ref?: string; limit?: number }): Promise<CommitSummary[]>
  getCommit(owner: string, repo: string, sha: string): Promise<CommitSummary | null>
}

/**
 * Parsed result of a pasted GitHub URL / shorthand. Re-exported from @pine/core, whose definition is
 * structurally identical plus an optional `short?: boolean` on commit refs (additive).
 */
export type { ParsedGitHubRef } from '@pine/core'

/** Durable content storage for manifests and evidence packages. */
export interface ManifestStorage {
  readonly kind: 'ipfs' | 'mock'
  /** Stores canonical JSON; returns ipfs:// URI and keccak256 content hash */
  putJson(value: unknown, name?: string): Promise<{ uri: string; cid: string; hash: Hex; gatewayUrl: string }>
  getJson<T = unknown>(uri: string): Promise<T>
  getManifest(uri: string): Promise<ClaimManifest>
  gatewayUrl(uri: string): string
}

/**
 * What `DraftStore.saveIfUnchanged` did: saved the draft, or saved nothing because the stored draft is no longer the
 * version this store last read or wrote (`base`, null when the store keeps no copy): another tab saved it (`current`)
 * or deleted it (`current: null`).
 */
export type DraftSaveResult =
  | { ok: true; draft: ClaimDraft }
  | { ok: false; current: ClaimDraft | null; base: ClaimDraft | null }

/**
 * Draft persistence (local storage in mock/envio modes, REST in rest mode). `updatedAt` is the draft's revision: every
 * save moves it forward. The local store also never lets a save take a stored draft's market or confirmed publication
 * steps away (a sealed draft stays sealed).
 */
export interface DraftStore {
  list(owner: string): Promise<ClaimDraft[]>
  get(id: string): Promise<ClaimDraft | null>
  save(draft: ClaimDraft): Promise<ClaimDraft>
  /**
   * Optimistic concurrency between tabs: saves only while the stored draft is still the version this store last read
   * (`get`) or wrote, or, for a draft it never saw stored, while none is stored. Otherwise it saves nothing, and the
   * stored draft becomes the version this store last saw: the caller adopts `current` before saving again. A draft
   * deleted elsewhere stays a conflict until the caller recreates it on purpose with `save`.
   */
  saveIfUnchanged(draft: ClaimDraft): Promise<DraftSaveResult>
  remove(id: string): Promise<void>
}

/** Account persistence (local in mock/envio, REST in rest mode). */
export interface AccountStore {
  get(githubLogin: string): Promise<Account | null>
  upsertFromGitHub(user: GitHubUser, scopes: string[], demo: boolean): Promise<Account>
  linkWallet(githubLogin: string, wallet: LinkedWallet): Promise<Account>
  unlinkWallet(githubLogin: string, address: Address): Promise<Account>
  setPrimaryWallet(githubLogin: string, address: Address): Promise<Account>
  updatePreferences(githubLogin: string, prefs: Partial<AccountPreferences>): Promise<Account>
  exportData(githubLogin: string): Promise<Record<string, unknown>>
  remove(githubLogin: string): Promise<void>
}

/** Pine's own contract deployment (the rest of the deployment manifest is the verified Gnosis constants). */
export interface PineDeploymentEnv {
  claimRegistry: Address
  evidenceRegistry: Address
  deploymentBlock: number
}

export interface PineEnv {
  dataSource: DataSourceKind
  apiUrl?: string
  /** `api` mode, server only: the internal origin of pine-api for SSR reads (PINE_API_INTERNAL_URL). */
  apiInternalUrl?: string
  /** `api` mode: Pine's deployment, pinned at build time, used to verify every transaction plan. */
  deployment?: PineDeploymentEnv
  envioGraphqlUrl?: string
  ipfsGateway: string
  ipfsUploadUrl?: string
  defaultChainId: number
  demoWallet: boolean
  siteUrl: string
  githubOAuthConfigured: boolean
}

export class PineDataError extends Error {
  constructor(
    message: string,
    readonly code: 'network' | 'not_found' | 'bad_response' | 'unauthorized' | 'rate_limited' | 'unsupported',
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'PineDataError'
  }
}
