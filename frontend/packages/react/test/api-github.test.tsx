import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { useGitHubCommits, useGitHubPulls, useGitHubRepo, useGitHubRepoSearch, useGitHubViewerRepos, useResolveGitHubInput } from '../src/github'

// `api` mode: the GitHub hooks read the Pine backend's /api/v1/github routes (backend session cookie, same origin),
// never the app's /api/github proxy, and keep the proxy's error semantics.

const SHA = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
const BASE = '0123456789abcdef0123456789abcdef01234567'
const REPO = '/api/v1/github/repos/kleros/kleros-v2'

const repo = { id: 427_016_914, owner: 'kleros', ownerId: 1_001_001, name: 'kleros-v2', fullName: 'kleros/kleros-v2', private: false, fork: false, defaultBranch: 'main', htmlUrl: 'https://github.com/kleros/kleros-v2', pushedAt: '2026-10-03T08:00:00Z' }
const pull = { number: 2101, title: 'Reporter journal', state: 'open', merged: false, headSha: SHA, headRef: 'feat/journal', headRepoId: 427_016_914, baseSha: BASE, baseRef: 'main', htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101', authorLogin: 'tomas-reyes', updatedAt: '2026-10-02T09:30:00Z' }
const commit = { sha: SHA, parents: [BASE], message: 'reporter: persist the deposit source', authorLogin: 'tomas-reyes', committedAt: '2026-10-02T09:00:00Z', htmlUrl: `https://github.com/kleros/kleros-v2/commit/${SHA}` }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const notFound = () => json({ error: { code: 'NOT_FOUND', message: 'Not found on GitHub', requestId: 'r' } }, 404)
const unlinked = () => json({ error: { code: 'FORBIDDEN', message: 'Connect your GitHub account first', requestId: 'r' } }, 403)

const linkedRoutes: Record<string, () => Response> = {
  '/api/v1/github/repos?page=1': () => json({ items: [repo], hasMore: false }),
  [REPO]: () => json({ ...repo, viewerPermission: 'admin' }),
  [`${REPO}/pulls?state=all&page=1`]: () => json({ items: [pull], hasMore: false }),
  [`${REPO}/pulls/2101`]: () => json(pull),
  [`${REPO}/pulls/2101/commits`]: () => json({ items: [commit] }),
  [`${REPO}/commits/${SHA}`]: () => json({ commit, membershipVerified: false }),
}

let routes: Record<string, () => Response> = linkedRoutes
const calls: string[] = []

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'api', demoWallet: false }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

beforeEach(() => {
  routes = linkedRoutes
  calls.length = 0
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    return (routes[url] ?? notFound)()
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('GitHub hooks in api mode', () => {
  it('read the backend’s GitHub routes, never the app proxy', async () => {
    const r = renderHook(() => useGitHubRepo('kleros', 'kleros-v2'), { wrapper })
    await waitFor(() => expect(r.result.current.data?.fullName).toBe('kleros/kleros-v2'))
    const pulls = renderHook(() => useGitHubPulls('kleros', 'kleros-v2', 'all'), { wrapper })
    await waitFor(() => expect(pulls.result.current.data?.map((p) => p.number)).toEqual([2101]))
    const viewer = renderHook(() => useGitHubViewerRepos({ limit: 50 }), { wrapper })
    await waitFor(() => expect(viewer.result.current.data?.items.map((x) => x.fullName)).toEqual(['kleros/kleros-v2']))
    expect(calls).toEqual(expect.arrayContaining([REPO, `${REPO}/pulls?state=all&page=1`, '/api/v1/github/repos?page=1']))
    expect(calls.some((u) => u.startsWith('/api/github/'))).toBe(false)
  })

  it('resolves a pull request URL to its head commit and a SourceRef', async () => {
    const { result } = renderHook(() => useResolveGitHubInput('https://github.com/kleros/kleros-v2/pull/2101/files'), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('resolved'), { timeout: 3000 })
    expect(result.current.commit?.sha).toBe(SHA)
    expect(result.current.source).toMatchObject({ provider: 'github', owner: 'kleros', repo: 'kleros-v2', repoId: 427_016_914, commit: { sha: SHA }, pullRequest: { number: 2101 }, baseCommit: { sha: BASE } })
  })

  it('says "connect your GitHub account" (403) instead of "not found" when GitHub is not linked', async () => {
    routes = Object.fromEntries(Object.keys(linkedRoutes).map((k) => [k, unlinked]))
    const r = renderHook(() => useGitHubRepo('kleros', 'kleros-v2'), { wrapper })
    await waitFor(() => expect(r.result.current.isError).toBe(true))
    expect(r.result.current.error).toMatchObject({ status: 403, message: 'Connect your GitHub account first' })
    const resolved = renderHook(() => useResolveGitHubInput('kleros/kleros-v2'), { wrapper })
    await waitFor(() => expect(resolved.result.current.status).toBe('error'), { timeout: 3000 })
    expect(resolved.result.current.reason).toBe('Connect your GitHub account first')
    const viewer = renderHook(() => useGitHubViewerRepos(), { wrapper })
    await waitFor(() => expect(viewer.result.current.error?.status).toBe(403))
    const search = renderHook(() => useGitHubRepoSearch('kleros'), { wrapper })
    await waitFor(() => expect(search.result.current.error?.status).toBe(403), { timeout: 3000 })
  })

  it('reports a missing repository as not found, like the proxy', async () => {
    const { result } = renderHook(() => useResolveGitHubInput('kleros/no-such-repo'), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('not_found'), { timeout: 3000 })
    expect(result.current.reason).toMatch(/kleros\/no-such-repo was not found/)
  })

  it('asks for the full SHA instead of sending a short one', async () => {
    const { result } = renderHook(() => useResolveGitHubInput('kleros/kleros-v2@ab12cd3'), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('error'), { timeout: 3000 })
    expect(result.current.reason).toMatch(/full 40-character commit SHA/)
    expect(calls.some((u) => u.includes('/commits/'))).toBe(false)
  })

  it('has no branch history in api mode (commits come through pull requests)', async () => {
    const { result } = renderHook(() => useGitHubCommits('kleros', 'kleros-v2'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual([])
    expect(calls.some((u) => u.includes('/commits'))).toBe(false)
  })
})
