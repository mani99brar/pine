'use client'

import { useId, useMemo } from 'react'
import type { DepthSnapshot } from '@pine/core'
import { formatAmount, formatPrice } from '@pine/core'
import { useWidth } from './useSize'
import { depthByBand } from '@/lib/depth'

const M = { top: 16, right: 12, bottom: 28, left: 46 }

/** Cumulative depth around mid for one outcome token. The ±5 pt band is shaded. */
export function DepthChart({ depth, symbol, height = 200, loading }: { depth?: DepthSnapshot | null; symbol: string; height?: number; loading?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const uid = useId().replace(/:/g, '')

  const { bids, asks, maxSize } = useMemo(() => {
    const levels = depth?.levels ?? []
    const b = levels.filter((l) => l.side === 'bid').sort((p, q) => q.price - p.price)
    const a = levels.filter((l) => l.side === 'ask').sort((p, q) => p.price - q.price)
    const ms = Math.max(1, ...levels.map((l) => l.size))
    return { bids: b, asks: a, maxSize: ms }
  }, [depth])

  if (loading && !depth) return <div ref={ref} className="skeleton" style={{ height }} />
  if (!depth || depth.levels.length === 0) {
    return (
      <div ref={ref} className="flex items-center justify-center rounded-[var(--radius-tile)] border border-dashed border-line-strong text-[0.9rem] text-ink-3" style={{ height }}>
        No depth on this pool right now.
      </div>
    )
  }

  const mid = depth.mid
  const lo = Math.max(0, mid - 0.25)
  const hi = Math.min(1, mid + 0.25)
  const iw = Math.max(10, width - M.left - M.right)
  const ih = height - M.top - M.bottom
  const x = (p: number) => M.left + ((p - lo) / (hi - lo)) * iw
  const y = (s: number) => M.top + (1 - s / (maxSize * 1.08)) * ih

  const step = (levels: typeof bids, dir: 1 | -1) => {
    let d = `M${x(mid)},${y(0)}`
    let prev = 0
    for (const l of levels) {
      const px = x(Math.min(hi, Math.max(lo, l.price)))
      d += `L${px},${y(prev)}L${px},${y(l.size)}`
      prev = l.size
    }
    d += `L${dir === 1 ? x(hi) : x(lo)},${y(prev)}L${dir === 1 ? x(hi) : x(lo)},${y(0)}Z`
    return d
  }

  const within5 = depthByBand(depth, [0.05])[0] ?? 0
  const xticks = [lo, (lo + mid) / 2, mid, (mid + hi) / 2, hi]

  return (
    <div ref={ref} className="w-full">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Depth for the ${depth.outcome.toUpperCase()} token around a mid price of ${formatPrice(mid)}: about ${formatAmount(within5, { maxDecimals: 0 })} ${symbol} executable within 5 points.`}
        className="block"
      >
        <defs>
          <pattern id={`d-${uid}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--sheet)" />
            <rect width="1.4" height="5" fill="var(--ink)" opacity="0.4" />
          </pattern>
        </defs>
        <rect x={x(Math.max(lo, mid - 0.05))} y={M.top} width={x(Math.min(hi, mid + 0.05)) - x(Math.max(lo, mid - 0.05))} height={ih} fill="var(--lumen-wash)" />
        <path d={step(bids, -1)} fill="var(--fog-2)" stroke="var(--ink)" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={step(asks, 1)} fill={`url(#d-${uid})`} stroke="var(--ink)" strokeWidth={1.5} strokeLinejoin="round" />
        <line x1={x(mid)} x2={x(mid)} y1={M.top - 4} y2={M.top + ih} stroke="var(--ink)" strokeWidth={2.5} />
        <line x1={M.left} x2={M.left + iw} y1={M.top + ih} y2={M.top + ih} stroke="var(--ink)" />
        {[0, 0.5, 1].map((f) => (
          <text key={f} x={M.left - 8} y={y(maxSize * f) + 4} textAnchor="end" fontSize={11} fill="var(--ink-3)" className="t-figure">
            {formatAmount(maxSize * f, { compact: true, maxDecimals: 0 })}
          </text>
        ))}
        {xticks.map((p) => (
          <text key={p} x={x(p)} y={height - 9} textAnchor="middle" fontSize={11} fill={p === mid ? 'var(--ink)' : 'var(--ink-3)'} className="t-figure">
            {p === mid ? `mid ${formatPrice(p)}` : formatPrice(p)}
          </text>
        ))}
        <text x={x(mid) + 6} y={M.top + 10} fontSize={11} fill="var(--lumen-ink)" fontWeight={650}>
          ±5 pts
        </text>
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.78rem] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-4 border border-ink bg-fog-2" /> bids (tokens wanted, below mid)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-4 border border-ink bg-[repeating-linear-gradient(45deg,var(--ink)_0_1px,transparent_1px_4px)] opacity-70" /> asks (tokens offered, above mid)
        </span>
        <span>Size in outcome tokens, cumulative.</span>
      </div>
    </div>
  )
}
