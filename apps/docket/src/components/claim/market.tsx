'use client'

import { useId, useState } from 'react'
import type { ClaimDetail, DepthSnapshot, PriceRange } from '@pine/core'
import { formatAmount, formatPrice, formatPriceCents, priceImpact, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useDepth, usePriceHistory } from '@pine/react'
import { cn } from '@/lib/cn'
import { ExternalLink } from '@/components/ui/external-link'
import { Input, Select } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'
import { PriceChart } from './price-chart'

const RANGES: { id: PriceRange; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
]

export function MarketSection({ claim }: { claim: ClaimDetail }) {
  const [range, setRange] = useState<PriceRange>('7d')
  const history = usePriceHistory(claim.market ? claim.id : undefined, range)
  const m = claim.market
  if (!m) {
    return (
      <p className="measure text-graphite">
        {claim.status === 'failed'
          ? 'No market was created, so there is no price and nothing to trade.'
          : 'No market exists yet, so there is no price. The market is created during filing, and its terms freeze at that moment.'}
      </p>
    )
  }
  if (claim.status === 'publishing' || claim.status === 'failed') {
    return (
      <p className="measure text-graphite">
        The market contract exists, but funding did not finish, so its pools hold little or no liquidity. Any price shown elsewhere would not
        mean anything yet. Once filing finishes, prices, depth and price impact appear here.
      </p>
    )
  }
  const yes = m.outcomes.find((o) => o.label.toLowerCase().startsWith('yes')) ?? m.outcomes[0]
  const change = yes?.change24h
  const sym = m.collateral.symbol
  const decided = claim.status === 'resolved' || claim.status === 'settled'

  return (
    <div className="space-y-8">
      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0">
          <p className="text-[15px] font-bold text-graphite">{decided ? 'Last Yes price, after the question was decided' : COPY.priceLabel}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-[3.25rem] leading-none font-[800] tracking-[-0.03em]">{yes ? formatPrice(yes.price) : '—'}</span>
            {decided ? (
              <span className="text-[15px] text-graphite measure">
                The outcome is final, so this price now tracks what a Yes token pays out. It is no longer a market-implied chance.
              </span>
            ) : typeof change === 'number' ? (
              <span className="text-[15px] text-graphite">
                {change === 0 ? 'Unchanged' : `${change > 0 ? 'Up' : 'Down'} ${Math.abs(change * 100).toFixed(1)} points`} in 24 hours
              </span>
            ) : null}
          </p>
          <div className="mt-6 print:hidden">
            <div role="group" aria-label="Chart range" className="mb-3 inline-flex border border-rule-strong bg-sheet print:hidden">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={range === r.id}
                  onClick={() => setRange(r.id)}
                  className={cn(
                    'border-r border-rule px-3 py-1.5 text-sm font-bold last:border-r-0',
                    range === r.id ? 'bg-ink text-white' : 'hover:bg-bond',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {history.isLoading ? (
              <Skeleton className="h-56 w-full sm:h-64" />
            ) : history.data && history.data.length > 1 ? (
              <PriceChart points={history.data} deadline={claim.evidenceDeadline} />
            ) : (
              <p className="flex h-40 items-center justify-center border border-dashed border-rule-strong text-graphite">
                Not enough trades in this range to draw a line.
              </p>
            )}
          </div>
        </div>
        <aside className="space-y-5">
          <MarginNote title="Reading this number">
            <p>{COPY.priceCaveat}</p>
          </MarginNote>
          <MarginNote title="Trading after the deadline">
            <p>{COPY.deadlineIsNotTradingCutoff}</p>
          </MarginNote>
        </aside>
      </div>

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem] print:hidden">
        <ImpactCalculator claimId={claim.id} symbol={sym} />
        <aside>
          <MarginNote title="Why depth matters">
            <p>
              The headline price is the last or mid price. A larger trade walks through the order book, so the average price you
              would get is worse. A price is only as informative as the money behind it.
            </p>
          </MarginNote>
        </aside>
      </div>

      <div>
        <h3 className="text-xl">Activity in this market</h3>
        <dl className="mt-3 grid grid-cols-2 border-t border-l border-rule bg-sheet sm:grid-cols-3 lg:grid-cols-5">
          {[
            { k: 'Liquidity in pools', v: formatAmount(m.liquidity, { symbol: sym, compact: true }) },
            { k: 'Volume, 24 hours', v: formatAmount(m.volume24h, { symbol: sym, compact: true }) },
            { k: 'Volume, all time', v: formatAmount(m.volumeTotal, { symbol: sym, compact: true }) },
            { k: 'Traders', v: m.traders.toLocaleString('en-US') },
            { k: 'Open interest', v: formatAmount(m.openInterest, { symbol: sym, compact: true }) },
          ].map((s) => (
            <div key={s.k} className="border-r border-b border-rule px-4 py-3">
              <dt className="text-sm text-graphite">{s.k}</dt>
              <dd className="mt-0.5 text-lg font-bold">{s.v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm text-graphite measure">{COPY.volumeCaveat}</p>
      </div>

      <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div>
          <h3 className="text-xl">Pools and contracts</h3>
          <ul className="mt-3 divide-y divide-rule border-y border-rule text-[15px]">
            {m.pools.map((p) => (
              <li key={p.address} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
                <span>
                  <strong>{p.outcome === 'yes' ? 'Yes' : 'No'} pool</strong> on {p.dex}, fee tier {(p.feeBps / 100).toFixed(2)}%
                </span>
                <span className="text-graphite">
                  holds {formatAmount(p.tvl, { symbol: sym, compact: true })}{' '}
                  <code className="ml-1 font-mono text-[13px]">{shortHash(p.address, 4)}</code>
                </span>
              </li>
            ))}
            <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
              <span>
                <strong>Market contract</strong> on Seer
              </span>
              <span className="flex items-center gap-3">
                <code className="font-mono text-[13px]">{shortHash(m.address, 4)}</code>
                <ExternalLink href={m.seerUrl}>Trade on Seer</ExternalLink>
              </span>
            </li>
          </ul>
        </div>
        <aside className="lg:pt-10">
          <MarginNote title="Liquidity is not a bounty">
            <p>{COPY.liquidityIsNotBounty}</p>
          </MarginNote>
        </aside>
      </div>
    </div>
  )
}

function ImpactCalculator({ claimId, symbol }: { claimId: string; symbol: string }) {
  const [outcome, setOutcome] = useState<'yes' | 'no'>('yes')
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('25')
  const depth = useDepth(claimId, outcome)
  const id = useId()
  const n = Number(amount)
  const valid = Number.isFinite(n) && n > 0
  const result = depth.data && valid ? safeImpact(depth.data, side, n) : null

  return (
    <div className="min-w-0">
      <h3 className="text-xl">What would a trade actually cost?</h3>
      <p className="mt-1 text-[15px] text-graphite">Estimate price impact against the current order book. Nothing is traded here.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="text-sm font-bold">Outcome</span>
          <Select className="mt-1" value={outcome} onChange={(e) => setOutcome(e.target.value as 'yes' | 'no')}>
            <option value="yes">Yes tokens</option>
            <option value="no">No tokens</option>
          </Select>
        </label>
        <label className="block">
          <span className="text-sm font-bold">Direction</span>
          <Select className="mt-1" value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </Select>
        </label>
        <label className="block" htmlFor={`${id}-amt`}>
          <span className="text-sm font-bold">Amount in {symbol}</span>
          <Input
            id={`${id}-amt`}
            inputMode="decimal"
            className="mt-1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!valid}
          />
        </label>
      </div>
      <div className="mt-4 border border-rule bg-sheet px-4 py-3" aria-live="polite">
        {depth.isLoading ? (
          <Skeleton className="h-5 w-2/3" />
        ) : !depth.data ? (
          <p className="text-graphite">No order book is available for this outcome.</p>
        ) : !valid ? (
          <p className="text-red">Enter an amount greater than zero, like 25.</p>
        ) : result ? (
          <>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-graphite">Average price</dt>
              <dd className="text-lg font-bold">{formatPriceCents(result.avgPrice)} {symbol}</dd>
            </div>
            <div>
              <dt className="text-sm text-graphite">Price impact</dt>
              <dd className={cn('text-lg font-bold', result.impact > 0.05 && 'text-red')}>{(result.impact * 100).toFixed(1)}%</dd>
            </div>
            <div>
              <dt className="text-sm text-graphite">Fillable at current depth</dt>
              <dd className="text-lg font-bold">
                {result.executable ? 'All of it' : `${formatAmount(String(result.filled), { maxDecimals: 2 })} ${symbol}`}
              </dd>
            </div>
          </dl>
          {!result.executable ? (
            <p className="mt-2 text-sm text-ochre">
              The book is too thin to fill the whole amount. The rest would need new liquidity or counterparties.
            </p>
          ) : null}
          </>
        ) : (
          <p className="text-graphite">Could not estimate impact for this amount.</p>
        )}
      </div>
      {depth.data ? <DepthTable depth={depth.data} /> : null}
    </div>
  )
}

function safeImpact(depth: DepthSnapshot, side: 'buy' | 'sell', amount: number) {
  try {
    return priceImpact(depth, side, amount)
  } catch {
    return null
  }
}

function DepthTable({ depth }: { depth: DepthSnapshot }) {
  const asks = depth.levels.filter((l) => l.side === 'ask').slice(0, 6)
  const bids = depth.levels.filter((l) => l.side === 'bid').slice(0, 6)
  const max = Math.max(1, ...depth.levels.map((l) => l.size))
  return (
    <details className="mt-3">
      <summary className="text-sm font-bold text-violet underline underline-offset-4">Show order book depth</summary>
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {[
          { title: 'Sellers (asks)', rows: asks },
          { title: 'Buyers (bids)', rows: bids },
        ].map((side) => (
          <table key={side.title} className="w-full text-left text-sm">
            <caption className="pb-1 text-left font-bold">{side.title}</caption>
            <thead className="text-graphite">
              <tr>
                <th scope="col" className="py-1">Price</th>
                <th scope="col" className="py-1 text-right">Cumulative tokens</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {side.rows.map((l, i) => (
                <tr key={i} className="relative">
                  <td className="py-1">{formatPriceCents(l.price)}</td>
                  <td className="relative py-1 text-right">
                    <span
                      aria-hidden
                      className={cn('absolute inset-y-1 right-0', l.side === 'ask' ? 'bg-mist' : 'bg-violet-wash')}
                      style={{ width: `${(l.size / max) * 100}%` }}
                    />
                    <span className="relative">{formatAmount(String(l.size), { maxDecimals: 1 })}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </details>
  )
}
