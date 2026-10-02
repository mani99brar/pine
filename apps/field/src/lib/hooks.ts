'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQueries } from '@tanstack/react-query'
import type { DepthSnapshot } from '@pine/core'
import { pineKeys, usePine } from '@pine/react'

/** Depth snapshots for many claims at once, sharing the cache with useDepth(). */
export function useDepthMap(ids: string[], outcome: 'yes' | 'no' = 'yes') {
  const { data } = usePine()
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: pineKeys.depth(id, outcome),
      queryFn: () => data.getDepth(id, outcome),
      staleTime: 15_000,
    })),
  })
  const map: Record<string, DepthSnapshot | null | undefined> = {}
  const loading: Record<string, boolean> = {}
  ids.forEach((id, i) => {
    map[id] = results[i]?.data
    loading[id] = results[i]?.isLoading ?? false
  })
  return { map, loading }
}

/** Read/write a set of URL search params as state (shareable filters). */
export function useUrlState<K extends string>(keys: readonly K[]) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const values = {} as Record<K, string | undefined>
  keys.forEach((k) => {
    values[k] = params?.get(k) ?? undefined
  })
  const set = useCallback(
    (patch: Partial<Record<K, string | undefined | null>>) => {
      const next = new URLSearchParams(params?.toString() ?? '')
      Object.entries(patch).forEach(([k, val]) => {
        if (val === undefined || val === null || val === '') next.delete(k)
        else next.set(k, String(val))
      })
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [params, pathname, router],
  )
  return [values, set] as const
}
