'use client'

import { formatUnits } from 'viem'
import type { ClaimDetail } from '@pine/core'
import { explorerAddressUrl, formatAmount, formatPriceCents } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ApiWireLiquidityView } from '@pine/data'
import { HashChip } from '@/components/ui/interactive'
import { apiDetailFactsOf, priceOf } from '@/lib/claims'
import { OUTCOME_HEX } from '@/lib/crystal'
import { cn } from '@/lib/cn'

type OutcomeView = ApiWireLiquidityView['outcomes'][number]

const NAME = { yes: 'Yes', no: 'No' } as const

function units(wei: string | null, maxDecimals = 2): string {
  if (wei === null) return '—'
  try {
    return formatAmount(formatUnits(BigInt(wei), 18), { maxDecimals })
  } catch {
    return '—'
  }
}

/** Algebra fees are in hundredths of a basis point (100 = 0.01%). */
function feeText(fee: number | null): string {
  return fee === null ? '—' : `${(fee / 10_000).toFixed(2)}%`
}

function Quotes({ o }: { o: OutcomeView }) {
  if (o.depth.length === 0) return <p className="text-[0.84375rem] text-lumen-3">No quotes: {o.reason ?? 'there is no priced pool for this outcome.'}</p>
  return (
    <table className="w-full text-left text-[0.84375rem]">
      <caption className="sr-only">Buying {NAME[o.outcome]} with 1, 10 and 100 xDAI</caption>
      <thead>
        <tr className="text-[0.75rem] text-lumen-3">
          <th scope="col" className="pb-1.5 font-normal">
            Spend
          </th>
          <th scope="col" className="pb-1.5 font-normal">
            Receive
          </th>
          <th scope="col" className="pb-1.5 text-right font-normal">
            Average price
          </th>
          <th scope="col" className="pb-1.5 text-right font-normal">
            Impact
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--edge)]">
        {o.depth.map((q) => {
          const avg = priceOf(q.averagePriceSdai)
          return (
            <tr key={q.xdaiIn} className="align-top">
              <td className="tnum py-1.5 pr-3 text-lumen">
                {units(q.xdaiIn)} xDAI
                <span className="block text-[0.75rem] text-lumen-3">{units(q.sdaiIn)} sDAI</span>
              </td>
              {q.outcomeOut === null ? (
                <td colSpan={3} className="py-1.5 text-lumen-3">
                  {q.reason ?? 'Not executable at this size'}
                </td>
              ) : (
                <>
                  <td className="tnum py-1.5 pr-3 text-lumen">
                    {units(q.outcomeOut)} {NAME[o.outcome]}
                  </td>
                  <td className="tnum py-1.5 text-right text-lumen">{avg !== undefined ? `${formatPriceCents(avg)} sDAI` : '—'}</td>
                  <td className={cn('tnum py-1.5 text-right', q.priceImpactBps !== null && q.priceImpactBps > 500 ? 'text-na' : 'text-lumen')}>
                    {q.priceImpactBps === null ? '—' : `${(q.priceImpactBps / 100).toFixed(1)}%`}
                  </td>
                </>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * The market of a backend claim: its outcome pools, marginal prices and executable quotes as Pine reads them at one
 * block. Pine does not index trades, so there is no volume, trader count or price history to show.
 */
export function ApiMarketPanel({ claim }: { claim: ClaimDetail }) {
  const api = apiDetailFactsOf(claim)
  const liq = api?.liquidity ?? null
  const chain = getChainOrDefault(claim.chainId)
  const m = claim.market
  return (
    <div className="grid gap-6">
      <div className="glass cut-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="t-h4">What a buy would get</h3>
          {liq && <p className="text-[0.78rem] text-lumen-3">Quoted at block {liq.block}</p>}
        </div>
        <p className="mt-1 max-w-[70ch] text-[0.84375rem] text-lumen-3">
          The pool’s answer to buying each outcome with 1, 10 and 100 xDAI (converted to sDAI first). Larger buys move the price; trading happens on Seer, not here.
        </p>
        {liq ? (
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            {liq.outcomes.map((o) => (
              <div key={o.outcome} className="min-w-0">
                <p className="mb-2 flex items-center gap-2 text-[0.875rem] font-semibold text-lumen">
                  <span aria-hidden className="h-[3px] w-5 rounded-full" style={{ background: OUTCOME_HEX[o.outcome] }} />
                  {NAME[o.outcome]}
                </p>
                <Quotes o={o} />
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-[0.9rem] text-lumen-3">Pine could not read the pools right now. Try again in a moment.</p>
        )}
      </div>

      <div className="glass cut-xl p-5 sm:p-6">
        <h3 className="t-h4">Pools</h3>
        {liq ? (
          <ul className="mt-3 grid gap-3">
            {liq.outcomes.map((o) => {
              const sdai = priceOf(o.priceSdai)
              const xdai = priceOf(o.priceXdai)
              return (
                <li key={o.outcome} className="cut-sm grid gap-2 border border-edge bg-void px-3 py-2.5 text-[0.84375rem] sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-center">
                  <span className="font-semibold text-lumen">{NAME[o.outcome]} pool</span>
                  {o.pool ? (
                    <HashChip value={o.pool} name={`${NAME[o.outcome]} pool address`} href={explorerAddressUrl(claim.chainId, o.pool)} className="w-fit max-w-full" />
                  ) : (
                    <span className="text-lumen-3">{o.reason ?? 'No pool yet'}</span>
                  )}
                  <span className="tnum text-lumen-2 sm:text-right">
                    {sdai !== undefined ? `${formatPriceCents(sdai)} sDAI` : 'not priced'}
                    {xdai !== undefined && <span className="text-lumen-3"> ({formatPriceCents(xdai)} xDAI)</span>}
                    {o.pool && <span className="block text-[0.75rem] text-lumen-3">fee {feeText(o.fee)}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="mt-3 text-[0.9rem] text-lumen-3">Pool facts are unavailable right now.</p>
        )}
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.78rem] text-lumen-3">Collateral</dt>
            <dd className="mt-0.5 text-[0.9375rem] text-lumen">{m?.collateral.symbol ?? claim.collateralSymbol}</dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.78rem] text-lumen-3">1 sDAI in xDAI</dt>
            <dd className="tnum mt-0.5 text-[0.9375rem] text-lumen">{liq ? formatAmount(liq.sdaiToXdai, { maxDecimals: 4 }) : '—'}</dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.78rem] text-lumen-3">Chain</dt>
            <dd className="mt-0.5 text-[0.9375rem] text-lumen">{chain.name}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[0.78rem] text-lumen-3">Pine does not index trades yet, so liquidity totals, volume, trader counts and price history are not shown. {COPY.volumeCaveat}</p>
        {liq && liq.notes.length > 0 && (
          <ul className="mt-3 grid gap-1 text-[0.78rem] text-lumen-3">
            {liq.notes.map((n, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rotate-45 bg-lumen-3" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{n}</span>
              </li>
            ))}
          </ul>
        )}
        {m && (
          <p className="mt-4 text-[0.84375rem] text-lumen-3">
            Trading happens on Seer.{' '}
            <a href={m.seerUrl} target="_blank" rel="noopener noreferrer nofollow" className="link text-lumen-2">
              Open this market on Seer
            </a>
            . {COPY.deadlineIsNotTradingCutoff}
          </p>
        )}
      </div>
    </div>
  )
}
