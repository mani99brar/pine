import { describe, expect, it } from 'vitest'
import { createGitHubSource, LiveGitHubSource, parseGitHubRef, PineDataError } from '../src'
import type { GhCommit, GhPull, GhRepo } from '../src/github'
import { fixtures } from '../src/mock/fixtures'

// Trimmed real-shape GitHub REST v3 payloads
const REPO: GhRepo = {
  id: 812004417,
  name: 'gateway-balancer-bot',
  full_name: 'kleros/gateway-balancer-bot',
  owner: { login: 'kleros' },
  description: 'Keeper',
  private: false,
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 38,
  forks_count: 9,
  license: { spdx_id: 'MIT', name: 'MIT License' },
  html_url: 'https://github.com/kleros/gateway-balancer-bot',
  updated_at: '2026-09-30T10:00:00Z',
  pushed_at: '2026-10-01T12:00:00Z',
  topics: ['keeper'],
}

const PULL: GhPull = {
  number: 47,
  title: 'feat(funding): reporter top-up planner',
  state: 'closed',
  draft: false,
  merged_at: '2026-10-02T09:00:00Z',
  user: { login: 'tomas-reyes', id: 31877412, avatar_url: 'https://avatars.githubusercontent.com/u/31877412?v=4', html_url: 'https://github.com/tomas-reyes' },
  html_url: 'https://github.com/kleros/gateway-balancer-bot/pull/47',
  head: { sha: 'a'.repeat(40), ref: 'feat/reporter-topup-planner' },
  base: { sha: 'b'.repeat(40), ref: 'main' },
  created_at: '2026-09-29T08:00:00Z',
  updated_at: '2026-10-02T09:00:00Z',
  commits: 4,
  additions: 652,
  deletions: 64,
  changed_files: 5,
  labels: [{ name: 'accounting' }, { name: 'needs-verification' }],
  body: 'Implements reporter funding.',
}

const COMMIT: GhCommit = {
  sha: 'a'.repeat(40),
  html_url: `https://github.com/kleros/gateway-balancer-bot/commit/${'a'.repeat(40)}`,
  commit: {
    message: 'fix(funding): skip top-up',
    author: { name: 'Tomás Reyes', date: '2026-10-01T12:00:00Z' },
    committer: { name: 'GitHub', date: '2026-10-01T12:01:00Z' },
    verification: { verified: true },
  },
  author: { login: 'tomas-reyes', id: 31877412, avatar_url: 'https://avatars.githubusercontent.com/u/31877412?v=4', html_url: 'https://github.com/tomas-reyes' },
  parents: [{ sha: 'c'.repeat(40) }],
  stats: { additions: 14, deletions: 31, total: 45 },
  files: [{ filename: 'src/funding/reporter-planner.ts', status: 'modified', additions: 14, deletions: 31 }],
}

function stub(routes: Record<string, () => Response>) {
  const seen: { url: string; headers: Record<string, string> }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const path = url.replace('https://api.github.com', '')
    const key = Object.keys(routes).find((k) => path.startsWith(k))
    return key ? routes[key]!() : new Response('{"message":"Not Found"}', { status: 404 })
  }) as typeof fetch
  return { fetcher, seen }
}

const ok = (body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status: 200, headers })

