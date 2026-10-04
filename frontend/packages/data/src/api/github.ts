import { parseGitHubRef, type CommitSummary, type GitHubUser, type Page, type PullSummary, type RepoSummary } from '@pine/core'
import type { GitHubSource } from '../types'
import { pineSessionSchema } from './auth'
import { PineApiClient, PineBackendError, seg } from './http'
import {
  githubCommitDetailSchema,
  githubCommitListSchema,
  githubPullPageSchema,
  githubPullSchema,
  githubRepoPageSchema,
  githubRepoSchema,
  type WireGitHubCommit,
  type WireGitHubPull,
  type WireGitHubRepo,
} from './read-schemas'

// GitHub through the Pine backend (`/api/v1/github/*`): public repositories of the user's linked GitHub account, read
// with the backend session cookie (same origin). Every response is GitHub data, untrusted, validated with zod (SEC-GH-15).
// Links are rebuilt from the validated owner/name/number/sha instead of trusting upstream URLs.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
const SHA40 = /^[0-9a-fA-F]{40}$/
const MAX_PAGE = 100
const MAX_PULL_NUMBER = 2 ** 31 - 1
const VIEWER_REPOS_TTL_MS = 60_000
const SEARCH_PAGES = 3

export interface ApiGitHubSourceOptions {
  /** The same-origin backend client (the GitHub routes need the session cookie). */
  client?: PineApiClient
  /** When no client is given: "" for same origin. */
  baseUrl?: string
  fetch?: typeof fetch
  /**
   * Signed out or GitHub not linked (401/403), or a repository that is not public (422):
   * - `empty` (default): read as "not available": viewer null, empty lists, null resources;
   * - `throw`: the PineBackendError propagates, so a UI can say "Connect your GitHub account" instead of "not found".
   */
  unavailable?: 'empty' | 'throw'
  now?: () => number
}

function repoUrl(owner: string, name: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function avatarFor(login: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}`
}

const BOT_SUFFIX = '[bot]'

/** A GitHub App author ("dependabot[bot]") has its page at github.com/apps/<name> and no user avatar by login. */
function authorPage(login: string): string {
  return login.endsWith(BOT_SUFFIX)
    ? `https://github.com/apps/${encodeURIComponent(login.slice(0, -BOT_SUFFIX.length))}`
    : `https://github.com/${encodeURIComponent(login)}`
}

const GHOST: GitHubUser = { login: 'ghost', id: 0, name: null, avatarUrl: 'https://avatars.githubusercontent.com/u/10137?v=4', htmlUrl: 'https://github.com/ghost' }

function authorAvatar(login: string): string {
  return login.endsWith(BOT_SUFFIX) ? GHOST.avatarUrl : avatarFor(login)
}

/** RepoSummary from a backend GitHubRepo; description, language, stars and license are not served (null / 0). */
export function repoFromApi(r: WireGitHubRepo): RepoSummary {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    description: null,
    private: false,
    defaultBranch: r.defaultBranch,
    language: null,
    stars: 0,
    license: null,
    htmlUrl: repoUrl(r.owner, r.name),
    updatedAt: r.pushedAt ?? '',
  }
}

/** PullSummary from a backend GitHubPull; draft flag, counts, labels, body and creation time are not served. */
export function pullFromApi(p: WireGitHubPull, owner: string, name: string): PullSummary {
  const author: GitHubUser = p.authorLogin
    ? { login: p.authorLogin, id: 0, name: null, avatarUrl: authorAvatar(p.authorLogin), htmlUrl: authorPage(p.authorLogin) }
    : GHOST
  return {
    number: p.number,
    title: p.title,
    state: p.merged ? 'merged' : p.state,
    draft: false,
    author,
    htmlUrl: `${repoUrl(owner, name)}/pull/${p.number}`,
    headSha: p.headSha,
    headRef: p.headRef,
    baseSha: p.baseSha,
    baseRef: p.baseRef,
    createdAt: '',
    updatedAt: p.updatedAt,
    commits: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    labels: [],
    body: null,
  }
}

