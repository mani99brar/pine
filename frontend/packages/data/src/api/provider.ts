import type {
  ActivityItem,
  ActivityQuery,
  Address,
  ClaimQuery,
  ClaimSort,
  ClaimStatus,
  DepthSnapshot,
  Outcome,
  Page,
  PlatformStats,
  PolicyVersion,
  Portfolio,
  PricePoint,
} from '@pine/core'
import type { ClaimDocument } from '@pine/core/pine-shared'
import { PineDataError, type DataSourceKind, type PineDataProvider } from '../types'
import { PineApiClient, PineBackendError, seg } from './http'
import {
  activityFromApi,
  API_CHAIN_ID,
  claimDetailFromApi,
  claimStatusOf,
  claimSummaryFromApi,
  depthFromApi,
  evidenceFromApi,
  holdingsFromApi,
  policyRefOf,
  portfolioFromHoldings,
  verifiedClaimDocument,
  type ApiClaimDetail,
  type ApiClaimSummary,
  type ApiEvidence,
  type ApiLiquidityPosition,
} from './mappers'
import { compareVersions, policyFromApi } from './policies'
import {
  activityViewSchema,
  agentClaimSchema,
  claimDetailSchema,
  claimListSchema,
  evidenceListSchema,
  githubRepoSchema,
  liquidityViewSchema,
  oracleViewSchema,
  policyDetailSchema,
  policyListSchema,
  policyParametersSchema,
  positionsViewSchema,
  type WireAgentClaim,
  type WireClaimView,
  type WireEvidenceItem,
  type WireListedClaim,
  type WirePolicyDetail,
  type WirePolicyParameters,
  type WirePolicySummary,
  type WirePositionsView,
} from './read-schemas'

export interface ApiDataProviderOptions {
  /** "" in the browser (same origin); the internal API origin on the server. Ignored when `client` is given. */
  baseUrl?: string
  client?: PineApiClient
  fetch?: typeof fetch
  /** No backend reachable (SSR without PINE_API_INTERNAL_URL): every read resolves empty or null without a request. */
  offline?: boolean
  /**
   * Resolve `ClaimQuery.repo` (owner/name) to GitHub's repository id through the backend GitHub route, which needs the
   * browser's session cookie and a linked GitHub account. Default true; server providers set false (no cookie there).
   */
  resolveRepositories?: boolean
  /**
   * Server providers only: the visitor's IP address as the trusted edge proxy set it (nginx `X-Forwarded-For
   * $remote_addr`), sent to pine-api as `X-Forwarded-For` so its per-IP limits count server-rendered reads per visitor
   * instead of in one bucket shared by every visitor. Forwarded only when it is exactly one IPv4/IPv6 literal
   * (ipAddressLiteral); no other client header is ever forwarded. Ignored when `client` is given.
   */
  forwardedFor?: string | null
  /** Clock in milliseconds (tests inject one). */
  now?: () => number
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * `value` when it is exactly one IPv4 address in dotted decimal (no leading zeros) or one IPv6 address (RFC 4291 text,
 * IPv4 suffix allowed), else null: no list, port, brackets, zone, hostname, whitespace or other characters.
 */
export function ipAddressLiteral(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 45) return null
  if (IPV4.test(value)) return value
  if (!value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return null
  try {
    // The WHATWG URL parser implements the IPv6 address grammar exactly (one "::", 8 pieces, a strict IPv4 tail).
    void new URL(`http://[${value}]/`)
    return value
  } catch {
    return null
  }
}

/** `fetch` that adds `X-Forwarded-For: <ip>` (a validated literal) to every request. */
function forwardingFetch(fetcher: typeof fetch | undefined, ip: string): typeof fetch {
  const base: typeof fetch = fetcher ?? ((...args) => fetch(...args))
  return (input, init) => base(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), 'x-forwarded-for': ip } })
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/
const POLICY_ID = /^[A-Z]{2,8}-\d{3}$/
const SEMVER = /^\d+\.\d+\.\d+$/