describe('LiveGitHubSource', () => {
  it('sends the GitHub API headers and an optional bearer token', async () => {
    const { fetcher, seen } = stub({ '/repos/kleros/gateway-balancer-bot': ok(REPO) })
    await new LiveGitHubSource({ fetch: fetcher, token: 'gho_test' }).getRepo('kleros', 'gateway-balancer-bot')
    expect(seen[0]!.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer gho_test' })
    await new LiveGitHubSource({ fetch: fetcher }).getRepo('kleros', 'gateway-balancer-bot')
    expect(seen[1]!.headers.Authorization).toBeUndefined()
  })

  it('maps repos, pulls and commits to domain types', async () => {
    const { fetcher, seen } = stub({
      '/repos/kleros/gateway-balancer-bot/pulls/47/commits': ok([COMMIT]),
      '/repos/kleros/gateway-balancer-bot/pulls/47': ok(PULL),
      '/repos/kleros/gateway-balancer-bot/pulls?': ok([{ ...PULL, commits: undefined, additions: undefined }]),
      '/repos/kleros/gateway-balancer-bot/commits/': ok(COMMIT),
      '/repos/kleros/gateway-balancer-bot/commits?': ok([{ ...COMMIT, stats: undefined, files: undefined }]),
      '/repos/kleros/gateway-balancer-bot': ok(REPO),
    })
    const gh = createGitHubSource({ mode: 'live', fetch: fetcher })
    expect(gh.kind).toBe('live')
    const repo = await gh.getRepo('kleros', 'gateway-balancer-bot')
    expect(repo).toMatchObject({ fullName: 'kleros/gateway-balancer-bot', owner: 'kleros', stars: 38, license: 'MIT', private: false, updatedAt: '2026-10-01T12:00:00Z' })
    const pull = await gh.getPull('kleros', 'gateway-balancer-bot', 47)
    expect(pull).toMatchObject({ state: 'merged', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), labels: ['accounting', 'needs-verification'], commits: 4, changedFiles: 5 })
    expect(pull?.author.avatarUrl).toContain('avatars.githubusercontent.com')
    const list = await gh.listPulls('kleros', 'gateway-balancer-bot', { state: 'all' })
    expect(list[0]?.commits).toBe(0)
    expect(seen.at(-1)!.url).toContain('state=all')
    const commits = await gh.listPullCommits('kleros', 'gateway-balancer-bot', 47)
    expect(commits[0]).toMatchObject({ sha: 'a'.repeat(40), verified: true, parents: ['c'.repeat(40)], author: { login: 'tomas-reyes', name: 'Tomás Reyes' } })
    const commit = await gh.getCommit('kleros', 'gateway-balancer-bot', 'aaaaaaa')
    expect(commit?.files?.[0]?.filename).toBe('src/funding/reporter-planner.ts')
    expect(commit?.stats?.total).toBe(45)
    const history = await gh.listCommits('kleros', 'gateway-balancer-bot', { ref: 'main', limit: 5 })
    expect(history[0]?.stats).toBeUndefined()
    expect(seen.at(-1)!.url).toContain('sha=main')
  })

  it('returns null / empty for 404', async () => {
    const { fetcher } = stub({})
    const gh = new LiveGitHubSource({ fetch: fetcher })
    expect(await gh.getRepo('nope', 'nope')).toBeNull()
    expect(await gh.getPull('nope', 'nope', 1)).toBeNull()
    expect(await gh.getCommit('nope', 'nope', 'abc1234')).toBeNull()
    expect(await gh.listPulls('nope', 'nope')).toEqual([])
    expect(await gh.getViewer()).toBeNull() // no token
    expect((await gh.listViewerRepos()).items).toEqual([])
  })

  it('maps an exhausted rate limit to PineDataError(rate_limited) with the reset time', async () => {
    const reset = 1_790_000_000
    const { fetcher } = stub({
      '/repos/a/b': () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
      '/repos/c/d': () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
      '/repos/e/f': () => new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'x-ratelimit-remaining': '4999' } }),
      '/repos/g/h': () => new Response('oops', { status: 502 }),
      '/repos/empty/repo/commits': () => new Response(JSON.stringify({ message: 'Git Repository is empty.' }), { status: 409 }),
      '/repos/i/j/commits/': () => new Response(JSON.stringify({ message: 'No commit found for SHA: zzz' }), { status: 422 }),
    })
    const gh = new LiveGitHubSource({ fetch: fetcher })
    const err = (await gh.getRepo('a', 'b').catch((e: unknown) => e)) as PineDataError
    expect(err).toBeInstanceOf(PineDataError)
    expect(err.code).toBe('rate_limited')
    expect(err.message).toContain(new Date(reset * 1000).toISOString())
    expect((err.cause as { resetAt: string }).resetAt).toBe(new Date(reset * 1000).toISOString())
    await expect(gh.getRepo('c', 'd')).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(gh.getRepo('e', 'f')).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(gh.getRepo('g', 'h')).rejects.toMatchObject({ code: 'network' })
    expect(await gh.listCommits('empty', 'repo')).toEqual([])
    expect(await gh.getCommit('i', 'j', 'zzz')).toBeNull()
    const down = new LiveGitHubSource({ fetch: (async () => { throw new TypeError('offline') }) as typeof fetch })
    await expect(down.getRepo('a', 'b')).rejects.toMatchObject({ code: 'network' })
  })

  it('lists public viewer repos with page cursors', async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({ ...REPO, id: i, name: `r${i}`, full_name: `kleros/r${i}` }))
    const { fetcher, seen } = stub({ '/user/repos': ok(page, { link: '<https://api.github.com/user/repos?page=3>; rel="next"' }), '/user': ok({ login: 'mara-okafor', id: 1, avatar_url: 'x', html_url: 'y' }) })
    const gh = new LiveGitHubSource({ fetch: fetcher, token: 't' })
    const res = await gh.listViewerRepos({ cursor: '2', limit: 2 })
    expect(seen[0]!.url).toContain('/user/repos?visibility=public&sort=updated&per_page=2&page=2')
    expect(res.nextCursor).toBe('3')
    expect((await gh.getViewer())?.login).toBe('mara-okafor')
    // a full page whose Link header has no rel="next" is the last page
    const { fetcher: f2 } = stub({ '/user/repos': ok(page, { link: '<https://api.github.com/user/repos?page=1>; rel="prev"' }) })
    expect((await new LiveGitHubSource({ fetch: f2, token: 't' }).listViewerRepos({ limit: 2 })).nextCursor).toBeUndefined()
  })
})

