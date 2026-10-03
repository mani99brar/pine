import type { DepthSnapshot } from '@pine/core'
import { formatAmount } from '@pine/core'
import { DEPTH_BANDS, THIN_DEPTH, depthByBand, depthHeight } from '@/lib/depth'
import { cn } from '@/lib/cn'

export interface DepthBarsProps {
  depth?: DepthSnapshot | null
  symbol: string
  size?: 'sm' | 'md' | 'lg'
  caption?: boolean
  loading?: boolean
  className?: string
}

const DIMS = {
  sm: { w: 3, gap: 2, h: 14 },
  md: { w: 5, gap: 2.5, h: 20 },
  lg: { w: 10, gap: 4, h: 44 },
} as const

/**
 * Depth bars: executable collateral within ±1, ±2, ±5, ±10, ±20 points of mid, read like signal
 * strength. Hollow bars mean thin depth.
 */
export function DepthBars({ depth, symbol, size = 'md', caption = true, loading, className }: DepthBarsProps) {
  const amounts = depthByBand(depth)
  const d = DIMS[size]
  const width = DEPTH_BANDS.length * d.w + (DEPTH_BANDS.length - 1) * d.gap
  const within5 = amounts[2] ?? 0
  const thin = within5 < THIN_DEPTH
  const unavailable = !loading && (!depth || depth.levels.length === 0)

  const aria = unavailable
    ? 'Executable depth unavailable'
    : `Executable depth: ${DEPTH_BANDS.map((b, i) => `${formatAmount(amounts[i] ?? 0, { maxDecimals: 0 })} ${symbol} within ${Math.round(b * 100)} ${b === 0.01 ? 'point' : 'points'}`).join(', ')} of mid`

  return (
    <span
      role="img"
      aria-label={loading ? 'Loading depth' : aria}
      title="Collateral you could trade before the price moves 1, 2, 5, 10 and 20 percentage points. Hollow bars mean thin depth."
      className={cn('inline-flex items-end gap-2', className)}
    >
      <svg width={width} height={d.h} viewBox={`0 0 ${width} ${d.h}`} aria-hidden className="block shrink-0 overflow-visible">
        {DEPTH_BANDS.map((band, i) => {
          const x = i * (d.w + d.gap)
          const amount = amounts[i] ?? 0
          const frac = loading || unavailable ? 0 : depthHeight(amount)
          const barH = Math.max(2.5, frac * d.h)
          const hollow = loading || unavailable || amount < THIN_DEPTH
          // reference ghost: the full-height slot, so short bars read as "missing" depth
          return (
            <g key={band}>
              <rect x={x} y={0} width={d.w} height={d.h} fill="var(--line)" opacity={0.45} rx={0.5} />
              <rect
                x={hollow ? x + 0.5 : x}
                y={d.h - barH + (hollow ? 0.5 : 0)}
                width={hollow ? d.w - 1 : d.w}
                height={hollow ? barH - 1 : barH}
                fill={hollow ? 'var(--sheet)' : 'var(--ink)'}
                stroke={hollow ? 'var(--ink-3)' : 'none'}
                strokeWidth={hollow ? 1 : 0}
                rx={0.5}
              />
            </g>
          )
        })}
      </svg>
      {caption && (
        <span className={cn('leading-none', size === 'lg' ? 'text-sm' : 'text-[0.78rem]', size === 'sm' && 'whitespace-nowrap')}>
          {loading ? (
            <span className="text-ink-3">depth…</span>
          ) : unavailable ? (
            <span className="text-ink-3">no depth</span>
          ) : (
            <>
              <span className={cn('t-figure', size === 'lg' ? 'text-xl' : 'text-[0.95rem]', thin ? 'text-ink-2' : 'text-ink')}>
                {formatAmount(within5, { compact: within5 >= 10_000, maxDecimals: 0 })}
              </span>{' '}
              <span className="text-ink-3">
                {symbol} {size === 'sm' ? 'within 5 pts' : 'tradable within 5 pts of the price'}
                {thin && size !== 'sm' ? ' (thin)' : ''}
              </span>
            </>
          )}
        </span>
      )}
    </span>
  )
}
