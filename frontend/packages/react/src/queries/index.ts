'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ActivityQuery, Address, ClaimQuery, PriceRange } from '@pine/core'
import { usePine } from '../providers/context'
import { pineKeys } from './keys'

export { pineKeys } from './keys'

/** Market/claim lists: fresh for 30s. */
const LIST_STALE = 30_000
/** Static-ish data (policies): 10 minutes. */
const STATIC_STALE = 10 * 60_000
/** Live claim polling interval. */
export const LIVE_POLL_MS = 15_000

export function useClaims(q?: ClaimQuery) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.claims(q),
    queryFn: () => data.listClaims(q),
    staleTime: LIST_STALE,
    placeholderData: (prev) => prev,
  })
}

export function useInfiniteClaims(q?: ClaimQuery) {
  const { data } = usePine()
  return useInfiniteQuery({
    queryKey: pineKeys.claimsInfinite(q),
    queryFn: ({ pageParam }) => data.listClaims({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: LIST_STALE,
  })
}

/** A single claim. `{ live: true }` polls every 15s (market prices, oracle and evidence). */
export function useClaim(id: string | undefined, opts?: { live?: boolean }) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.claim(id),
    queryFn: () => data.getClaim(id as string),
    enabled: Boolean(id),
    staleTime: opts?.live ? 10_000 : LIST_STALE,
    refetchInterval: opts?.live ? LIVE_POLL_MS : false,
    refetchIntervalInBackground: false,
  })
}

export function usePriceHistory(id: string | undefined, range: PriceRange) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.priceHistory(id, range),
    queryFn: () => data.getPriceHistory(id as string, range),
    enabled: Boolean(id),
    staleTime: range === '24h' ? 30_000 : 120_000,
    placeholderData: (prev) => prev,
  })
}

export function useDepth(id: string | undefined, outcome: 'yes' | 'no') {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.depth(id, outcome),
    queryFn: () => data.getDepth(id as string, outcome),
    enabled: Boolean(id),
    staleTime: 15_000,
  })
}

export function useEvidence(id: string | undefined) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.evidence(id),
    queryFn: () => data.listEvidence(id as string),
    enabled: Boolean(id),
    staleTime: 20_000,
  })
}

export function useActivity(q?: ActivityQuery) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.activity(q),
    queryFn: () => data.listActivity(q),
    staleTime: 20_000,
    placeholderData: (prev) => prev,
  })
}

export function usePortfolio(address: Address | undefined) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.portfolio(address),
    queryFn: () => data.getPortfolio(address as Address),
    enabled: Boolean(address),
    staleTime: 20_000,
  })
}

export function usePolicies() {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.policies(),
    queryFn: () => data.listPolicies(),
    staleTime: STATIC_STALE,
  })
}

export function usePolicy(id: string | undefined, version?: string) {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.policy(id, version),
    queryFn: () => data.getPolicy(id as string, version),
    enabled: Boolean(id),
    staleTime: STATIC_STALE,
  })
}

export function useStats() {
  const { data } = usePine()
  return useQuery({
    queryKey: pineKeys.stats(),
    queryFn: () => data.getStats(),
    staleTime: 60_000,
  })
}
