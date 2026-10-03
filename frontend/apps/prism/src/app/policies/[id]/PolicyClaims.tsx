'use client'

import { useClaims } from '@pine/react'
import { ClaimRow } from '@/components/table/ClaimRow'
import { Skeleton } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/hooks'

export function PolicyClaims({ policyId }: { policyId: string }) {
  const q = useClaims({ policyId, sort: 'newest', limit: 30 })
  const now = useNowMs()
  if (q.isLoading) return <Skeleton className="h-40 w-full" />
  const items = q.data?.items ?? []
  if (!items.length) return <p className="text-lumen-2">No published claims use this policy yet.</p>
  return (
    <ul className="glass cut-xl divide-y divide-[var(--edge)] overflow-hidden">
      {items.map((c) => (
        <ClaimRow key={c.id} claim={c} nowMs={now} />
      ))}
    </ul>
  )
}
