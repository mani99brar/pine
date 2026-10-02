'use client'

import * as React from 'react'
import type { ActivityType } from '@pine/core'
import { formatAmount, sumDecimals } from '@pine/core'
import { useActivity, usePortfolio, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Figure, PageHeader } from '@/components/ui/page-header'
import { SkeletonRows } from '@/components/ui/skeleton'
import { ActivityTable } from '@/components/claim/activity-table'

const GROUPS: { id: string; label: string; types?: ActivityType[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'funding', label: 'Funding', types: ['approval', 'split', 'merge', 'liquidity_added', 'liquidity_removed', 'market_created', 'manifest_pinned'] },
  { id: 'trades', label: 'Trades', types: ['trade'] },
  { id: 'evidence', label: 'Evidence', types: ['evidence_submitted'] },
  { id: 'oracle', label: 'Oracle', types: ['answer_posted', 'arbitration_requested', 'ruling', 'finalized'] },
  { id: 'redemptions', label: 'Redemptions', types: ['redeemed'] },
]

export function Activity() {
  const wallet = useWallet()
  const [group, setGroup] = React.useState('all')
  const g = GROUPS.find((x) => x.id === group)!
  const q = useActivity({ account: wallet.address, types: g.types, limit: 200 })
  const portfolio = usePortfolio(wallet.address)
  const t = portfolio.data?.totals
  const sym = 'sDAI'
  const realized = t ? sumDecimals([t.withdrawnAllTime, `-${t.depositedAllTime}`, `-${t.feesPaidAllTime}`]) : undefined
  const atStake = t ? sumDecimals([t.positionsValue, t.liquidityValue]) : undefined
  return (
    <div>
      <PageHeader
        title="Activity"
        description={
          wallet.isConnected
            ? 'Every transaction from your wallet across claims, with funding and redemption reconciliation.'
            : 'Recent activity across all claims. Connect a wallet to see and reconcile your own transactions.'
        }
        actions={
          !wallet.isConnected ? (
            <Button variant="secondary" onClick={() => wallet.connect()}>
              Connect wallet
            </Button>
          ) : null
        }
      />
      {t ? (
        <dl className="grid grid-cols-2 gap-px border-b border-line bg-line md:grid-cols-3 xl:grid-cols-6">
          <Figure label="Deposited" value={formatAmount(t.depositedAllTime, { symbol: sym, maxDecimals: 2 })} hint="Liquidity, splits and buys" />
          <Figure label="Withdrawn and redeemed" value={formatAmount(t.withdrawnAllTime, { symbol: sym, maxDecimals: 2 })} />
          <Figure label="Fees and gas" value={formatAmount(t.feesPaidAllTime, { symbol: sym, maxDecimals: 4 })} hint="Not recoverable" />
          <Figure label="Redeemable now" value={formatAmount(t.redeemable, { symbol: sym, maxDecimals: 2 })} tone={Number(t.redeemable) > 0 ? 'good' : 'default'} />
          <Figure label="Still at stake" value={formatAmount(atStake ?? '0', { symbol: sym, maxDecimals: 2 })} hint="Positions and LP at mark" />
          <Figure
            label="Realized so far"
            value={
              <span className={cn(Number(realized) < 0 ? 'text-bark' : 'text-needle')}>
                {Number(realized) < 0 ? '−' : '+'}
                {formatAmount(String(Math.abs(Number(realized ?? 0))), { symbol: sym, maxDecimals: 2 })}
              </span>
            }
            hint="Withdrawn minus deposited and fees"
          />
        </dl>
      ) : null}
      <div className="bg-surface">
        <div className="scrollbar-thin flex gap-1 relative overflow-x-auto border-b border-line px-3 py-2 sm:px-6" role="toolbar" aria-label="Filter by type">
          {GROUPS.map((x) => (
            <button
              key={x.id}
              type="button"
              aria-pressed={group === x.id}
              onClick={() => setGroup(x.id)}
              className={cn('h-7 shrink-0 rounded-ctl px-2.5 text-[13px] text-muted hover:bg-sunken hover:text-bark', group === x.id && 'bg-sunken font-medium text-bark')}
            >
              {x.label}
            </button>
          ))}
        </div>
        {q.isLoading ? (
          <SkeletonRows rows={8} />
        ) : q.isError ? (
          <EmptyState tone="error" title="Activity could not be loaded" action={<Button variant="secondary" onClick={() => void q.refetch()}>Retry</Button>}>
            {(q.error as Error)?.message}
          </EmptyState>
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={group === 'all' ? 'No transactions yet' : `No ${g.label.toLowerCase()} transactions`}>
            Publishing, trading, evidence and redemptions are recorded here with explorer links as soon as they are indexed.
          </EmptyState>
        ) : (
          <ActivityTable items={q.data!.items} showClaim />
        )}
      </div>
    </div>
  )
}
