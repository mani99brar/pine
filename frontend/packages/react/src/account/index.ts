'use client'

import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore } from 'react'
import { hashKey, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { signIn as nextAuthSignIn, signOut as nextAuthSignOut, useSession } from 'next-auth/react'
import { useSignMessage } from 'wagmi'
import { createSiweMessage } from 'viem/siwe'
import type { Account, AccountPreferences, Address, Hex, LinkedWallet } from '@pine/core'
import { DEMO_WALLET_ADDRESS, defaultPreferences, localPreferencesSchema, type LocalPreferences, type PineSession } from '@pine/data'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { apiFetch, PineApiError } from '../internal/api'
import { getBrowserStorage, readJson, removeKey, writeJson } from '../internal/storage'
import { useWallet } from '../wallet'
import { DEFAULT_SPENDING_LIMIT } from '../composer/defaults'
import { usePineSession, useSignOut, useSiweSignIn, type SiweStep } from '../api/session'

/** Shape of `session.user` produced by `@pine/server/auth`. */
export interface PineSessionUser {
  name?: string | null
  email?: string | null
  image?: string | null
  login?: string
  githubId?: number
  avatarUrl?: string
  htmlUrl?: string
  scopes?: string[]
  demo?: boolean
  provider?: 'github' | 'demo'
}

const MIRROR_KEY = 'pine:account'

export const SIWE_STATEMENT =
  'Link this wallet to your Pine account. Signing proves you control the address. It does not authorize any transaction or spending.'

/** Account built from the session alone (used while /api/account/me is unavailable). */
function accountFromSession(user: PineSessionUser): Account {
  return {
    id: `gh:${user.login ?? 'unknown'}`,
    github: {
      login: user.login ?? user.name ?? 'unknown',
      id: user.githubId ?? 0,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? user.image ?? '',
      htmlUrl: user.htmlUrl ?? `https://github.com/${user.login ?? ''}`,
      scopes: user.scopes ?? [],
    },
    wallets: [],
    preferences: {
      defaultChainId: 100,
      defaultSpendingLimit: '50',
      notifyOnEvidence: true,
      notifyOnAnswer: true,
      notifyOnDeadline: true,
      displayCurrency: 'collateral',
    },
    createdAt: new Date(0).toISOString(),
    demo: Boolean(user.demo),
  }
}

// ---------------------------------------------------------------------------
// `api` mode: the backend's wallet session is the account
// ---------------------------------------------------------------------------

/** The backend exposes no account creation time. */
const UNKNOWN_TIME = new Date(0).toISOString()

/**
 * The backend session as the app's `Account`. The wallet that signed in is the only wallet, and GitHub comes from the
 * session's link. What the backend does not provide stays neutral and is never invented: no name or avatar, no scopes
 * (the GitHub App requests no permissions), an unknown creation time, and an empty login with `id` 0 while GitHub is not
 * linked (`UseAccountResult.backend.github` is the link state to read).
 */
export function accountFromBackendSession(session: PineSession, preferences: AccountPreferences, chainId: number): Account {
  const wallet = session.wallet.toLowerCase() as Address
  const login = session.githubLogin
  const githubId = session.githubUserId
  const linked = login !== null && githubId !== null
  return {
    id: `wallet:${wallet}`,
    github: {
      login: linked ? login : '',
      id: linked ? githubId : 0,
      name: null,
      avatarUrl: '',
      htmlUrl: linked ? `https://github.com/${login}` : '',
      scopes: [],
    },
    wallets: [{ address: wallet, chainId, verifiedAt: session.authenticatedAt, primary: true }],
    preferences,
    createdAt: UNKNOWN_TIME,
    demo: false,
  }
}

/**
 * Re-renders when the backend session query is replaced in the cache. Sign-in, sign-out and GitHub unlink (../api/session)
 * remove the per-user queries, the session among them, and write a new session entry; TanStack does not tell the
 * observers of a removed query, so a mounted `usePineSession()` would keep the previous identity until something else
 * re-rendered it. Call next to `usePineSession()`.
 */
export function useSessionReplacement(): void {
  const qc = useQueryClient()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const hash = hashKey(pineKeys.session())
    return qc.getQueryCache().subscribe((event) => {
      if (event.query.queryHash === hash && (event.type === 'added' || event.type === 'removed')) rerender()
    })
  }, [qc])
}

