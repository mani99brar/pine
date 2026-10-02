import type { CommitSummary, GitHubUser, Page, PullState, PullSummary, RepoSummary } from '@pine/core'
import { PineDataError, type GitHubSource } from '../types'

export const GITHUB_API_URL = 'https://api.github.com'

// ---------------------------------------------------------------------------
// Wire types (subset of the GitHub REST v3 responses we read)
// ---------------------------------------------------------------------------

export interface GhUser {
  login: string
  id: number
  name?: string | null
  avatar_url: string
  html_url: string
}

export interface GhRepo {
  id: number
  name: string
  full_name: string
  owner: { login: string }
  description: string | null
  private: boolean
  default_branch: string
  language: string | null
  stargazers_count: number
  forks_count?: number
  license?: { spdx_id?: string | null; name?: string | null } | null
  html_url: string
  updated_at: string
  pushed_at?: string | null
  topics?: string[]
}

export interface GhPull {
  number: number
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  merged_at?: string | null
  merged?: boolean
  user: GhUser | null
  html_url: string
  head: { sha: string; ref: string }
  base: { sha: string; ref: string }
  created_at: string
  updated_at: string
  commits?: number
  additions?: number
  deletions?: number
  changed_files?: number
  labels?: { name: string }[]
  body?: string | null
}

export interface GhCommit {
  sha: string
  html_url: string
  commit: {
    message: string
    author: { name?: string | null; date?: string | null } | null
    committer?: { name?: string | null; date?: string | null } | null
    verification?: { verified: boolean } | null
  }
  author: GhUser | null
  parents: { sha: string }[]
  stats?: { additions: number; deletions: number; total: number }
  files?: { filename: string; status: string; additions: number; deletions: number }[]
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapGhUser(u: GhUser | null | undefined): GitHubUser {
  if (!u) return { login: 'ghost', id: 0, name: null, avatarUrl: 'https://avatars.githubusercontent.com/u/10137?v=4', htmlUrl: 'https://github.com/ghost' }
  return { login: u.login, id: u.id, name: u.name ?? null, avatarUrl: u.avatar_url, htmlUrl: u.html_url }
}

export function mapGhRepo(r: GhRepo): RepoSummary {
  const spdx = r.license?.spdx_id
  return {
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? null,
    private: r.private,
    defaultBranch: r.default_branch,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count,
    license: spdx && spdx !== 'NOASSERTION' ? spdx : r.license?.name ?? null,
    htmlUrl: r.html_url,
    updatedAt: r.pushed_at ?? r.updated_at,
    topics: r.topics,
  }
}

export function mapGhPull(p: GhPull): PullSummary {
  const state: PullState = p.merged_at || p.merged ? 'merged' : p.state
  return {
    number: p.number,
    title: p.title,
    state,
    draft: p.draft ?? false,
    author: mapGhUser(p.user),
    htmlUrl: p.html_url,
    headSha: p.head.sha,
    headRef: p.head.ref,
    baseSha: p.base.sha,
    baseRef: p.base.ref,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    // List responses omit these counts; the single-PR endpoint includes them.
    commits: p.commits ?? 0,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    labels: (p.labels ?? []).map((l) => l.name),
    body: p.body ?? null,
  }
}

export function mapGhCommit(c: GhCommit): CommitSummary {
  const out: CommitSummary = {
    sha: c.sha,
    message: c.commit.message,
    author: {
      name: c.commit.author?.name ?? c.author?.login ?? 'unknown',
      login: c.author?.login,
      avatarUrl: c.author?.avatar_url,
      date: c.commit.author?.date ?? c.commit.committer?.date ?? new Date(0).toISOString(),
    },
    htmlUrl: c.html_url,
    parents: c.parents.map((p) => p.sha),
  }
  if (c.commit.verification) out.verified = c.commit.verification.verified
  if (c.stats) out.stats = { additions: c.stats.additions, deletions: c.stats.deletions, total: c.stats.total }
  if (c.files) out.files = c.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }))
  if (!out.author.login) delete out.author.login
  if (!out.author.avatarUrl) delete out.author.avatarUrl
  return out
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Map a non-OK GitHub response to a PineDataError (404 is handled by callers as null/empty). */
export async function gitHubError(res: Response): Promise<PineDataError> {
  const remaining = res.headers.get('x-ratelimit-remaining')
  const reset = res.headers.get('x-ratelimit-reset')
  const retryAfter = res.headers.get('retry-after')
  let detail = ''
  try {
    const body = (await res.json()) as { message?: string }
    detail = body?.message ? ` (${body.message})` : ''
  } catch {
    // ignore
  }
  if ((res.status === 403 || res.status === 429) && (remaining === '0' || retryAfter !== null || res.status === 429)) {
    const resetAt = reset
      ? new Date(Number(reset) * 1000).toISOString()
      : retryAfter
        ? new Date(Date.now() + Number(retryAfter) * 1000).toISOString()
        : undefined
    return new PineDataError(
      `GitHub API rate limit exceeded${resetAt ? `; resets at ${resetAt}` : ''}. Sign in with GitHub to raise the limit.${detail}`,
      'rate_limited',
      { status: res.status, resetAt },
    )
  }
  if (res.status === 401 || res.status === 403) {
    return new PineDataError(`GitHub denied the request (${res.status})${detail}`, 'unauthorized', { status: res.status })
  }
  if (res.status === 404) return new PineDataError(`GitHub resource not found${detail}`, 'not_found', { status: 404 })
  return new PineDataError(`GitHub API error ${res.status}${detail}`, res.status >= 500 ? 'network' : 'bad_response', { status: res.status })
}

