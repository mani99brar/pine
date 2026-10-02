import type { CommitSummary, GitHubUser, Page, PullSummary, RepoSummary } from '@pine/core'
import { DEMO_GITHUB_USER } from '../demo'
import { readMockLatencyEnabled } from '../env'
import { clone, mulberry32, sleep } from '../internal/util'
import { fixtures as defaultFixtures, type PineFixtures } from '../mock/fixtures'
import type { GitHubSource } from '../types'

const ci = (s: string) => s.toLowerCase()

/** Fixture-backed GitHub source (demo mode). Includes one private repo flagged `private: true`. */
export class MockGitHubSource implements GitHubSource {
  readonly kind = 'mock' as const
  private readonly fx: PineFixtures
  private readonly latency: boolean
  private readonly rand = mulberry32(0x6a09e667)

  constructor(opts: { fixtures?: PineFixtures; latency?: boolean } = {}) {
    this.fx = opts.fixtures ?? defaultFixtures
    this.latency = opts.latency ?? readMockLatencyEnabled()
  }

  private async delay(): Promise<void> {
    if (this.latency) await sleep(Math.round(60 + this.rand() * 140))
  }

  private repoKey(owner: string, repo: string): string | undefined {
    const want = ci(`${owner}/${repo}`)
    return this.fx.repos.find((r) => ci(r.fullName) === want)?.fullName
  }

  async getViewer(): Promise<GitHubUser | null> {
    await this.delay()
    return { ...DEMO_GITHUB_USER }
  }

  async listViewerRepos(opts: { cursor?: string; limit?: number } = {}): Promise<Page<RepoSummary>> {
    await this.delay()
    const all = this.fx.viewerRepos
      .map((n) => this.fx.repos.find((r) => r.fullName === n))
      .filter((r): r is RepoSummary => !!r)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    const offset = Math.max(0, Number.parseInt(opts.cursor ?? '0', 10) || 0)
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30))
    const items = all.slice(offset, offset + limit)
    return { items: clone(items), nextCursor: offset + limit < all.length ? String(offset + limit) : undefined, total: all.length }
  }

  async searchRepos(query: string): Promise<RepoSummary[]> {
    await this.delay()
    const terms = ci(query).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    return clone(
      this.fx.repos
        .filter((r) => !r.private)
        .filter((r) => {
          const hay = ci([r.fullName, r.description ?? '', r.language ?? '', ...(r.topics ?? [])].join(' '))
          return terms.every((t) => hay.includes(t))
        })
        .sort((a, b) => b.stars - a.stars),
    )
  }

  async getRepo(owner: string, repo: string): Promise<RepoSummary | null> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    const r = key ? this.fx.repos.find((x) => x.fullName === key) : undefined
    return r ? clone(r) : null
  }

  async listPulls(owner: string, repo: string, opts: { state?: 'open' | 'closed' | 'all' } = {}): Promise<PullSummary[]> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    const list = key ? this.fx.pulls[key] ?? [] : []
    const state = opts.state ?? 'open'
    return clone(list.filter((p) => state === 'all' || (state === 'open' ? p.state === 'open' : p.state !== 'open')))
  }

  async getPull(owner: string, repo: string, number: number): Promise<PullSummary | null> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    const p = key ? this.fx.pulls[key]?.find((x) => x.number === number) : undefined
    return p ? clone(p) : null
  }

  async listPullCommits(owner: string, repo: string, number: number): Promise<CommitSummary[]> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    return clone(key ? this.fx.pullCommits[`${key}#${number}`] ?? [] : [])
  }

  async listCommits(owner: string, repo: string, opts: { ref?: string; limit?: number } = {}): Promise<CommitSummary[]> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    if (!key) return []
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30))
    const history = this.fx.commits[key] ?? []
    const ref = opts.ref?.trim()
    const repoMeta = this.fx.repos.find((r) => r.fullName === key)
    if (!ref || ref === repoMeta?.defaultBranch) return clone(history.slice(0, limit))
    // a PR head branch: its commits (newest first) followed by the base history
    const pr = (this.fx.pulls[key] ?? []).find((p) => p.headRef === ref)
    if (pr) {
      const prCommits = [...(this.fx.pullCommits[`${key}#${pr.number}`] ?? [])].reverse()
      const baseIdx = history.findIndex((c) => c.sha === pr.baseSha)
      return clone([...prCommits, ...(baseIdx >= 0 ? history.slice(baseIdx) : [])].slice(0, limit))
    }
    // a SHA: walk parents
    const start = this.findCommit(key, ref)
    if (!start) return []
    const out: CommitSummary[] = []
    let cur: CommitSummary | undefined = start
    while (cur && out.length < limit) {
      out.push(cur)
      const parent: string | undefined = cur.parents[0]
      cur = parent ? this.fx.commitsBySha[parent] : undefined
    }
    return clone(out.map(({ ...c }) => stripRepo(c)))
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<CommitSummary | null> {
    await this.delay()
    const key = this.repoKey(owner, repo)
    if (!key) return null
    const c = this.findCommit(key, sha)
    return c ? clone(stripRepo(c)) : null
  }

  /** Full or abbreviated (≥ 7 hex) SHA lookup within a repo. */
  private findCommit(repoKey: string, sha: string): CommitSummary | undefined {
    const s = ci(sha)
    if (!/^[0-9a-f]{7,40}$/.test(s)) return undefined
    const exact = this.fx.commitsBySha[s]
    if (exact && exact.repo === repoKey) return exact
    const matches = Object.values(this.fx.commitsBySha).filter((c) => c.repo === repoKey && c.sha.startsWith(s))
    return matches.length === 1 ? matches[0] : undefined
  }
}

function stripRepo(c: CommitSummary & { repo?: string }): CommitSummary {
  const { repo: _repo, ...rest } = c
  return rest
}
