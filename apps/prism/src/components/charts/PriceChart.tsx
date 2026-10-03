'use client'

import { useId, useMemo, useState } from 'react'
import { usePriceHistory } from '@pine/react'
import type { Evidence, PriceRange } from '@pine/core'
import { formatPrice } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { motion } from 'motion/react'
import { Segmented } from '@/components/ui/interactive'
import { ErrorState, Skeleton } from '@/components/ui/primitives'
import { OUTCOME_HEX } from '@/lib/crystal'
import { useElementWidth, useReduceMotion } from '@/lib/hooks'

const RANGES: { value: PriceRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
]

function fmtTime(t: number, range: PriceRange): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return range === '24h' ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC` : `${date} ${pad(d.getUTCHours())}:00 UTC`
}

/** Yes and No price over time as two lines of light; evidence filings are pinned on the time axis. */
export function PriceChart({ claimId, evidence = [], deadline }: { claimId: string; evidence?: Evidence[]; deadline?: string }) {
  const [range, setRange] = useState<PriceRange>('7d')
  const q = usePriceHistory(claimId, range)
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [cursor, setCursor] = useState<number | null>(null)
  const reduce = useReduceMotion()
  const raw = useId()
  const uid = `pc${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const H = 260
  const pad = { l: 44, r: 12, t: 14, b: 28 }
  const points = useMemo(() => q.data ?? [], [q.data])

  const geo = useMemo(() => {
    if (points.length < 2 || width < 100) return null
    const t0 = points[0].t
    const t1 = points[points.length - 1].t
    const iw = width - pad.l - pad.r
    const ih = H - pad.t - pad.b
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * iw
    const y = (p: number) => pad.t + (1 - p) * ih
    const line = (k: 'yes' | 'no') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ')
    const area = `${line('yes')} L${x(t1).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z`
    const pins = evidence
      .map((e) => ({ e, t: Date.parse(e.submittedAt) }))
      .filter(({ t }) => t >= t0 && t <= t1)
      .map(({ e, t }) => ({ id: e.id, x: x(t), kind: e.kind, title: e.title }))
    const dl = deadline ? Date.parse(deadline) : NaN
    const deadlineX = dl >= t0 && dl <= t1 ? x(dl) : null
    return { x, y, line, area, t0, t1, iw, ih, pins, deadlineX }
  }, [points, width, evidence, deadline, pad.l, pad.r, pad.t, pad.b])

  const idx = cursor === null ? null : Math.min(points.length - 1, Math.max(0, cursor))
  const at = idx !== null ? points[idx] : null
  const first = points[0]
  const last = points[points.length - 1]

  const onMove = (clientX: number, rect: DOMRect) => {
    if (!geo) return
    const rel = (clientX - rect.left - pad.l) / geo.iw
    setCursor(Math.round(rel * (points.length - 1)))
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4 text-[0.8125rem] text-lumen-2">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[3px] w-5 rounded-full" style={{ background: OUTCOME_HEX.yes }} /> Yes: {COPY.outcome.yes}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[2px] w-5 rounded-full" style={{ background: OUTCOME_HEX.no, opacity: 0.8 }} /> No
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rotate-45" style={{ background: '#5AD8FF' }} /> evidence filed
          </span>
        </div>
        <Segmented label="Price range" size="sm" value={range} onChange={setRange} options={RANGES} />
      </div>
      <div
        ref={ref}
        className="relative h-[260px] w-full outline-none"
        tabIndex={0}
        role="img"
        aria-label={
          first && last
            ? `Yes price over ${range}: from ${formatPrice(first.yes)} to ${formatPrice(last.yes)}. ${COPY.priceLabel}.`
            : 'Price history'
        }
        onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setCursor(null)}
        onKeyDown={(e) => {
          if (!points.length) return
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            setCursor((c) => Math.max(0, (c ?? points.length - 1) - 1))
          } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            setCursor((c) => Math.min(points.length - 1, (c ?? 0) + 1))
          } else if (e.key === 'Escape') setCursor(null)
        }}
        onBlur={() => setCursor(null)}
      >
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !geo ? (
          q.isLoading || width === 0 ? (
            <Skeleton className="h-full w-full" />
          ) : (
            <p className="pt-10 text-center text-[0.9rem] text-lumen-3">No trades in this range yet.</p>
          )
        ) : (
          <svg width={width} height={H} className="block" aria-hidden>
            <defs>
              <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={OUTCOME_HEX.yes} stopOpacity="0.28" />
                <stop offset="1" stopColor={OUTCOME_HEX.yes} stopOpacity="0" />
              </linearGradient>
              <filter id={`${uid}-glow`} x="-5%" y="-30%" width="110%" height="160%">
                <feGaussianBlur stdDeviation="4" />
              </filter>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((p) => (
              <g key={p}>
                <line x1={pad.l} x2={width - pad.r} y1={geo.y(p)} y2={geo.y(p)} stroke="#F5EDE4" strokeOpacity={p === 0 ? 0.16 : 0.06} />
                <text x={pad.l - 8} y={geo.y(p) + 4} textAnchor="end" fill="#A69789" fontSize="11" className="tnum">
                  {Math.round(p * 100)}%
                </text>
              </g>
            ))}
            {geo.deadlineX !== null && (
              <g>
                <line x1={geo.deadlineX} x2={geo.deadlineX} y1={pad.t} y2={H - pad.b} stroke="#FFB648" strokeOpacity="0.7" strokeDasharray="4 4" />
                <text x={geo.deadlineX - 4} y={pad.t + 10} textAnchor="end" fill="#FFB648" fontSize="11">
                  evidence deadline
                </text>
              </g>
            )}
            <motion.path key={`a-${range}`} d={geo.area} fill={`url(#${uid}-area)`} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }} />
            <path d={geo.line('no')} fill="none" stroke={OUTCOME_HEX.no} strokeOpacity="0.55" strokeWidth="1.4" />
            <path d={geo.line('yes')} fill="none" stroke={OUTCOME_HEX.yes} strokeWidth="5" strokeOpacity="0.35" filter={`url(#${uid}-glow)`} />
            <motion.path
              key={`l-${range}`}
              d={geo.line('yes')}
              fill="none"
              stroke={OUTCOME_HEX.yes}
              strokeWidth="2"
              strokeLinejoin="round"
              initial={reduce ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            />
            {geo.pins.map((p) => (
              <g key={p.id} transform={`translate(${p.x} ${H - pad.b})`}>
                <title>{p.title}</title>
                <line y1={-geo.ih} y2={0} stroke="#5AD8FF" strokeOpacity="0.18" />
                <rect x={-4} y={-4} width={8} height={8} transform="rotate(45)" fill={p.kind === 'counterexample' ? '#FF6B83' : '#5AD8FF'} />
              </g>
            ))}
            <text x={pad.l} y={H - 8} fill="#A69789" fontSize="11">
              {fmtTime(geo.t0, range)}
            </text>
            <text x={width - pad.r} y={H - 8} fill="#A69789" fontSize="11" textAnchor="end">
              {fmtTime(geo.t1, range)}
            </text>
            {at && (
              <g>
                <line x1={geo.x(at.t)} x2={geo.x(at.t)} y1={pad.t} y2={H - pad.b} stroke="#F5EDE4" strokeOpacity="0.4" />
                <circle cx={geo.x(at.t)} cy={geo.y(at.yes)} r="4.5" fill={OUTCOME_HEX.yes} stroke="#16110f" strokeWidth="2" />
                <circle cx={geo.x(at.t)} cy={geo.y(at.no)} r="3.5" fill={OUTCOME_HEX.no} stroke="#16110f" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}
        {at && geo && (
          <div
            className="glass-float cut-md pointer-events-none absolute top-2 px-3 py-2 text-[0.8125rem]"
            style={{ left: Math.min(width - 190, Math.max(pad.l, geo.x(at.t) + 12)) }}
            aria-live="polite"
          >
            <p className="text-lumen-3">{fmtTime(at.t, range)}</p>
            <p className="tnum text-lumen">
              Yes <strong className="font-semibold">{formatPrice(at.yes)}</strong>
              <span className="ml-3 text-lumen-2">No {formatPrice(at.no)}</span>
            </p>
          </div>
        )}
      </div>
      <p className="mt-2 text-[0.78rem] text-lumen-3">Use the arrow keys on the chart to step through prices. {COPY.priceCaveat}</p>
    </div>
  )
}
