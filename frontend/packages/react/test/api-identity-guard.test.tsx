/** `api` mode sign-in through useAccount (SIWE) and the wallet-switch guard (SEC-AUTH-13), with a scripted wallet. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createSiweMessage } from 'viem/siwe'
import type { PineSession } from '@pine/data'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { useAccount } from '../src/account'
import { LOCAL_DRAFT_OWNER, useDraftOwner } from '../src/composer/drafts'
import { __resetIdentityState, useWalletSessionGuard } from '../src/api/identity'

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
const SIGNATURE = `0x${'11'.repeat(65)}` as const
const NOW = new Date('2026-10-04T12:00:00Z')

function sessionView(wallet: string): PineSession {
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
  }
}

/** The message the backend builds for this page's origin (siwe.ts), optionally tampered. */
function challengeMessage(over: Partial<Parameters<typeof createSiweMessage>[0]> = {}): string {
  return createSiweMessage({
    domain: window.location.host,
    address: A,
    statement: `Sign in to Pine. I accept the terms with sha256 ${TERMS}.`,
    uri: window.location.origin,
    version: '1',
    chainId: 100,
    nonce: NONCE,
    issuedAt: NOW,
    expirationTime: new Date(NOW.getTime() + 10 * 60_000),
    ...over,
  })
}

interface Call {
  method: string
  path: string
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
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname + url.search, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null }
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

function connect(address: `0x${string}` | undefined, isReconnecting = false) {
  fake.wallet = { address, chainId: 100, isConnected: address !== undefined, isReconnecting }
}

beforeEach(() => {
  // Only Date is faked (the sign-in message expiry is checked against the clock); timers stay real for waitFor.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  __resetIdentityState()
  fake.sign.mockReset()
  fake.sign.mockResolvedValue(SIGNATURE)
  connect(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('signIn() in api mode (Sign-In with Ethereum)', () => {
  it('checks the backend message, signs it in the wallet and verifies it', async () => {
    connect(A)
    let session: PineSession | null = null
    const message = challengeMessage()
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/siwe/challenge') return json(200, { message, nonce: NONCE, expiresAt: '2026-10-04T12:10:00.000Z' })
      if (c.path === '/api/v1/auth/siwe/verify') {
        session = sessionView(A)
        return json(200, session)
      }
      return undefined
    })
    const { result } = renderHook(() => ({ a: useAccount(), owner: useDraftOwner() }), { wrapper })
    await waitFor(() => expect(result.current.a.status).toBe('signed_out'))
    await act(async () => {
      await result.current.a.signIn()
    })
    expect(calls.find((c) => c.path === '/api/v1/auth/siwe/challenge')?.body).toEqual({ address: A.toLowerCase() })
    expect(fake.sign).toHaveBeenCalledWith({ message, account: A })
    expect(calls.find((c) => c.path === '/api/v1/auth/siwe/verify')?.body).toEqual({ message, signature: SIGNATURE })
    expect(result.current.a.status).toBe('signed_in')
    expect(result.current.a.backend?.siwe.step).toBe('done')
    expect(result.current.a.backend?.wallet).toBe(A.toLowerCase())
    expect(result.current.owner).toBe(A.toLowerCase())
  })

  it('SEC-AUTH-04 never signs a sign-in message for another site', async () => {
    connect(A)
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return unauthenticated()
      if (c.path === '/api/v1/auth/siwe/challenge') {
        return json(200, { message: challengeMessage({ domain: 'evil.example', uri: 'https://evil.example' }), nonce: NONCE, expiresAt: '2026-10-04T12:10:00.000Z' })
      }
      return undefined
    })
    const { result } = renderHook(() => useAccount(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    await act(async () => {
      await expect(result.current.signIn()).rejects.toThrow(/another site/)
    })
    expect(fake.sign).not.toHaveBeenCalled()
    expect(calls.some((c) => c.path === '/api/v1/auth/siwe/verify')).toBe(false)
    expect(result.current.backend?.siwe).toMatchObject({ step: 'error', error: expect.stringMatching(/another site/) })
    expect(result.current.status).toBe('signed_out')
  })
})

describe('useWalletSessionGuard (SEC-AUTH-13)', () => {
  function signedInAs(wallet: string, logout: () => Response = () => new Response(null, { status: 204 })) {
    let session: PineSession | null = sessionView(wallet)
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return session ? json(200, session) : unauthenticated()
      if (c.path === '/api/v1/auth/logout' && c.method === 'POST') {
        const res = logout()
        if (res.ok) session = null
        return res
      }
      return undefined
    })
    return calls
  }

  it('SEC-AUTH-13 signs out when the wallet switches to another account', async () => {
    connect(A)
    const calls = signedInAs(A)
    const { result, rerender } = renderHook(() => ({ guard: useWalletSessionGuard(), a: useAccount(), owner: useDraftOwner() }), { wrapper })
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    // The same account in EIP-55 or lower case is the same wallet.
    connect(A.toLowerCase() as `0x${string}`)
    rerender()
    expect(calls.some((c) => c.path === '/api/v1/auth/logout')).toBe(false)

    connect(B)
    rerender()
    await waitFor(() => expect(result.current.a.status).toBe('signed_out'))
    expect(calls.filter((c) => c.path === '/api/v1/auth/logout')).toHaveLength(1)
    expect(result.current.guard).toMatchObject({ from: A.toLowerCase(), to: B.toLowerCase(), state: 'signed_out' })
    expect(result.current.owner).toBe(LOCAL_DRAFT_OWNER)
  })

  it('keeps the session while the wallet is disconnected or still reconnecting', async () => {
    connect(undefined)
    const calls = signedInAs(A)
    const { result, rerender } = renderHook(() => ({ guard: useWalletSessionGuard(), a: useAccount() }), { wrapper })
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    connect(B, true)
    rerender()
    expect(result.current.a.backend?.walletMismatch).toBe(false)
    expect(calls.some((c) => c.path === '/api/v1/auth/logout')).toBe(false)
    expect(result.current.a.status).toBe('signed_in')
    expect(result.current.guard).toBeNull()
  })

  it('flags the mismatch on the account, and reports a failed sign-out once instead of retrying in a loop', async () => {
    connect(B)
    const calls = signedInAs(A, () => json(500, { error: { code: 'INTERNAL', message: 'Internal error', requestId: 'req-3' } }))
    const { result, rerender } = renderHook(() => ({ guard: useWalletSessionGuard(), a: useAccount() }), { wrapper })
    await waitFor(() => expect(result.current.guard?.state).toBe('failed'))
    rerender()
    rerender()
    expect(calls.filter((c) => c.path === '/api/v1/auth/logout')).toHaveLength(1)
    expect(result.current.guard).toMatchObject({ from: A.toLowerCase(), to: B.toLowerCase() })
  })

  it('exposes the mismatch on the account even without the guard mounted', async () => {
    connect(B)
    const calls = signedInAs(A)
    const { result } = renderHook(() => useAccount(), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    expect(result.current.backend?.walletMismatch).toBe(true)
    // Only the shell's guard ends the session; reading the account never does.
    expect(calls.some((c) => c.path === '/api/v1/auth/logout')).toBe(false)
  })
})
