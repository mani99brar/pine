'use client'

import { useId } from 'react'
import { motion } from 'motion/react'
import type { Outcome } from '@pine/core'
import { formatPrice } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { OUTCOME_HEX } from '@/lib/crystal'
import { cn } from '@/lib/cn'
import { AnimatedNumber } from '@/components/ui/interactive'
import { useReduceMotion } from '@/lib/hooks'

export interface BeamPrices {
  yes: number
  no: number
  invalid: number
}

const W = 720
const H = 300
const PRISM = { apex: [300, 34] as const, left: [214, 262] as const, right: [386, 262] as const }
const ENTRY: [number, number] = [258, 156]
const EXIT: [number, number] = [338, 150]
const END_Y = { yes: 62, no: 158, invalid: 250 }
const MAX_T = 132

function beamPoints(p: number, endY: number, minT = 2): string {
  const t1 = Math.max(minT, p * MAX_T)
  const t0 = Math.max(1.4, 3 + p * 12)
  const [ex, ey] = EXIT
  return `${ex},${ey - t0 / 2} ${W},${endY - t1 / 2} ${W},${endY + t1 / 2} ${ex},${ey + t0 / 2}`
}

/**
 * The market price as light: one white beam enters the prism and splits into a Yes beam
 * (Counterexample demonstrated), a No beam (No qualifying counterexample submitted) and a thin
 * Invalid-result sliver. Each beam's width at the right edge is proportional to its price.
 */
