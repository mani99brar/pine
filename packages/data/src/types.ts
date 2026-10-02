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

/** Which indexer backs reads. */
export type DataSourceKind = 'mock' | 'rest' | 'envio'

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

/** Parsed result of a pasted GitHub URL / shorthand. */
export type ParsedGitHubRef =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'pull'; owner: string; repo: string; number: number }
  | { kind: 'commit'; owner: string; repo: string; sha: string }
  | { kind: 'pull_commit'; owner: string; repo: string; number: number; sha: string }

/** Durable content storage for manifests and evidence packages. */
export interface ManifestStorage {
  readonly kind: 'ipfs' | 'mock'
  /** Stores canonical JSON; returns ipfs:// URI and keccak256 content hash */
  putJson(value: unknown, name?: string): Promise<{ uri: string; cid: string; hash: Hex; gatewayUrl: string }>
  getJson<T = unknown>(uri: string): Promise<T>
  getManifest(uri: string): Promise<ClaimManifest>
  gatewayUrl(uri: string): string
}

/** Draft persistence (local storage in mock/envio modes, REST in rest mode). */
export interface DraftStore {
  list(owner: string): Promise<ClaimDraft[]>
  get(id: string): Promise<ClaimDraft | null>
  save(draft: ClaimDraft): Promise<ClaimDraft>
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

export interface PineEnv {
  dataSource: DataSourceKind
  apiUrl?: string
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
