import { describe, expect, it } from 'vitest'
import { PineDataError, type GitHubSource } from '@pine/data'
import type { CommitSummary, PullSummary, RepoSummary } from '@pine/core'
import { createGitHubHandler } from '../src/github'
import { ctx, req, signedIn, signedOut } from './helpers'

const gh = createGitHubHandler(signedIn(), { mode: 'mock' })

async function get(path: string, query = '') {
  return gh.GET(req(`/api/github/${path}${query}`), ctx(path.split('/').filter(Boolean)))
}

describe('GitHub proxy (mock source)', () => {
  it('viewer repos, search and repo', async () => {
    const repos = await get('viewer/repos')
    expect(repos.status).toBe(200)
    expect(repos.headers.get('cache-control')).toMatch(/^private/)
    const page = (await repos.json()) as { items: RepoSummary[] }
    expect(page.items.map((r) => r.fullName)).toContain('kleros/gateway-balancer-bot')

    const search = await get('search/repos', '?q=balancer')
    expect(search.status).toBe(200)
    expect(((await search.json()) as RepoSummary[]).some((r) => r.fullName === 'kleros/gateway-balancer-bot')).toBe(true)
    expect((await get('search/repos', '?q=a')).status).toBe(400)

    const repo = await get('repos/kleros/gateway-balancer-bot')
    expect(repo.status).toBe(200)
    expect(((await repo.json()) as RepoSummary).defaultBranch).toBeTruthy()
  })

  it('pulls, pull, pull commits, commits and commit (short SHA resolves)', async () => {
    const pulls = (await (await get('repos/kleros/gateway-balancer-bot/pulls', '?state=all')).json()) as PullSummary[]
    expect(pulls.length).toBeGreaterThan(0)
    const pr = pulls[0]!
    const one = await get(`repos/kleros/gateway-balancer-bot/pulls/${pr.number}`)
    expect(one.status).toBe(200)
    expect(((await one.json()) as PullSummary).headSha).toBe(pr.headSha)
    const prCommits = await get(`repos/kleros/gateway-balancer-bot/pulls/${pr.number}/commits`)
    expect(prCommits.status).toBe(200)
    expect(Array.isArray(await prCommits.json())).toBe(true)

    const commits = (await (await get('repos/kleros/gateway-balancer-bot/commits')).json()) as CommitSummary[]
    const full = commits[0]!.sha
    const byShort = await get(`repos/kleros/gateway-balancer-bot/commits/${full.slice(0, 7)}`)
    expect(byShort.status).toBe(200)
    expect(((await byShort.json()) as CommitSummary).sha).toBe(full)
    const byFull = await get(`repos/kleros/gateway-balancer-bot/commits/${full}`)
    expect(byFull.headers.get('cache-control')).toBe('private, max-age=3600')
  })

  it('validates input and returns helpful 404s', async () => {
    expect((await get('repos/kleros/does-not-exist')).status).toBe(404)
    expect((await get('repos/kleros/gateway-balancer-bot/pulls/999999')).status).toBe(404)
    expect((await get('repos/kleros/gateway-balancer-bot/pulls/abc')).status).toBe(400)
    expect((await get('repos/kleros/gateway-balancer-bot/commits/not-a-sha!')).status).toBe(400)
    expect((await get('repos/-bad-/x')).status).toBe(400)
    const unknown = await get('orgs/kleros')
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { hint: string } }).error.hint).toMatch(/viewer/)
  })

  it('maps rate limits to 429 with retry info', async () => {
    const limited: GitHubSource = {
      kind: 'live',
      getViewer: async () => null,
      listViewerRepos: async () => ({ items: [] }),
      searchRepos: async () => [],
      getRepo: async () => {
        throw new PineDataError('GitHub rate limit exceeded; resets in 120s', 'rate_limited', {
          resetAt: new Date(Date.now() + 120_000).toISOString(),
        })
      },
      listPulls: async () => [],
      getPull: async () => null,
      listPullCommits: async () => [],
      listCommits: async () => [],
      getCommit: async () => null,
    }
    const handler = createGitHubHandler(signedIn(), { source: limited })
    const res = await handler.GET(req('/api/github/repos/a/b'), ctx(['repos', 'a', 'b']))
    expect(res.status).toBe(429)
    const retry = Number(res.headers.get('retry-after'))
    expect(retry).toBeGreaterThan(100)
    expect(retry).toBeLessThanOrEqual(121)
    const body = (await res.json()) as { error: { code: string; retryAfter: number } }
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.retryAfter).toBe(retry)
  })

  it('viewer repos need a GitHub sign-in on the live source', async () => {
    const live = createGitHubHandler(signedOut, { mode: 'live' })
    const res = await live.GET(req('/api/github/viewer/repos'), ctx(['viewer', 'repos']))
    expect(res.status).toBe(401)
  })
})
