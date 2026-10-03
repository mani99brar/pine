'use client'

import { useMemo, useState } from 'react'
import { useDepth } from '@pine/react'
import type { DepthSnapshot } from '@pine/core'
import { formatAmount, formatPrice, formatPriceCents, priceImpact } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Segmented } from '@/components/ui/interactive'
import { ErrorState, Skeleton } from '@/components/ui/primitives'
import { useElementWidth } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const BID = '#5AD8FF'
const ASK = '#FFB648'

function DepthSvg({ depth, width }: { depth: DepthSnapshot; width: number }) {
  const H = 200
  const pad = { l: 44, r: 12, t: 10, b: 26 }
  const bids = depth.levels.filter((l) => l.side === 'bid').sort((a, b) => b.price - a.price)
  const asks = depth.levels.filter((l) => l.side === 'ask').sort((a, b) => a.price - b.price)
  const maxSize = Math.max(1, ...depth.levels.map((l) => l.size))
  const lo = Math.max(0, Math.min(depth.mid - 0.2, ...bids.map((b) => b.price)))
  const hi = Math.min(1, Math.max(depth.mid + 0.2, ...asks.map((a) => a.price)))
  const iw = width - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const x = (p: number) => pad.l + ((p - lo) / Math.max(0.0001, hi - lo)) * iw
  const y = (s: number) => pad.t + (1 - s / maxSize) * ih
  const step = (levels: typeof bids, dir: 1 | -1) => {
    if (!levels.length) return ''
    let d = `M${x(depth.mid)},${y(0)}`
    let prev = 0
    for (const l of levels) {
      d += ` L${x(l.price)},${y(prev)} L${x(l.price)},${y(l.size)}`
      prev = l.size
    }
    d += ` L${x(dir === 1 ? hi : lo)},${y(prev)} L${x(dir === 1 ? hi : lo)},${y(0)} Z`
    return d
  }
  return (
    <svg width={width} height={H} aria-hidden className="block">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={width - pad.r} y1={y(maxSize * t)} y2={y(maxSize * t)} stroke="#F5EDE4" strokeOpacity={t === 0 ? 0.16 : 0.06} />
          <text x={pad.l - 8} y={y(maxSize * t) + 4} textAnchor="end" fill="#A69789" fontSize="11" className="tnum">
            {formatAmount(maxSize * t, { compact: true, maxDecimals: 0 })}
          </text>
        </g>
      ))}
      <path d={step(bids, -1)} fill={BID} fillOpacity="0.16" stroke={BID} strokeOpacity="0.8" strokeWidth="1.4" />
      <path d={step(asks, 1)} fill={ASK} fillOpacity="0.14" stroke={ASK} strokeOpacity="0.8" strokeWidth="1.4" />
      <line x1={x(depth.mid)} x2={x(depth.mid)} y1={pad.t} y2={H - pad.b} stroke="#fff" strokeOpacity="0.8" />
      <text x={x(depth.mid)} y={H - 8} textAnchor="middle" fill="#F5EDE4" fontSize="11" className="tnum">
        mid {formatPriceCents(depth.mid)}
      </text>
      <text x={pad.l} y={H - 8} fill="#A69789" fontSize="11" className="tnum">
        {formatPriceCents(lo)}
      </text>
      <text x={width - pad.r} y={H - 8} fill="#A69789" fontSize="11" textAnchor="end" className="tnum">
        {formatPriceCents(hi)}
      </text>
    </svg>
  )
}

/** Executable depth for one outcome, plus a price-impact calculator walking the same book. */
export function DepthAndImpact({ claimId, collateral }: { claimId: string; collateral: string }) {
  const [outcome, setOutcome] = useState<'yes' | 'no'>('yes')
  const q = useDepth(claimId, outcome)
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('10')
  const amt = Number(amount.replace(',', '.'))
  const impact = useMemo(() => (q.data && Number.isFinite(amt) ? priceImpact(q.data, side, amt) : null), [q.data, side, amt])
  const valid = Number.isFinite(amt) && amt > 0

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="t-h4">Depth</h3>
          <Segmented
            label="Depth outcome"
            size="sm"
            value={outcome}
            onChange={setOutcome}
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
          />
        </div>
        <div ref={ref} className="h-[200px] w-full" role="img" aria-label={q.data ? `Depth for ${outcome}: mid price ${formatPriceCents(q.data.mid)} ${collateral} per token.` : 'Depth'}>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : q.isLoading || width === 0 ? (
            <Skeleton className="h-full w-full" />
          ) : q.data && q.data.levels.length ? (
            <DepthSvg depth={q.data} width={width} />
          ) : (
            <p className="pt-10 text-center text-[0.9rem] text-lumen-3">No resting liquidity for this outcome.</p>
          )}
        </div>
        <div className="mt-2 flex gap-4 text-[0.78rem] text-lumen-3">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-sm" style={{ background: BID }} /> bids (sell into)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-3 rounded-sm" style={{ background: ASK }} /> asks (buy from)
          </span>
        </div>
      </div>

      <div className="cut-lg well p-4 sm:p-5">
        <h3 className="t-h4">Price impact</h3>
        <p className="mt-1 text-[0.84375rem] text-lumen-3">What a trade of this size would actually pay, walking the {outcome === 'yes' ? 'Yes' : 'No'} book.</p>
        <div className="mt-4 grid gap-3">
          <Segmented
            label="Trade side"
            size="sm"
            value={side}
            onChange={setSide}
            options={[
              { value: 'buy', label: `Buy ${outcome === 'yes' ? 'Yes' : 'No'}` },
              { value: 'sell', label: `Sell ${outcome === 'yes' ? 'Yes' : 'No'}` },
            ]}
          />
          <div>
            <label htmlFor="impact-amount" className="label">
              Amount in {collateral}
            </label>
            <input id="impact-amount" className="field tnum" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid && amount !== ''} />
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[0.78rem] text-lumen-3">Average price</dt>
            <dd className="t-figure text-[1.5rem] text-lumen">{impact && valid ? formatPriceCents(impact.avgPrice) : '—'}</dd>
          </div>
          <div>
            <dt className="text-[0.78rem] text-lumen-3">Impact vs mid</dt>
            <dd className={cn('t-figure text-[1.5rem]', impact && impact.impact > 0.05 ? 'text-na' : 'text-lumen')}>{impact && valid ? `${(impact.impact * 100).toFixed(1)}%` : '—'}</dd>
          </div>
          <div>
            <dt className="text-[0.78rem] text-lumen-3">Fills</dt>
            <dd className="tnum text-[0.96875rem] text-lumen">
              {impact && valid ? `${formatAmount(impact.filled, { maxDecimals: 2 })} of ${formatAmount(amt, { maxDecimals: 2 })} ${collateral}` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[0.78rem] text-lumen-3">Tokens</dt>
            <dd className="tnum text-[0.96875rem] text-lumen">{impact && valid ? formatAmount(impact.tokens, { maxDecimals: 2 }) : '—'}</dd>
          </div>
        </dl>
        {impact && valid && !impact.executable && (
          <p className="mt-3 text-[0.84375rem] text-na" role="status">
            Not enough depth: only part of this trade would execute at any price.
          </p>
        )}
        <p className="mt-3 text-[0.78rem] text-lumen-3">
          Estimates from indexed depth. Trading happens on Seer, not here.
          {outcome === 'yes' && q.data ? ` ${COPY.priceLabel} at mid: ${formatPrice(q.data.mid)}.` : ''}
        </p>
      </div>
    </div>
  )
}
