/**
 * `api` mode session robustness: a failed session check is "unknown" (not signed out, no refetch loop), the session is
 * refetched on focus and reconnect, any backend 401 drops the cached session, and tabs tell each other about changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query'
import { createSiweMessage } from 'viem/siwe'
import { PineApiClient, anyBodySchema, type PineSession } from '@pine/data'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { pineKeys } from '../src/queries/keys'
import { useAccount } from '../src/account'
import { useGitHubLink, usePineSession, useSignOut } from '../src/api/session'
import { __resetIdentityState, useWalletSessionGuard, useWalletSwitchNotice } from '../src/api/identity'

const fake = vi.hoisted(() => ({
  wallet: { address: undefined as `0x${string}` | undefined, chainId: 100 as number | undefined, isConnected: false, isReconnecting: false },
  sign: vi.fn<(args: { message: string; account: string }) => Promise<`0x${string}`>>(),
}))

vi.mock('../src/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/wallet')>()
  return {
    ...actual,
    useWallet: () => ({ ...fake.wallet, isDemo: false, connect: () => undefined, disconnect: () => undefined, switchChain: async () => undefined }),
  }
})

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  return { ...actual, useSignMessage: () => ({ signMessageAsync: fake.sign }) }
})

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const
const TERMS = `0x${'ab'.repeat(32)}`
const NONCE = '0123456789abcdef0123456789abcdef'
const NOW = new Date('2026-10-04T12:00:00Z')
const SESSION_PATH = '/api/v1/auth/session'

function sessionView(wallet: string, over: Partial<PineSession> = {}): PineSession {
  return {
    wallet: wallet.toLowerCase(),
    githubUserId: null,
    githubLogin: null,
    isAdmin: false,
    termsDigest: TERMS,
    termsAccepted: true,
    authenticatedAt: NOW.toISOString(),
    idleExpiresAt: '2026-10-05T12:00:00.000Z',
    absoluteExpiresAt: '2026-10-11T12:00:00.000Z',
    ...over,
  }
}

interface Call {
  method: string
  path: string
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const apiError = (status: number, code: string, message: string) => json(status, { error: { code, message, requestId: 'req-1' } })
const unauthenticated = () => apiError(401, 'UNAUTHENTICATED', 'Sign in required')
const unavailable = () => apiError(503, 'NOT_READY', 'Try again shortly')

function backend(route: (call: Call) => Response | Error | undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, 'http://localhost')
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname + url.search }
      calls.push(call)
      const res = route(call)
      if (res instanceof Error) throw res
      return res ?? apiError(404, 'NOT_FOUND', 'Not found')
    }),
  )
  return calls
}

const sessionCalls = (calls: Call[]) => calls.filter((c) => c.path === SESSION_PATH).length

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'api', demoWallet: false }} queryClient={qc}>
        {children}
      </PineProviders>
    )
  }
}

function render<T>(hook: () => T, qc: QueryClient = createPineQueryClient()) {
  return { qc, ...renderHook(hook, { wrapper: wrapperFor(qc) }) }
}

function connect(address: `0x${string}` | undefined) {
  fake.wallet = { address, chainId: 100, isConnected: address !== undefined, isReconnecting: false }
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

/** Created per call: the client reads the stubbed fetch when it is built. */
const client = () => new PineApiClient({ baseUrl: '' })

