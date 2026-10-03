'use client'

import { useState } from 'react'
import type { ActivityItem, ClaimDetail } from '@pine/core'
import { explorerTxUrl, formatAmount, formatDate, shortHash } from '@pine/core'
import { useActivity } from '@pine/react'
import { cn } from '@/lib/cn'
import { ExternalLink } from '@/components/ui/external-link'
import { Skeleton } from '@/components/ui/layout'

/** The chronological record: every event on file, newest last, scheduled ones marked. */
export function RecordSection({ claim }: { claim: ClaimDetail }) {
  const events = [...claim.timeline].sort((a, b) => a.at.localeCompare(b.at))
  const activity = useActivity({ claimId: claim.id, limit: 50 })
  const [all, setAll] = useState(false)
  const rows = activity.data?.items ?? []
  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-xl">Entries on the record</h3>
        <ol className="mt-3 border-l-2 border-ink">
          {events.map((e) => (
            <li key={e.id} className="relative pb-4 pl-5 last:pb-0">
              <span
                aria-hidden
                className={cn(
                  'absolute top-2 -left-[6px] size-2.5 rounded-full',
                  e.scheduled ? 'border-2 border-ink bg-sheet' : 'bg-ink',
                )}
              />
              <p className="text-sm text-graphite">
                <time dateTime={e.at}>{formatDate(e.at, 'long')}</time>
                {e.scheduled ? <span className="ml-2 rounded-xs bg-wheat px-1 font-bold text-ochre">Scheduled</span> : null}
              </p>
              <p className="font-bold">{e.title}</p>
              {e.detail ? <p className="untrusted text-[15px] text-graphite">{e.detail}</p> : null}
              {e.txHash ? (
                <p className="text-sm">
                  <ExternalLink href={explorerTxUrl(claim.chainId, e.txHash)}>Transaction {shortHash(e.txHash, 4)}</ExternalLink>
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="text-xl">Market transactions</h3>
        <p className="mt-1 text-[15px] text-graphite">Trades, liquidity, exhibits and oracle actions, newest first.</p>
        {activity.isLoading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-4/6" />
          </div>
        ) : rows.length > 0 ? (
          <>
            <ActivityTable items={all ? rows : rows.slice(0, 8)} showClaim={false} />
            {rows.length > 8 ? (
              <button type="button" className="link mt-3 text-[15px] font-bold print:hidden" onClick={() => setAll(!all)}>
                {all ? 'Show the latest 8 only' : `Show all ${rows.length} transactions`}
              </button>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-graphite">No transactions recorded for this claim yet.</p>
        )}
      </div>
    </div>
  )
}

const TYPE_LABEL: Record<ActivityItem['type'], string> = {
  market_created: 'Market created',
  manifest_pinned: 'Manifest pinned',
  liquidity_added: 'Liquidity added',
  liquidity_removed: 'Liquidity withdrawn',
  split: 'Collateral split',
  merge: 'Tokens merged',
  trade: 'Trade',
  evidence_submitted: 'Exhibit filed',
  answer_posted: 'Answer posted',
  arbitration_requested: 'Arbitration requested',
  ruling: 'Ruling',
  finalized: 'Finalized',
  redeemed: 'Redeemed',
  approval: 'Exact approval',
}

export function activityLabel(t: ActivityItem['type']) {
  return TYPE_LABEL[t] ?? t
}

export function ActivityTable({ items, showClaim = true }: { items: ActivityItem[]; showClaim?: boolean }) {
  return (
    <div tabIndex={0} role="region" aria-label="Record of events" className="mt-3 overflow-x-auto border border-rule bg-sheet">
      <table className="w-full min-w-[40rem] text-left text-[15px]">
        <caption className="sr-only">Transactions</caption>
        <thead className="border-b border-rule bg-bond text-sm text-graphite">
          <tr>
            <th scope="col" className="px-4 py-2">When (UTC)</th>
            <th scope="col" className="px-4 py-2">Entry</th>
            {showClaim ? <th scope="col" className="px-4 py-2">Claim</th> : null}
            <th scope="col" className="px-4 py-2 text-right">Amount</th>
            <th scope="col" className="px-4 py-2">Transaction</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {items.map((a) => {
            const n = a.amount ? Number(a.amount) : 0
            return (
              <tr key={a.id} className={cn(a.status === 'failed' && 'bg-red-wash')}>
                <td className="px-4 py-2.5 whitespace-nowrap text-graphite tabular">{formatDate(a.at, 'utc')}</td>
                <td className="px-4 py-2.5">
                  <span className="font-bold">{activityLabel(a.type)}</span>
                  <span className="untrusted block text-sm text-graphite">{a.summary}</span>
                  {a.status && a.status !== 'confirmed' ? (
                    <span className={cn('text-sm font-bold', a.status === 'failed' ? 'text-red' : 'text-ochre')}>
                      {a.status === 'failed' ? 'Failed' : 'Pending'}
                    </span>
                  ) : null}
                </td>
                {showClaim ? (
                  <td className="px-4 py-2.5 text-sm">
                    <a href={`/claims/${a.claimId}`} className="link">
                      PINE-{String(a.claimNumber).padStart(4, '0')}
                    </a>
                  </td>
                ) : null}
                <td className={cn('px-4 py-2.5 text-right whitespace-nowrap tabular', n < 0 ? 'text-ink' : n > 0 ? 'text-ink' : 'text-graphite')}>
                  {a.amount ? `${n > 0 ? '+' : ''}${formatAmount(a.amount, { symbol: a.token, maxDecimals: 4 })}` : '—'}
                </td>
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
  )
}
