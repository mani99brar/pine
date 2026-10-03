/** `api` mode identity: useAccount, useDraftOwner and the account helpers on top of the backend session. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { createSiweMessage } from 'viem/siwe'
import type { Account } from '@pine/core'
import type { PineSession } from '@pine/data'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { pineKeys } from '../src/queries/keys'
import { useAccount, useAccountData, useLinkWallet, useUpdatePreferences } from '../src/account'
import { LOCAL_DRAFT_OWNER, useDraftOwner } from '../src/composer/drafts'
import { siweTermsDigest, usePendingSiweTerms } from '../src/api/identity'
import { useSignOut } from '../src/api/session'

const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const TERMS = `0x${'ab'.repeat(32)}`

function sessionView(over: Partial<PineSession> = {}): PineSession {
  return {
    wallet: WALLET,
    githubUserId: null,
    githubLogin: null,
    isAdmin: false,
    termsDigest: TERMS,
    termsAccepted: true,
    authenticatedAt: '2026-10-04T12:00:00.000Z',
    idleExpiresAt: '2026-10-05T12:00:00.000Z',
    absoluteExpiresAt: '2026-10-11T12:00:00.000Z',
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
const signedOut = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'req-1' } })

/** Stubs the backend behind the same-origin client; unknown routes answer 404 like the API (an Error: network failure). */
function backend(route: (call: Call) => Response | Error | undefined): Call[] {
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
      const res = route(call)
      if (res instanceof Error) throw res
      return res ?? json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-2' } })
    }),
  )
  return calls
}

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

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useAccount in api mode', () => {
  it('is signed out when the backend answers 401, offers only Sign-In with Ethereum and never asks next-auth', async () => {
    const calls = backend((c) => (c.path === '/api/v1/auth/session' ? signedOut() : undefined))
    const { result } = render(() => ({ a: useAccount(), owner: useDraftOwner() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_out'))
    expect(result.current.a.account).toBeNull()
    expect(result.current.a.providers).toEqual({ github: false, demo: false, siwe: true })
    expect(result.current.a.backend?.session).toBeNull()
    expect(result.current.a.user).toBeUndefined()
    expect(result.current.a.error).toBeNull()
    expect(result.current.owner).toBe(LOCAL_DRAFT_OWNER)
    expect(calls.some((c) => c.path.startsWith('/api/auth') || c.path.startsWith('/api/account'))).toBe(false)
  })

  it('maps a session without GitHub to an account of the session wallet', async () => {
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView({ wallet: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })) : undefined))
    const { result, qc } = render(() => ({ a: useAccount(), owner: useDraftOwner() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    const { a } = result.current
    expect(a.account).toMatchObject({
      id: `wallet:${WALLET}`,
      wallets: [{ address: WALLET, chainId: 100, verifiedAt: '2026-10-04T12:00:00.000Z', primary: true }],
      github: { login: '', id: 0, name: null, avatarUrl: '', htmlUrl: '', scopes: [] },
      demo: false,
    })
    expect(a.account?.preferences.defaultSpendingLimit).toBe('50')
    expect(a.backend).toMatchObject({ wallet: WALLET, github: null, termsAccepted: true, termsDigest: TERMS, isAdmin: false, walletMismatch: false })
    // Drafts are owned by the session wallet, lowercase.
    expect(result.current.owner).toBe(WALLET)
    // The same account is in the cache that new drafts read their default spending limit from.
    await waitFor(() => expect(qc.getQueryData<Account>(pineKeys.account())?.id).toBe(`wallet:${WALLET}`))
  })

  it('maps a linked GitHub identity from the session (numeric id and login)', async () => {
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView({ githubUserId: 9001, githubLogin: 'pine-labs' })) : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    expect(result.current.backend?.github).toEqual({ login: 'pine-labs', id: 9001 })
    expect(result.current.account?.github).toEqual({ login: 'pine-labs', id: 9001, name: null, avatarUrl: '', htmlUrl: 'https://github.com/pine-labs', scopes: [] })
  })

  it('stays signed in but reports terms that must be accepted again', async () => {
    const digest = `0x${'cd'.repeat(32)}`
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView({ termsAccepted: false, termsDigest: digest })) : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    expect(result.current.backend?.termsAccepted).toBe(false)
    expect(result.current.backend?.termsDigest).toBe(digest)
  })

  it('never treats a malformed session answer as signed in', async () => {
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, { ...sessionView(), wallet: 'javascript:alert(1)' }) : undefined))
    const { result } = render(() => ({ a: useAccount(), owner: useDraftOwner() }))
    await waitFor(() => expect(result.current.a.error).not.toBeNull())
    expect(result.current.a.status).toBe('signed_out')
    expect(result.current.a.account).toBeNull()
    expect(result.current.a.error?.message).toMatch(/unexpected shape/)
    expect(result.current.owner).toBe(LOCAL_DRAFT_OWNER)
  })

  it('SEC-AUTH-13 signs out through the backend, for this session or every session', async () => {
    let session: PineSession | null = sessionView()
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return session ? json(200, session) : signedOut()
      if (c.path === '/api/v1/auth/logout' && c.method === 'POST') {
        session = null
        return new Response(null, { status: 204 })
      }
      return undefined
    })
    const { result } = render(() => ({ a: useAccount(), owner: useDraftOwner() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    await act(async () => {
      await result.current.a.signOut({ everywhere: true })
    })
    const logout = calls.find((c) => c.path === '/api/v1/auth/logout')
    expect(logout).toMatchObject({ method: 'POST', body: { everywhere: true } })
    expect(logout?.headers['x-pine-csrf']).toBe('1')
    expect(logout?.headers['content-type']).toBe('application/json')
    expect(result.current.a.status).toBe('signed_out')
    expect(result.current.a.account).toBeNull()
    expect(result.current.owner).toBe(LOCAL_DRAFT_OWNER)
  })

  /** Signed in as WALLET; POST /auth/logout answers with `logout()` (the session ends only on 2xx). */
  function signedInWithLogout(logout: () => Response | Error) {
    let session: PineSession | null = sessionView()
    const calls = backend((c) => {
      if (c.path === '/api/v1/auth/session') return session ? json(200, session) : signedOut()
      if (c.path === '/api/v1/auth/logout' && c.method === 'POST') {
        const res = logout()
        if (res instanceof Response && res.ok) session = null
        return res
      }
      return undefined
    })
    return calls
  }

  it.each([
    ['503', () => json(503, { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Database unavailable', requestId: 'req-4' } })],
    ['429 (another session filled the rate limit)', () => json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests', requestId: 'req-5' } })],
    ['a network failure', () => new TypeError('Failed to fetch')],
  ])('SEC-AUTH-13 stays signed in and throws when Pine does not confirm the sign-out (%s)', async (_name, logout) => {
    signedInWithLogout(logout)
    const { result } = render(() => ({ a: useAccount(), owner: useDraftOwner() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    let error: unknown
    await act(async () => {
      error = await result.current.a.signOut({ everywhere: true }).catch((e: unknown) => e)
    })
    expect(error).toBeInstanceOf(Error)
    // The HttpOnly cookie is still valid: showing "signed out" here would be false.
    expect(result.current.a.status).toBe('signed_in')
    expect(result.current.a.account).not.toBeNull()
    expect(result.current.owner).toBe(WALLET)
  })

  it('treats 401 as already signed out', async () => {
    signedInWithLogout(() => signedOut())
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    await act(async () => {
      await result.current.signOut()
    })
    expect(result.current.status).toBe('signed_out')
  })

  it('SEC-AUTH-13 says other sessions were not ended when this one had already expired', async () => {
    signedInWithLogout(() => signedOut())
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    let error: unknown
    await act(async () => {
      error = await result.current.signOut({ everywhere: true }).catch((e: unknown) => e)
    })
    expect((error as Error).message).toMatch(/other sessions were not signed out/)
    expect(result.current.status).toBe('signed_out')
  })

  it('drops the session here anyway with `force`, still throwing the failure', async () => {
    signedInWithLogout(() => json(500, { error: { code: 'INTERNAL', message: 'Internal error', requestId: 'req-6' } }))
    const { result } = renderHook(() => ({ a: useAccount(), signOut: useSignOut() }), { wrapper: wrapperFor(createPineQueryClient()) })
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    let error: unknown
    await act(async () => {
      error = await result.current.signOut({ force: true }).catch((e: unknown) => e)
    })
    expect(error).toBeInstanceOf(Error)
    expect(result.current.a.status).toBe('signed_out')
  })

  it('asks for a wallet before requesting any sign-in message', async () => {
    const calls = backend((c) => (c.path === '/api/v1/auth/session' ? signedOut() : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_out'))
    let error: unknown
    await act(async () => {
      error = await result.current.signIn().catch((e: unknown) => e)
    })
    expect((error as Error).message).toMatch(/Connect a wallet/)
    expect(result.current.backend?.siwe.step).toBe('error')
    expect(calls.some((c) => c.path.includes('/siwe/'))).toBe(false)
  })
})

describe('account helpers in api mode', () => {
  it('keeps the default spending limit in this browser for the signed-in wallet, validated', async () => {
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView()) : undefined))
    const { result, qc } = render(() => ({ a: useAccount(), prefs: useUpdatePreferences() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    await act(async () => {
      await result.current.prefs.mutateAsync({ defaultSpendingLimit: '75.5' })
    })
    await waitFor(() => expect(result.current.a.account?.preferences.defaultSpendingLimit).toBe('75.5'))
    expect(JSON.parse(localStorage.getItem(`pine:prefs:${WALLET}`) ?? 'null')).toEqual({ defaultSpendingLimit: '75.5' })
    expect(qc.getQueryData<Account>(pineKeys.account())?.preferences.defaultSpendingLimit).toBe('75.5')

    for (const bad of [{ defaultSpendingLimit: '-1' }, { defaultSpendingLimit: '0' }, { defaultSpendingLimit: '1e9' }]) {
      await act(async () => {
        await expect(result.current.prefs.mutateAsync(bad)).rejects.toThrow(/positive amount/)
      })
    }
    // Settings the backend cannot honour are refused rather than silently "saved".
    await act(async () => {
      await expect(result.current.prefs.mutateAsync({ notifyOnEvidence: false })).rejects.toThrow(/not available/)
    })
    expect(result.current.a.account?.preferences.defaultSpendingLimit).toBe('75.5')
  })

  it('ignores a tampered stored limit and uses the default', async () => {
    localStorage.setItem(`pine:prefs:${WALLET}`, JSON.stringify({ defaultSpendingLimit: '99999999999999999999' }))
    backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView()) : undefined))
    const { result } = render(() => useAccount())
    await waitFor(() => expect(result.current.status).toBe('signed_in'))
    expect(result.current.account?.preferences.defaultSpendingLimit).toBe('50')
  })

  it('has no wallet linking, export or deletion: the signed-in wallet is the account', async () => {
    const calls = backend((c) => (c.path === '/api/v1/auth/session' ? json(200, sessionView()) : undefined))
    const { result } = render(() => ({ a: useAccount(), link: useLinkWallet(), data: useAccountData() }))
    await waitFor(() => expect(result.current.a.status).toBe('signed_in'))
    await act(async () => {
      await expect(result.current.link.link()).rejects.toThrow(/wallet you sign in with is your account/)
      await expect(result.current.link.unlink(WALLET)).rejects.toThrow(/wallet you sign in with/)
    })
    expect(result.current.data.available).toBe(false)
    await expect(result.current.data.exportData()).rejects.toThrow(/no account export/)
    await expect(result.current.data.deleteAccount()).rejects.toThrow(/no account export or deletion/)
    expect(calls.some((c) => c.path.startsWith('/api/account'))).toBe(false)
  })
})

describe('the terms digest being signed', () => {
  const message = createSiweMessage({
    domain: 'app.pine.example',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    statement: `Sign in to Pine. I accept the terms with sha256 ${TERMS}.`,
    uri: 'https://app.pine.example',
    version: '1',
    chainId: 100,
    nonce: '0123456789abcdef0123456789abcdef',
    issuedAt: new Date('2026-10-04T12:00:00Z'),
    expirationTime: new Date('2026-10-04T12:10:00Z'),
  })

  it('reads only Pine’s terms statement', () => {
    expect(siweTermsDigest(message)).toBe(TERMS)
    expect(siweTermsDigest(message.replace(/Sign in to Pine\. I accept the terms with sha256 0x[0-9a-f]{64}\./, 'Transfer everything.'))).toBeNull()
    expect(siweTermsDigest({ raw: '0x00' })).toBeNull()
    expect(siweTermsDigest('not a siwe message')).toBeNull()
  })

  it('shows the digest while the wallet is asked to sign the message', async () => {
    backend((c) => (c.path === '/api/v1/auth/session' ? signedOut() : undefined))
    const { result, qc } = render(() => usePendingSiweTerms())
    expect(result.current).toBeNull()
    const mutation = qc.getMutationCache().build(qc, { mutationKey: ['signMessage'], mutationFn: () => new Promise<never>(() => {}) })
    act(() => {
      void mutation.execute({ message })
    })
    await waitFor(() => expect(result.current).toBe(TERMS))
  })
})
