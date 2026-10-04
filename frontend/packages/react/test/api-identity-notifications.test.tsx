/** `api` mode notifications: GET /api/v1/accounts/me/notifications and POST …/:id/read. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { PineSession } from '@pine/data'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { usePineNotifications } from '../src/api/identity'

const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const MARKET = '0x5fbdb2315678afecb367f032d93f642f64180aa3'
const ID_1 = '3b241101-e2bb-4255-8caf-4136c566a962'
const ID_2 = '6f1c2b8e-5a4d-4f3e-9b2a-1c0d9e8f7a6b'
const ID_3 = '0d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a'

const SESSION: PineSession = {
  wallet: WALLET,
  githubUserId: null,
  githubLogin: null,
  isAdmin: false,
  termsDigest: `0x${'ab'.repeat(32)}`,
  termsAccepted: true,
  authenticatedAt: '2026-10-04T12:00:00.000Z',
  idleExpiresAt: '2026-10-05T12:00:00.000Z',
  absoluteExpiresAt: '2026-10-11T12:00:00.000Z',
}

function notification(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    market: MARKET,
    kind: 'evidence_closing',
    target: 1_791_201_600,
    message: 'Evidence submission closes at 2026-10-05T12:00:00Z UTC.',
    payload: { market: MARKET },
    createdAt: '2026-10-04T12:00:00.000Z',
    readAt: null,
    ...over,
  }
}

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthenticated = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'req-1' } })

function backend(route: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, 'http://localhost')
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      }
      calls.push(call)
      return route(call) ?? json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-2' } })
    }),
  )
  return calls
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'api', demoWallet: false }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('usePineNotifications', () => {
  it('lists the signed-in user’s notifications and pages with the cursor', async () => {
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications') return json(200, { items: [notification(ID_1), notification(ID_2, { readAt: '2026-10-04T13:00:00.000Z' })], nextCursor: 'cursor-1' })
      if (c.path === '/api/v1/accounts/me/notifications?cursor=cursor-1') return json(200, { items: [notification(ID_3, { kind: 'arbitration_Requested' })], nextCursor: null })
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items.map((n) => n.id)).toEqual([ID_1, ID_2])
    expect(result.current.unread).toBe(1)
    expect(result.current.hasMore).toBe(true)
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(3))
    expect(result.current.hasMore).toBe(false)
    expect(calls.filter((c) => c.path.startsWith('/api/v1/accounts/me/notifications')).every((c) => c.method === 'GET')).toBe(true)
  })

  it('asks the backend for unread notifications only when filtered', async () => {
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications?unread=true') return json(200, { items: [notification(ID_1)], nextCursor: null })
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications({ unreadOnly: true }), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.items).toHaveLength(1)
    expect(calls.some((c) => c.path === '/api/v1/accounts/me/notifications?unread=true')).toBe(true)
  })

  it('marks one as read with the CSRF header and an empty JSON object', async () => {
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications') return json(200, { items: [notification(ID_1)], nextCursor: null })
      if (c.path === `/api/v1/accounts/me/notifications/${ID_1}/read`) return json(200, { id: ID_1, readAt: '2026-10-04T14:00:00.000Z' })
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    await act(async () => {
      await result.current.markRead(ID_1)
    })
    const read = calls.find((c) => c.path.endsWith('/read'))
    expect(read).toMatchObject({ method: 'POST', body: {} })
    expect(read?.headers['x-pine-csrf']).toBe('1')
    expect(read?.headers['content-type']).toBe('application/json')
    expect(result.current.items[0]?.readAt).toBe('2026-10-04T14:00:00.000Z')
    expect(result.current.unread).toBe(0)
  })

  it('rejects a malformed page at the boundary instead of rendering it', async () => {
    backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications') {
        return json(200, { items: [notification('../../auth/logout'), notification(ID_2, { market: 'javascript:alert(1)', message: { html: '<img src=x>' } })], nextCursor: null })
      }
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.items).toEqual([])
    expect(result.current.error?.message).toMatch(/unexpected shape/)
  })

  it('never sends a read request for an id that is not a notification id', async () => {
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications') return json(200, { items: [], nextCursor: null })
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await expect(result.current.markRead('../../auth/logout')).rejects.toThrow(/Invalid notification id/)
    })
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('stays idle while signed out', async () => {
    const calls = backend((c) => (c.path === '/api/v1/auth/session' ? unauthenticated() : undefined))
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    expect(result.current.items).toEqual([])
    expect(calls.some((c) => c.path.startsWith('/api/v1/accounts'))).toBe(false)
  })

  it('drops the session when the backend says it ended, without asking again in a loop', async () => {
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return json(200, SESSION)
      if (c.path === '/api/v1/accounts/me/notifications') return unauthenticated()
      return undefined
    })
    const { result } = renderHook(() => usePineNotifications(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.status).toBe('signed_out')
    expect(calls.filter((c) => c.path === '/api/v1/auth/session')).toHaveLength(1)
    expect(calls.filter((c) => c.path === '/api/v1/accounts/me/notifications')).toHaveLength(1)
  })
})
