import { cn } from '@/lib/cn'

/**
 * Graduated instruments: the console's one visual motif.
 * Every tick encodes a time, a price or a completion state.
 */

/** Inline sparkline of YES price. Single series; the endpoint carries a dot. */
export function Sparkline({
  values,
  width = 72,
  height = 22,
  className,
  label,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
  label?: string
}) {
  if (values.length < 2) return <span className={cn('inline-block text-faint', className)} style={{ width, height }} aria-hidden />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(max - min, 0.02)
  const pad = 3
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2)
    const y = pad + (1 - (v - min) / span) * (height - pad * 2)
    return [x, y] as const
  })
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]!
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0 overflow-visible', className)}
      role="img"
      aria-label={label ?? 'YES price trend'}
    >
      <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--chart-1)" stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  )
}

/**
 * Price gauge: a 0–100 graduated scale with a needle at the YES price.
 * Minor tick every 5, major every 25.
 */
export function PriceGauge({
  value,
  previous,
  className,
  width = 120,
  showScale = false,
}: {
  value: number | undefined
  previous?: number
  className?: string
  width?: number
  showScale?: boolean
}) {
  const h = showScale ? 22 : 12
  const ticks = Array.from({ length: 21 }, (_, i) => i * 5)
  const x = (p: number) => 1 + (p / 100) * (width - 2)
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} className={cn('shrink-0', className)} aria-hidden>
      <line x1={0} x2={width} y1={9} y2={9} stroke="var(--line-strong)" strokeWidth={1} />
      {ticks.map((t) => (
        <line
          key={t}
          x1={x(t)}
          x2={x(t)}
          y1={t % 25 === 0 ? 3 : 6}
          y2={9}
          stroke={t % 25 === 0 ? 'var(--faint)' : 'var(--line-strong)'}
          strokeWidth={1}
        />
      ))}
      {typeof previous === 'number' ? (
        <line x1={x(previous * 100)} x2={x(previous * 100)} y1={1} y2={11} stroke="var(--faint)" strokeWidth={1} strokeDasharray="1 1.5" />
      ) : null}
      {typeof value === 'number' ? (
        <g>
          <line x1={x(value * 100)} x2={x(value * 100)} y1={0} y2={12} stroke="var(--bark)" strokeWidth={2} strokeLinecap="round" />
        </g>
      ) : null}
      {showScale
        ? [0, 50, 100].map((t) => (
            <text
              key={t}
              x={x(t)}
              y={21}
              fontSize={9}
              fill="var(--faint)"
              textAnchor={t === 0 ? 'start' : t === 100 ? 'end' : 'middle'}
              fontFamily="var(--font-mono)"
            >
              {t}
            </text>
          ))
        : null}
    </svg>
  )
}

/**
 * Deadline bar: the evidence window drawn as graduations from creation to deadline.
 * Elapsed ticks are filled; a resin tick marks "now". Past deadlines render fully filled in slate.
 */
export function DeadlineBar({
  start,
  end,
  now,
  className,
  width = 88,
}: {
  start: string
  end: string
  now: Date
  className?: string
  width?: number
}) {
  const s = Date.parse(start)
  const e = Date.parse(end)
  const n = now.getTime()
  const frac = e > s ? Math.min(1, Math.max(0, (n - s) / (e - s))) : 1
  const count = Math.max(8, Math.floor(width / 5))
  const past = n >= e
  const urgent = !past && e - n < 48 * 3600 * 1000
  return (
    <svg width={width} height={10} viewBox={`0 0 ${width} 10`} className={cn('shrink-0', className)} aria-hidden>
      {Array.from({ length: count + 1 }, (_, i) => {
        const x = 0.5 + (i / count) * (width - 1)
        const filled = i / count <= frac
        return (
          <line
            key={i}
            x1={x}
            x2={x}
            y1={i % 4 === 0 ? 1 : 4}
            y2={10}
            stroke={past ? 'var(--slate)' : filled ? (urgent ? 'var(--resin)' : 'var(--bark)') : 'var(--line-strong)'}
            strokeWidth={1}
            opacity={filled || past ? 0.9 : 1}
          />
        )
      })}
      {!past ? (
        <line x1={0.5 + frac * (width - 1)} x2={0.5 + frac * (width - 1)} y1={0} y2={10} stroke="var(--resin-fill)" strokeWidth={2} />
      ) : null}
    </svg>
  )
}

/** Small status dot used in tables and badges. */
export function Dot({ className, pulse }: { className?: string; pulse?: boolean }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full bg-current', pulse && 'animate-pulse-dot', className)} />
}