describe('MockGitHubSource', () => {
  const gh = createGitHubSource({ mode: 'mock' })

  it('serves fixture repos, including one flagged private', async () => {
    expect(gh.kind).toBe('mock')
    expect((await gh.getViewer())?.login).toBe('mara-okafor')
    const mine = await gh.listViewerRepos()
    expect(mine.items.some((r) => r.private)).toBe(true)
    expect((await gh.searchRepos('keeper')).map((r) => r.fullName)).toContain('kleros/gateway-balancer-bot')
    expect((await gh.searchRepos('ops-runbooks')).length).toBe(0) // private repos are not searchable
    expect(await gh.getRepo('KLEROS', 'Gateway-Balancer-Bot')).not.toBeNull()
    expect(await gh.getRepo('nope', 'nope')).toBeNull()
  })

  it('serves PRs by state, PR commits and commit lookup by short SHA', async () => {
    const open = await gh.listPulls('acme-labs', 'fastparse')
    expect(open.every((p) => p.state === 'open')).toBe(true)
    const closed = await gh.listPulls('acme-labs', 'fastparse', { state: 'closed' })
    expect(closed.map((p) => p.state)).toEqual(['merged'])
    const pr = await gh.getPull('kleros', 'gateway-balancer-bot', 47)
    const commits = await gh.listPullCommits('kleros', 'gateway-balancer-bot', 47)
    expect(commits.at(-1)?.sha).toBe(pr?.headSha)
    const byShort = await gh.getCommit('kleros', 'gateway-balancer-bot', pr!.headSha.slice(0, 7))
    expect(byShort?.sha).toBe(pr?.headSha)
    expect((byShort as unknown as Record<string, unknown>).repo).toBeUndefined()
    const branch = await gh.listCommits('kleros', 'gateway-balancer-bot', { ref: pr!.headRef })
    expect(branch[0]?.sha).toBe(pr?.headSha)
    expect(branch.some((c) => c.sha === pr?.baseSha)).toBe(true)
    const walk = await gh.listCommits('kleros', 'gateway-balancer-bot', { ref: pr!.baseSha, limit: 3 })
    expect(walk[0]?.sha).toBe(pr?.baseSha)
    expect(walk).toHaveLength(3)
    expect(await gh.listPulls('mara-okafor', 'reporter-sim')).toEqual([])
  })

  it('every fixture claim resolves through parseGitHubRef + the mock source', async () => {
    for (const c of fixtures.claims) {
      const ref = parseGitHubRef(`https://github.com/${c.source.owner}/${c.source.repo}/pull/${c.source.prNumber}`)
      expect(ref?.kind).toBe('pull')
      const pr = await gh.getPull(c.source.owner, c.source.repo, c.source.prNumber!)
      expect(pr?.headSha).toBe(c.source.commitSha)
    }
  })
})
