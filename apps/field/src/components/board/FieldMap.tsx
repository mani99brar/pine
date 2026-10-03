'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { ClaimSummary, DepthSnapshot } from '@pine/core'
import { formatAmount, formatClaimNumber, formatDuration, formatPrice } from '@pine/core'
import { depthWithin5 } from '@/lib/depth'
import { useNowMs } from '@/lib/now'
import { useWidth } from '@/components/charts/useSize'
import { cn } from '@/lib/cn'

const DAY = 86_400_000
const TICKS = [0, 1, 3, 7, 14, 30]

/**
 * The field map: every open claim placed by time left in its evidence window (x, square-root scale)
 * and market-implied chance of an accepted counterexample (y). Ring size is executable depth within
 * ±5 pts; a Lumen fill marks windows closing within 24 hours. The y axis is itself a vertical tension bar.
 */
export function FieldMap({
  claims,
  depths,
  className,
  height = 420,
  compact,
  settle = true,
}: {
  claims: ClaimSummary[]
  depths: Record<string, DepthSnapshot | null | undefined>
  className?: string
  height?: number
  compact?: boolean
  settle?: boolean
}) {
  const now = useNowMs()
  const open = useMemo(() => claims.filter((c) => c.status === 'open' && c.yesPrice !== undefined), [claims])
  const maxDays = useMemo(() => {
    if (now === null) return 14
    const m = Math.max(1, ...open.map((c) => (new Date(c.evidenceDeadline).getTime() - now) / DAY))
    return m <= 7 ? 7 : m <= 14 ? 14 : 30
  }, [open, now])
  const xOf = (days: number) => Math.sqrt(Math.max(0, Math.min(days, maxDays)) / maxDays)
  const ticks = TICKS.filter((t) => t <= maxDays)
  const [plotRef, plotW] = useWidth<HTMLDivElement>(640)

  // Marker geometry in pixels, then a greedy label placement: right of the ring, else left, else above,
  // else below; a label that would still collide is dropped (the ring keeps its tooltip and label).
  const placed = useMemo(() => {
    if (now === null) return []
    const h = Math.min(height, typeof window === 'undefined' ? height : window.innerWidth * 1.05)
    const pts = open.map((c) => {
      const days = (new Date(c.evidenceDeadline).getTime() - now) / DAY
      const d = depthWithin5(depths[c.id])
      const r = Math.round(6 + Math.min(1, Math.log10(1 + d) / Math.log10(2001)) * (compact ? 9 : 13))
      const x = xOf(days)
      const y = c.yesPrice ?? 0
      return { c, days, d, r, x, y, px: 18 + (plotW - 36) * x, py: 14 + (h - 28) * (1 - y) }
    })
    type Box = { l: number; t: number; r: number; b: number }
    const hit = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t
    const rings: Box[] = pts.map((p) => ({ l: p.px - p.r, r: p.px + p.r, t: p.py - p.r - 4, b: p.py + p.r + 4 }))
    const labels: Box[] = []
    const LW = 44
    const LH = 16
    return pts.map((p, i) => {
      const options: { side: 'right' | 'left' | 'top' | 'bottom'; box: Box }[] = [
        { side: 'right', box: { l: p.px + p.r + 4, r: p.px + p.r + 4 + LW, t: p.py - LH / 2, b: p.py + LH / 2 } },
        { side: 'left', box: { l: p.px - p.r - 4 - LW, r: p.px - p.r - 4, t: p.py - LH / 2, b: p.py + LH / 2 } },
        { side: 'top', box: { l: p.px - LW / 2, r: p.px + LW / 2, t: p.py - p.r - 6 - LH, b: p.py - p.r - 6 } },
        { side: 'bottom', box: { l: p.px - LW / 2, r: p.px + LW / 2, t: p.py + p.r + 6, b: p.py + p.r + 6 + LH } },
      ]
      const fits = options.find(
        (o) => o.box.l >= 2 && o.box.r <= plotW - 2 && o.box.t >= 0 && o.box.b <= h && !labels.some((b) => hit(b, o.box)) && !rings.some((b, j) => j !== i && hit(b, o.box)),
      )
      if (fits) labels.push(fits.box)
      return { ...p, side: fits?.side ?? null }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, now, depths, plotW, height, compact, maxDays])

  return (
    <figure className={cn('relative', className)}>
      <figcaption className="sr-only">
        Map of open claims by time left in the evidence window and market-implied chance that a qualifying counterexample is accepted.
      </figcaption>
      <div className="grid grid-cols-[22px_1fr] gap-x-3">
        {/* y axis: a vertical tension bar */}
        <div className="relative" style={{ height: `min(${height}px, 105vw)` }} aria-hidden>
          <span className="absolute left-0 right-0 top-0 h-[2px] bg-ink" />
          <span className="hatch-yes absolute left-[5px] right-[5px] top-[4px]" style={{ height: `calc(50% - 6px)` }} />
          <span className="absolute left-[5px] right-[5px] bg-cobalt" style={{ top: 'calc(50% + 2px)', bottom: 4 }} />
          <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-ink" />
        </div>
        <div ref={plotRef} className="relative min-w-0 rounded-[var(--radius-tile)] border border-line bg-sheet" style={{ height: `min(${height}px, 105vw)` }}>
          {/* gridlines */}
          <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden>
            {[0.25, 0.5, 0.75].map((y) => (
              <line key={y} x1="0" x2="100%" y1={`${(1 - y) * 100}%`} y2={`${(1 - y) * 100}%`} stroke="var(--line)" strokeDasharray={y === 0.5 ? undefined : '2 4'} />
            ))}
            {ticks.map((t) => (
              <line key={t} y1="0" y2="100%" x1={`${xOf(t) * 100}%`} x2={`${xOf(t) * 100}%`} stroke="var(--line)" strokeDasharray="2 4" />
            ))}
          </svg>
          {/* y labels */}
          {[1, 0.75, 0.5, 0.25, 0].map((y) => (
            <span
              key={y}
              aria-hidden
              className="t-figure absolute left-1.5 text-[0.72rem] text-ink-3"
              style={{ top: `calc(${(1 - y) * 100}% - ${y === 1 ? 0 : y === 0 ? 14 : 7}px)` }}
            >
              {Math.round(y * 100)}%
            </span>
          ))}
          {/* markers */}
          {now !== null &&
            placed.map(({ c, days, d, r, x, y, side }, i) => {
              const urgent = days < 1
              const label = `${formatClaimNumber(c.number)}: ${c.title}. ${formatPrice(y)} implied chance of accepted counterexample, ${formatDuration(days * DAY)} left, ${formatAmount(d, { maxDecimals: 0 })} ${c.collateralSymbol} executable within 5 points.`
              return (
                <Link
                  key={c.id}
                  href={`/claims/${c.id}`}
                  aria-label={label}
                  title={`${formatClaimNumber(c.number)} ${c.title}`}
                  className="group absolute z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:z-[3] hover:z-[3]"
                  style={{
                    left: `calc(18px + (100% - 36px) * ${x})`,
                    top: `calc(14px + (100% - 28px) * ${1 - y})`,
                    animation: settle ? `rise-in 500ms cubic-bezier(.2,.8,.2,1) ${120 + i * 55}ms backwards` : undefined,
                  }}
                >
                  <span
                    className={cn(
                      'block rounded-full border-2 border-ink transition-transform group-hover:scale-110',
                      urgent ? 'bg-lumen' : 'bg-sheet',
                    )}
                    style={{ width: r * 2, height: r * 2 }}
                  />
                  <span aria-hidden className="absolute left-1/2 top-1/2 h-[calc(100%+8px)] w-[3px] -translate-x-1/2 -translate-y-1/2 bg-ink" />
                  {!compact && side && (
                    <span
                      aria-hidden
                      className={cn(
                        't-figure pointer-events-none absolute z-[2] whitespace-nowrap rounded-[2px] bg-sheet/90 px-1 text-[0.78rem] text-ink-2 group-hover:text-ink',
                        side === 'right' && 'left-[calc(100%+4px)] top-1/2 -translate-y-1/2',
                        side === 'left' && 'right-[calc(100%+4px)] top-1/2 -translate-y-1/2',
                        side === 'top' && 'bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2',
                        side === 'bottom' && 'left-1/2 top-[calc(100%+6px)] -translate-x-1/2',
                      )}
                    >
                      {formatClaimNumber(c.number).replace('PINE-', '#')}
                    </span>
                  )}
                </Link>
              )
            })}
        </div>
      </div>
      {/* x axis */}
      <div className="ml-[34px] mt-2 flex items-start justify-between text-[0.75rem] text-ink-3" aria-hidden>
        <div className="relative h-4 flex-1">
          {ticks.map((t) => (
            <span
              key={t}
              className="t-figure absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `calc(18px + (100% - 36px) * ${xOf(t)})` }}
            >
              {t === 0 ? 'now' : `${t}d`}
            </span>
          ))}
        </div>
      </div>
      {!compact && (
        <div className="ml-[34px] mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8rem] text-ink-2">
          <span>Across: time left to submit evidence</span>
          <span>Up: implied chance a qualifying counterexample is accepted</span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full border-2 border-ink" />
            <span aria-hidden className="inline-block h-4 w-4 rounded-full border-2 border-ink" />
            ring size: executable depth
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full border-2 border-ink bg-lumen" />
            closes within 24 h
          </span>
        </div>
      )}
    </figure>
  )
}
