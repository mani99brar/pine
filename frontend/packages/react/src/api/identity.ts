'use client'

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useInfiniteQuery, useMutation, useMutationState, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useConfig } from 'wagmi'
import { signMessageMutationOptions } from 'wagmi/query'
import { parseSiweMessage } from 'viem/siwe'
import type { Address, Hex } from '@pine/core'
import {
  PineBackendError,
  pineNotificationPageSchema,
  pineNotificationReadSchema,
  seg,
  type PineNotification,
  type PineNotificationPage,
} from '@pine/data'
import { useSessionReplacement } from '../account'
import { usePine } from '../providers/context'
import { useWallet } from '../wallet'
import { SIWE_TERMS_STATEMENT, handleSessionGone, usePineSession, useSignOut } from './session'

// `api` mode identity support on top of ./session: the signed-in user's notifications, the terms digest of the sign-in
// message being signed, and the wallet-switch guard (SEC-AUTH-13).

export type { PineNotification } from '@pine/data'
export { accountFromBackendSession, apiPreferences, useSessionReplacement, type BackendIdentity } from '../account'

const NOTIFICATIONS_PATH = '/api/v1/accounts/me/notifications'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Notification query keys (under 'notifications', which sign-in and sign-out clear with the other per-user keys). */
export const notificationKeys = {
  all: () => ['pine', 'notifications'] as const,
  list: (unreadOnly: boolean) => ['pine', 'notifications', unreadOnly ? 'unread' : 'all'] as const,
}

export interface PineNotificationsState {
  /** `disabled` outside `api` mode, `signed_out` without a backend session. */
  status: 'disabled' | 'signed_out' | 'loading' | 'ready' | 'error'
  /** Newest first. Every field is data: render `message` as plain text. */
  items: PineNotification[]
  /** Unread among the loaded pages. */
  unread: number
  hasMore: boolean
  loadingMore: boolean
  loadMore(): void
  error: Error | null
  refetch(): void
  /** POST …/:id/read. The item keeps its place with `readAt` set. */
  markRead(id: string): Promise<void>
  /** The id being marked as read. */
  markingRead: string | null
}

/**
 * The signed-in user's notifications: GET /api/v1/accounts/me/notifications (50 per page, cursor paging). The backend's
 * `markets.watch` job writes them every minute for claim creators and evidence submitters, so the list refreshes on the
 * same cadence while mounted.
 */
export function usePineNotifications(opts: { unreadOnly?: boolean } = {}): PineNotificationsState {
  const unreadOnly = opts.unreadOnly ?? false
  const { api } = usePine()
  const session = usePineSession()
  useSessionReplacement()
  const qc = useQueryClient()
  const enabled = api !== null && session.status === 'signed_in'

  const q = useInfiniteQuery({
    queryKey: notificationKeys.list(unreadOnly),
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (last: PineNotificationPage) => last.nextCursor,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false,
    retry: (count, error) => !(error instanceof PineBackendError && error.status > 0 && error.status < 500) && count < 2,
    queryFn: async ({ pageParam, signal }): Promise<PineNotificationPage> => {
      if (!api) throw new Error('The Pine API is not configured.')
      try {
        const page = await api.request('GET', NOTIFICATIONS_PATH, pineNotificationPageSchema, {
          query: { cursor: pageParam ?? undefined, unread: unreadOnly ? 'true' : undefined },
          signal,
        })
        if (!page) throw new PineBackendError(`Empty response (GET ${NOTIFICATIONS_PATH})`, 204, 'BAD_RESPONSE')
        return page
      } catch (e) {
        // The session ended server-side (expiry, sign-out elsewhere): drop it here too. Asking the session again instead
        // would loop when Pine answers the session but not this route.
        handleSessionGone(qc, e)
        throw e
      }
    },
  })

  const read = useMutation<{ id: string; readAt: string }, Error, string>({
    mutationFn: async (id) => {
      if (!api) throw new Error('The Pine API is not configured.')
      if (!UUID.test(id)) throw new Error('Invalid notification id.')
      return api.post(`${NOTIFICATIONS_PATH}/${seg(id)}/read`, pineNotificationReadSchema)
    },
    onSuccess: ({ id, readAt }) => {
      qc.setQueriesData<InfiniteData<PineNotificationPage, string | null>>({ queryKey: notificationKeys.all() }, (data) =>
        data
          ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? readAt } : n)) })) }
          : data,
      )
    },
  })

  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: PineNotification[] = []
    for (const page of q.data?.pages ?? []) {
      for (const n of page.items) {
        if (seen.has(n.id)) continue
        seen.add(n.id)
        out.push(n)
      }
    }
    return out
  }, [q.data])

  const { fetchNextPage, refetch: refetchQuery } = q
  const loadMore = useCallback(() => {
    void fetchNextPage()
  }, [fetchNextPage])
  const refetch = useCallback(() => {
    void refetchQuery()
  }, [refetchQuery])
  const { mutateAsync } = read
  const markRead = useCallback(
    async (id: string) => {
      await mutateAsync(id)
    },
    [mutateAsync],
  )

  let status: PineNotificationsState['status']
  if (api === null) status = 'disabled'
  else if (session.status === 'loading') status = 'loading'
  else if (session.status !== 'signed_in') status = 'signed_out'
  else if (q.isError && !q.data) status = 'error'
  else if (q.isPending) status = 'loading'
  else status = 'ready'

  return {
    status,
    items,
    unread: items.filter((n) => n.readAt === null).length,
    hasMore: Boolean(q.hasNextPage),
    loadingMore: q.isFetchingNextPage,
    loadMore,
    error: q.error ?? null,
    refetch,
    markRead,
    markingRead: read.isPending ? (read.variables ?? null) : null,
  }
}