/** CommitSummary from a backend GitHubCommit (author login only; no name, stats or signature data). */
export function commitFromApi(c: WireGitHubCommit, owner: string, name: string): CommitSummary {
  return {
    sha: c.sha,
    message: c.message,
    author: {
      name: c.authorLogin ?? 'unknown',
      ...(c.authorLogin ? { login: c.authorLogin, avatarUrl: authorAvatar(c.authorLogin) } : {}),
      date: c.committedAt ?? '',
    },
    htmlUrl: `${repoUrl(owner, name)}/commit/${c.sha}`,
    parents: [...c.parents],
  }
}

function validRepo(owner: string, name: string): boolean {
  return OWNER.test(owner) && NAME.test(name)
}

export class ApiGitHubSource implements GitHubSource {
  readonly kind = 'live' as const
  readonly client: PineApiClient
  private readonly mode: 'empty' | 'throw'
  private readonly now: () => number
  private viewerRepos: { at: number; repos: Promise<RepoSummary[]> } | null = null

  constructor(opts: ApiGitHubSourceOptions = {}) {
    this.client = opts.client ?? new PineApiClient({ baseUrl: opts.baseUrl ?? '', fetch: opts.fetch })
    this.mode = opts.unavailable ?? 'empty'
    this.now = opts.now ?? (() => Date.now())
  }

  /** 401/403 (and 422 for single resources) → the "not available" value, or rethrown in `throw` mode. */
  private async guard<T>(call: () => Promise<T>, fallback: T, opts: { notPublic?: boolean } = {}): Promise<T> {
    try {
      return await call()
    } catch (err) {
      const unavailable = err instanceof PineBackendError && (err.status === 401 || err.status === 403 || (opts.notPublic === true && err.status === 422))
      if (unavailable && this.mode === 'empty') return fallback
      throw err
    }
  }

  /** The linked GitHub identity of the backend session; null when signed out or not linked. */
  async getViewer(): Promise<GitHubUser | null> {
    try {
      const s = await this.client.get('/api/v1/auth/session', pineSessionSchema)
      if (s.githubUserId === null || s.githubLogin === null) return null
      return {
        login: s.githubLogin,
        id: s.githubUserId,
        name: null,
        avatarUrl: `https://avatars.githubusercontent.com/u/${s.githubUserId}`,
        htmlUrl: `https://github.com/${s.githubLogin}`,
      }
    } catch (err) {
      if (err instanceof PineBackendError && err.status === 401) return null
      throw err
    }
  }

  /** Public repositories of the linked account, 30 per backend page; the cursor is the page number. */
  async listViewerRepos(opts: { cursor?: string; limit?: number } = {}): Promise<Page<RepoSummary>> {
    const page = opts.cursor === undefined ? 1 : /^[1-9][0-9]{0,2}$/.test(opts.cursor) ? Number(opts.cursor) : 0
    if (page < 1 || page > MAX_PAGE) return { items: [] }
    return this.guard(async () => {
      const res = await this.client.get('/api/v1/github/repos', githubRepoPageSchema, { page })
      const items = res.items.map(repoFromApi)
      return res.hasMore && page < MAX_PAGE ? { items, nextCursor: String(page + 1) } : { items }
    }, { items: [] })
  }

  private async allViewerRepos(): Promise<RepoSummary[]> {
    const now = this.now()
    if (this.viewerRepos && now - this.viewerRepos.at < VIEWER_REPOS_TTL_MS) return this.viewerRepos.repos
    const repos = (async () => {
      const out: RepoSummary[] = []
      for (let page = 1; page <= SEARCH_PAGES; page++) {
        const res = await this.client.get('/api/v1/github/repos', githubRepoPageSchema, { page })
        out.push(...res.items.map(repoFromApi))
        if (!res.hasMore) break
      }
      return out
    })()
    this.viewerRepos = { at: now, repos }
    repos.catch(() => {
      if (this.viewerRepos?.repos === repos) this.viewerRepos = null
    })
    return repos
  }

