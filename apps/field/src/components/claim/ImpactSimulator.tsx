'use client'

import { useState } from 'react'
import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatPrice, priceImpact } from '@pine/core'
import { useDepth } from '@pine/react'
import { Segmented, Slider, ExternalLink } from '@/components/ui/interactive'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { cn } from '@/lib/cn'

/** Log-scale mapping for the size slider: 0..100 → 1..max */
function sizeFromSlider(v: number, max: number): number {
  const lo = Math.log10(1)
  const hi = Math.log10(max)
  const raw = 10 ** (lo + (v / 100) * (hi - lo))
  const mag = raw < 10 ? 1 : raw < 100 ? 5 : raw < 1000 ? 10 : 50
  return Math.max(1, Math.round(raw / mag) * mag)
}

/**
 * Price-impact simulator: slide a trade size and see the average price, the impact in points, whether
 * the book can fill it, and where the knot would move. Estimates only; trading happens on Seer.
 */
export function ImpactSimulator({ claim }: { claim: ClaimDetail }) {
  const [outcome, setOutcome] = useState<'yes' | 'no'>('yes')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [slider, setSlider] = useState(45)
  const depthQ = useDepth(claim.id, outcome)
  const depth = depthQ.data
  const symbol = claim.collateralSymbol
  const max = Math.max(500, Math.round(Number(claim.liquidity) * 1.5) || 500)
  const amount = sizeFromSlider(slider, max)

  const res = depth ? priceImpact(depth, side, amount) : undefined
  const after = res && res.tokens > 0 ? res.worstPrice : depth?.mid
  // Show the move on the YES rope regardless of which token is traded.
  const yesNow = depth ? (outcome === 'yes' ? depth.mid : 1 - depth.mid) : claim.yesPrice
  const yesAfter = after === undefined ? undefined : outcome === 'yes' ? after : 1 - after
  const slipPts = res && depth ? Math.abs(res.avgPrice - depth.mid) * 100 : 0
  const relPct = res ? res.impact * 100 : 0

  return (
    <section aria-labelledby="impact-title" className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
      <h2 id="impact-title" className="t-h3">
        Price-impact simulator
      </h2>
      <p className="mt-1 text-[0.84rem] text-ink-2">What would a trade of this size actually do to the price?</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Segmented
          label="Side"
          size="sm"
          value={side}
          onChange={setSide}
          options={[
            { value: 'buy', label: 'Buy' },
            { value: 'sell', label: 'Sell' },
          ]}
        />
        <Segmented
          label="Outcome token"
          size="sm"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: 'yes', label: <><span aria-hidden className="hatch-yes inline-block h-2.5 w-2.5" />Yes</> },
            { value: 'no', label: <><span aria-hidden className="inline-block h-2.5 w-2.5 bg-cobalt" />No</> },
          ]}
        />
      </div>

      <div className="mt-5">
        <div className="flex items-baseline justify-between">
          <label htmlFor="impact-size" className="text-[0.84rem] font-[600]">
            Trade size
          </label>
          <span className="text-ink-2">
            <span className="t-figure text-[1.5rem] text-ink">{formatAmount(amount, { maxDecimals: 0 })}</span> {symbol}
          </span>
        </div>
        <Slider
          value={slider}
          onChange={setSlider}
          min={0}
          max={100}
          step={1}
          label="Trade size"
          valueText={`${formatAmount(amount, { maxDecimals: 0 })} ${symbol}`}
          className="mt-1"
        />
        <div className="flex justify-between text-[0.72rem] text-ink-3">
          <span>1</span>
          <span>{formatAmount(max, { compact: true, maxDecimals: 1 })}</span>
        </div>
      </div>

      <div className="mt-5" aria-live="polite">
        {depthQ.isLoading ? (
          <div className="skeleton h-24" />
        ) : !depth || !res ? (
          <p className="text-[0.88rem] text-ink-2">No depth is available for this token, so impact cannot be estimated.</p>
        ) : (
          <>
            <p className="mb-3 text-[0.78rem] text-ink-3">Where the knot would move (dashed post: now)</p>
            <TensionBar yes={yesAfter} yes24hAgo={yesNow} invalid={claim.market?.outcomes[2]?.price} />
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <dt className="text-[0.78rem] text-ink-3">Average price</dt>
                <dd className="t-figure mt-0.5 text-[1.3rem]">{formatPrice(res.avgPrice)}</dd>
              </div>
              <div>
                <dt className="text-[0.78rem] text-ink-3">Last fill moves it to</dt>
                <dd className="t-figure mt-0.5 text-[1.3rem]">{formatPrice(res.worstPrice)}</dd>
              </div>
              <div>
                <dt className="text-[0.78rem] text-ink-3">Slippage vs mid {formatPrice(depth.mid)}</dt>
                <dd className={cn('t-figure mt-0.5 text-[1.3rem]', slipPts >= 5 ? 'text-lumen-ink' : 'text-ink')}>
                  {slipPts.toFixed(1)} pts <span className="font-sans text-[0.75rem] font-[450] text-ink-3">({relPct.toFixed(0)}% relative)</span>
                </dd>
              </div>
              <div>
                <dt className="text-[0.78rem] text-ink-3">Fills</dt>
                <dd className={cn('mt-0.5 text-[0.95rem] font-[650]', res.executable ? 'text-ink' : 'text-flare-ink')}>
                  {res.executable ? 'All of it' : `Only ${formatAmount(res.filled, { maxDecimals: 0 })} ${symbol}`}
                  <span className="block text-[0.75rem] font-[450] text-ink-3">{formatAmount(res.tokens, { maxDecimals: 1 })} tokens</span>
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>

      <p className="mt-4 text-[0.78rem] leading-[1.45] text-ink-3">
        Estimate from the current depth snapshot, before swap fees. Trading happens on Seer; Pine does not place orders.{' '}
        {claim.market && <ExternalLink href={claim.market.seerUrl}>Open the market on Seer</ExternalLink>}
      </p>
    </section>
  )
}
