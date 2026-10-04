'use client'

import { useId } from 'react'
import { motion } from 'motion/react'
import type { ClaimDetail } from '@pine/core'
import { formatPrice, formatPriceCents } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { OUTCOME_HEX } from '@/lib/crystal'
import { apiDetailFactsOf, apiOutcomePrices, type OutcomePrices } from '@/lib/claims'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'

// Same optics as PrismBeam, but an outcome without a reported price gets no beam (a faint dashed trace instead) and
// reads "—": the backend reports marginal pool prices for Yes and No only, and Invalid has no Pine pool.
const W = 720
const H = 300
const PRISM = { apex: [300, 34] as const, left: [214, 262] as const, right: [386, 262] as const }
const ENTRY: [number, number] = [258, 156]
const EXIT: [number, number] = [338, 150]
const END_Y = { yes: 62, no: 158, invalid: 250 } as const
const MAX_T = 132

type Key = keyof typeof END_Y

function beamPoints(p: number, endY: number): string {
  const t1 = Math.max(2, p * MAX_T)
  const t0 = Math.max(1.4, 3 + p * 12)
  const [ex, ey] = EXIT
  return `${ex},${ey - t0 / 2} ${W},${endY - t1 / 2} ${W},${endY + t1 / 2} ${ex},${ey + t0 / 2}`
}

function unknownReason(claim: ClaimDetail, k: Key): string {
  if (k === 'invalid') return 'Not priced: Pine reports no Invalid-result pool'
  const reason = apiDetailFactsOf(claim)?.liquidity?.outcomes.find((o) => o.outcome === k)?.reason
  // Backend text (not user content), shown as plain text.
  return reason ? `Not priced yet: ${reason}` : 'Not priced yet'
}

/** The market as light for a backend claim: beams only for prices the backend reported. */
export function ApiPriceSplit({ claim }: { claim: ClaimDetail }) {
  const raw = useId()
  const uid = `ap${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const reduce = useReduceMotion()
  const prices: OutcomePrices = apiOutcomePrices(claim)
  const api = apiDetailFactsOf(claim)
  const lit = prices.yes !== undefined || prices.no !== undefined
  const transition = reduce ? { duration: 0 } : { duration: 0.9, ease: [0.16, 1, 0.3, 1] as const, delay: 0.35 }
  const labels: { k: Key; title: string; color: string }[] = [
    { k: 'yes', title: COPY.outcome.yes, color: OUTCOME_HEX.yes },
    { k: 'no', title: COPY.outcome.no, color: OUTCOME_HEX.no },
    { k: 'invalid', title: 'Invalid result', color: OUTCOME_HEX.invalid },
  ]
  const priceText = (k: Key) => (prices[k] !== undefined ? formatPrice(prices[k] as number) : 'not priced')
  const summary = lit ? `Pool prices. Yes: ${priceText('yes')}. No: ${priceText('no')}. Invalid result: not priced.` : 'No pool price yet.'

  return (
    <figure>
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
            </defs>
            <polygon points={`0,${ENTRY[1] - 3} ${ENTRY[0]},${ENTRY[1] - 1.2} ${ENTRY[0]},${ENTRY[1] + 1.2} 0,${ENTRY[1] + 3}`} fill={`url(#${uid}-in)`} opacity={lit ? 1 : 0.35} />
            {lit && <polygon points={`${ENTRY[0]},${ENTRY[1] - 1.6} ${EXIT[0]},${EXIT[1] - 5} ${EXIT[0]},${EXIT[1] + 6} ${ENTRY[0]},${ENTRY[1] + 1.6}`} fill="#FFF6EC" opacity="0.32" />}
            {labels.map((l) => {
              const p = prices[l.k]
              if (p === undefined) {
                return <line key={l.k} x1={EXIT[0]} y1={EXIT[1]} x2={W} y2={END_Y[l.k]} stroke={l.color} strokeOpacity="0.28" strokeWidth="1" strokeDasharray="3 7" />
              }
              const pts = beamPoints(p, END_Y[l.k])
              const op = l.k === 'no' ? 0.5 : 0.95
              return (
                <g key={l.k}>
                  <motion.polygon initial={reduce ? false : { points: beamPoints(0, END_Y[l.k]), opacity: 0 }} animate={{ points: pts, opacity: op * 0.55 }} transition={transition} fill={l.color} filter={`url(#${uid}-blur)`} />
                  <motion.polygon initial={reduce ? false : { points: beamPoints(0, END_Y[l.k]), opacity: 0 }} animate={{ points: pts, opacity: op }} transition={transition} fill={`url(#${uid}-${l.k})`} />
                  <line x1={EXIT[0]} y1={EXIT[1]} x2={W} y2={END_Y[l.k]} stroke="#FFFFFF" strokeWidth="1" strokeOpacity={op * 0.5} />
                </g>
              )
            })}
            <polygon
              points={`${PRISM.apex.join(',')} ${PRISM.right.join(',')} ${PRISM.left.join(',')}`}
              fill={`url(#${uid}-glass)`}
              stroke="#F5EDE4"
              strokeOpacity={lit ? 0.62 : 0.3}
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          {!lit && <p className="absolute inset-x-0 bottom-2 text-center text-[0.875rem] text-lumen-3">No pool price yet. Light enters once a pool is priced.</p>}
        </div>
        <figcaption className="relative min-h-0">
          <ul className="grid h-full content-between gap-3 md:gap-2">
            {labels.map((l) => {
              const p = prices[l.k]
              return (
                <li key={l.k} className="min-w-0 border-l-2 pl-3" style={{ borderColor: p !== undefined ? l.color : `color-mix(in oklab, ${l.color} 28%, transparent)` }}>
                  <p className={cn('text-[0.8125rem] leading-[1.3]', p !== undefined ? 'text-lumen-2' : 'text-lumen-3')}>{l.title}</p>
                  {p !== undefined ? (
                    <>
                      <p className={cn('t-figure mt-0.5 leading-none text-lumen', l.k === 'yes' ? 'text-[2rem]' : 'text-[1.5rem]')}>{formatPrice(p)}</p>
                      <p className="tnum mt-0.5 text-[0.75rem] text-lumen-3">{formatPriceCents(p)} sDAI per token</p>
                    </>
                  ) : (
                    <>
                      <p className="t-figure mt-0.5 text-[1.5rem] leading-none text-lumen-3" aria-label="Not priced">
                        —
                      </p>
                      <p className="mt-0.5 text-[0.75rem] leading-[1.35] text-lumen-3">{unknownReason(claim, l.k)}</p>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </figcaption>
      </div>
      {api?.liquidity && <p className="mt-3 text-[0.78rem] text-lumen-3">Prices at block {api.liquidity.block}. {api.liquidity.priceLabel}</p>}
    </figure>
  )
}