/** The backend has no preferences API: in `api` mode they stay in this browser, per signed-in wallet. */
const PREFS_PREFIX = 'pine:prefs:'
const prefsListeners = new Set<() => void>()
const noopSubscribe = () => () => {}

function subscribePrefs(cb: () => void): () => void {
  prefsListeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFS_PREFIX)) cb()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    prefsListeners.delete(cb)
    window.removeEventListener('storage', onStorage)
  }
}

function readPrefsRaw(wallet: string | undefined): string | null {
  if (!wallet) return null
  try {
    return getBrowserStorage().getItem(PREFS_PREFIX + wallet.toLowerCase())
  } catch {
    return null
  }
}

function parseStoredPrefs(raw: string | null): LocalPreferences {
  if (!raw) return {}
  try {
    const parsed = localPreferencesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** `api` mode preferences: the package defaults plus what the user saved in this browser (validated, else ignored). */
export function apiPreferences(raw: string | null, chainId: number): AccountPreferences {
  return { ...defaultPreferences({ defaultChainId: chainId }), defaultSpendingLimit: DEFAULT_SPENDING_LIMIT, ...parseStoredPrefs(raw) }
}

const LOCAL_PREFERENCE_KEYS = new Set<string>(['defaultSpendingLimit', 'displayCurrency'])

function saveApiPreferences(qc: QueryClient, patch: Partial<AccountPreferences>, chainId: number): Account {
  const session = qc.getQueryData<PineSession | null>(pineKeys.session())
  if (!session) throw new Error('Sign in to save your defaults.')
  const unsupported = Object.keys(patch).filter((k) => !LOCAL_PREFERENCE_KEYS.has(k))
  if (unsupported.length > 0) throw new Error(`These settings are not available with the Pine API: ${unsupported.join(', ')}.`)
  const wallet = session.wallet.toLowerCase()
  const next = localPreferencesSchema.safeParse({ ...parseStoredPrefs(readPrefsRaw(wallet)), ...patch })
  if (!next.success) throw new Error('Enter a positive amount with at most 6 decimals, for example 50 or 120.5.')
  writeJson(getBrowserStorage(), PREFS_PREFIX + wallet, next.data)
  prefsListeners.forEach((l) => l())
  return accountFromBackendSession(session, apiPreferences(readPrefsRaw(wallet), chainId), chainId)
}

/** `api` mode identity, from the backend session (GET /api/v1/auth/session). */
export interface BackendIdentity {
  session: PineSession | null
  /** The session wallet, lowercase: the account's identity. */
  wallet: Address | null
  /** The linked GitHub identity (the numeric id is the key; the login is a display snapshot). */
  github: { login: string; id: number } | null
  isAdmin: boolean
  /** False when the current terms changed after the last sign-in: sign in again to accept them. */
  termsAccepted: boolean
  /** sha256 of Pine's current terms, which the sign-in message names. */
  termsDigest: Hex | null
  /** Progress of `signIn()` (Sign-In with Ethereum). */
  siwe: { step: SiweStep; error: string | null; reset(): void }
  /** The connected wallet is another account than the session wallet; the session ends (SEC-AUTH-13). */
  walletMismatch: boolean
}

export interface UseAccountResult {
  status: 'loading' | 'signed_out' | 'signed_in'
  account: Account | null
  /** next-auth sign-in; in `api` mode Sign-In with Ethereum against the backend (the provider is ignored). */
  signIn(provider?: 'github' | 'demo'): Promise<void>
  /** `everywhere` (api mode) ends every session of the account. */
  signOut(opts?: { everywhere?: boolean }): Promise<void>
  refresh(): Promise<void>
  /** Session user (login, avatar, scopes, demo flag); undefined in `api` mode */
  user?: PineSessionUser
  /** Which sign-in methods the deployment offers: GitHub or demo through next-auth, or SIWE in `api` mode */
  providers: { github: boolean; demo: boolean; siwe: boolean }
  error: Error | null
  /** `api` mode identity; null in every other mode. */
  backend: BackendIdentity | null
}

/**
 * The signed-in Pine account: GitHub identity (from next-auth), linked wallets and preferences
 * (from `/api/account/me`). The last known account is mirrored in localStorage for instant paint.
 * In `api` mode the account is the backend's wallet session instead (see `accountFromBackendSession`).
 */
export function useAccount(): UseAccountResult {
  const { apiBase, env } = usePine()
  const apiMode = env.dataSource === 'api'
  const session = useSession()
  const qc = useQueryClient()
  const user = apiMode ? undefined : (session.data?.user as PineSessionUser | undefined)
  const authed = !apiMode && session.status === 'authenticated'
  const backendSession = usePineSession()
  useSessionReplacement()
  const siwe = useSiweSignIn()
  const signOutBackend = useSignOut()
  const wallet = useWallet()

  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const q = useQuery<Account | null, PineApiError>({
    queryKey: pineKeys.account(),
    queryFn: async () => {
      try {
        const res = await apiFetch<{ account: Account }>(apiBase, '/api/account/me')
        return res.account
      } catch (e) {
        if (e instanceof PineApiError && e.status === 401) return null
        throw e
      }
    },
    enabled: authed,
    staleTime: 60_000,
    // Only read the local mirror after mount: the server render cannot see it, and reading it during the
    // first client render makes the client say "signed_in" while the server said "loading" (hydration mismatch).
    placeholderData: () => {
      if (!mounted) return undefined
      const mirrored = readJson<Account>(getBrowserStorage(), MIRROR_KEY)
      return mirrored && user?.login && mirrored.github.login === user.login ? mirrored : undefined
    },
  })

  useEffect(() => {
    if (!apiMode && q.data && !q.isPlaceholderData) writeJson(getBrowserStorage(), MIRROR_KEY, q.data)
  }, [apiMode, q.data, q.isPlaceholderData])

  const bound = backendSession.session?.wallet.toLowerCase()
  const prefsRaw = useSyncExternalStore(
    apiMode ? subscribePrefs : noopSubscribe,
    () => readPrefsRaw(apiMode ? bound : undefined),
    () => null,
  )
  const apiAccount = useMemo(
    () =>
      apiMode && backendSession.session
        ? accountFromBackendSession(backendSession.session, apiPreferences(prefsRaw, env.defaultChainId), env.defaultChainId)
        : null,
    [apiMode, backendSession.session, prefsRaw, env.defaultChainId],
  )
  // Hooks that read the account from the cache (new drafts take the default spending limit) see the same account.
  useEffect(() => {
    if (!apiMode) return
    const cached = qc.getQueryData<Account | null>(pineKeys.account())
    if (JSON.stringify(cached ?? null) !== JSON.stringify(apiAccount)) qc.setQueryData(pineKeys.account(), apiAccount)
  }, [apiMode, apiAccount, qc])

  const providers = useMemo(
    () =>
      apiMode
        ? { github: false, demo: false, siwe: true }
        : { github: env.githubOAuthConfigured, demo: !env.githubOAuthConfigured || env.dataSource === 'mock', siwe: false },
    [apiMode, env.githubOAuthConfigured, env.dataSource],
  )

  const siweSignIn = siwe.signIn
  const signIn = useCallback(
    async (provider?: 'github' | 'demo') => {
      if (apiMode) {
        await siweSignIn()
        return
      }
      const p = provider ?? (providers.github ? 'github' : 'demo')
      const redirectTo = typeof window !== 'undefined' ? window.location.href : '/'
      await nextAuthSignIn(p, { redirectTo })
    },
    [apiMode, siweSignIn, providers.github],
  )

  const signOut = useCallback(
    async (opts?: { everywhere?: boolean }) => {
      if (apiMode) {
        await signOutBackend(opts)
        return
      }
      removeKey(getBrowserStorage(), MIRROR_KEY)
      qc.setQueryData(pineKeys.account(), null)
      const redirectTo = typeof window !== 'undefined' ? window.location.href : '/'
      await nextAuthSignOut({ redirectTo })
    },
    [apiMode, signOutBackend, qc],
  )

  const refreshBackend = backendSession.refresh
  const refresh = useCallback(async () => {
    if (apiMode) {
      await refreshBackend()
      return
    }
    await session.update()
    await qc.invalidateQueries({ queryKey: pineKeys.account() })
  }, [apiMode, refreshBackend, qc, session])

  if (apiMode) {
    const s = backendSession.session
    const selected = wallet.isConnected && !wallet.isReconnecting ? wallet.address?.toLowerCase() : undefined
    const status: UseAccountResult['status'] =
      backendSession.status === 'signed_in' ? 'signed_in' : backendSession.status === 'loading' ? 'loading' : 'signed_out'
    return {
      status,
      account: apiAccount,
      signIn,
      signOut,
      refresh,
      user: undefined,
      providers,
      error: backendSession.error,
      backend: {
        session: s,
        wallet: (bound as Address | undefined) ?? null,
        github: s && s.githubLogin !== null && s.githubUserId !== null ? { login: s.githubLogin, id: s.githubUserId } : null,
        isAdmin: s?.isAdmin ?? false,
        termsAccepted: s?.termsAccepted ?? false,
        termsDigest: s ? (s.termsDigest as Hex) : null,
        siwe: { step: siwe.step, error: siwe.error, reset: siwe.reset },
        walletMismatch: Boolean(bound && selected && selected !== bound),
      },
    }
  }

  let status: UseAccountResult['status']
  if (session.status === 'loading') status = 'loading'
  else if (!authed) status = 'signed_out'
  else status = q.data || q.isError ? 'signed_in' : 'loading'

  const account = authed ? (q.data ?? (q.isError && user ? accountFromSession(user) : null)) : null

  return { status, account, signIn, signOut, refresh, user, providers, error: q.error, backend: null }
}

export type LinkWalletStatus = 'idle' | 'connecting' | 'signing' | 'verifying' | 'linked' | 'error'

const API_MODE_WALLETS = 'With the Pine API, the wallet you sign in with is your account: there are no other wallets to link.'

/**
 * Links wallets to the account with Sign-In with Ethereum (EIP-4361). The server issues a nonce
 * (httpOnly cookie), verifies the signature, domain, nonce and expiry, then stores the wallet.
 * In demo mode the simulated wallet is linked through a clearly labelled demo route (no signature).
 * Not available in `api` mode, where the signed-in wallet is the account (every call rejects).
 */
export function useLinkWallet(): {
  link(): Promise<LinkedWallet>
  unlink(address: Address): Promise<void>
  setPrimary(address: Address): Promise<void>
  status: LinkWalletStatus
  error: string | null
} {
  const { apiBase, demo, env } = usePine()
  const apiMode = env.dataSource === 'api'
  const wallet = useWallet()
  const qc = useQueryClient()
  const { signMessageAsync } = useSignMessage()
  const [status, setStatus] = useState<LinkWalletStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const setAccount = useCallback((account: Account) => qc.setQueryData(pineKeys.account(), account), [qc])

  const link = useCallback(async (): Promise<LinkedWallet> => {
    setError(null)
    try {
      if (apiMode) throw new Error(API_MODE_WALLETS)
      if (demo) {
        if (!wallet.isConnected) {
          setStatus('connecting')
          wallet.connect()
        }
        setStatus('verifying')
        const res = await apiFetch<{ account: Account; wallet: LinkedWallet }>(apiBase, '/api/account/wallets/demo', {
          method: 'POST',
          body: JSON.stringify({ address: DEMO_WALLET_ADDRESS, chainId: wallet.chainId }),
        })
        setAccount(res.account)
        setStatus('linked')
        return res.wallet
      }
      if (!wallet.isConnected || !wallet.address) {
        setStatus('connecting')
        wallet.connect()
        throw new Error('Connect a wallet first, then link it.')
      }
      setStatus('signing')
      const { nonce } = await apiFetch<{ nonce: string }>(apiBase, '/api/account/nonce')
      const now = new Date()
      const message = createSiweMessage({
        domain: window.location.host,
        address: wallet.address,
        statement: SIWE_STATEMENT,
        uri: window.location.origin,
        version: '1',
        chainId: wallet.chainId ?? 100,
        nonce,
        issuedAt: now,
        expirationTime: new Date(now.getTime() + 10 * 60_000),
      })
      const signature = await signMessageAsync({ message, account: wallet.address })
      setStatus('verifying')
      const res = await apiFetch<{ account: Account; wallet: LinkedWallet }>(apiBase, '/api/account/siwe/verify', {
        method: 'POST',
        body: JSON.stringify({ message, signature }),
      })
      setAccount(res.account)
      setStatus('linked')
      return res.wallet
    } catch (e) {
      const msg = (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e))
      setError(msg)
      setStatus('error')
      throw e instanceof Error ? e : new Error(msg)
    }
  }, [apiBase, apiMode, demo, wallet, signMessageAsync, setAccount])

  const unlink = useCallback(
    async (address: Address) => {
      setError(null)
      try {
        if (apiMode) throw new Error(API_MODE_WALLETS)
        const res = await apiFetch<{ account: Account }>(apiBase, `/api/account/wallets/${address}`, { method: 'DELETE' })
        setAccount(res.account)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [apiBase, apiMode, setAccount],
  )

  const setPrimary = useCallback(
    async (address: Address) => {
      setError(null)
      try {
        if (apiMode) throw new Error(API_MODE_WALLETS)
        const res = await apiFetch<{ account: Account }>(apiBase, `/api/account/wallets/${address}/primary`, { method: 'POST' })
        setAccount(res.account)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [apiBase, apiMode, setAccount],
  )

  return { link, unlink, setPrimary, status, error }
}

/**
 * PATCH /api/account/preferences. Returns a TanStack mutation; `mutate(partialPrefs)`.
 * In `api` mode the default spending limit and display currency are saved in this browser for the signed-in wallet;
 * other settings reject (the backend has no preferences API).
 */
export function useUpdatePreferences() {
  const { apiBase, env } = usePine()
  const qc = useQueryClient()
  return useMutation<Account, Error, Partial<AccountPreferences>, { previous?: Account | null }>({
    mutationFn: async (prefs) => {
      if (env.dataSource === 'api') return saveApiPreferences(qc, prefs, env.defaultChainId)
      const res = await apiFetch<{ account: Account }>(apiBase, '/api/account/preferences', {
        method: 'PATCH',
        body: JSON.stringify(prefs),
      })
      return res.account
    },
    onMutate: async (prefs) => {
      await qc.cancelQueries({ queryKey: pineKeys.account() })
      const previous = qc.getQueryData<Account | null>(pineKeys.account())
      if (previous) qc.setQueryData(pineKeys.account(), { ...previous, preferences: { ...previous.preferences, ...prefs } })
      return { previous }
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(pineKeys.account(), ctx.previous)
    },
    onSuccess: (account) => {
      qc.setQueryData(pineKeys.account(), account)
    },
  })
}

const API_MODE_ACCOUNT_DATA = 'The Pine API offers no account export or deletion.'

/**
 * Downloads the account export (GET /api/account/export) or deletes the account. `available` is false in `api` mode,
 * where the backend has neither (both calls reject).
 */
export function useAccountData() {
  const { apiBase, env } = usePine()
  const qc = useQueryClient()
  const available = env.dataSource !== 'api'
  const exportData = useCallback(async () => {
    if (!available) throw new Error(API_MODE_ACCOUNT_DATA)
    if (typeof window === 'undefined') return
    window.location.href = `${apiBase}/api/account/export`
  }, [apiBase, available])
  const deleteAccount = useCallback(async () => {
    if (!available) throw new Error(API_MODE_ACCOUNT_DATA)
    await apiFetch(apiBase, '/api/account/me', { method: 'DELETE' })
    removeKey(getBrowserStorage(), MIRROR_KEY)
    qc.setQueryData(pineKeys.account(), null)
  }, [apiBase, available, qc])
  return { exportData, deleteAccount, available }
}
