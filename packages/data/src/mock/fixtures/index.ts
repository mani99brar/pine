/**
 * Rich, deterministic demo fixtures. All dates are relative to an anchor: "now" rounded down to the
 * hour. Fixtures are built lazily and rebuilt when the hour changes, so a long-running server never
 * serves stale statuses (e.g. an "open" claim past its deadline), and a server and a browser in the
 * same hour produce identical data.
 *
 * import { fixtures } from '@pine/data/fixtures'   // live view: always the current hour's build
 * import { getFixtures } from '@pine/data/fixtures' // explicit: getFixtures(nowMs)
 */
import type {
  Account,
  ActivityItem,
  ClaimDetail,
  ClaimDraft,
  CommitSummary,
  GitHubUser,
  Portfolio,
  PricePoint,
  PullSummary,
  RepoSummary,
} from '@pine/core'
import { DEMO_GITHUB_USER, DEMO_WALLET_ADDRESS } from '../../demo'
import { fakeAddress, hourFloor, hoursFromNow, withAnchor } from '../../internal/util'
import { actors, contracts, wallets } from './actors'
import { buildClaim, compact } from './build'
import { CLAIM_SEEDS } from './claims'
import { buildGitHubFixtures, findPull, users as usersByLogin, viewerRepoNames, type GitHubFixtures } from './github'
import { buildDemoPortfolio } from './portfolio'

