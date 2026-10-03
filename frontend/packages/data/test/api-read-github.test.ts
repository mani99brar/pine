/** api read side: ApiGitHubSource over the backend's /api/v1/github routes and /api/v1/auth/session. */
import { describe, expect, it } from 'vitest'
import { ApiGitHubSource, createGitHubSource, PineBackendError } from '../src'
import { apiError, fakeBackend, githubCommit, githubPull, githubRepo, json, session, TARGET_COMMIT } from './api-read-fixtures'

const REPO = '/api/v1/github/repos/kleros/kleros-v2'

function source(routes: Parameters<typeof fakeBackend>[0], unavailable: 'empty' | 'throw' = 'empty', now = () => 0) {
  const backend = fakeBackend(routes)
  return { gh: new ApiGitHubSource({ baseUrl: '', fetch: backend.fetch, unavailable, now }), calls: backend.calls }
}

describe('ApiGitHubSource', () => {
  it('is the api mode of createGitHubSource', () => {
    const gh = createGitHubSource({ mode: 'api' })
    expect(gh).toBeInstanceOf(ApiGitHubSource)
    expect(gh.kind).toBe('live')
  })

  it('reads the viewer from the backend session', async () => {
    const { gh, calls } = source({ '/api/v1/auth/session': session() })
    expect(await gh.getViewer()).toEqual({
      login: 'maintainer',
      id: 9001,
      name: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/9001',
      htmlUrl: 'https://github.com/maintainer',
    })
    expect(calls).toEqual(['/api/v1/auth/session'])
    expect((await source({ '/api/v1/auth/session': session({ githubUserId: null, githubLogin: null }) }).gh.getViewer())).toBeNull()
    expect(await source({ '/api/v1/auth/session': apiError(401, 'UNAUTHENTICATED', 'Sign in required') }).gh.getViewer()).toBeNull()
    expect(await source({ '/api/v1/auth/session': apiError(401, 'UNAUTHENTICATED') }, 'throw').gh.getViewer()).toBeNull()
  })

  it('lists the linked account’s public repositories page by page', async () => {
    const { gh, calls } = source({
      '/api/v1/github/repos?page=1': { items: [githubRepo()], hasMore: true },
      '/api/v1/github/repos?page=2': { items: [githubRepo({ id: 5, name: 'docs', fullName: 'kleros/docs', pushedAt: null })], hasMore: false },
    })
    const first = await gh.listViewerRepos({ limit: 50 })
    expect(first).toEqual({
      items: [
        {
          id: 427_016_914,
          owner: 'kleros',
          name: 'kleros-v2',
          fullName: 'kleros/kleros-v2',
          description: null,
          private: false,
          defaultBranch: 'main',
          language: null,
          stars: 0,
          license: null,
          htmlUrl: 'https://github.com/kleros/kleros-v2',
          updatedAt: '2026-10-03T08:00:00Z',
        },
      ],
      nextCursor: '2',
    })
    const second = await gh.listViewerRepos({ cursor: first.nextCursor })
    expect(second.nextCursor).toBeUndefined()
    expect(second.items[0]).toMatchObject({ name: 'docs', updatedAt: '' })
    expect(await gh.listViewerRepos({ cursor: '../1' })).toEqual({ items: [] })
    expect(await gh.listViewerRepos({ cursor: '101' })).toEqual({ items: [] })
    expect(calls).toEqual(['/api/v1/github/repos?page=1', '/api/v1/github/repos?page=2'])
  })

  it('treats a signed-out session or an unlinked GitHub account (401/403) as "not available", or rethrows on request', async () => {
    const unlinked = apiError(403, 'FORBIDDEN', 'Connect your GitHub account first')
    const routes = { '/api/v1/github/repos': unlinked, [REPO]: unlinked, [`${REPO}/pulls`]: unlinked, [`${REPO}/pulls/2101`]: unlinked, [`${REPO}/pulls/2101/commits`]: unlinked, [`${REPO}/commits/${TARGET_COMMIT}`]: unlinked }
    const { gh } = source(routes)
    expect(await gh.listViewerRepos()).toEqual({ items: [] })
    expect(await gh.searchRepos('kleros/kleros-v2')).toEqual([])
    expect(await gh.getRepo('kleros', 'kleros-v2')).toBeNull()
    expect(await gh.listPulls('kleros', 'kleros-v2')).toEqual([])
    expect(await gh.getPull('kleros', 'kleros-v2', 2101)).toBeNull()
    expect(await gh.listPullCommits('kleros', 'kleros-v2', 2101)).toEqual([])
    expect(await gh.getCommit('kleros', 'kleros-v2', TARGET_COMMIT)).toBeNull()
    const strict = source(routes, 'throw').gh
    await expect(strict.getRepo('kleros', 'kleros-v2')).rejects.toMatchObject({ name: 'PineBackendError', status: 403, message: 'Connect your GitHub account first' })
    await expect(strict.listViewerRepos()).rejects.toBeInstanceOf(PineBackendError)
    await expect(strict.searchRepos('kleros')).rejects.toMatchObject({ status: 403 })
    // Other failures always surface.
    await expect(source({ [REPO]: apiError(502, 'UPSTREAM_UNAVAILABLE') }).gh.getRepo('kleros', 'kleros-v2')).rejects.toMatchObject({ status: 502 })
  })

  it('SEC-GH-13 reads a non-public repository as unavailable and rejects a "private" repository payload', async () => {
    expect(await source({ [REPO]: apiError(422, 'UNPROCESSABLE', 'Only public repositories are supported') }).gh.getRepo('kleros', 'kleros-v2')).toBeNull()
    await expect(source({ [REPO]: githubRepo({ private: true }) }).gh.getRepo('kleros', 'kleros-v2')).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
    expect(await source({ [REPO]: apiError(404, 'NOT_FOUND') }).gh.getRepo('kleros', 'kleros-v2')).toBeNull()
  })

  it('builds links from validated owner/name/number/sha, never from upstream URLs', async () => {
    const { gh } = source({
      [REPO]: { ...githubRepo({ htmlUrl: 'javascript:alert(1)' }), viewerPermission: 'admin' },
      [`${REPO}/pulls/2101`]: githubPull({ htmlUrl: 'https://evil.example/pull/2101' }),
      [`${REPO}/commits/${TARGET_COMMIT}`]: { commit: githubCommit({ htmlUrl: 'https://evil.example/c' }), membershipVerified: false },
    })
    expect((await gh.getRepo('kleros', 'kleros-v2'))?.htmlUrl).toBe('https://github.com/kleros/kleros-v2')
    expect((await gh.getPull('kleros', 'kleros-v2', 2101))?.htmlUrl).toBe('https://github.com/kleros/kleros-v2/pull/2101')
    expect((await gh.getCommit('kleros', 'kleros-v2', TARGET_COMMIT))?.htmlUrl).toBe(`https://github.com/kleros/kleros-v2/commit/${TARGET_COMMIT}`)
  })

  it('maps pull requests and their commits', async () => {
    const { gh, calls } = source({
      [`${REPO}/pulls?state=all&page=1`]: { items: [githubPull(), githubPull({ number: 7, state: 'open', merged: false, authorLogin: null })], hasMore: false },
      [`${REPO}/pulls/2101/commits`]: { items: [githubCommit(), githubCommit({ sha: 'F'.repeat(40), authorLogin: null, committedAt: null })] },
    })
    const pulls = await gh.listPulls('kleros', 'kleros-v2', { state: 'all' })
    expect(pulls[0]).toEqual({
      number: 2101,
      title: 'Reporter journal: persist deposit source',
      state: 'merged',
      draft: false,
      author: { login: 'tomas-reyes', id: 0, name: null, avatarUrl: 'https://avatars.githubusercontent.com/tomas-reyes', htmlUrl: 'https://github.com/tomas-reyes' },
      htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101',
      headSha: TARGET_COMMIT,
      headRef: 'feat/reporter-journal',
      baseSha: '0123456789abcdef0123456789abcdef01234567',
      baseRef: 'main',
      createdAt: '',
      updatedAt: '2026-10-02T09:30:00Z',
      commits: 0,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      labels: [],
      body: null,
    })
    expect(pulls[1]).toMatchObject({ state: 'open', author: { login: 'ghost' } })
    const commits = await gh.listPullCommits('kleros', 'kleros-v2', 2101)
    expect(commits[0]).toEqual({
      sha: TARGET_COMMIT,
      message: 'reporter: persist the deposit source before sending',
      author: { name: 'tomas-reyes', login: 'tomas-reyes', avatarUrl: 'https://avatars.githubusercontent.com/tomas-reyes', date: '2026-10-02T09:00:00Z' },
      htmlUrl: `https://github.com/kleros/kleros-v2/commit/${TARGET_COMMIT}`,
      parents: ['0123456789abcdef0123456789abcdef01234567'],
    })
    expect(commits[1]).toMatchObject({ sha: 'f'.repeat(40), author: { name: 'unknown', date: '' } })
    expect(calls).toEqual([`${REPO}/pulls?state=all&page=1`, `${REPO}/pulls/2101/commits`])
  })

  it('SEC-GH-15 rejects GitHub data that is not well-formed', async () => {
    await expect(source({ [`${REPO}/pulls/2101/commits`]: { items: [githubCommit({ sha: 'abc123' })] } }).gh.listPullCommits('kleros', 'kleros-v2', 2101)).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
    await expect(source({ [`${REPO}/pulls/2101`]: githubPull({ headSha: `0x${TARGET_COMMIT}` }) }).gh.getPull('kleros', 'kleros-v2', 2101)).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
    await expect(source({ '/api/v1/github/repos': { items: [githubRepo({ owner: '../admin' })], hasMore: false } }).gh.listViewerRepos()).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
  })

  it('never sends a request for malformed owners, names, numbers or SHAs', async () => {
    const { gh, calls } = source({})
    expect(await gh.getRepo('..', 'x')).toBeNull()
    expect(await gh.getRepo('kleros', '..')).toBeNull()
    expect(await gh.getRepo('kleros', '.')).toBeNull()
    expect(await gh.getRepo('kleros/x', 'y')).toBeNull()
    expect(await gh.getRepo('-kleros', 'y')).toBeNull()
    expect(await gh.listPulls('kleros', '%2e%2e')).toEqual([])
    for (const n of [0, -1, 1.5, 2 ** 31, Number.NaN]) expect(await gh.getPull('kleros', 'kleros-v2', n)).toBeNull()
    expect(await gh.listPullCommits('kleros', 'kleros-v2', 0)).toEqual([])
    expect(await gh.getCommit('kleros', 'kleros-v2', 'ab12cd3')).toBeNull()
    expect(await gh.getCommit('kleros', 'kleros-v2', '../../../user')).toBeNull()
    expect(await gh.listCommits()).toEqual([])
    expect(calls).toEqual([])
  })

  it('looks a commit up by its full SHA, lowercased', async () => {
    const { gh, calls } = source({ [`${REPO}/commits/${TARGET_COMMIT}`]: { commit: githubCommit(), membershipVerified: false } })
    expect((await gh.getCommit('kleros', 'kleros-v2', TARGET_COMMIT.toUpperCase()))?.sha).toBe(TARGET_COMMIT)
    expect(calls).toEqual([`${REPO}/commits/${TARGET_COMMIT}`])
    expect(await source({}).gh.getCommit('kleros', 'kleros-v2', TARGET_COMMIT)).toBeNull()
  })

  it('searches by owner/name lookup plus the linked account’s repositories (cached for a minute)', async () => {
    let now = 0
    const { gh, calls } = source(
      {
        '/api/v1/github/repos?page=1': { items: [githubRepo(), githubRepo({ id: 5, name: 'docs', fullName: 'kleros/docs' })], hasMore: false },
        [REPO]: { ...githubRepo(), viewerPermission: 'read' },
        '/api/v1/github/repos/pinehq/pine': json({ ...githubRepo({ id: 9, owner: 'pinehq', name: 'pine', fullName: 'pinehq/pine' }), viewerPermission: 'none' }),
      },
      'empty',
      () => now,
    )
    expect((await gh.searchRepos('kleros/kleros-v2')).map((r) => r.fullName)).toEqual(['kleros/kleros-v2'])
    expect((await gh.searchRepos('https://github.com/pinehq/pine')).map((r) => r.fullName)).toEqual(['pinehq/pine'])
    expect((await gh.searchRepos('DOCS')).map((r) => r.fullName)).toEqual(['kleros/docs'])
    expect(await gh.searchRepos('k')).toEqual([])
    expect(calls.filter((u) => u.startsWith('/api/v1/github/repos?'))).toEqual(['/api/v1/github/repos?page=1'])
    now = 61_000
    await gh.searchRepos('docs')
    expect(calls.filter((u) => u.startsWith('/api/v1/github/repos?'))).toHaveLength(2)
  })
})