/** GET /api/v1/claims accepts limit 1..25 (strict query schema). */
const LIST_LIMIT_MAX = 25
const LIST_LIMIT_DEFAULT = 20
const LIST_CURSOR_MAX = 200
/**
 * Backend pages read per listClaims call (at most 100 claims scanned): moderation and the filters applied here can
 * leave a backend page short or empty while its cursor continues, so pages are read until the limit is filled.
 */
const LIST_PAGES_MAX = 4
const ACTIVITY_CURSOR_MAX = 2_048
/** Parallel claim-document reads when a listing page is enriched (each is one agent-feed request). */
const DOCUMENT_CONCURRENCY = 4
const DOCUMENT_CACHE_MAX = 256
/** Evidence pages (50 each) and position pages (20 NFTs each, 200 scanned at most) read per call: bounded loops. */
const EVIDENCE_PAGES_MAX = 10
const POSITION_PAGES_MAX = 10
const PORTFOLIO_MARKETS_MAX = 20
/** The positions and liquidity routes allow 4 concurrent cache misses per process: stay well below. */
const PORTFOLIO_CONCURRENCY = 2
const CATALOG_TTL_MS = 60_000
/** GitHub's answer for owner/name: an id is kept 10 minutes (renames and transfers), "no public repository" 1 minute. */
const REPOSITORY_ID_TTL_MS = 600_000
const REPOSITORY_MISS_TTL_MS = 60_000
const REPOSITORY_LOOKUPS_MAX = 256

const REPOSITORY_FILTER_NEEDS_GITHUB =
  'Filtering claims by repository needs a signed-in account with a linked GitHub account: GitHub resolves owner/name to the repository id that claims pin on chain.'

type ListingPhase = 'evidence_open' | 'reveal_open' | 'closed'

/**
 * Backend listing phases that can hold claims of each frontend status (none: never on the backend). `closed` means the
 * reveal deadline has passed (oracle open, arbitration, finalized, resolved); a claim in its reveal window is
 * `awaiting_answer` (claimStatusOf), never `open`.
 */
const STATUS_PHASES: Record<ClaimStatus, readonly ListingPhase[]> = {
  draft: [],
  publishing: [],
  failed: [],
  open: ['evidence_open'],
  awaiting_answer: ['reveal_open', 'closed'],
  answer_proposed: ['closed'],
  disputed: ['closed'],
  arbitration: ['closed'],
  resolved: ['closed'],
  settled: ['closed'],
}

function addressOf(value: string | undefined): Address | null {
  return value !== undefined && ADDRESS.test(value) ? (value.toLowerCase() as Address) : null
}

function emptyPortfolio(address: Address): Portfolio {
  return {
    address,
    positions: [],
    liquidity: [],
    totals: { positionsValue: '0', liquidityValue: '0', redeemable: '0', depositedAllTime: '0', withdrawnAllTime: '0', feesPaidAllTime: '0' },
  }
}

function optional<T>(p: Promise<T>): Promise<T | null> {
  return p.catch(() => null)
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function hiddenView(v: Pick<WireClaimView, 'hidden' | 'moderation' | 'contentModeration'>): boolean {
  return v.hidden || v.moderation !== null || v.contentModeration !== null
}

function hiddenAgent(a: WireAgentClaim): boolean {
  const p = a.item.platform
  return p.hidden || p.moderation !== null || p.contentModeration !== null
}

interface ClaimQueryPlan {
  /** The backend's listing filters, in URL order (each page request adds its cursor and limit). */
  filters: { phase?: ListingPhase; repositoryId?: number; creator?: Address }
  cursor?: string
  /** Claims wanted in this page: 1..25. Backend pages are read until they are found (bounded). */
  limit: number
  statuses: ReadonlySet<ClaimStatus> | null
  outcome?: Outcome
  /** Lowercase owner/name whose GitHub repository id is still needed (no trusted id was given). */
  repo?: { owner: string; name: string }
}

function isRepositoryId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * ClaimQuery → the backend's strict listing query (phase, repositoryId, creator, cursor, limit ≤ 25; nothing else is
 * ever sent), plus the filters applied to the returned page. Null when nothing can match (draft/publishing/failed
 * statuses, another chain, malformed creator/repo/repository id/cursor), so no request is made.
 *
 * A repository filter uses only a trusted numeric id: `q.repositoryId`, or `resolvedRepositoryId` (GitHub's answer for
 * `q.repo`). Without one the plan carries `repo` for the caller to resolve; owner/name stated in claim documents are
 * never used to filter or to learn ids (SEC-GH-12).
 */