export function PrismBeam({
  prices,
  outcome,
  noMarket,
  className,
  compactLabels,
}: {
  prices?: BeamPrices
  outcome?: Outcome
  noMarket?: boolean
  className?: string
  compactLabels?: boolean
}) {
  const raw = useId()
  const uid = `pb${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const reduce = useReduceMotion()
  const p = prices ?? { yes: 0, no: 0, invalid: 0 }
  const lit = !noMarket && Boolean(prices)
  const show = (k: keyof BeamPrices) => (outcome ? (outcome === k ? 1 : 0) : lit ? 1 : 0)
  const width = (k: keyof BeamPrices) => (outcome ? (outcome === k ? 0.62 : 0) : p[k])
  const beamOpacity = (k: keyof BeamPrices) => {
    if (!show(k)) return 0
    if (outcome === 'no' || (outcome === undefined && k === 'no')) return outcome === 'no' ? 0.45 : 0.5
    if (k === 'invalid') return 0.7
    return 0.95
  }
  const transition = reduce ? { duration: 0 } : { duration: 0.9, ease: [0.16, 1, 0.3, 1] as const }

  const labels: { k: keyof BeamPrices; title: string; color: string }[] = [
    { k: 'yes', title: COPY.outcome.yes, color: OUTCOME_HEX.yes },
    { k: 'no', title: COPY.outcome.no, color: OUTCOME_HEX.no },
    { k: 'invalid', title: 'Invalid result', color: OUTCOME_HEX.invalid },
  ]

  const summary = outcome
    ? `Resolved: ${outcome === 'yes' ? COPY.outcome.yes : outcome === 'no' ? COPY.outcome.no : COPY.outcome.invalid}.`
    : lit
      ? `${COPY.priceLabel}: ${formatPrice(p.yes)}. No: ${formatPrice(p.no)}. Invalid result: ${formatPrice(p.invalid)}.`
      : 'No market price yet.'

  return (
    <figure className={cn('relative', className)}>
      <div className="grid items-stretch gap-x-5 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(13rem,15.5rem)]">
        <div className="relative min-w-0">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={summary}>
            <defs>
              <linearGradient id={`${uid}-in`} x1="0" x2="1">
                <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
                <stop offset="0.55" stopColor="#FFF6EC" stopOpacity="0.75" />
                <stop offset="1" stopColor="#FFFFFF" stopOpacity="1" />
              </linearGradient>
              {labels.map((l) => (
                <linearGradient key={l.k} id={`${uid}-${l.k}`} x1="0" x2="1">
                  <stop offset="0" stopColor={l.color} stopOpacity="1" />
                  <stop offset="0.6" stopColor={l.color} stopOpacity="0.7" />
                  <stop offset="1" stopColor={l.color} stopOpacity="0.22" />
                </linearGradient>
              ))}
              <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#F5EDE4" stopOpacity="0.16" />
                <stop offset="0.5" stopColor="#F5EDE4" stopOpacity="0.05" />
                <stop offset="1" stopColor="#F5EDE4" stopOpacity="0.1" />
              </linearGradient>
              <filter id={`${uid}-blur`} x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="9" />
              </filter>
              <filter id={`${uid}-frost`} x="-5%" y="-20%" width="110%" height="140%">
                <feTurbulence type="fractalNoise" baseFrequency="0.02 0.25" numOctaves={2} seed={7} result="n" />
                <feDisplacementMap in="SourceGraphic" in2="n" scale="5" result="d" />
                <feGaussianBlur in="d" stdDeviation="1.2" />
              </filter>
            </defs>

            {/* faint graticule: the beam lands on a measured screen */}
            <g stroke="#F5EDE4" strokeOpacity="0.06">
              {[0.25, 0.5, 0.75].map((t) => (
                <line key={t} x1={W - 1} x2={W - 1} y1={H * t - 8} y2={H * t + 8} />
              ))}
              <line x1={W - 0.5} x2={W - 0.5} y1={10} y2={H - 10} />
            </g>

            {/* incoming white light */}
            <motion.g initial={reduce ? false : { scaleX: 0, opacity: 0 }} animate={{ scaleX: 1, opacity: lit || outcome ? 1 : 0.35 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} style={{ transformOrigin: '0px 156px' }}>
              <polygon points={`0,${ENTRY[1] - 7} ${ENTRY[0]},${ENTRY[1] - 2.2} ${ENTRY[0]},${ENTRY[1] + 2.2} 0,${ENTRY[1] + 7}`} fill={`url(#${uid}-in)`} filter={`url(#${uid}-blur)`} opacity="0.6" />
              <polygon points={`0,${ENTRY[1] - 3} ${ENTRY[0]},${ENTRY[1] - 1.2} ${ENTRY[0]},${ENTRY[1] + 1.2} 0,${ENTRY[1] + 3}`} fill={`url(#${uid}-in)`} />
            </motion.g>

            {/* refracted path inside the glass */}
            {(lit || outcome) && <polygon points={`${ENTRY[0]},${ENTRY[1] - 1.6} ${EXIT[0]},${EXIT[1] - 5} ${EXIT[0]},${EXIT[1] + 6} ${ENTRY[0]},${ENTRY[1] + 1.6}`} fill="#FFF6EC" opacity="0.32" />}

            {/* outgoing beams: glow layer, then core */}
            {labels.map((l) => {
              const pts = beamPoints(width(l.k), END_Y[l.k], outcome ? 2 : 2)
              const op = beamOpacity(l.k)
              return (
                <g key={l.k} filter={l.k === 'invalid' || outcome === 'invalid' ? `url(#${uid}-frost)` : undefined}>
                  <motion.polygon
                    initial={reduce ? false : { points: beamPoints(0, END_Y[l.k]), opacity: 0 }}
                    animate={{ points: pts, opacity: op * 0.55 }}
                    transition={{ ...transition, delay: reduce ? 0 : 0.35 }}
                    fill={l.color}
                    filter={`url(#${uid}-blur)`}
                  />
                  <motion.polygon
                    initial={reduce ? false : { points: beamPoints(0, END_Y[l.k]), opacity: 0 }}
                    animate={{ points: pts, opacity: op }}
                    transition={{ ...transition, delay: reduce ? 0 : 0.35 }}
                    fill={`url(#${uid}-${l.k})`}
                  />
                  {op > 0 && (
                    <motion.line
                      x1={EXIT[0]}
                      y1={EXIT[1]}
                      x2={W}
                      y2={END_Y[l.k]}
                      stroke="#FFFFFF"
                      strokeWidth="1"
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: op * 0.5 }}
                      transition={{ duration: 0.6, delay: reduce ? 0 : 0.7 }}
                    />
                  )}
                </g>
              )
            })}

            {/* the prism */}
            <polygon
              points={`${PRISM.apex.join(',')} ${PRISM.right.join(',')} ${PRISM.left.join(',')}`}
              fill={`url(#${uid}-glass)`}
              stroke="#F5EDE4"
              strokeOpacity={lit || outcome ? 0.62 : 0.3}
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <line x1={PRISM.apex[0] - 6} y1={PRISM.apex[1] + 20} x2={PRISM.left[0] + 14} y2={PRISM.left[1] - 10} stroke="#FFFFFF" strokeOpacity="0.28" strokeWidth="1" />
            {outcome === 'yes' && (
              <polyline points="262,120 286,142 278,166 306,188 300,214" fill="none" stroke={OUTCOME_HEX.yes} strokeWidth="2" strokeOpacity="0.9" />
            )}
          </svg>
          {!lit && !outcome && (
            <p className="absolute inset-x-0 bottom-2 text-center text-[0.875rem] text-lumen-3">No market price yet. Light enters once the market is funded.</p>
          )}
        </div>

        <figcaption className="relative min-h-0">
          <ul className="grid h-full content-between gap-3 md:gap-2">
            {labels.map((l) => {
              const visible = outcome ? outcome === l.k : lit
              return (
                <li key={l.k} className={cn('min-w-0 border-l-2 pl-3 transition-opacity duration-500', visible ? 'opacity-100' : 'opacity-35')} style={{ borderColor: l.color }}>
                  <p className={cn('text-[0.8125rem] leading-[1.3]', compactLabels ? 'text-lumen-3' : 'text-lumen-2')}>{l.title}</p>
                  {outcome ? (
                    <p className="t-figure mt-0.5 text-[1.5rem] leading-none text-lumen">{outcome === l.k ? 'Final' : '—'}</p>
                  ) : lit ? (
                    <p className={cn('t-figure mt-0.5 leading-none', l.k === 'invalid' ? 'text-[1.25rem] text-lumen-2' : 'text-[2rem] text-lumen')}>
                      <AnimatedNumber value={p[l.k]} format={(n) => formatPrice(n)} />
                    </p>
                  ) : (
                    <p className="t-figure mt-0.5 text-[1.5rem] leading-none text-lumen-3">{'—'}</p>
                  )}
                </li>
              )
            })}
          </ul>
        </figcaption>
      </div>
    </figure>
  )
}

