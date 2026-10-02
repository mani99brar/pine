'use client'

import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { PricePoint, PriceRange, TimelineEvent } from '@pine/core'
import { formatDate, formatPrice } from '@pine/core'
import { useWidth } from './useSize'
import { cn } from '@/lib/cn'

const M = { top: 34, right: 14, bottom: 28, left: 42 }

const EVENT_MARK: Partial<Record<TimelineEvent['kind'], { letter: string; label: string }>> = {
  market_created: { letter: 'M', label: 'Market created' },
  evidence_submitted: { letter: 'E', label: 'Evidence submitted' },
  evidence_deadline: { letter: 'D', label: 'Evidence deadline' },
  oracle_opened: { letter: 'O', label: 'Oracle opened' },
  answer_posted: { letter: 'A', label: 'Answer posted' },
  answer_challenged: { letter: 'C', label: 'Answer challenged' },
  arbitration_requested: { letter: 'K', label: 'Arbitration requested' },
  ruling: { letter: 'R', label: 'Ruling' },
  finalized: { letter: 'F', label: 'Finalized' },
}

function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`
}

function tickLabel(t: number, range: PriceRange): string {
  const d = new Date(t)
  if (range === '24h') return `${pad(d.getUTCHours())}:00`
  return formatDate(d.toISOString(), 'short').replace(/, \d{4}$/, '')
}

function niceTicks(t0: number, t1: number, range: PriceRange, width: number): number[] {
  const H = 3_600_000
  const D = 24 * H
  const step = range === '24h' ? (width < 480 ? 12 * H : 6 * H) : range === '7d' ? (width < 480 ? 2 * D : D) : range === '30d' ? (width < 480 ? 10 * D : 5 * D) : Math.max(D, Math.ceil((t1 - t0) / 5 / D) * D)
  const first = Math.ceil(t0 / step) * step
  const out: number[] = []
  for (let t = first; t <= t1; t += step) out.push(t)
  return out
}

/**
 * The tension chart: the tension bar unrolled over time. Below the line is the YES share (hatched),
 * above it the NO share. Timeline events are pinned along the top edge; hover or use the arrow keys
 * to read any point.
 */
export function TensionChart({
  points,
  events,
  range,
  height = 300,
  loading,
}: {
  points: PricePoint[]
  events: TimelineEvent[]
  range: PriceRange
  height?: number
  loading?: boolean
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')
  const [hover, setHover] = useState<number | null>(null)
  const [activeEvent, setActiveEvent] = useState<string | null>(null)

  const data = useMemo(() => [...points].sort((a, b) => a.t - b.t), [points])
  const t0 = data[0]?.t ?? 0
  const t1 = data[data.length - 1]?.t ?? 1
  const iw = Math.max(10, width - M.left - M.right)
  const ih = height - M.top - M.bottom
  const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * iw
  const y = (p: number) => M.top + (1 - p) * ih

  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d.t).toFixed(1)},${y(d.yes).toFixed(1)}`).join('')
  const yesArea = data.length ? `${line}L${x(t1).toFixed(1)},${y(0)}L${x(t0).toFixed(1)},${y(0)}Z` : ''
  const noArea = data.length ? `${line}L${x(t1).toFixed(1)},${y(1)}L${x(t0).toFixed(1)},${y(1)}Z` : ''

  const pinned = useMemo(
    () =>
      events
        .filter((e) => EVENT_MARK[e.kind])
        .map((e) => ({ ...e, ts: new Date(e.at).getTime() }))
        .filter((e) => e.ts >= t0 && e.ts <= t1),
    [events, t0, t1],
  )
  const ticks = niceTicks(t0, t1, range, width)

  const hp = hover !== null ? data[hover] : undefined
  const first = data[0]
  const last = data[data.length - 1]
  const min = data.reduce((m, d) => Math.min(m, d.yes), 1)
  const max = data.reduce((m, d) => Math.max(m, d.yes), 0)
  const summary = last && first
    ? `Implied chance of an accepted counterexample over ${range === 'all' ? 'the market lifetime' : `the last ${range}`}: from ${formatPrice(first.yes)} to ${formatPrice(last.yes)}, low ${formatPrice(min)}, high ${formatPrice(max)}. ${pinned.length} events marked.`
    : 'No price history yet.'

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!data.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const t = t0 + ((px - M.left) / iw) * (t1 - t0)
    let best = 0
    let bd = Infinity
    data.forEach((d, i) => {
      const dd = Math.abs(d.t - t)
      if (dd < bd) {
        bd = dd
        best = i
      }
    })
    setHover(best)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!data.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      setHover((h) => {
        const cur = h ?? data.length - 1
        return Math.max(0, Math.min(data.length - 1, cur + (e.key === 'ArrowRight' ? step : -step)))
      })
    } else if (e.key === 'Home') setHover(0)
    else if (e.key === 'End') setHover(data.length - 1)
    else if (e.key === 'Escape') setHover(null)
  }

  return (
    <div ref={ref} className="relative w-full">
      {loading && !data.length ? (
        <div className="skeleton" style={{ height }} />
      ) : !data.length ? (
        <div className="flex items-center justify-center rounded-[var(--radius-tile)] border border-dashed border-line-strong text-[0.9rem] text-ink-3" style={{ height }}>
          No trades yet in this range.
        </div>
      ) : (
        <div
          tabIndex={0}
          role="group"
          aria-label={`${summary} Use the left and right arrow keys to read individual points.`}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className={cn('relative rounded-[3px] outline-none focus-visible:shadow-[0_0_0_3px_var(--lumen)]', loading && 'opacity-60')}
        >
          <svg width={width} height={height} className="block touch-pan-y select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} aria-hidden>
            <defs>
              <pattern id={`h-${uid}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                <rect width="6" height="6" fill="var(--flare-wash)" />
                <rect width="1.6" height="6" fill="var(--flare)" opacity="0.55" />
              </pattern>
              <clipPath id={`c-${uid}`}>
                <rect x={M.left} y={M.top} width={iw} height={ih} />
              </clipPath>
            </defs>
            {/* areas */}
            <g clipPath={`url(#c-${uid})`}>
              <path d={noArea} fill="var(--cobalt-wash)" />
              <path d={yesArea} fill={`url(#h-${uid})`} />
            </g>
            {/* gridlines */}
            {[0.25, 0.5, 0.75].map((g) => (
              <g key={g}>
                <line x1={M.left} x2={M.left + iw} y1={y(g)} y2={y(g)} stroke="var(--sheet)" strokeOpacity={0.9} strokeWidth={1} />
                <line x1={M.left} x2={M.left + iw} y1={y(g)} y2={y(g)} stroke="var(--line-strong)" strokeDasharray="2 4" />
              </g>
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <text key={g} x={M.left - 8} y={y(g) + 4} textAnchor="end" className="t-figure" fontSize={11.5} fill="var(--ink-3)">
                {Math.round(g * 100)}%
              </text>
            ))}
            {/* anchors: the chart is bounded like the bar */}
            <line x1={M.left} x2={M.left} y1={M.top - 4} y2={M.top + ih + 4} stroke="var(--ink)" strokeWidth={2} />
            <line x1={M.left + iw} x2={M.left + iw} y1={M.top - 4} y2={M.top + ih + 4} stroke="var(--ink)" strokeWidth={2} />
            {/* the line */}
            <path d={line} fill="none" stroke="var(--ink)" strokeWidth={2.25} strokeLinejoin="round" clipPath={`url(#c-${uid})`} />
            {/* x ticks */}
            {ticks.map((t) => (
              <text key={t} x={x(t)} y={height - 8} textAnchor="middle" fontSize={11.5} fill="var(--ink-3)" className="t-figure">
                {tickLabel(t, range)}
              </text>
            ))}
            {/* event lines */}
            {pinned.map((e) => (
              <line
                key={e.id}
                x1={x(e.ts)}
                x2={x(e.ts)}
                y1={M.top - 8}
                y2={M.top + ih}
                stroke="var(--ink)"
                strokeOpacity={activeEvent === e.id ? 0.9 : 0.35}
                strokeDasharray={e.kind === 'evidence_deadline' ? undefined : '3 3'}
                strokeWidth={e.kind === 'evidence_deadline' ? 1.5 : 1}
              />
            ))}
            {/* hover crosshair */}
            {hp && (
              <g>
                <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + ih} stroke="var(--ink)" strokeWidth={1} />
                <rect x={x(hp.t) - 2.5} y={y(hp.yes) - 9} width={5} height={18} fill="var(--ink)" stroke="var(--sheet)" strokeWidth={2} />
              </g>
            )}
          </svg>

          {/* event pins (focusable) */}
          {pinned.map((e) => {
            const mark = EVENT_MARK[e.kind]!
            const left = x(e.ts)
            return (
              <button
                key={e.id}
                type="button"
                onFocus={() => setActiveEvent(e.id)}
                onBlur={() => setActiveEvent(null)}
                onPointerEnter={() => setActiveEvent(e.id)}
                onPointerLeave={() => setActiveEvent(null)}
                aria-label={`${e.title}, ${formatDate(e.at, 'long')}`}
                className={cn(
                  'absolute top-[6px] flex h-[19px] min-w-[19px] -translate-x-1/2 items-center justify-center rounded-[3px] px-1 text-[0.68rem] font-[750] leading-none',
                  e.kind === 'evidence_submitted' ? 'bg-ink text-on-ink' : e.kind === 'evidence_deadline' ? 'bg-lumen text-[#161a33] shadow-[0_0_0_1.5px_var(--ink)]' : 'bg-sheet text-ink shadow-[0_0_0_1.5px_var(--ink)]',
                )}
                style={{ left }}
              >
                {mark.letter}
              </button>
            )
          })}
          {/* event tooltip */}
          {activeEvent &&
            (() => {
              const e = pinned.find((p) => p.id === activeEvent)
              if (!e) return null
              const left = Math.min(Math.max(x(e.ts), 120), width - 120)
              return (
                <div role="tooltip" className="pointer-events-none absolute top-[30px] z-10 w-[15rem] -translate-x-1/2 rounded-[4px] bg-ink px-3 py-2 text-[0.8rem] text-on-ink" style={{ left }}>
                  <p className="font-[650]">{e.title}</p>
                  <p className="mt-0.5 opacity-80">{formatDate(e.at, 'long')}</p>
                </div>
              )
            })()}
          {/* point tooltip */}
          {hp && !activeEvent && (
            <div
              aria-live="polite"
              className="pointer-events-none absolute z-10 rounded-[4px] border-[1.5px] border-ink bg-sheet px-3 py-2 text-[0.8rem]"
              style={{
                left: Math.min(Math.max(x(hp.t) + 12, 8), width - 190),
                top: Math.max(M.top, Math.min(y(hp.yes) - 30, height - 110)),
                width: 178,
              }}
            >
              <p className="text-ink-3">{formatDate(new Date(hp.t).toISOString(), 'long')}</p>
              <p className="mt-1 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="hatch-yes inline-block h-2.5 w-2.5" />
                  Yes
                </span>
                <span className="t-figure text-[1rem] text-flare-ink">{formatPrice(hp.yes)}</span>
              </p>
              <p className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-2.5 w-2.5 bg-cobalt" />
                  No
                </span>
                <span className="t-figure text-[1rem] text-cobalt-ink">{formatPrice(hp.no)}</span>
              </p>
            </div>
          )}
        </div>
      )}
      <p className="mt-2 text-[0.75rem] text-ink-3">Times in UTC. Pins: M market created, E evidence, D evidence deadline, A answer, C challenge, K arbitration, R ruling, F finalized.</p>
    </div>
  )
}