  /**
   * The backend has no repository search: an `owner/name` (or GitHub URL) query is looked up directly, and the linked
   * account's own repositories (first pages, cached for a minute) are filtered by name.
   */
  async searchRepos(query: string): Promise<RepoSummary[]> {
    const q = query.trim()
    if (q.length < 2 || q.length > 256) return []
    const ref = parseGitHubRef(q)
    const [direct, own] = await Promise.all([
      ref ? this.getRepo(ref.owner, ref.repo) : Promise.resolve(null),
      this.guard(() => this.allViewerRepos(), [] as RepoSummary[]),
    ])
    const needle = q.toLowerCase()
    const out = direct ? [direct] : []
    for (const r of own) if (r.fullName.toLowerCase().includes(needle) && !out.some((x) => x.id === r.id)) out.push(r)
    return out
  }

  async getRepo(owner: string, name: string): Promise<RepoSummary | null> {
    if (!validRepo(owner, name)) return null
    return this.guard(async () => {
      const r = await this.client.getOrNull(`/api/v1/github/repos/${seg(owner)}/${seg(name)}`, githubRepoSchema)
      return r ? repoFromApi(r) : null
    }, null, { notPublic: true })
  }

  /** The first backend page of pull requests (newest first). */
  async listPulls(owner: string, name: string, opts: { state?: 'open' | 'closed' | 'all' } = {}): Promise<PullSummary[]> {
    if (!validRepo(owner, name)) return []
    const state = opts.state === 'closed' || opts.state === 'all' ? opts.state : 'open'
    return this.guard(async () => {
      const res = await this.client.getOrNull(`/api/v1/github/repos/${seg(owner)}/${seg(name)}/pulls`, githubPullPageSchema, { state, page: 1 })
      return (res?.items ?? []).map((p) => pullFromApi(p, owner, name))
    }, [], { notPublic: true })
  }

  async getPull(owner: string, name: string, number: number): Promise<PullSummary | null> {
    if (!validRepo(owner, name) || !Number.isSafeInteger(number) || number < 1 || number > MAX_PULL_NUMBER) return null
    return this.guard(async () => {
      const p = await this.client.getOrNull(`/api/v1/github/repos/${seg(owner)}/${seg(name)}/pulls/${number}`, githubPullSchema)
      return p ? pullFromApi(p, owner, name) : null
    }, null, { notPublic: true })
  }

  /** Commits of a pull request, oldest first (GitHub caps the list at 250). */
  async listPullCommits(owner: string, name: string, number: number): Promise<CommitSummary[]> {
    if (!validRepo(owner, name) || !Number.isSafeInteger(number) || number < 1 || number > MAX_PULL_NUMBER) return []
    return this.guard(async () => {
      const res = await this.client.getOrNull(`/api/v1/github/repos/${seg(owner)}/${seg(name)}/pulls/${number}/commits`, githubCommitListSchema)
      return (res?.items ?? []).map((c) => commitFromApi(c, owner, name))
    }, [], { notPublic: true })
  }

  /** The backend has no branch history route: always empty (pick commits through a pull request). */
  async listCommits(): Promise<CommitSummary[]> {
    return []
  }

  /**
   * A commit by its full 40-hex SHA (the backend resolves no short SHAs). Existence only: membership in a pull request
   * or branch is proven by the backend at preview (SEC-GH-11).
   */
  async getCommit(owner: string, name: string, sha: string): Promise<CommitSummary | null> {
    if (!validRepo(owner, name) || !SHA40.test(sha)) return null
    const lower = sha.toLowerCase()
    return this.guard(async () => {
      const res = await this.client.getOrNull(`/api/v1/github/repos/${seg(owner)}/${seg(name)}/commits/${lower}`, githubCommitDetailSchema)
      return res ? commitFromApi(res.commit, owner, name) : null
    }, null, { notPublic: true })
  }
}
