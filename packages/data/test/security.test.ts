/** Security regressions for @pine/data: URL building from user input, auth headers, GraphQL variables. */
import { describe, expect, it, vi } from 'vitest'
import { EnvioDataProvider, LiveGitHubSource, PineDataError, RestAccountStore, RestDataProvider, RestDraftStore } from '../src'
import { hasDotSegment } from '../src/internal/util'
import type { ClaimDraft } from '@pine/core'

function recordingFetch(response: () => Response = () => new Response('{}', { status: 200 })) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response()
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

describe('security: dot segments in REST paths', () => {
  it('hasDotSegment catches plain and percent-encoded dot segments, only in the path', () => {
    for (const p of ['/drafts/..', '/drafts/.', '/drafts/%2e%2e', '/drafts/.%2E', '/a/../b', '/x/%2E']) expect(hasDotSegment(p), p).toBe(true)
    for (const p of ['/drafts/d1', '/drafts/...', '/drafts/a.b', '/search?q=../..', '/claims/pine-0001']) expect(hasDotSegment(p), p).toBe(false)
  })

  it('draft store never sends an authenticated request for "." or ".." ids', async () => {
    const { fetcher, calls } = recordingFetch()
    const store = new RestDraftStore({ baseUrl: 'https://api.test/v1', fetch: fetcher, getToken: () => 'user-token' })
    expect(await store.get('..')).toBeNull()
    await store.remove('.')
    await expect(store.save({ id: '..' } as ClaimDraft)).rejects.toBeInstanceOf(PineDataError)
    expect(calls).toEqual([])
  })

  it('read provider resolves dot ids to "not found" without fetching', async () => {
    const { fetcher, calls } = recordingFetch()
    const p = new RestDataProvider({ baseUrl: 'https://api.test/v1', fetch: fetcher })
    expect(await p.getClaim('..')).toBeNull()
    expect(await p.getPolicy('.')).toBeNull()
    expect(calls).toEqual([])
  })

  it('account store percent-encodes wallet addresses in paths', async () => {
    const account = { id: 'gh:x', github: { login: 'x', id: 1, name: null, avatar_url: '', html_url: '', scopes: [] }, wallets: [], preferences: {}, created_at: '2026-10-03T00:00:00Z', demo: false }
    const { fetcher, calls } = recordingFetch(() => new Response(JSON.stringify(account), { status: 200 }))
    const store = new RestAccountStore({ baseUrl: 'https://api.test/v1', fetch: fetcher, getToken: () => 'tok' })
    await store.unlinkWallet('x', '../../admin' as `0x${string}`).catch(() => undefined)
    expect(calls[0]?.url).toBe('https://api.test/v1/accounts/x/wallets/..%2F..%2Fadmin')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('reads never carry the bearer token; writes do', async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const p = new RestDataProvider({ baseUrl: 'https://api.test/v1', fetch: fetcher, getToken: () => 'secret-token' })
    await p.listEvidence('pine-0001')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('security: GitHub client paths', () => {
  it('owner/repo/sha of "." or ".." never reach another GitHub API endpoint with the token', async () => {
    const { fetcher, calls } = recordingFetch(() => new Response(JSON.stringify({ login: 'victim' }), { status: 200 }))
    const gh = new LiveGitHubSource({ token: 'gho_secret', fetch: fetcher })
    expect(await gh.getRepo('..', 'user')).toBeNull()
    expect(await gh.getRepo('kleros', '..')).toBeNull()
    expect(await gh.getCommit('kleros', 'repo', '..')).toBeNull()
    expect(await gh.listCommits('kleros', '.')).toEqual([])
    expect(calls).toEqual([])
  })

  it('encodes path segments built from user input', async () => {
    const { fetcher, calls } = recordingFetch(() => new Response('null', { status: 404 }))
    const gh = new LiveGitHubSource({ fetch: fetcher })
    await gh.getCommit('kleros', 'repo', 'abc/../../user')
    expect(calls[0]?.url).toBe('https://api.github.com/repos/kleros/repo/commits/abc%2F..%2F..%2Fuser')
  })
})

describe('security: Envio queries', () => {
  it('user input only travels in GraphQL variables, never in the query text', async () => {
    const bodies: { query: string; variables: Record<string, unknown> }[] = []
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ data: { Claim: [] } }))
    }) as unknown as typeof fetch
    const p = new EnvioDataProvider({ url: 'https://indexer.test/v1/graphql', fetch: fetcher })
    const evil = '"} } mutation { delete_Claim(where: {}) { affected_rows } } #'
    await p.listClaims({ search: evil, policyId: evil, repo: evil })
    await p.getClaim(evil)
    expect(bodies.length).toBe(2)
    for (const b of bodies) {
      expect(b.query.toLowerCase()).not.toContain('mutation')
      expect(b.query.toLowerCase()).not.toContain('delete_claim')
      expect(JSON.stringify(b.variables).toLowerCase()).toContain('delete')
    }
  })
})