beforeEach(() => {
  __resetIdentityState()
  fake.sign.mockReset()
  connect(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a session check that fails (5xx, network)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('is unknown, not signed out, and is not refetched for every component that mounts afterwards', async () => {
    const calls = backend((c) => (c.path === SESSION_PATH ? unavailable() : undefined))
    const { qc } = render(() => usePineSession())
    await advance(10_000)
    // One request and two retries.
    expect(sessionCalls(calls)).toBe(3)

    // /account mounted the sign-in form here, whose own observer refetched the failed query, which went back to loading
    // and unmounted the form again: one request a second, forever.
    const later = render(() => ({ session: usePineSession(), account: useAccount() }), qc)
    await advance(30_000)
    expect(sessionCalls(calls)).toBe(3)
    expect(later.result.current.session).toMatchObject({ status: 'error', session: null })
    expect(later.result.current.session.error?.message).toMatch(/Try again shortly/)
    expect(later.result.current.account.status).toBe('error')
    expect(later.result.current.account.account).toBeNull()
  })

  it('also when the network fails', async () => {
    const calls = backend((c) => (c.path === SESSION_PATH ? new TypeError('Failed to fetch') : undefined))
    const { result } = render(() => useAccount())
    await advance(10_000)
    expect(sessionCalls(calls)).toBe(3)
    expect(result.current.status).toBe('error')
  })

  it('keeps the last known session when a refetch fails', async () => {
    let down = false
    backend((c) => (c.path === SESSION_PATH ? (down ? unavailable() : json(200, sessionView(A))) : undefined))
    const { result } = render(() => useAccount())
    await advance(100)
    expect(result.current.status).toBe('signed_in')
    down = true
    await act(async () => {
      void result.current.refresh()
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.status).toBe('signed_in')
    expect(result.current.backend?.wallet).toBe(A.toLowerCase())
  })

  it('is asked again when the window regains focus and when the browser comes back online', async () => {
    let down = true
    const calls = backend((c) => (c.path === SESSION_PATH ? (down ? unavailable() : json(200, sessionView(A))) : undefined))
    const { result } = render(() => useAccount())
    await advance(10_000)
    expect(result.current.status).toBe('error')

    down = false
    act(() => void document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await advance(100)
    expect(result.current.status).toBe('signed_in')

    // Back online: asked again although the session is not stale yet.
    const before = sessionCalls(calls)
    down = true
    act(() => {
      window.dispatchEvent(new Event('offline'))
      window.dispatchEvent(new Event('online'))
    })
    await advance(10_000)
    expect(sessionCalls(calls)).toBeGreaterThan(before)
    // Failed again: the last known session stays.
    expect(result.current.status).toBe('signed_in')
  })
})

describe('a backend 401 means there is no session', () => {
  function signedIn(route: (call: Call) => Response | undefined = () => undefined) {
    let session: PineSession | null = sessionView(A)
    const calls = backend((c) => {
      if (c.path === SESSION_PATH) return session ? json(200, session) : unauthenticated()
      return route(c)
    })
    return { calls, end: () => (session = null) }
  }

  /** A per-user read, mounted once the account is signed in. */
  const read = (path: string, key: string) => () => useQuery({ queryKey: ['pine', key, path], queryFn: () => client().get(path, anyBodySchema), retry: false })

  it('a 401 from a per-user query drops the cached session and the per-user data', async () => {
    const { end } = signedIn((c) => (c.path === '/api/v1/github/repos' ? unauthenticated() : undefined))
    const { result, qc } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    qc.setQueryData(['pine', 'notifications', 'all'], { pages: [] })
    end()
    const repos = render(read('/api/v1/github/repos', 'github'), qc)
    await waitFor(() => expect(repos.result.current.isError).toBe(true))
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    expect(qc.getQueryData(pineKeys.session())).toBeNull()
    expect(qc.getQueryData(['pine', 'notifications', 'all'])).toBeUndefined()
  })

  it('a 401 from a mutation does too', async () => {
    const { end } = signedIn((c) => (c.path === '/api/v1/drafts' ? unauthenticated() : undefined))
    const { result, qc } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    end()
    const save = render(() => useMutation({ mutationFn: () => client().post('/api/v1/drafts', anyBodySchema, {}) }), qc)
    await act(async () => {
      await save.result.current.mutateAsync().catch(() => undefined)
    })
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
  })

  it('a 401 from Link GitHub shows signed out instead of "Sign in required" next to "Signed in as"', async () => {
    const { end } = signedIn((c) => (c.path === '/api/v1/auth/github/start' ? unauthenticated() : undefined))
    const { result } = render(() => ({ account: useAccount(), gh: useGitHubLink() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    end()
    await act(async () => {
      await expect(result.current.gh.link()).rejects.toThrow(/Sign in required/)
    })
    expect(result.current.account.status).toBe('signed_out')
    expect(result.current.account.backend?.session).toBeNull()
  })

  it('a step-up request (401 STEP_UP_REQUIRED) keeps the session', async () => {
    signedIn((c) => (c.path === '/api/v1/admin/x' ? apiError(401, 'STEP_UP_REQUIRED', 'Sign in again') : undefined))
    const { result, qc } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    const admin = render(read('/api/v1/admin/x', 'admin'), qc)
    await waitFor(() => expect(admin.result.current.isError).toBe(true))
    expect(result.current.status).toBe('signed_in')
  })

  it('other failures (403, 5xx) keep the session', async () => {
    signedIn((c) => (c.path === '/api/v1/github/repos' ? apiError(403, 'FORBIDDEN', 'GitHub is not linked') : c.path === '/api/v1/drafts' ? unavailable() : undefined))
    const { result, qc } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    const repos = render(read('/api/v1/github/repos', 'github'), qc)
    const drafts = render(read('/api/v1/drafts', 'drafts'), qc)
    await waitFor(() => expect(repos.result.current.isError && drafts.result.current.isError).toBe(true))
    expect(result.current.status).toBe('signed_in')
  })
})

describe('tabs of this browser share the session', () => {
  const others: BroadcastChannel[] = []
  /** Another tab of the same browser. */
  function otherTab(): { channel: BroadcastChannel; received: unknown[] } {
    const channel = new BroadcastChannel('pine:session')
    const received: unknown[] = []
    channel.onmessage = (e: MessageEvent<unknown>) => received.push(e.data)
    others.push(channel)
    return { channel, received }
  }

  afterEach(() => {
    others.splice(0).forEach((c) => c.close())
  })

  it('refetches the session and the per-user data when another tab announces a change', async () => {
    let session: PineSession | null = sessionView(A)
    const calls = backend((c) => (c.path === SESSION_PATH ? (session ? json(200, session) : unauthenticated()) : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    const before = sessionCalls(calls)

    // The other tab signed out.
    session = null
    otherTab().channel.postMessage('session-changed')
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    expect(sessionCalls(calls)).toBe(before + 1)

    // ... and links GitHub after signing in again.
    session = sessionView(A, { githubLogin: 'pine-labs', githubUserId: 9001 })
    otherTab().channel.postMessage('session-changed')
    await waitFor(() => expect(result.current.backend?.github).toEqual({ login: 'pine-labs', id: 9001 }))
  })

  it('ignores other messages on the channel', async () => {
    const calls = backend((c) => (c.path === SESSION_PATH ? json(200, sessionView(A)) : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    const before = sessionCalls(calls)
    const tab = otherTab()
    tab.channel.postMessage({ type: 'session-changed', session: sessionView(B) })
    tab.channel.postMessage('something else')
    // A message that is handled refetches; wait for one so the ignored ones above have been delivered.
    tab.channel.postMessage('session-changed')
    await waitFor(() => expect(sessionCalls(calls)).toBe(before + 1))
    expect(result.current.backend?.wallet).toBe(A.toLowerCase())
  })

  it('announces a sign-out to the other tabs (and not to itself)', async () => {
    let session: PineSession | null = sessionView(A)
    const calls = backend((c) => {
      if (c.path === SESSION_PATH) return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/logout') {
        session = null
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const tab = otherTab()
    const { result } = render(() => ({ account: useAccount(), signOut: useSignOut() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    const before = sessionCalls(calls)
    await act(async () => {
      await result.current.signOut()
    })
    await waitFor(() => expect(tab.received).toEqual(['session-changed']))
    expect(result.current.account.status).toBe('signed_out')
    // This tab already knows: it does not refetch its own announcement.
    expect(sessionCalls(calls)).toBe(before)
  })

  it('announces a GitHub unlink', async () => {
    backend((c) => {
      if (c.path === SESSION_PATH) return json(200, sessionView(A, { githubLogin: 'pine-labs', githubUserId: 9001 }))
      if (c.path === '/api/v1/auth/github' && c.method === 'DELETE') return new Response(null, { status: 204 })
      return undefined
    })
    const tab = otherTab()
    const { result } = render(() => ({ account: useAccount(), gh: useGitHubLink() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    await act(async () => {
      await result.current.gh.unlink()
    })
    await waitFor(() => expect(tab.received).toEqual(['session-changed']))
  })

  it('works without BroadcastChannel', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    let session: PineSession | null = sessionView(A)
    backend((c) => {
      if (c.path === SESSION_PATH) return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/logout') {
        session = null
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const { result } = render(() => ({ account: useAccount(), signOut: useSignOut() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    await act(async () => {
      await result.current.signOut()
    })
    expect(result.current.account.status).toBe('signed_out')
  })
})

describe('the wallet-switch notice (SEC-AUTH-13)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  it('SEC-AUTH-13 clears the wallet-switch notice once the user signs in again, so a later manual sign-out does not repeat it', async () => {
    let session: PineSession | null = sessionView(A)
    backend((c) => {
      if (c.path === SESSION_PATH) return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/logout') {
        session = null
        return new Response(null, { status: 204 })
      }
      if (c.path === '/api/v1/auth/siwe/challenge') {
        const message = createSiweMessage({
          domain: window.location.host,
          address: B,
          statement: `Sign in to Pine. I accept the terms with sha256 ${TERMS}.`,
          uri: window.location.origin,
          version: '1',
          chainId: 100,
          nonce: NONCE,
          issuedAt: NOW,
          expirationTime: new Date(NOW.getTime() + 10 * 60_000),
        })
        return json(200, { message, nonce: NONCE, expiresAt: '2026-10-04T12:10:00.000Z' })
      }
      if (c.path === '/api/v1/auth/siwe/verify') {
        session = sessionView(B)
        return json(200, session)
      }
      return undefined
    })
    fake.sign.mockResolvedValue(`0x${'11'.repeat(65)}`)
    connect(A)
    const { result, rerender } = render(() => ({ guard: useWalletSessionGuard(), notice: useWalletSwitchNotice(), account: useAccount() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    connect(B)
    rerender()
    await waitFor(() => expect(result.current.notice.notice?.state).toBe('signed_out'))

    await act(async () => {
      await result.current.account.signIn()
    })
    expect(result.current.account.status).toBe('signed_in')
    expect(result.current.notice.notice).toBeNull()

    await act(async () => {
      await result.current.account.signOut()
    })
    expect(result.current.account.status).toBe('signed_out')
    expect(result.current.notice.notice).toBeNull()
  })

  it('SEC-AUTH-13 keeps the notice while the user stays signed out', async () => {
    let session: PineSession | null = sessionView(A)
    backend((c) => {
      if (c.path === SESSION_PATH) return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/logout') {
        session = null
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    connect(A)
    const { result, rerender } = render(() => ({ guard: useWalletSessionGuard(), notice: useWalletSwitchNotice(), account: useAccount() }))
    await waitFor(() => expect(result.current.account.status).toBe('signed_in'))
    connect(B)
    rerender()
    await waitFor(() => expect(result.current.notice.notice?.state).toBe('signed_out'))
    rerender()
    expect(result.current.notice.notice).toMatchObject({ from: A.toLowerCase(), to: B.toLowerCase(), state: 'signed_out' })
  })
})
