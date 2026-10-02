'use client'

import * as React from 'react'
import type { ClaimDetail, PriceRange } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { explorerAddressUrl, formatAmount, formatPrice, priceImpact, shortHash } from '@pine/core'
import { useDepth, usePriceHistory } from '@pine/react'
import { cn } from '@/lib/cn'
import { Callout } from '@/components/ui/callout'
import { EmptyState } from '@/components/ui/empty-state'
import { ExternalLink } from '@/components/ui/external-link'
import { Input, Segmented } from '@/components/ui/field'
import { Pane } from '@/components/ui/pane'
import { Skeleton } from '@/components/ui/skeleton'
import { DepthChart, PriceChart } from './charts'

export function MarketTab({ claim }: { claim: ClaimDetail }) {
  const [range, setRange] = React.useState<PriceRange>('7d')
  const [outcome, setOutcome] = React.useState<'yes' | 'no'>('yes')
  const history = usePriceHistory(claim.id, range)
  const depth = useDepth(claim.id, outcome)
  const m = claim.market

  if (!m) {
    return (
      <EmptyState title="No market exists for this claim yet">
        {claim.status === 'publishing'
          ? 'Publishing stopped before the market was created. Finish publishing to create it.'
          : 'The market was never created, so there is no price or depth to show.'}
      </EmptyState>
    )
  }

  const sym = m.collateral.symbol
  return (
    <div className="divide-y divide-line">
      <section className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4" aria-label="Outcome prices">
        {m.outcomes.map((o) => {
          const tone = o.index === 0 ? 'yes' : o.index === 1 ? 'no' : 'invalid'
          return (
            <div key={o.index} className="bg-surface px-4 py-3">
              <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <span
                  aria-hidden
                  className={cn(
                    'size-2.5 rounded-[2px]',
                    tone === 'yes' && 'bg-flare',
                    tone === 'no' && 'border-[1.6px] border-slate',
                    tone === 'invalid' && 'border-[1.6px] border-violet',
                  )}
                />
                {o.label}
              </p>
              <p className="tnum mt-0.5 text-2xl font-semibold leading-tight">{formatPrice(o.price)}</p>
              <p className="tnum text-xs text-muted">
                {o.price.toFixed(3)} {sym} per token
                {typeof o.change24h === 'number' && Math.abs(o.change24h) >= 0.001 ? (
                  <span className="ml-1.5">
                    {o.change24h > 0 ? '+' : '−'}
                    {(Math.abs(o.change24h) * 100).toFixed(1)} pts 24h
                  </span>
                ) : null}
              </p>
            </div>
          )
        })}
        <div className="bg-surface px-4 py-3">
          <p className="text-[12.5px] text-muted">Liquidity</p>
          <p className="tnum mt-0.5 text-2xl font-semibold leading-tight">{formatAmount(m.liquidity, { compact: true })}</p>
          <p className="text-xs text-muted">{sym} across {m.pools.length} pools</p>
        </div>
      </section>

      <Pane
        title="YES price"
        description={COPY.priceLabel}
        actions={
          <Segmented
            label="Range"
            value={range}
            onChange={setRange}
            size="xs"
            options={(['24h', '7d', '30d', 'all'] as const).map((r) => ({ value: r, label: r }))}
          />
        }
        className="border-0"
      >
        <div className="px-2 py-3 sm:px-4">
          {history.isLoading ? (
            <Skeleton className="h-[240px] w-full" />
          ) : history.data && history.data.length > 1 ? (
            <div className={cn(history.isFetching && 'opacity-60 transition-opacity')}>
              <PriceChart points={history.data} deadline={claim.evidenceDeadline} />
            </div>
          ) : (
            <p className="px-2 py-16 text-center text-sm text-muted">No trades in this range yet.</p>
          )}
          <p className="mt-2 px-2 text-xs text-muted">{COPY.priceCaveat}</p>
        </div>
      </Pane>

      <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:divide-x lg:divide-line">
        <Pane
          title="Executable depth"
          className="border-0"
          actions={
            <Segmented
              label="Outcome"
              value={outcome}
              onChange={setOutcome}
              size="xs"
              options={[
                { value: 'yes', label: 'Yes pool' },
                { value: 'no', label: 'No pool' },
              ]}
            />
          }
        >
          <div className="px-2 py-3 sm:px-4">
            {depth.isLoading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : depth.data ? (
              <DepthChart depth={depth.data} />
            ) : (
              <p className="py-16 text-center text-sm text-muted">No depth data for this pool.</p>
            )}
          </div>
        </Pane>
        <Pane title="Price impact" className="border-0 border-t border-line lg:border-t-0" description="Walks the book before you trade">
          {depth.data ? <ImpactCalculator depth={depth.data} symbol={sym} outcome={outcome} /> : <Skeleton className="m-4 h-40" />}
        </Pane>
      </div>

      <section className="grid grid-cols-1 gap-6 px-4 py-5 sm:px-6 lg:grid-cols-2" aria-label="Market details">
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">Activity</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted">Volume 24h</dt>
            <dd className="tnum text-right">{formatAmount(m.volume24h, { symbol: sym })}</dd>
            <dt className="text-muted">Volume total</dt>
            <dd className="tnum text-right">{formatAmount(m.volumeTotal, { symbol: sym })}</dd>
            <dt className="text-muted">Traders</dt>
            <dd className="tnum text-right">{m.traders}</dd>
            <dt className="text-muted">Open interest</dt>
            <dd className="tnum text-right">{formatAmount(m.openInterest, { symbol: sym })}</dd>
          </dl>
          <p className="mt-2 text-xs text-muted">{COPY.volumeCaveat}</p>
        </div>
        <div>
          <h3 className="mb-2 text-[15px] font-semibold">Pools</h3>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="stretch-cond border-b border-line text-left text-[12px] text-muted">
                <th className="py-1.5 font-medium">Pool</th>
                <th className="py-1.5 font-medium">Venue</th>
                <th className="py-1.5 text-right font-medium">TVL</th>
                <th className="py-1.5 text-right font-medium">Fee</th>
              </tr>
            </thead>
            <tbody>
              {m.pools.map((p) => (
                <tr key={p.address} className="border-b border-line last:border-0">
                  <td className="py-1.5">
                    <ExternalLink href={explorerAddressUrl(m.chainId, p.address)} className="mono-cond text-[11.5px]">
                      {p.outcome.toUpperCase()} {shortHash(p.address)}
                    </ExternalLink>
                  </td>
                  <td className="py-1.5 text-muted">{p.dex}</td>
                  <td className="tnum py-1.5 text-right">{formatAmount(p.tvl, { compact: true })}</td>
                  <td className="tnum py-1.5 text-right">{(p.feeBps / 100).toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[13px]">
            <ExternalLink href={m.seerUrl}>Trade on Seer</ExternalLink>
          </p>
        </div>
      </section>
      <div className="space-y-2 px-4 py-4 sm:px-6">
        <Callout tone="info">{COPY.deadlineIsNotTradingCutoff}</Callout>
        <Callout tone="info">{COPY.liquidityIsNotBounty}</Callout>
      </div>
    </div>
  )
}

function ImpactCalculator({ depth, symbol, outcome }: { depth: NonNullable<ReturnType<typeof useDepth>['data']>; symbol: string; outcome: 'yes' | 'no' }) {
  const [side, setSide] = React.useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = React.useState('25')
  const n = Number(amount)
  const valid = amount.trim() !== '' && Number.isFinite(n) && n > 0
  const r = valid ? priceImpact(depth, side, n) : undefined
  const id = React.useId()
  return (
    <div className="space-y-4 px-4 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <Segmented
          label="Side"
          value={side}
          onChange={setSide}
          options={[
            { value: 'buy', label: `Buy ${outcome.toUpperCase()}` },
            { value: 'sell', label: `Sell ${outcome.toUpperCase()}` },
          ]}
        />
        <div className="min-w-[140px] flex-1">
          <label htmlFor={id} className="stretch-cond mb-1 block text-[12.5px] text-muted">
            Amount ({symbol})
          </label>
          <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!valid && amount !== ''} className="tnum" />
        </div>
      </div>
      {r ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted">Mid price</dt>
          <dd className="tnum text-right">{formatPrice(depth.mid)}</dd>
          <dt className="text-muted">Average fill</dt>
          <dd className="tnum text-right font-semibold">{formatPrice(r.avgPrice)}</dd>
          <dt className="text-muted">Worst level touched</dt>
          <dd className="tnum text-right">{formatPrice(r.worstPrice)}</dd>
          <dt className="text-muted">Price impact</dt>
          <dd className={cn('tnum text-right font-semibold', r.impact > 0.05 && 'text-resin')}>{(r.impact * 100).toFixed(2)}%</dd>
          <dt className="text-muted">Tokens received</dt>
          <dd className="tnum text-right">{r.tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })}</dd>
          <dt className="text-muted">Executable now</dt>
          <dd className="text-right">
            {r.executable ? (
              'Fully'
            ) : (
              <span className="text-flare">
                Only {formatAmount(String(r.filled.toFixed(4)), { symbol })} fills
              </span>
            )}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted">Enter an amount above zero to estimate a fill.</p>
      )}
      <p className="text-xs leading-[1.45] text-muted">
        Estimate from the indexed depth snapshot, before pool fees and slippage protection. Your wallet and the DEX show the final amount.
      </p>
    </div>
  )
}