function build(anchor: number): PineFixtures {
  const gh = buildGitHubFixtures()
  const { repos, pulls, commits, pullCommits, commitsBySha } = gh
  const built = CLAIM_SEEDS.map((seed) => buildClaim(seed, gh))

  const claims: ClaimDetail[] = built.map((b) => b.detail).sort((a, b) => b.number - a.number)
  const prices: Record<string, PricePoint[]> = Object.fromEntries(built.map((b) => [b.detail.id, b.prices]))
  const baseActivity: ActivityItem[] = built.flatMap((b) => b.activity)
  const { portfolio: demoPortfolio, extraActivity } = buildDemoPortfolio(claims, prices, baseActivity)
  const activity: ActivityItem[] = [...baseActivity, ...extraActivity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  const accounts: Account[] = [
    {
      id: 'acct_mara-okafor',
      github: { ...DEMO_GITHUB_USER, scopes: ['read:user'] },
      wallets: [
        { address: DEMO_WALLET_ADDRESS, chainId: 100, verifiedAt: hoursFromNow(-1080), label: 'Demo wallet', primary: true },
        { address: fakeAddress('wallet:mara-ledger'), chainId: 100, verifiedAt: hoursFromNow(-410), label: 'Ledger (cold storage)', primary: false },
      ],
      preferences: {
        defaultChainId: 100,
        defaultSpendingLimit: '500',
        notifyOnEvidence: true,
        notifyOnAnswer: true,
        notifyOnDeadline: true,
        notificationEmail: 'mara.okafor@example.com',
        displayCurrency: 'collateral',
      },
      createdAt: hoursFromNow(-1100),
      demo: true,
    },
    {
      id: 'acct_tomas-reyes',
      github: { ...(usersByLogin['tomas-reyes'] as GitHubUser), scopes: ['read:user'] },
      wallets: [{ address: wallets.tomas, chainId: 100, verifiedAt: hoursFromNow(-700), primary: true }],
      preferences: {
        defaultChainId: 100,
        defaultSpendingLimit: '100',
        notifyOnEvidence: true,
        notifyOnAnswer: false,
        notifyOnDeadline: true,
        displayCurrency: 'usd',
      },
      createdAt: hoursFromNow(-720),
      demo: true,
    },
  ]

  // ---------------------------------------------------------------------------
  // Drafts (demo user's local drafts)
  // ---------------------------------------------------------------------------

  function draftSource(fullName: string, number: number): ClaimDraft['source'] {
    const pr = findPull(gh, fullName, number)
    if (!pr) return undefined
    const head = commitsBySha[pr.headSha]
    const [owner = '', repo = ''] = fullName.split('/')
    return compact({
      provider: 'github' as const,
      owner,
      repo,
      repoId: repos.find((r) => r.fullName === fullName)?.id,
      pullRequest: { number: pr.number, title: pr.title, htmlUrl: pr.htmlUrl, author: pr.author.login, state: pr.state },
      commit: {
        sha: pr.headSha,
        message: head?.message ?? pr.title,
        author: head?.author.login ?? pr.author.login,
        committedAt: head?.author.date ?? pr.updatedAt,
        htmlUrl: `https://github.com/${fullName}/commit/${pr.headSha}`,
      },
      baseCommit: { sha: pr.baseSha, htmlUrl: `https://github.com/${fullName}/commit/${pr.baseSha}` },
      license: repos.find((r) => r.fullName === fullName)?.license ?? null,
    })
  }

  const failed = claims.find((c) => c.status === 'failed')
  const refiledSpec = failed
    ? {
        ...failed.manifest.claim,
        evidence: { ...failed.manifest.claim.evidence, deadline: hoursFromNow(24 * 8) },
        oracle: { ...failed.manifest.claim.oracle, openingTime: hoursFromNow(24 * 8) },
      }
    : {}

  const drafts: ClaimDraft[] = [
    {
      id: 'draft-req8x2',
      owner: DEMO_GITHUB_USER.login,
      createdAt: hoursFromNow(-20),
      updatedAt: hoursFromNow(-1.5),
      stage: 'claim',
      source: draftSource('kleros/gateway-balancer-bot', 47),
      spec: {
        title: "Requotes never reset an operation's pricing-loss budget",
        policyId: 'BOT-001',
        policyVersion: '0.1.0',
        claimClass: 'limits-adherence',
        requirement:
          'Across any number of requotes and retries, the cumulative pricing loss accepted for one bridge operation never exceeds MAX_PRICING_LOSS_BPS of its original quote.',
        violation: '',
        scope: { inScope: ['src/bridge/operation.ts', 'src/bridge/lifi.ts (quotes only)'], outOfScope: [] },
        assumptions: [],
        exclusions: ['Real LI.FI execution.'],
        regressionOnly: false,
      },
      funding: { chainId: 100, liquidity: '150', spendingLimit: '200', initialYesPrice: 0.15, priceRange: [0.02, 0.6] },
    },
    {
      id: 'draft-bkt41q',
      owner: DEMO_GITHUB_USER.login,
      createdAt: hoursFromNow(-30),
      updatedAt: hoursFromNow(-28),
      stage: 'funding',
      source: draftSource('harbor/rate-limiter', 85),
      spec: { ...refiledSpec, title: 'Token bucket refill never exceeds burst capacity (re-filed after PINE-0016)' },
      funding: { chainId: 100, liquidity: '80', spendingLimit: '100', initialYesPrice: 0.12, priceRange: [0.02, 0.5] },
    },
  ]

  return {
    anchor,
    claims,
    prices,
    activity,
    portfolios: { [DEMO_WALLET_ADDRESS.toLowerCase()]: demoPortfolio },
    repos,
    pulls,
    commits,
    pullCommits,
    commitsBySha,
    users: Object.values(usersByLogin),
    usersByLogin,
    viewerRepos: viewerRepoNames,
    accounts,
    drafts,
    demo: { wallet: DEMO_WALLET_ADDRESS, github: DEMO_GITHUB_USER },
    addresses: { creators: wallets, actors, contracts },
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface PineFixtures {
  /** Anchor (unix ms) every relative fixture date is computed from */
  anchor: number
  claims: ClaimDetail[]
  /** Hourly price history per claim id */
  prices: Record<string, PricePoint[]>
  activity: ActivityItem[]
  /** Portfolios by lowercase address */
  portfolios: Record<string, Portfolio>
  repos: RepoSummary[]
  /** Pull requests keyed by `owner/repo` (newest first) */
  pulls: Record<string, PullSummary[]>
  /** Default-branch commit history keyed by `owner/repo` (newest first) */
  commits: Record<string, CommitSummary[]>
  /** Pull request commits keyed by `owner/repo#number` (oldest first) */
  pullCommits: Record<string, CommitSummary[]>
  /** Every commit by SHA (with its repo) */
  commitsBySha: Record<string, CommitSummary & { repo: string }>
  users: GitHubUser[]
  usersByLogin: Record<string, GitHubUser>
  /** Repositories listed for the demo user (one private, flagged `private: true`) */
  viewerRepos: string[]
  accounts: Account[]
  drafts: ClaimDraft[]
  demo: { wallet: typeof DEMO_WALLET_ADDRESS; github: GitHubUser }
  /** Fixture participants and the real contract addresses fixtures reference */
  addresses: { creators: typeof wallets; actors: typeof actors; contracts: typeof contracts }
}

let cache: PineFixtures | undefined

/** Fixtures for the hour containing `nowMs` (cached; rebuilt when the hour changes, ~30 ms). */
export function getFixtures(nowMs: number = Date.now()): PineFixtures {
  const anchor = hourFloor(nowMs)
  if (!cache || cache.anchor !== anchor) cache = withAnchor(anchor, () => build(anchor))
  return cache
}

/** Build fixtures for an explicit anchor (unix ms, rounded down to the hour) without touching the cache. */
export function buildFixtures(anchorMs: number): PineFixtures {
  const anchor = hourFloor(anchorMs)
  return withAnchor(anchor, () => build(anchor))
}

const KEYS: (keyof PineFixtures)[] = [
  'anchor',
  'claims',
  'prices',
  'activity',
  'portfolios',
  'repos',
  'pulls',
  'commits',
  'pullCommits',
  'commitsBySha',
  'users',
  'usersByLogin',
  'viewerRepos',
  'accounts',
  'drafts',
  'demo',
  'addresses',
]

/**
 * Live view of the current hour's fixtures: every property read goes through `getFixtures()`.
 * Nothing is built until a property is first read. Treat the data as read-only.
 */
export const fixtures: PineFixtures = Object.defineProperties(
  {} as PineFixtures,
  Object.fromEntries(KEYS.map((k) => [k, { enumerable: true, get: () => getFixtures()[k] }])),
)

export default fixtures