/** The terms digest a Pine sign-in message names (`Sign in to Pine. I accept the terms with sha256 0x….`), or null. */
export function siweTermsDigest(message: unknown): Hex | null {
  if (typeof message !== 'string' || message.length > 4096) return null
  try {
    const statement = parseSiweMessage(message).statement
    const match = statement ? SIWE_TERMS_STATEMENT.exec(statement) : null
    return match?.[1] ? (match[1] as Hex) : null
  } catch {
    return null
  }
}

/**
 * The terms digest of the sign-in message the wallet is asked to sign right now (null otherwise), so the page can show
 * what signing accepts next to the wallet prompt. Read from wagmi's pending `signMessage` mutation; nothing is fetched.
 */
export function usePendingSiweTerms(): Hex | null {
  const config = useConfig()
  const mutationKey = useMemo(() => [...signMessageMutationOptions(config).mutationKey], [config])
  const pending = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (m) => siweTermsDigest((m.state.variables as { message?: unknown } | undefined)?.message),
  })
  return pending.findLast((d): d is Hex => d !== null) ?? null
}

export { announceSessionChange } from './session'

/** An automatic sign-out caused by the wallet switching accounts. */
export interface WalletSwitch {
  /** Increases with every switch, so each one is announced once. */
  seq: number
  /** The session wallet that was signed out (lowercase). */
  from: Address
  /** The wallet's newly selected account (lowercase). */
  to: Address
  state: 'signing_out' | 'signed_out' | 'failed'
}

let lastSwitch: WalletSwitch | null = null
let switchSeq = 0
const switchListeners = new Set<() => void>()
const signingOut = new Set<string>()

function setSwitch(next: WalletSwitch | null): void {
  lastSwitch = next
  switchListeners.forEach((l) => l())
}

const switchStore = {
  subscribe(cb: () => void): () => void {
    switchListeners.add(cb)
    return () => {
      switchListeners.delete(cb)
    }
  },
  get: (): WalletSwitch | null => lastSwitch,
  server: (): WalletSwitch | null => null,
}

/** The last wallet-switch sign-out (SEC-AUTH-13) until dismissed; shared by every component that shows it. */
export function useWalletSwitchNotice(): { notice: WalletSwitch | null; dismiss(): void } {
  const notice = useSyncExternalStore(switchStore.subscribe, switchStore.get, switchStore.server)
  const dismiss = useCallback(() => setSwitch(null), [])
  return { notice, dismiss }
}

/**
 * SEC-AUTH-13: a backend session is bound to the wallet that signed in, so when the wallet's selected account changes to
 * another address the session is ended (POST /api/v1/auth/logout). Mount once in the app shell. A disconnected wallet
 * keeps the session: nothing can be signed without it, and connecting another account ends the session then.
 * Returns the last switch (see `useWalletSwitchNotice`).
 */
export function useWalletSessionGuard(): WalletSwitch | null {
  const { api } = usePine()
  const session = usePineSession()
  useSessionReplacement()
  const wallet = useWallet()
  const signOut = useSignOut()
  const bound = session.session?.wallet.toLowerCase()
  const selected = wallet.isConnected && !wallet.isReconnecting ? wallet.address?.toLowerCase() : undefined

  useEffect(() => {
    if (api === null || !bound || !selected || selected === bound) return
    const key = `${bound}>${selected}`
    if (signingOut.has(key)) return
    signingOut.add(key)
    switchSeq += 1
    const change = { seq: switchSeq, from: bound as Address, to: selected as Address }
    setSwitch({ ...change, state: 'signing_out' })
    // SEC-AUTH-13: fail closed. The session of the previous wallet is dropped in this browser even when Pine could not
    // end it server-side (the state says 'failed', so the user is told).
    signOut({ force: true })
      .then(
        () => setSwitch({ ...change, state: 'signed_out' }),
        () => setSwitch({ ...change, state: 'failed' }),
      )
      .finally(() => signingOut.delete(key))
  }, [api, bound, selected, signOut])

  return useWalletSwitchNotice().notice
}

/** Tests only: forget wallet-switch state. */
export function __resetIdentityState(): void {
  switchSeq = 0
  signingOut.clear()
  setSwitch(null)
}
