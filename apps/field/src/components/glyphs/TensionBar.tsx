'use client'

import { useState, type CSSProperties } from 'react'
import { COPY } from '@pine/core/copy'
import { formatPrice, type Outcome } from '@pine/core'
import { cn } from '@/lib/cn'

export type TensionSize = 'sm' | 'md' | 'lg'

const BAR_HEIGHT: Record<TensionSize, number> = { sm: 8, md: 14, lg: 26 }

export interface TensionBarProps {
  /** YES price in [0, 1]. Undefined means there is no market price yet. */
  yes?: number
  /** YES price 24 hours ago, for the ghost post and move trail. */
  yes24hAgo?: number
  /**
   * Price of Seer's native "Invalid result" token. Drawn as a thin slate cross-hatched segment at the
   * NO end, so the three outcome prices read left to right: YES | NO | Invalid.
   */
  invalid?: number
  size?: TensionSize
  /** Final outcome: the bar collapses to the resolved side. */
  outcome?: Outcome
  /** Animate the knot from 50% on mount (board load). Delay in ms for the stagger wave. */
  settleDelay?: number
  /** Background colour of the surface the bar sits on (the gap around the knot uses it). */
  surface?: 'sheet' | 'fog'
  className?: string
}

/** Signed move in percentage points, e.g. +2.1 */
export function movePts(yes?: number, yes24hAgo?: number): number | undefined {
  if (yes === undefined || yes24hAgo === undefined) return undefined
  return Math.round((yes - yes24hAgo) * 1000) / 10
}

export function formatMove(pts: number | undefined): string {
  if (pts === undefined) return 'no 24h data'
  if (Math.abs(pts) < 0.05) return 'no change'
  return `${pts > 0 ? '+' : '−'}${Math.abs(pts).toFixed(1)} pts`
}

export function tensionAriaLabel(yes?: number, yes24hAgo?: number, outcome?: Outcome, invalid?: number): string {
  if (outcome) return `Resolved: ${COPY.outcome[outcome]}`
  if (yes === undefined) return 'No market price yet'
  const pts = movePts(yes, yes24hAgo)
  const move =
    pts === undefined
      ? ''
      : Math.abs(pts) < 0.05
        ? ', unchanged in 24 hours'
        : `, ${pts > 0 ? 'up' : 'down'} ${Math.abs(pts).toFixed(1)} points in 24 hours`
  const inv = invalid !== undefined && invalid > 0.0005 ? `. Invalid result token ${formatPrice(invalid)}` : ''
  return `${COPY.priceLabel}: ${formatPrice(yes)}${move}${inv}`
}

/**
 * The tension bar: the YES/NO split as a rope held between two anchors, the knot at the market-implied
 * chance. YES (counterexample) is hatched Flare on the left; NO (none submitted) is solid Cobalt.
 */