export function planClaimQuery(q: ClaimQuery, resolvedRepositoryId?: number): ClaimQueryPlan | null {
  if (q.chainId !== undefined && q.chainId !== API_CHAIN_ID) return null
  const statuses = q.status === undefined ? [] : Array.isArray(q.status) ? q.status : [q.status]
  // null: every phase. One request carries at most one phase; several are filtered on the page.
  let phases: Set<ListingPhase> | null = statuses.length > 0 ? new Set(statuses.flatMap((s) => STATUS_PHASES[s] ?? [])) : null
  if (q.outcome) {
    // An outcome exists only once the reveal deadline has passed.
    phases = new Set<ListingPhase>(!phases || phases.has('closed') ? ['closed'] : [])
  }
  if (phases?.size === 0) return null
  const phase = phases?.size === 1 ? [...phases][0] : undefined
  let creator: Address | undefined
  if (q.creator !== undefined) {
    const c = addressOf(q.creator)
    if (!c) return null
    creator = c
  }
  let repositoryId: number | undefined
  let repo: { owner: string; name: string } | undefined
  if (q.repositoryId !== undefined) {
    if (!isRepositoryId(q.repositoryId)) return null
    repositoryId = q.repositoryId
  } else if (q.repo !== undefined) {
    const [, owner, name] = REPO.exec(q.repo) ?? []
    if (!owner || !name || name === '.' || name === '..') return null
    if (resolvedRepositoryId === undefined) repo = { owner: owner.toLowerCase(), name: name.toLowerCase() }
    else if (isRepositoryId(resolvedRepositoryId)) repositoryId = resolvedRepositoryId
    else return null
  }
  if (q.cursor !== undefined && q.cursor.length > LIST_CURSOR_MAX) return null
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? LIST_LIMIT_DEFAULT) || 1), LIST_LIMIT_MAX)
  return {
    filters: {
      ...(phase ? { phase } : {}),
      ...(repositoryId !== undefined ? { repositoryId } : {}),
      ...(creator ? { creator } : {}),
    },
    ...(q.cursor ? { cursor: q.cursor } : {}),
    limit,
    statuses: statuses.length > 0 ? new Set(statuses) : null,
    ...(q.outcome ? { outcome: q.outcome } : {}),
    ...(repo ? { repo } : {}),
  }
}

/** Filters on platform facts (status, outcome, policy, repository id): applied before any claim document is read. */
function matchesPlatform(c: ApiClaimSummary, q: ClaimQuery, plan: ClaimQueryPlan): boolean {
  if (plan.statuses && !plan.statuses.has(c.status)) return false
  if (plan.outcome && c.outcome !== plan.outcome) return false
  // An unknown policy matches no policy or family filter (its family is a placeholder).
  if ((q.policyId || q.family) && c.policy.unknown) return false
  if (q.policyId && c.policy.id !== q.policyId.trim().toUpperCase()) return false
  if (q.family && c.policy.family !== q.family) return false
  // The backend filters by repository id; the on-chain id of every returned claim must agree.
  if (plan.filters.repositoryId !== undefined && c.api.repositoryId !== plan.filters.repositoryId) return false
  return true
}

