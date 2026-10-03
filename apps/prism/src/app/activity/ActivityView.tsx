'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ActivityType } from '@pine/core'
import { formatAmount, formatClaimNumber } from '@pine/core'
import { useActivity, usePortfolio, useWallet } from '@pine/react'
import { ActivityRows } from '@/components/claim/AgentAndActivity'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '@/components/ui/primitives'
import { useMounted } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const FILTERS: { id: string; label: string; types?: ActivityType[] }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'funding', label: 'Funding', types: ['market_created', 'manifest_pinned', 'approval', 'split', 'merge', 'liquidity_added', 'liquidity_removed'] },
  { id: 'trades', label: 'Trades', types: ['trade'] },
  { id: 'evidence', label: 'Evidence', types: ['evidence_submitted'] },
  { id: 'oracle', label: 'Oracle', types: ['answer_posted', 'arbitration_requested', 'ruling', 'finalized'] },
  { id: 'redeemed', label: 'Redemptions', types: ['redeemed'] },
]

export function ActivityView() {
  const mounted = useMounted()
  const wallet = useWallet()
  const [filter, setFilter] = useState('all')
  const types = FILTERS.find((f) => f.id === filter)?.types
  const account = wallet.isConnected ? wallet.address : undefined
  const q = useActivity({ account, types, limit: 200 })
  const full = useActivity({ account, limit: 500 })
  const portfolio = usePortfolio(account)
  const sym = 'sDAI'

  const recon = useMemo(() => {
    let out = 0
    let inn = 0
    let pending = 0
    let failed = 0
    const byClaim = new Map<string, { number: number; title: string; out: number; inn: number }>()
    for (const a of full.data?.items ?? []) {
      if (a.status === 'pending') pending++
      if (a.status === 'failed') {
        failed++
        continue
      }
      if (!a.amount || a.token !== sym) continue
      const v = Number(a.amount)
      if (!Number.isFinite(v) || v === 0) continue
      const row = byClaim.get(a.claimId) ?? { number: a.claimNumber, title: a.claimTitle, out: 0, inn: 0 }
      if (v < 0) {
        out += -v
        row.out += -v
      } else {
        inn += v
        row.inn += v
      }
      byClaim.set(a.claimId, row)
    }
    return { out, inn, pending, failed, rows: [...byClaim.entries()].sort((a, b) => b[1].number - a[1].number) }
  }, [full.data])

  const t = portfolio.data?.totals
  const deposited = t ? Number(t.depositedAllTime) : undefined
  const diff = deposited !== undefined ? Math.abs(deposited - recon.out) : undefined

  return (
    <div className="grid gap-10">
      {!mounted ? (
        <Skeleton className="h-40 w-full" />
      ) : !account ? (
        <div className="glass cut-lg flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="max-w-[60ch] text-lumen-2">Connect a wallet to reconcile your own funding, trades and redemptions. Showing all recent activity meanwhile.</p>
          <Button variant="glass" onClick={() => wallet.connect()}>
            {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
          </Button>
        </div>
      ) : (
        <section aria-labelledby="recon-title" className="glass cut-xl p-5 sm:p-6">
          <h2 id="recon-title" className="t-h3">
            Reconciliation
          </h2>
          <p className="mt-1 text-[0.875rem] text-lumen-3">Your transaction history, summed, against what the indexer says you hold and moved.</p>
          <dl className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            {(
              [
                ['Out, from your history', recon.out],
                ['In, from your history', recon.inn],
                ['Deposited, per indexer', t?.depositedAllTime],
                ['Withdrawn, per indexer', t?.withdrawnAllTime],
                ['Fees paid, per indexer', t?.feesPaidAllTime],
                ['Redeemable now', t?.redeemable],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="cut-sm border border-edge bg-void px-3 py-2.5">
                <dt className="text-[0.75rem] text-lumen-3">{k}</dt>
                <dd className="tnum mt-0.5 text-[1rem] text-lumen">{v === undefined ? '—' : `${formatAmount(v, { maxDecimals: 4 })} ${sym}`}</dd>
              </div>
            ))}
          </dl>
          {diff !== undefined && (
            <p className={cn('mt-4 text-[0.875rem]', diff > 0.01 ? 'text-na' : 'text-lumen-2')} role="status">
              {diff > 0.01
                ? `History and indexer differ by ${formatAmount(diff, { maxDecimals: 4 })} ${sym}. Liquidity added on the DEX is recorded there without an amount here; check the pool positions on your dashboard.`
                : 'Your history and the indexer agree on what you deposited.'}
            </p>
          )}
          {(recon.pending > 0 || recon.failed > 0) && (
            <p className="mt-2 text-[0.8125rem] text-lumen-3">
              {recon.pending} pending and {recon.failed} failed transactions are left out of the totals. Failed transactions moved no collateral.
            </p>
          )}
          {recon.rows.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-[0.875rem] font-semibold text-lumen-2">Per claim</summary>
              <ul className="mt-3 grid gap-1.5 text-[0.84375rem]">
                {recon.rows.map(([id, r]) => (
                  <li key={id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-4">
                    <Link href={`/claims/${id}`} className="link truncate text-lumen-2">
                      {formatClaimNumber(r.number)} {r.title}
                    </Link>
                    <span className="tnum text-lumen">−{formatAmount(r.out, { maxDecimals: 2 })}</span>
                    <span className="tnum text-hb">+{formatAmount(r.inn, { maxDecimals: 2 })}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <section aria-labelledby="ledger-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="ledger-title" className="t-h3">
            {account ? 'Your transactions' : 'Recent activity'}
          </h2>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <LoadingBlock lines={6} />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="Nothing here yet">Transactions appear here once they are indexed.</EmptyState>
        ) : (
          <div className="glass cut-xl px-4 sm:px-5">
            <ActivityRows items={q.data!.items} showClaim />
          </div>
        )}
      </section>
    </div>
  )
}