/** Small prism for rows and cards: three beams whose thickness follows the prices. */
export function PrismMini({ prices, outcome, className, width = 76 }: { prices?: BeamPrices; outcome?: Outcome; className?: string; width?: number }) {
  const h = width * (28 / 76)
  const beam = (k: keyof BeamPrices, y: number, color: string) => {
    const v = outcome ? (outcome === k ? 0.8 : 0) : (prices?.[k] ?? 0)
    if (v <= 0) return null
    const t = Math.max(1, v * 14)
    return <polygon key={k} points={`30,14 76,${y - t / 2} 76,${y + t / 2} 30,14.6`} fill={color} opacity={k === 'no' ? (outcome === 'no' ? 0.55 : 0.75) : k === 'invalid' ? 0.6 : 0.95} />
  }
  return (
    <svg viewBox="0 0 76 28" width={width} height={h} aria-hidden className={className}>
      <line x1="0" y1="14.3" x2="22" y2="14.3" stroke="#F5EDE4" strokeOpacity={prices || outcome ? 0.9 : 0.3} strokeWidth="1.2" />
      {beam('yes', 6, OUTCOME_HEX.yes)}
      {beam('no', 15, OUTCOME_HEX.no)}
      {beam('invalid', 23, OUTCOME_HEX.invalid)}
      <polygon points="26,3 33,25 19,25" fill="rgba(245,237,228,0.1)" stroke="#F5EDE4" strokeOpacity={prices || outcome ? 0.7 : 0.35} strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

/** Prices for a claim (Yes, No, Invalid result) from the market outcomes or the summary price. */
export function pricesFrom(claim: { yesPrice?: number; market?: { outcomes: { label: string; price: number; index: number }[] } }): BeamPrices | undefined {
  const outs = claim.market?.outcomes
  if (outs && outs.length) {
    const yes = outs.find((o) => /^yes$/i.test(o.label))?.price ?? outs[0]?.price ?? 0
    const no = outs.find((o) => /^no$/i.test(o.label))?.price ?? outs[1]?.price ?? 0
    const invalid = outs.find((o) => /invalid/i.test(o.label))?.price ?? outs[2]?.price ?? 0
    return { yes, no, invalid }
  }
  if (claim.yesPrice === undefined) return undefined
  // Summaries carry only the Yes price: the glyph shows No as its complement and no Invalid sliver.
  return { yes: claim.yesPrice, no: Math.max(0, 1 - claim.yesPrice), invalid: 0 }
}
