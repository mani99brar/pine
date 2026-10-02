'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { formatAmount, formatClaimNumber, formatPrice, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useClaims } from '@pine/react'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { MoveFigure } from '@/components/board/ClaimTile'
import { Skeleton } from '@/components/ui/primitives'
import { useDepthMap } from '@/lib/hooks'

/** The hero's live element: the flagship open claim drawn at full width as a giant tension bar. */
export function HeroLive() {
  const q = useClaims({ status: 'open', sort: 'liquidity', limit: 50 })
  const claim = useMemo(() => {
    const items = q.data?.items ?? []
    return items.find((c) => c.tags.includes('flagship')) ?? items[0]
  }, [q.data])
  const depth = useDepthMap(claim ? [claim.id] : [])

  if (q.isLoading) {
    return (
      <div aria-hidden className="mt-14">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="mt-6 h-12 w-full" />
        <Skeleton className="mt-6 h-5 w-80" />
      </div>
    )
  }
  if (!claim || claim.yesPrice === undefined) return null

  return (
    <div className="mt-14">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-2 rounded-full bg-ink px-2.5 py-1 text-[0.78rem] font-[650] text-on-ink">
            <span aria-hidden className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-lumen opacity-70 motion-reduce:hidden" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-lumen" />
            </span>
            Live on the board
          </span>
          <Link href={`/claims/${claim.id}`} className="min-w-0 font-[650] underline decoration-line-strong underline-offset-4 hover:decoration-ink">
            {formatClaimNumber(claim.number)}: {claim.title}
          </Link>
        </p>
        <span className="flex items-center gap-3 text-[0.84rem] text-ink-3">
          <PolicyMark family={claim.policy.family} code={claim.policy.id} size={14} />
          <span>
            {claim.source.owner}/{claim.source.repo} <code className="t-code text-ink-2">@{shortSha(claim.source.commitSha)}</code>
          </span>
        </span>
      </div>

      <div className="mt-7 flex items-end justify-between gap-6">
        <div>
          <p className="t-figure text-[clamp(3.25rem,2rem+5vw,6rem)] leading-[0.85] text-flare-ink">{formatPrice(claim.yesPrice)}</p>
          <p className="mt-2 max-w-[34ch] text-[0.88rem] text-ink-2">{COPY.priceLabel}</p>
        </div>
        <div className="hidden text-right sm:block">
          <MoveFigure yes={claim.yesPrice} yes24hAgo={claim.yesPrice24hAgo} className="justify-end text-[0.9rem]" />
        </div>
      </div>

      <TensionBar yes={claim.yesPrice} yes24hAgo={claim.yesPrice24hAgo} size="lg" settleDelay={350} surface="fog" className="mt-6" />

      <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-4">
        <TimeRing start={claim.createdAt} end={claim.evidenceDeadline} size={46} labelPosition="inside" />
        <span className="text-[0.86rem] text-ink-2">left to submit evidence</span>
        <DepthBars depth={depth.map[claim.id]} loading={depth.loading[claim.id]} symbol={claim.collateralSymbol} size="md" />
        <span className="text-[0.86rem] text-ink-2">
          <span className="t-figure text-[1.05rem] text-ink">{formatAmount(claim.liquidity, { maxDecimals: 0 })}</span> {claim.collateralSymbol} liquidity,{' '}
          <span className="t-figure text-[1.05rem] text-ink">{claim.evidenceCount}</span> evidence {claim.evidenceCount === 1 ? 'item' : 'items'}
        </span>
        <span className="sm:hidden">
          <MoveFigure yes={claim.yesPrice} yes24hAgo={claim.yesPrice24hAgo} />
        </span>
      </div>
    </div>
  )
}
