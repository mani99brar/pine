'use client'

import { useMemo } from 'react'
import { useClaims, useStats } from '@pine/react'
import { formatAmount } from '@pine/core'
import { ClaimTile, ClaimTileSkeleton } from '@/components/board/ClaimTile'
import { FieldMap } from '@/components/board/FieldMap'
import { sortClaims } from '@/components/board/BoardView'
import { useDepthMap } from '@/lib/hooks'
import { ButtonLink } from '@/components/ui/Button'

export function BoardPreview() {
  const q = useClaims({ status: 'open', sort: 'deadline', limit: 50 })
  const stats = useStats()
  const items = useMemo(() => q.data?.items ?? [], [q.data])
  const depth = useDepthMap(items.map((c) => c.id))
  const closing = useMemo(() => sortClaims(items, 'closing', depth.map).slice(0, 3), [items, depth.map])

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="min-w-0 rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-6">
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="t-h3">The field right now</h3>
          {stats.data && (
            <p className="text-[0.84rem] text-ink-3">
              <span className="t-figure text-[1rem] text-ink">{stats.data.openClaims}</span> open,{' '}
              <span className="t-figure text-[1rem] text-ink">{formatAmount(stats.data.totalLiquidity, { compact: true, maxDecimals: 1 })}</span>{' '}
              {stats.data.collateralSymbol} liquidity
            </p>
          )}
        </div>
        {q.isLoading ? <div className="skeleton h-[320px]" /> : <FieldMap claims={items} depths={depth.map} height={320} />}
      </div>
      <div className="min-w-0">
        <h3 className="t-h3">Closing soonest</h3>
        <ul className="mt-4 grid gap-3">
          {q.isLoading
            ? Array.from({ length: 3 }, (_, i) => (
                <li key={i}>
                  <ClaimTileSkeleton />
                </li>
              ))
            : closing.map((c, i) => (
                <li key={c.id} className="flex">
                  <ClaimTile claim={c} depth={depth.map[c.id]} depthLoading={depth.loading[c.id]} settleDelay={200 + i * 120} className="w-full" />
                </li>
              ))}
        </ul>
        <ButtonLink href="/board" variant="secondary" className="mt-4 w-full">
          Browse open claims
        </ButtonLink>
      </div>
    </div>
  )
}
