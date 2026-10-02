'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { formatClaimNumber, formatPrice } from '@pine/core'
import { useClaims } from '@pine/react'
import { ArrowRight } from 'lucide-react'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { MoveFigure } from '@/components/board/ClaimTile'
import { sortClaims } from '@/components/board/BoardView'
import { useDepthMap } from '@/lib/hooks'
import { useNowMs } from '@/lib/now'

/**
 * The hero's glyph wall: the open claims closing soonest, drawn as compact columns of glyphs. On
 * desktop it is a row of four; on phones it becomes a swipeable strip.
 */
export function GlyphWall() {
  const q = useClaims({ status: 'open', sort: 'deadline', limit: 50 })
  const items = useMemo(() => q.data?.items ?? [], [q.data])
  const depth = useDepthMap(items.map((c) => c.id))
  const shown = useMemo(() => sortClaims(items, 'closing', depth.map).slice(0, 4), [items, depth.map])
  const now = useNowMs()
  const closing = now === null ? 0 : items.filter((c) => new Date(c.evidenceDeadline).getTime() - now < 86_400_000).length

  return (
    <section aria-labelledby="wall-title" className="mt-7 sm:mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id="wall-title" className="flex items-center gap-2 text-[0.92rem] font-[650]">
          <span aria-hidden className="relative inline-flex h-2.5 w-2.5">
            <span className="absolute inset-0 animate-ping rounded-full bg-lumen opacity-70 motion-reduce:hidden" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-lumen shadow-[0_0_0_1.5px_var(--ink)]" />
          </span>
          Live on the board
          {q.data && (
            <span className="font-[450] text-ink-2">
              {items.length} open, {closing} closing within 24 hours
            </span>
          )}
        </h2>
        <Link href="/board" className="inline-flex items-center gap-1 text-[0.88rem] font-[650] underline decoration-line-strong underline-offset-[3px] hover:decoration-ink">
          See every claim <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
      <ul className="scrollbar-none -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 relative overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-px sm:overflow-visible sm:rounded-[var(--radius-tile)] sm:border sm:border-line sm:bg-line sm:px-0 sm:pb-0 lg:grid-cols-4">
        {(q.isLoading ? Array.from({ length: 4 }, () => null) : shown).map((c, i) => (
          <li key={c?.id ?? i} className="w-[82%] shrink-0 snap-start rounded-[var(--radius-tile)] border border-line bg-sheet sm:w-auto sm:rounded-none sm:border-0">
            {c ? (
              <Link href={`/claims/${c.id}`} className="flex h-full flex-col px-4 pb-4 pt-3.5 transition-colors hover:bg-fog-2/40">
                <span className="flex items-center gap-2 text-[0.8rem]">
                  <span className="t-figure text-[0.88rem] text-ink-2">{formatClaimNumber(c.number)}</span>
                  <PolicyMark family={c.policy.family} code={c.policy.id} size={13} className="text-[0.8rem]" />
                </span>
                <span className="mt-1.5 line-clamp-2 min-h-[2.6em] text-[0.95rem] font-[650] leading-[1.3]">{c.title}</span>
                <span className="mt-3 flex items-baseline gap-2">
                  <span className="t-figure text-[1.9rem] text-flare-ink">{c.yesPrice !== undefined ? formatPrice(c.yesPrice) : '—'}</span>
                  <MoveFigure yes={c.yesPrice} yes24hAgo={c.yesPrice24hAgo} />
                </span>
                <TensionBar yes={c.yesPrice} yes24hAgo={c.yesPrice24hAgo} settleDelay={250 + i * 140} className="mt-2" />
                <span className="mt-auto flex items-center justify-between gap-3 pt-5">
                  <TimeRing start={c.createdAt} end={c.evidenceDeadline} size={30} labelPosition="beside" />
                  <DepthBars depth={depth.map[c.id]} loading={depth.loading[c.id]} symbol={c.collateralSymbol} size="sm" />
                </span>
              </Link>
            ) : (
              <div className="px-4 pb-4 pt-3.5" aria-hidden>
                <span className="skeleton block h-3.5 w-28" />
                <span className="skeleton mt-3 block h-4 w-11/12" />
                <span className="skeleton mt-5 block h-7 w-20" />
                <span className="skeleton mt-3 block h-3.5 w-full" />
                <span className="skeleton mt-6 block h-6 w-full" />
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[0.78rem] text-ink-3 sm:hidden">Swipe for more. Big figure: market-implied chance a qualifying counterexample is accepted.</p>
      <p className="mt-2 hidden text-[0.78rem] text-ink-3 sm:block">
        Big figure and knot: market-implied chance a qualifying counterexample is accepted. Ring: time left to submit evidence. Bars: collateral tradable within 5 points of the price.
      </p>
    </section>
  )
}
