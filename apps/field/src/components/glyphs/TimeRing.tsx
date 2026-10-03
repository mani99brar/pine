'use client'

import { formatDate, formatDuration } from '@pine/core'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

const DAY = 86_400_000
const HOUR = 3_600_000

export interface TimeRingProps {
  /** Start of the window (claim creation / answer time) */
  start: string
  /** End of the window (evidence deadline / finalization) */
  end: string
  size?: number
  /** evidence = evidence window (Ink, Lumen when < 24h); challenge = oracle answer finalization (Cobalt dotted) */
  variant?: 'evidence' | 'challenge'
  /** Show the remaining time beside the ring instead of inside it */
  labelPosition?: 'inside' | 'beside' | 'none'
  className?: string
}

function splitLabel(ms: number): [string, string] {
  if (ms <= 0) return ['closed', '']
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / 60_000)
  if (d > 0) return [`${d}d`, `${h}h`]
  if (h > 0) return [`${h}h`, `${m}m`]
  return [`${Math.max(1, m)}m`, '']
}

/**
 * The time ring: an evidence (or challenge) window as a draining dial. The arc is the remaining share of
 * the window, clockwise from 12 o'clock, with one tick per day.
 */
export function TimeRing({ start, end, size = 44, variant = 'evidence', labelPosition = 'inside', className }: TimeRingProps) {
  const now = useNowMs()
  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  const total = Math.max(1, endMs - startMs)
  const remaining = now === null ? null : endMs - now
  const frac = remaining === null ? 1 : Math.max(0, Math.min(1, remaining / total))
  const past = remaining !== null && remaining <= 0
  const urgent = remaining !== null && remaining > 0 && remaining < DAY

  const stroke = size >= 64 ? 5 : size >= 40 ? 4 : 3
  const r = size / 2 - stroke / 2 - 1.5
  const c = 2 * Math.PI * r
  const days = Math.round(total / DAY)
  const ticks = days >= 2 && days <= 21 ? Array.from({ length: days - 1 }, (_, i) => ((i + 1) * DAY) / total) : []

  const [main, sub] = remaining === null ? ['', ''] : splitLabel(remaining)
  const what = variant === 'evidence' ? 'Evidence window' : 'Answer finalizes'
  const aria =
    remaining === null
      ? `${what}: closes ${formatDate(end, 'long')}`
      : past
        ? `${what}: closed ${formatDate(end, 'long')}`
        : `${what}: ${formatDuration(remaining)} remaining, closes ${formatDate(end, 'long')}`

  const arcColor = variant === 'challenge' ? 'var(--cobalt)' : urgent ? 'var(--lumen)' : 'var(--ink)'
  const textColor = urgent && variant === 'evidence' ? 'text-lumen-ink' : 'text-ink'
  const inside = labelPosition === 'inside' && size >= 40

  return (
    <span role="img" aria-label={aria} title={aria} className={cn('inline-flex items-center gap-2', className)}>
      <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="block">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--line)"
            strokeWidth={stroke}
            strokeDasharray={past || variant === 'challenge' ? '2 3' : undefined}
          />
          {!past && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={arcColor}
              strokeWidth={stroke}
              strokeDasharray={`${frac * c} ${c}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="transition-[stroke-dasharray] duration-700"
            />
          )}
          {ticks.map((t, i) => {
            const a = t * 2 * Math.PI - Math.PI / 2
            const r1 = r + stroke / 2 + 0.5
            const r0 = r - stroke / 2 - 0.5
            return (
              <line
                key={i}
                x1={size / 2 + Math.cos(a) * r0}
                y1={size / 2 + Math.sin(a) * r0}
                x2={size / 2 + Math.cos(a) * r1}
                y2={size / 2 + Math.sin(a) * r1}
                stroke="var(--sheet)"
                strokeWidth={1.25}
              />
            )
          })}
        </svg>
        {inside && (
          <span className={cn('absolute inset-0 flex flex-col items-center justify-center leading-none', textColor)}>
            <span className="t-figure" style={{ fontSize: size >= 64 ? 20 : 13 }}>
              {main}
            </span>
            {sub && (
              <span className="t-figure mt-[1px] text-ink-3" style={{ fontSize: size >= 64 ? 12 : 9.5 }}>
                {sub}
              </span>
            )}
          </span>
        )}
      </span>
      {labelPosition === 'beside' && (
        <span className={cn('t-figure text-[0.95rem]', textColor)}>
          {remaining === null ? '' : past ? 'closed' : formatDuration(remaining)}
        </span>
      )}
    </span>
  )
}