export function TensionBar({
  yes,
  yes24hAgo,
  invalid,
  size = 'md',
  outcome,
  settleDelay,
  surface = 'sheet',
  className,
}: TensionBarProps) {
  const h = BAR_HEIGHT[size]
  const label = tensionAriaLabel(yes, yes24hAgo, outcome, invalid)

  // Pulse once whenever a live price changes (not on first render).
  const [prev, setPrev] = useState(yes)
  const [pulse, setPulse] = useState(0)
  if (yes !== prev) {
    setPrev(yes)
    setPulse((n) => n + 1)
  }

  const anchorOverhang = size === 'lg' ? 5 : 3
  const gapBg = surface === 'sheet' ? 'var(--sheet)' : 'var(--fog)'

  if (outcome) {
    return (
      <div role="img" aria-label={label} title={label} className={cn('relative', className)} style={{ height: h }}>
        <Anchor side="left" overhang={anchorOverhang} />
        <span
          className={cn(
            'absolute inset-y-0 left-[3px] right-[3px]',
            outcome === 'yes' && 'hatch-yes',
            outcome === 'no' && 'bg-cobalt',
            outcome === 'invalid' && 'hatch-invalid',
          )}
        />
        <Anchor side="right" overhang={anchorOverhang} />
      </div>
    )
  }

  if (yes === undefined) {
    return (
      <div role="img" aria-label={label} title={label} className={cn('relative', className)} style={{ height: h }}>
        <Anchor side="left" overhang={anchorOverhang} muted />
        <span className="absolute inset-y-0 left-[3px] right-[3px] rounded-[1px] border border-dashed border-line-strong" />
        <Anchor side="right" overhang={anchorOverhang} muted />
      </div>
    )
  }

  const p = clamp(yes)
  const q = yes24hAgo === undefined ? undefined : clamp(yes24hAgo)
  // Invalid share, kept visible (min 1.5%) when priced but never more than what's left of the rope.
  const inv = invalid !== undefined && invalid > 0.0005 ? Math.min(1 - p, Math.max(0.015, clamp(invalid))) : 0
  const style = {
    '--p': p,
    '--inv': inv,
    '--gap-bg': gapBg,
    height: h,
    animation: settleDelay !== undefined ? `tension-settle 900ms cubic-bezier(.2,.8,.2,1) ${settleDelay}ms backwards` : undefined,
  } as CSSProperties

  const showTrail = q !== undefined && Math.abs(p - q) >= 0.004
  const knotW = size === 'lg' ? 4 : 3
  const knotOver = size === 'lg' ? 6 : 4
  const trailGap = size === 'lg' ? 9 : 6

  return (
    <div role="img" aria-label={label} title={label} className={cn('tension relative', className)} style={style}>
      <Anchor side="left" overhang={anchorOverhang} />
      {/* YES side */}
      <span
        className="hatch-yes absolute inset-y-0 left-[3px]"
        style={{ width: 'max(0px, calc((100% - 6px) * var(--p)))' }}
      />
      {/* NO side */}
      <span
        className="absolute inset-y-0 bg-cobalt"
        style={{ right: 'calc(3px + (100% - 6px) * var(--inv))', width: 'max(0px, calc((100% - 6px) * (1 - var(--p) - var(--inv))))' }}
      />
      {/* Invalid result token (thin, at the NO end) */}
      {inv > 0 && (
        <span
          aria-hidden
          className="hatch-invalid absolute inset-y-0 right-[3px] border-l-2 border-[var(--gap-bg)]"
          style={{ width: 'calc((100% - 6px) * var(--inv))' }}
        />
      )}
      {/* 24h move, drawn under the bar: a dashed "was here" post, then a trail to the knot */}
      {q !== undefined && (
        <span
          aria-hidden
          className="absolute w-0 border-l-[1.5px] border-dashed border-ink/75"
          style={{ left: `calc(3px + (100% - 6px) * ${q})`, top: Math.round(h * 0.15), height: h - Math.round(h * 0.15) + trailGap + 1 }}
        />
      )}
      {showTrail && q !== undefined && (
        <span
          aria-hidden
          className="absolute h-[1.5px] bg-ink"
          style={{
            top: h + trailGap,
            left: `calc(3px + (100% - 6px) * ${Math.min(p, q)})`,
            width: `calc((100% - 6px) * ${Math.abs(p - q)})`,
          }}
        >
          <span
            className="absolute top-1/2 h-0 w-0 -translate-y-1/2 border-y-[4px] border-y-transparent"
            style={p > q ? { right: -1, borderLeft: '6px solid var(--ink)' } : { left: -1, borderRight: '6px solid var(--ink)' }}
          />
        </span>
      )}
      {/* knot */}
      <span
        aria-hidden
        className="tension-knot absolute"
        style={{
          left: 'calc(3px + (100% - 6px) * var(--p))',
          top: -knotOver,
          bottom: showTrail ? -(trailGap + 1) : -knotOver,
          width: knotW + 4,
          transform: 'translateX(-50%)',
          background: 'var(--gap-bg)',
        }}
      >
        <span className="absolute inset-y-0 left-1/2 -translate-x-1/2 bg-ink" style={{ width: knotW }} />
        {pulse > 0 && (
          <span
            key={pulse}
            className="absolute left-1/2 top-1/2 -ml-2 -mt-2 h-4 w-4 rounded-full border-2 border-ink"
            style={{ animation: 'knot-pulse 900ms ease-out forwards' }}
          />
        )}
      </span>
      <Anchor side="right" overhang={anchorOverhang} />
    </div>
  )
}

function Anchor({ side, overhang, muted }: { side: 'left' | 'right'; overhang: number; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('absolute w-[2px]', muted ? 'bg-line-strong' : 'bg-ink', side === 'left' ? 'left-0' : 'right-0')}
      style={{ top: -overhang, bottom: -overhang }}
    />
  )
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.min(1, Math.max(0, v))
}
