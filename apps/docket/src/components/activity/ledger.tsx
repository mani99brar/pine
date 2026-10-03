'use client'

import { useMemo, useState } from 'react'
import type { ActivityItem, ActivityType, Portfolio } from '@pine/core'
import { explorerTxUrl, formatAmount, formatClaimNumber, formatDate, fromScaled, shortHash, toScaled } from '@pine/core'
import { useActivity, usePortfolio, useWallet } from '@pine/react'
import { Wallet } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/field'
import { ExternalLink } from '@/components/ui/external-link'
import { EmptyState, Skeleton } from '@/components/ui/layout'
import { MarginNote } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { activityLabel } from '@/components/claim/record'

const GROUPS: { id: string; label: string; types: ActivityType[] }[] = [
  { id: '', label: 'All entries', types: [] },
  { id: 'funding', label: 'Deposits and withdrawals', types: ['liquidity_added', 'liquidity_removed', 'split', 'merge', 'approval'] },
  { id: 'trades', label: 'Trades', types: ['trade'] },
  { id: 'redeem', label: 'Redemptions', types: ['redeemed'] },
  { id: 'filing', label: 'Filing and exhibits', types: ['market_created', 'manifest_pinned', 'evidence_submitted'] },
  { id: 'oracle', label: 'Oracle and arbitration', types: ['answer_posted', 'arbitration_requested', 'ruling', 'finalized'] },
]

const S = 18
const add = (...v: (string | undefined)[]) => v.reduce((acc, x) => acc + (x ? (toScaled(x, S)?.value ?? 0n) : 0n), 0n)

function Reconciliation({ p, sym }: { p: Portfolio; sym: string }) {
  const t = p.totals
  const stillHeld = add(t.positionsValue, t.liquidityValue)
  const out = add(t.withdrawnAllTime, t.redeemable)
  const inn = add(t.depositedAllTime)
  const fees = add(t.feesPaidAllTime)
  const net = out + stillHeld - inn - fees
  const fmt = (v: bigint | string) => formatAmount(typeof v === 'string' ? v : fromScaled(v, S), { symbol: sym, maxDecimals: 2 })
  const rows = [
    { k: 'Deposited, all time', v: fmt(t.depositedAllTime), sign: '' , note: 'Liquidity and collateral you put in.' },
    { k: 'Fees and gas paid', v: fmt(t.feesPaidAllTime), sign: '−', note: 'Gone in any outcome.' },
    { k: 'Withdrawn, all time', v: fmt(t.withdrawnAllTime), sign: '+', note: 'Liquidity removed and tokens sold or merged.' },
    { k: 'Ready to redeem now', v: fmt(t.redeemable), sign: '+', note: 'Winning tokens in resolved markets.' },
    { k: 'Still held, at current prices', v: fmt(stillHeld), sign: '+', note: 'Outcome tokens and liquidity positions, marked to market.' },
  ]
  return (
    <div className="border border-rule bg-sheet">
      <h2 className="border-b border-rule px-5 py-3 text-xl">Reconciliation</h2>
      <dl className="divide-y divide-rule px-5">
        {rows.map((r) => (
          <div key={r.k} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
            <dt>
              <span className="font-bold">{r.k}</span>
              <span className="block text-sm text-graphite">{r.note}</span>
            </dt>
            <dd className="text-lg font-bold tabular">
              <span className="mr-1 text-graphite">{r.sign}</span>
              {r.v}
            </dd>
          </div>
        ))}
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-t-2 border-ink py-3">
          <dt>
            <span className="font-bold">Net result so far</span>
            <span className="block text-sm text-graphite">Withdrawn + redeemable + still held − deposited − fees</span>
          </dt>
          <dd className={cn('text-xl font-[800] tabular', net < 0n && 'text-red')}>
            {net < 0n ? '−' : net > 0n ? '+' : ''}
            {fmt(net < 0n ? -net : net)}
          </dd>
        </div>
      </dl>
      <p className="border-t border-rule px-5 py-3 text-sm text-graphite">
        Values still held move with the market. Only redeemed or withdrawn amounts are settled.
      </p>
    </div>
  )
}