/** Search terms over the title, the document's violation and stated repository, policy, commit, market and creator. */
function matchesSearch(c: ApiClaimSummary, q: ClaimQuery): boolean {
  const terms = (q.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = [c.title, c.violation, c.policy.id, `${c.source.owner}/${c.source.repo}`, c.source.commitSha, c.marketAddress ?? '', c.creator].join(' ').toLowerCase()
  return terms.every((t) => haystack.includes(t))
}

/**
 * Sorting applies to the returned page only. `newest` is the backend order; `deadline` sorts by evidence deadline;
 * liquidity, volume, yes_price and activity have no data in listings and keep the backend order.
 */
function sortClaims(items: ApiClaimSummary[], sort: ClaimSort | undefined): ApiClaimSummary[] {
  if (sort === 'deadline') return [...items].sort((a, b) => a.api.evidenceDeadline - b.api.evidenceDeadline)
  return items
}

/**
 * Pine backend (`packages/api`, same-origin `/api/v1`) as a PineDataProvider. Claims are identified by their Seer
 * market address; every response is validated with zod (malformed → PineBackendError BAD_RESPONSE); user-supplied text
 * is shown only from documents that match their on-chain digests, never for moderated claims or evidence nor for claims
 * that are not integrity-verified. Server-side instances call public GET routes only and never carry cookies.
 */
export class ApiDataProvider implements PineDataProvider {
  readonly kind: DataSourceKind = 'api'
  /** Null when offline (no backend configured for this runtime). */
  readonly client: PineApiClient | null
  private readonly now: () => number
  private catalogCache: { at: number; value: Promise<WirePolicySummary[]> } | null = null
  private readonly policyDetails = new Map<string, Promise<WirePolicyDetail | null>>()
  private readonly policyParameters = new Map<string, Promise<WirePolicyParameters | null>>()
  /** Verified claim documents by digest (immutable content). Only listing enrichment reads from it. */
  private readonly documents = new Map<string, ClaimDocument>()
  /** Lowercase owner/name → GitHub's repository id for it (null: no public repository), as GitHub answered. */
  private readonly repositoryLookups = new Map<string, { at: number; id: number | null }>()
  private readonly resolveRepositories: boolean

  constructor(opts: ApiDataProviderOptions = {}) {
    const ip = ipAddressLiteral(opts.forwardedFor)
    const fetcher = ip ? forwardingFetch(opts.fetch, ip) : opts.fetch
    this.client = opts.offline ? null : (opts.client ?? new PineApiClient({ baseUrl: opts.baseUrl ?? '', fetch: fetcher }))
    this.now = opts.now ?? (() => Date.now())
    this.resolveRepositories = opts.resolveRepositories ?? true
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000)
  }

  // ---------------------------------------------------------------- policies

  private catalog(client: PineApiClient): Promise<WirePolicySummary[]> {
    const now = this.now()
    if (this.catalogCache && now - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.value
    const value = client.get('/api/v1/policies', policyListSchema).then((r) => r.policies)
    const entry = { at: now, value }
    this.catalogCache = entry
    value.catch(() => {
      if (this.catalogCache === entry) this.catalogCache = null
    })
    return value
  }

  /** Without the catalog, verified claims keep their indexed policy id and others show the unknown policy (policyRefOf). */
  private catalogOrEmpty(client: PineApiClient): Promise<WirePolicySummary[]> {
    return this.catalog(client).catch(() => [])
  }

  private cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key)
    if (hit) return hit
    const p = load()
    map.set(key, p)
    p.catch(() => {
      if (map.get(key) === p) map.delete(key)
    })
    return p
  }

  private async policyVersion(client: PineApiClient, summary: WirePolicySummary): Promise<PolicyVersion | null> {
    const path = `/api/v1/policies/${seg(summary.id)}/${seg(summary.version)}`
    // The text and parameter schema of a published version never change (the digest pins the text).
    const [detail, parameters] = await Promise.all([
      this.cached(this.policyDetails, `${summary.id}@${summary.version}#${summary.sha256}`, () => client.getOrNull(path, policyDetailSchema)),
      this.cached(this.policyParameters, `${summary.id}@${summary.version}`, () => client.getOrNull(`${path}/parameters.schema.json`, policyParametersSchema)),
    ])
    return policyFromApi(summary, detail && detail.sha256 === summary.sha256 ? detail : null, parameters)
  }

  async listPolicies(): Promise<PolicyVersion[]> {
    const client = this.client
    if (!client) return []
    const list = await this.catalog(client)
    const out = await Promise.all(list.map((p) => this.policyVersion(client, p)))
    return out.filter((p): p is PolicyVersion => p !== null)
  }

  /** `version` omitted → the latest catalog version of `id`. Malformed ids or versions never reach the network. */
  async getPolicy(id: string, version?: string): Promise<PolicyVersion | null> {
    const client = this.client
    const pid = id.trim().toUpperCase()
    if (!client || !POLICY_ID.test(pid) || (version !== undefined && !SEMVER.test(version))) return null
    const candidates = (await this.catalog(client)).filter((p) => p.id === pid && (version === undefined || p.version === version))
    const latest = candidates.reduce<WirePolicySummary | null>((a, b) => (a === null || compareVersions(b.version, a.version) > 0 ? b : a), null)
    return latest ? this.policyVersion(client, latest) : null
  }

  // ---------------------------------------------------------------- claims

  /** Documents only: their owner/name are display snapshots, never a source of repository ids. */
  private rememberDocument(sha256: string, doc: ClaimDocument): void {
    if (!this.documents.has(sha256) && this.documents.size >= DOCUMENT_CACHE_MAX) {
      const oldest = this.documents.keys().next().value
      if (oldest !== undefined) this.documents.delete(oldest)
    }
    this.documents.set(sha256, doc)
  }

  /**
   * GitHub's repository id for owner/name, read through the backend GitHub route (session cookie and linked GitHub
   * account; one GitHub call, cached). Null when GitHub has no public repository by that name. Signed out or not linked
   * (401/403) is an error that says so, not an empty result; so is a server provider, which cannot resolve names.
   */
  private async repositoryIdOf(client: PineApiClient, repo: { owner: string; name: string }): Promise<number | null> {
    if (!this.resolveRepositories) throw new PineDataError('Filtering claims by repository name needs ClaimQuery.repositoryId on the server.', 'unsupported')
    const key = `${repo.owner}/${repo.name}`
    const now = this.now()
    const hit = this.repositoryLookups.get(key)
    if (hit && now - hit.at < (hit.id === null ? REPOSITORY_MISS_TTL_MS : REPOSITORY_ID_TTL_MS)) return hit.id
    let id: number | null
    try {
      id = (await client.getOrNull(`/api/v1/github/repos/${seg(repo.owner)}/${seg(repo.name)}`, githubRepoSchema))?.id ?? null
    } catch (err) {
      if (!(err instanceof PineBackendError)) throw err
      if (err.status === 401 || err.status === 403) throw new PineBackendError(REPOSITORY_FILTER_NEEDS_GITHUB, err.status, err.apiCode, err.requestId)
      // 422: not a public repository. Pine claims target public repositories only.
      if (err.status !== 422) throw err
      id = null
    }
    if (!this.repositoryLookups.has(key) && this.repositoryLookups.size >= REPOSITORY_LOOKUPS_MAX) {
      const oldest = this.repositoryLookups.keys().next().value
      if (oldest !== undefined) this.repositoryLookups.delete(oldest)
    }
    this.repositoryLookups.set(key, { at: now, id })
    return id
  }

  /**
   * The verified document of a listed claim (listed claims are verified and unmoderated), for its repository, pull
   * request and violation. Documents are immutable: a digest read once is not read again. Failures leave it unknown.
   */
  private async listingDocument(client: PineApiClient, item: WireListedClaim): Promise<ClaimDocument | null> {
    if (item.integrity.status !== 'verified') return null
    const sha = item.claimDocument.sha256
    const known = this.documents.get(sha)
    if (known) return known
    try {
      const res = await client.getOrNull(`/api/v1/agents/claims/${seg(item.market)}`, agentClaimSchema)
      if (!res || res.item.platform.market !== item.market || hiddenAgent(res) || !res.item.userSupplied) return null
      const doc = verifiedClaimDocument(res.item.userSupplied.document, sha)
      if (doc) this.rememberDocument(sha, doc)
      return doc
    } catch {
      return null
    }
  }

  /**
   * One page of listed claims. Backend pages (moderation applied after its SQL limit) and the filters applied here can
   * come back short or empty while the backend cursor continues, so backend pages are read until `limit` claims match,
   * the cursor ends or LIST_PAGES_MAX pages were read; each page asks for the claims still missing only, so nothing
   * past the returned cursor is skipped. `nextCursor` is the last backend cursor: after an unlucky bounded scan a page
   * can still be empty with a nextCursor (callers offer "load more" whenever it is set).
   */
  async listClaims(q: ClaimQuery = {}): Promise<Page<ApiClaimSummary>> {
    const client = this.client
    if (!client) return { items: [] }
    let planned = planClaimQuery(q)
    if (planned?.repo) {
      const id = await this.repositoryIdOf(client, planned.repo)
      // No public repository by that name on GitHub: no claim can be on it.
      planned = id === null ? null : planClaimQuery(q, id)
    }
    const plan = planned
    if (!plan) return { items: [] }
    const catalog = this.catalogOrEmpty(client)
    const items: ApiClaimSummary[] = []
    const seen = new Set<string>()
    let cursor = plan.cursor
    let nextCursor: string | null = null
    for (let i = 0; i < LIST_PAGES_MAX && items.length < plan.limit; i++) {
      const page = await client.get('/api/v1/claims', claimListSchema, { ...plan.filters, ...(cursor ? { cursor } : {}), limit: plan.limit - items.length })
      const policies = await catalog
      const summary = (item: WireListedClaim, document: ClaimDocument | null) =>
        claimSummaryFromApi({
          view: item,
          document,
          hidden: false,
          listed: item.listable,
          policy: policyRefOf(item.policyDocument, item.policyId, policies, { verified: item.integrity.status === 'verified', document }),
          indexer: page.indexer,
        })
      const fresh = page.items.filter((item) => !seen.has(item.market))
      for (const item of fresh) seen.add(item.market)
      // Documents are read only for claims that pass the platform filters.
      const candidates = fresh.filter((item) => matchesPlatform(summary(item, null), q, plan))
      const documents = await mapLimit(candidates, DOCUMENT_CONCURRENCY, (item) => this.listingDocument(client, item))
      candidates.forEach((item, j) => {
        const c = summary(item, documents[j] ?? null)
        if (matchesSearch(c, q)) items.push(c)
      })
      nextCursor = page.nextCursor
      if (!nextCursor) break
      cursor = nextCursor
    }
    const sorted = sortClaims(items, q.sort)
    return nextCursor ? { items: sorted, nextCursor } : { items: sorted }
  }

  /** Every evidence page of a market (bounded); [] when the market is not a registered claim. */
  private async evidenceItems(client: PineApiClient, market: Address): Promise<WireEvidenceItem[]> {
    const out: WireEvidenceItem[] = []
    let cursor: string | undefined
    for (let i = 0; i < EVIDENCE_PAGES_MAX; i++) {
      const page = await client.getOrNull(`/api/v1/markets/${seg(market)}/evidence`, evidenceListSchema, cursor ? { cursor } : undefined)
      if (!page) break
      out.push(...page.items.filter((e) => e.market === market))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    return out
  }

  /**
   * One claim by its market address (any other id is null without a request). Claim, document and evidence are
   * required; the oracle and liquidity routes are optional enrichments (rate limits or NOT_READY there degrade to the
   * claim's own oracle summary and unknown prices).
   */
  async getClaim(id: string): Promise<ApiClaimDetail | null> {
    const client = this.client
    const market = addressOf(id)
    if (!client || !market) return null
    const m = seg(market)
    const [detail, agent, evidence, oracle, liquidity, catalog] = await Promise.all([
      client.getOrNull(`/api/v1/claims/${m}`, claimDetailSchema),
      client.getOrNull(`/api/v1/agents/claims/${m}`, agentClaimSchema),
      this.evidenceItems(client, market),
      optional(client.getOrNull(`/api/v1/markets/${m}/oracle`, oracleViewSchema)),
      optional(client.getOrNull(`/api/v1/markets/${m}/liquidity`, liquidityViewSchema)),
      this.catalogOrEmpty(client),
    ])
    if (!detail || detail.claim.market !== market) return null
    const view = detail.claim
    const verified = view.integrity.status === 'verified'
    const sameClaim = agent !== null && agent.item.platform.market === market && agent.item.platform.claimDocument.sha256 === view.claimDocument.sha256
    // Moderation from either response withholds every user text (a race between the two reads errs on hiding).
    const hidden = hiddenView(view) || (sameClaim && hiddenAgent(agent))
    // The terms of a claim that failed (or has not passed) the integrity check are never shown, like on the backend.
    const raw = !hidden && verified && sameClaim ? agent.item.userSupplied?.document : undefined
    const document = verifiedClaimDocument(raw, view.claimDocument.sha256)
    if (document) this.rememberDocument(view.claimDocument.sha256, document)
    const evidenceItems: ApiEvidence[] = evidence.map((e) => evidenceFromApi(e, { claimHidden: hidden }))
    return claimDetailFromApi({
      view,
      document,
      hidden,
      listed: view.listed,
      policy: policyRefOf(view.policyDocument, view.policyId, catalog, { verified, document }),
      indexer: detail.indexer,
      evidence: evidenceItems,
      oracle: oracle && oracle.market === market ? oracle : null,
      liquidity: liquidity && liquidity.market === market ? liquidity : null,
      nowSec: this.nowSec(),
    })
  }

  async getClaimByMarket(chainId: number, marketAddress: Address): Promise<ApiClaimDetail | null> {
    return chainId === API_CHAIN_ID ? this.getClaim(marketAddress) : null
  }

  /** The backend keeps no price history. */
  async getPriceHistory(): Promise<PricePoint[]> {
    return []
  }

  /** Executable depth from the backend's quoter probes (asks only); null without a priced pool. */
  async getDepth(claimId: string, outcome: 'yes' | 'no'): Promise<DepthSnapshot | null> {
    const client = this.client
    const market = addressOf(claimId)
    if (!client || !market) return null
    const liquidity = await client.getOrNull(`/api/v1/markets/${seg(market)}/liquidity`, liquidityViewSchema)
    return liquidity && liquidity.market === market ? depthFromApi(liquidity, outcome, this.nowSec()) : null
  }

  async listEvidence(claimId: string): Promise<ApiEvidence[]> {
    const client = this.client
    const market = addressOf(claimId)
    if (!client || !market) return []
    const [items, detail] = await Promise.all([this.evidenceItems(client, market), client.getOrNull(`/api/v1/claims/${seg(market)}`, claimDetailSchema)])
    // Evidence of a moderated claim is listed as tombstones only.
    const claimHidden = detail ? hiddenView(detail.claim) : false
    return items.map((e) => evidenceFromApi(e, { claimHidden }))
  }

  /** Activity of one account (claims created, evidence submitted). Without `account` the backend has no feed: empty. */
  async listActivity(q: ActivityQuery = {}): Promise<Page<ActivityItem>> {
    const client = this.client
    const wallet = addressOf(q.account)
    if (!client || !wallet || (q.cursor !== undefined && q.cursor.length > ACTIVITY_CURSOR_MAX)) return { items: [] }
    const view = await client.get(`/api/v1/accounts/${seg(wallet)}/activity`, activityViewSchema, q.cursor ? { cursor: q.cursor } : undefined)
    const claimId = q.claimId?.toLowerCase()
    const types = q.types && q.types.length > 0 ? new Set(q.types) : null
    const items = activityFromApi(view).filter((i) => (!claimId || i.claimId === claimId) && (!types || types.has(i.type)))
    return view.nextCursor ? { items, nextCursor: view.nextCursor } : { items }
  }

  // ---------------------------------------------------------------- portfolio

  /** Every position page of (wallet, market), merged; null when the market is not a registered claim. */
  private async positions(client: PineApiClient, wallet: Address, market: Address): Promise<WirePositionsView | null> {
    let first: WirePositionsView | null = null
    const items: WirePositionsView['items'] = []
    let cursor: string | undefined
    for (let i = 0; i < POSITION_PAGES_MAX; i++) {
      const page = await client.getOrNull(`/api/v1/funding/positions/${seg(wallet)}`, positionsViewSchema, { market, ...(cursor ? { cursor } : {}) })
      if (!page || page.market !== market) return first ? { ...first, items } : null
      first ??= page
      items.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    return first ? { ...first, items, nextCursor: null } : null
  }

  private async holdings(client: PineApiClient, wallet: Address, market: Address): Promise<ReturnType<typeof holdingsFromApi> | null> {
    const positions = await this.positions(client, wallet, market)
    if (!positions) return null
    const holds = positions.items.length > 0 || Object.values(positions.balances).some((b) => b !== '0')
    if (!holds) return { positions: [], liquidity: [] as ApiLiquidityPosition[] }
    const [claim, liquidity] = await Promise.all([
      client.getOrNull(`/api/v1/claims/${seg(market)}`, claimDetailSchema),
      optional(client.getOrNull(`/api/v1/markets/${seg(market)}/liquidity`, liquidityViewSchema)),
    ])
    return holdingsFromApi({ positions, claim: claim?.claim ?? null, liquidity: liquidity && liquidity.market === market ? liquidity : null })
  }

  /**
   * Holdings across the markets this wallet created claims on or submitted evidence to (the backend has no
   * wallet → markets lookup). Use getMarketPortfolio for a specific market (e.g. on a claim page).
   */
  async getPortfolio(address: Address): Promise<Portfolio> {
    const client = this.client
    const wallet = addressOf(address)
    if (!client || !wallet) return emptyPortfolio(address)
    const activity = await client.get(`/api/v1/accounts/${seg(wallet)}/activity`, activityViewSchema)
    const markets = [...new Set([...activity.claims.map((c) => c.market), ...activity.evidence.map((e) => e.market)])].slice(0, PORTFOLIO_MARKETS_MAX)
    const parts = await mapLimit(markets, PORTFOLIO_CONCURRENCY, (m) => this.holdings(client, wallet, m))
    return portfolioFromHoldings(address, parts.filter((p): p is NonNullable<typeof p> => p !== null))
  }

  /** api mode only: the wallet's outcome tokens and LP positions in one market. */
  async getMarketPortfolio(address: Address, market: Address): Promise<Portfolio> {
    const client = this.client
    const wallet = addressOf(address)
    const m = addressOf(market)
    if (!client || !wallet || !m) return emptyPortfolio(address)
    const part = await this.holdings(client, wallet, m)
    return portfolioFromHoldings(address, part ? [part] : [])
  }

  // ---------------------------------------------------------------- stats

  /**
   * Approximate platform stats from two listing pages (newest 25 open, newest 25 closed): the counts are lower bounds
   * once a phase holds more than one page. Liquidity, volume and evidence totals are not indexed: 0.
   */
  async getStats(): Promise<PlatformStats> {
    const client = this.client
    const stats: PlatformStats = {
      openClaims: 0,
      resolvedClaims: 0,
      totalLiquidity: '0',
      volume30d: '0',
      evidenceSubmissions: 0,
      counterexamplesAccepted: 0,
      collateralSymbol: 'sDAI',
    }
    if (!client) return stats
    const [open, closed] = await Promise.all([
      client.get('/api/v1/claims', claimListSchema, { phase: 'evidence_open', limit: LIST_LIMIT_MAX }),
      client.get('/api/v1/claims', claimListSchema, { phase: 'closed', limit: LIST_LIMIT_MAX }),
    ])
    const resolved = closed.items.map((c) => claimStatusOf(c)).filter((s) => s.status === 'resolved')
    return {
      ...stats,
      openClaims: open.items.length,
      resolvedClaims: resolved.length,
      counterexamplesAccepted: resolved.filter((s) => s.outcome === 'yes').length,
    }
  }
}
