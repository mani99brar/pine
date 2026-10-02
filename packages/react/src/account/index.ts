'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { signIn as nextAuthSignIn, signOut as nextAuthSignOut, useSession } from 'next-auth/react'
import { useSignMessage } from 'wagmi'
import { createSiweMessage } from 'viem/siwe'
import type { Account, AccountPreferences, Address, LinkedWallet } from '@pine/core'
import { DEMO_WALLET_ADDRESS } from '@pine/data'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { apiFetch, PineApiError } from '../internal/api'
import { getBrowserStorage, readJson, removeKey, writeJson } from '../internal/storage'
import { useWallet } from '../wallet'

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

export interface UseAccountResult {
  status: 'loading' | 'signed_out' | 'signed_in'
  account: Account | null
  signIn(provider?: 'github' | 'demo'): Promise<void>
  signOut(): Promise<void>
  refresh(): Promise<void>
  /** Session user (login, avatar, scopes, demo flag) */
  user?: PineSessionUser
  /** Which sign-in methods the server offers (GitHub when OAuth is configured; demo otherwise / in mock mode) */
  providers: { github: boolean; demo: boolean }
  error: Error | null
}

/**
 * The signed-in Pine account: GitHub identity (from next-auth), linked wallets and preferences
 * (from `/api/account/me`). The last known account is mirrored in localStorage for instant paint.
 */
export function useAccount(): UseAccountResult {
  const { apiBase, env } = usePine()
  const session = useSession()
  const qc = useQueryClient()
  const user = session.data?.user as PineSessionUser | undefined
  const authed = session.status === 'authenticated'

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
    placeholderData: () => {
      const mirrored = readJson<Account>(getBrowserStorage(), MIRROR_KEY)
      return mirrored && user?.login && mirrored.github.login === user.login ? mirrored : undefined
    },
  })

  useEffect(() => {
    if (q.data && !q.isPlaceholderData) writeJson(getBrowserStorage(), MIRROR_KEY, q.data)
  }, [q.data, q.isPlaceholderData])

  const providers = useMemo(
    () => ({ github: env.githubOAuthConfigured, demo: !env.githubOAuthConfigured || env.dataSource === 'mock' }),
    [env.githubOAuthConfigured, env.dataSource],
  )

  const signIn = useCallback(
    async (provider?: 'github' | 'demo') => {
      const p = provider ?? (providers.github ? 'github' : 'demo')
      const redirectTo = typeof window !== 'undefined' ? window.location.href : '/'
      await nextAuthSignIn(p, { redirectTo })
    },
    [providers.github],
  )

  const signOut = useCallback(async () => {
    removeKey(getBrowserStorage(), MIRROR_KEY)
    qc.setQueryData(pineKeys.account(), null)
    const redirectTo = typeof window !== 'undefined' ? window.location.href : '/'
    await nextAuthSignOut({ redirectTo })
  }, [qc])

  const refresh = useCallback(async () => {
    await session.update()
    await qc.invalidateQueries({ queryKey: pineKeys.account() })
  }, [qc, session])

  let status: UseAccountResult['status']
  if (session.status === 'loading') status = 'loading'
  else if (!authed) status = 'signed_out'
  else status = q.data || q.isError ? 'signed_in' : 'loading'

  const account = authed ? (q.data ?? (q.isError && user ? accountFromSession(user) : null)) : null

  return { status, account, signIn, signOut, refresh, user, providers, error: q.error }
}

export type LinkWalletStatus = 'idle' | 'connecting' | 'signing' | 'verifying' | 'linked' | 'error'

/**
 * Links wallets to the account with Sign-In with Ethereum (EIP-4361). The server issues a nonce
 * (httpOnly cookie), verifies the signature, domain, nonce and expiry, then stores the wallet.
 * In demo mode the simulated wallet is linked through a clearly labelled demo route (no signature).
 */
export function useLinkWallet(): {
  link(): Promise<LinkedWallet>
  unlink(address: Address): Promise<void>
  setPrimary(address: Address): Promise<void>
  status: LinkWalletStatus
  error: string | null
} {
  const { apiBase, demo } = usePine()
  const wallet = useWallet()
  const qc = useQueryClient()
  const { signMessageAsync } = useSignMessage()
  const [status, setStatus] = useState<LinkWalletStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const setAccount = useCallback((account: Account) => qc.setQueryData(pineKeys.account(), account), [qc])

  const link = useCallback(async (): Promise<LinkedWallet> => {
    setError(null)
    try {
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
  }, [apiBase, demo, wallet, signMessageAsync, setAccount])

  const unlink = useCallback(
    async (address: Address) => {
      setError(null)
      try {
        const res = await apiFetch<{ account: Account }>(apiBase, `/api/account/wallets/${address}`, { method: 'DELETE' })
        setAccount(res.account)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [apiBase, setAccount],
  )

  const setPrimary = useCallback(
    async (address: Address) => {
      setError(null)
      try {
        const res = await apiFetch<{ account: Account }>(apiBase, `/api/account/wallets/${address}/primary`, { method: 'POST' })
        setAccount(res.account)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        throw e
      }
    },
    [apiBase, setAccount],
  )

  return { link, unlink, setPrimary, status, error }
}

/** PATCH /api/account/preferences. Returns a TanStack mutation; `mutate(partialPrefs)`. */
export function useUpdatePreferences() {
  const { apiBase } = usePine()
  const qc = useQueryClient()
  return useMutation<Account, PineApiError, Partial<AccountPreferences>, { previous?: Account | null }>({
    mutationFn: async (prefs) => {
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

/** Downloads the account export (GET /api/account/export). */
export function useAccountData() {
  const { apiBase } = usePine()
  const qc = useQueryClient()
  const exportData = useCallback(async () => {
    if (typeof window === 'undefined') return
    window.location.href = `${apiBase}/api/account/export`
  }, [apiBase])
  const deleteAccount = useCallback(async () => {
    await apiFetch(apiBase, '/api/account/me', { method: 'DELETE' })
    removeKey(getBrowserStorage(), MIRROR_KEY)
    qc.setQueryData(pineKeys.account(), null)
  }, [apiBase, qc])
  return { exportData, deleteAccount }
}