export function Ledger() {
  const wallet = useWallet()
  const [group, setGroup] = useState('')
  const types = GROUPS.find((g) => g.id === group)?.types
  const activity = useActivity({ account: wallet.address, types: types && types.length ? types : undefined, limit: 200 })
  const portfolio = usePortfolio(wallet.address)
  const items = useMemo(() => activity.data?.items ?? [], [activity.data])
  const sym = items.find((i) => i.token)?.token ?? 'sDAI'

  const withBalance = useMemo(() => {
    const asc = [...items].sort((a, b) => a.at.localeCompare(b.at))
    let run = 0n
    const map = new Map<string, bigint>()
    for (const a of asc) {
      if (a.amount && (!a.token || a.token === sym)) run += toScaled(a.amount, S)?.value ?? 0n
      map.set(a.id, run)
    }
    return map
  }, [items, sym])

  return (
    <div className="space-y-10">
      {!wallet.isConnected ? (
        <Notice
          tone="info"
          title="Showing recent activity across all claims"
          action={
            <Button size="sm" icon={<Wallet aria-hidden />} onClick={() => wallet.connect()}>
              Connect wallet
            </Button>
          }
        >
          Connect a wallet to see your own ledger and a reconciliation of everything you deposited, paid, withdrew and can redeem.
        </Notice>
      ) : null}

      {wallet.isConnected ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
          {portfolio.isLoading ? <Skeleton className="h-72 w-full" /> : portfolio.data ? <Reconciliation p={portfolio.data} sym={sym} /> : null}
          <aside className="space-y-6">
            <MarginNote title="Reading the ledger">
              <p>Amounts are signed from your side: + is collateral coming to you, − is collateral leaving you.</p>
              <p>The running balance adds up those flows from your first entry. It does not include the market value of what you still hold.</p>
            </MarginNote>
          </aside>
        </div>
      ) : null}

      <section aria-labelledby="entries">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="entries" className="text-2xl">
            Entries
          </h2>
          <label className="flex items-center gap-2 text-sm font-bold">
            Show
            <Select className="h-10 w-64" value={group} onChange={(e) => setGroup(e.target.value)}>
              {GROUPS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {activity.isLoading ? (
          <Skeleton className="mt-4 h-64 w-full" />
        ) : activity.isError ? (
          <Notice tone="critical" className="mt-4" title="The ledger could not be loaded" action={<button className="link" onClick={() => void activity.refetch()}>Try again</button>}>
            {(activity.error as Error).message}
          </Notice>
        ) : items.length === 0 ? (
          <EmptyState className="mt-4" title="No entries">
            {wallet.isConnected ? 'Nothing recorded for this wallet in this category.' : 'No activity yet.'}
          </EmptyState>
        ) : (
          <>
          {/* Phones: each entry as a ruled row, amount beside the label, so nothing hides off-screen. */}
          <ol className="mt-4 divide-y divide-rule border-y border-rule bg-sheet sm:hidden" aria-label="Ledger entries, newest first">
            {items.map((a: ActivityItem) => {
              const n = a.amount ? Number(a.amount) : 0
              const bal = withBalance.get(a.id) ?? 0n
              return (
                <li key={a.id} className={cn('px-4 py-3', a.status === 'failed' && 'bg-red-wash')}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-bold">{activityLabel(a.type)}</span>
                    {a.amount ? (
                      <span className={cn('shrink-0 font-bold whitespace-nowrap tabular', n < 0 ? 'text-ink' : 'text-violet')}>
                        {n > 0 ? '+' : n < 0 ? '−' : ''}
                        {formatAmount(a.amount.replace(/^-/, ''), { symbol: a.token, maxDecimals: 4 })}
                      </span>
                    ) : null}
                  </div>
                  <p className="untrusted text-sm text-graphite">{a.summary}</p>
                  {a.status === 'failed' ? <p className="text-sm font-bold text-red">Failed, nothing moved</p> : a.status === 'pending' ? <p className="text-sm font-bold text-ochre">Pending</p> : null}
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-graphite">
                    <span className="tabular">{formatDate(a.at, 'utc')}</span>
                    <a href={`/claims/${a.claimId}`} className="link tabular">
                      {formatClaimNumber(a.claimNumber)}
                    </a>
                    <ExternalLink href={explorerTxUrl(a.chainId, a.txHash)} icon={false}>
                      {shortHash(a.txHash, 4)}
                    </ExternalLink>
                    {wallet.isConnected ? (
                      <span className="tabular">
                        Balance {bal < 0n ? '−' : ''}
                        {formatAmount(fromScaled(bal < 0n ? -bal : bal, S), { maxDecimals: 2 })}
                      </span>
                    ) : null}
                  </p>
                </li>
              )
            })}
          </ol>
          <div tabIndex={0} role="region" aria-label="Ledger entries" className="mt-4 hidden overflow-x-auto border border-rule bg-sheet sm:block">
            <table className="w-full min-w-[52rem] text-left text-[15px]">
              <caption className="sr-only">Ledger entries, newest first</caption>
              <thead className="border-b border-rule bg-bond text-sm text-graphite">
                <tr>
                  <th scope="col" className="px-4 py-2">When (UTC)</th>
                  <th scope="col" className="px-4 py-2">Entry</th>
                  <th scope="col" className="px-4 py-2">Claim</th>
                  <th scope="col" className="px-4 py-2 text-right">Amount</th>
                  {wallet.isConnected ? <th scope="col" className="px-4 py-2 text-right">Running balance</th> : null}
                  <th scope="col" className="px-4 py-2">Transaction</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {items.map((a: ActivityItem) => {
                  const n = a.amount ? Number(a.amount) : 0
                  const bal = withBalance.get(a.id) ?? 0n
                  return (
                    <tr key={a.id} className={cn('align-top', a.status === 'failed' && 'bg-red-wash')}>
                      <td className="px-4 py-2.5 whitespace-nowrap text-graphite tabular">{formatDate(a.at, 'utc')}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-bold">{activityLabel(a.type)}</span>
                        <span className="untrusted block text-sm text-graphite">{a.summary}</span>
                        {a.status === 'failed' ? <span className="text-sm font-bold text-red">Failed, nothing moved</span> : a.status === 'pending' ? <span className="text-sm font-bold text-ochre">Pending</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-sm whitespace-nowrap">
                        <a href={`/claims/${a.claimId}`} className="link tabular">
                          {formatClaimNumber(a.claimNumber)}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap tabular">
                        {a.amount ? (
                          <span className={cn('font-bold', n < 0 ? 'text-ink' : 'text-violet')}>
                            {n > 0 ? '+' : n < 0 ? '−' : ''}
                            {formatAmount(a.amount.replace(/^-/, ''), { symbol: a.token, maxDecimals: 4 })}
                          </span>
                        ) : (
                          <span className="text-graphite">—</span>
                        )}
                      </td>
                      {wallet.isConnected ? (
                        <td className="px-4 py-2.5 text-right whitespace-nowrap text-graphite tabular">
                          {bal < 0n ? '−' : ''}
                          {formatAmount(fromScaled(bal < 0n ? -bal : bal, S), { maxDecimals: 2 })}
                        </td>
                      ) : null}
                      <td className="px-4 py-2.5 text-sm">
                        <ExternalLink href={explorerTxUrl(a.chainId, a.txHash)} icon={false}>
                          {shortHash(a.txHash, 4)}
                        </ExternalLink>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </div>
  )
}