// ---------------------------------------------------------------------------
// Live source
// ---------------------------------------------------------------------------

export interface LiveGitHubOptions {
  token?: string
  baseUrl?: string
  fetch?: typeof fetch
}

const enc = encodeURIComponent

export class LiveGitHubSource implements GitHubSource {
  readonly kind = 'live' as const
  private readonly base: string
  private readonly token?: string
  private readonly fetcher: typeof fetch

  constructor(opts: LiveGitHubOptions = {}) {
    this.base = (opts.baseUrl ?? GITHUB_API_URL).replace(/\/+$/, '')
    this.token = opts.token
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
  }

  private async request<T>(path: string): Promise<{ data: T; res: Response } | null> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    let res: Response
    try {
      res = await this.fetcher(`${this.base}${path}`, { headers })
    } catch (err) {
      throw new PineDataError('Could not reach the GitHub API', 'network', err)
    }
    // 404 missing; 409 empty repository (no commits); 422 unknown SHA/ref → "nothing there"
    if (res.status === 404 || res.status === 409 || res.status === 422) return null
    if (!res.ok) throw await gitHubError(res)
    try {
      return { data: (await res.json()) as T, res }
    } catch (err) {
      throw new PineDataError('GitHub returned an unreadable response', 'bad_response', err)
    }
  }

  async getViewer(): Promise<GitHubUser | null> {
    if (!this.token) return null
    const r = await this.request<GhUser>('/user')
    return r ? mapGhUser(r.data) : null
  }

  async listViewerRepos(opts: { cursor?: string; limit?: number } = {}): Promise<Page<RepoSummary>> {
    if (!this.token) return { items: [] }
    const page = Math.max(1, Number.parseInt(opts.cursor ?? '1', 10) || 1)
    const perPage = Math.min(100, Math.max(1, opts.limit ?? 30))
    const r = await this.request<GhRepo[]>(`/user/repos?visibility=public&sort=updated&per_page=${perPage}&page=${page}`)
    if (!r) return { items: [] }
    // Trust GitHub's Link header; fall back to a full page only when a proxy stripped it.
    const link = r.res.headers.get('link')
    const hasNext = link !== null ? /rel="next"/.test(link) : r.data.length === perPage
    return { items: r.data.map(mapGhRepo), nextCursor: hasNext ? String(page + 1) : undefined }
  }

  async searchRepos(query: string): Promise<RepoSummary[]> {
    const q = query.trim()
    if (!q) return []
    const r = await this.request<{ items: GhRepo[] }>(`/search/repositories?q=${enc(`${q} is:public`)}&per_page=20`)
    return r ? r.data.items.map(mapGhRepo) : []
  }

  async getRepo(owner: string, repo: string): Promise<RepoSummary | null> {
    const r = await this.request<GhRepo>(`/repos/${enc(owner)}/${enc(repo)}`)
    return r ? mapGhRepo(r.data) : null
  }

  async listPulls(owner: string, repo: string, opts: { state?: 'open' | 'closed' | 'all' } = {}): Promise<PullSummary[]> {
    const state = opts.state ?? 'open'
    const r = await this.request<GhPull[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=50`)
    return r ? r.data.map(mapGhPull) : []
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullSummary | null> {
    const r = await this.request<GhPull>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`)
    return r ? mapGhPull(r.data) : null
  }

  async listPullCommits(owner: string, repo: string, number: number): Promise<CommitSummary[]> {
    const r = await this.request<GhCommit[]>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/commits?per_page=100`)
    return r ? r.data.map(mapGhCommit) : []
  }

  async listCommits(owner: string, repo: string, opts: { ref?: string; limit?: number } = {}): Promise<CommitSummary[]> {
    const perPage = Math.min(100, Math.max(1, opts.limit ?? 30))
    const ref = opts.ref ? `&sha=${enc(opts.ref)}` : ''
    const r = await this.request<GhCommit[]>(`/repos/${enc(owner)}/${enc(repo)}/commits?per_page=${perPage}${ref}`)
    return r ? r.data.map(mapGhCommit) : []
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<CommitSummary | null> {
    const r = await this.request<GhCommit>(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`)
    return r ? mapGhCommit(r.data) : null
  }
}
