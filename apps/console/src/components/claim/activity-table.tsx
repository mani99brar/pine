'use client'

import Link from 'next/link'
import type { ActivityItem, ActivityType } from '@pine/core'
import { explorerTxUrl, formatAmount, formatClaimNumber, formatDate, shortHash } from '@pine/core'
import { cn } from '@/lib/cn'
import { ExternalLink } from '@/components/ui/external-link'

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  market_created: 'Market created',
  manifest_pinned: 'Manifest pinned',
  liquidity_added: 'Liquidity added',
  liquidity_removed: 'Liquidity removed',
  split: 'Split collateral',
  merge: 'Merged positions',
  trade: 'Trade',
  evidence_submitted: 'Evidence submitted',
  answer_posted: 'Answer posted',
  arbitration_requested: 'Arbitration requested',
  ruling: 'Ruling',
  finalized: 'Finalized',
  redeemed: 'Redeemed',
  approval: 'Approval',
}

export function SignedAmount({ amount, token }: { amount?: string; token?: string }) {
  if (!amount) return <span className="text-faint">none</span>
  const neg = amount.trim().startsWith('-')
  const abs = neg ? amount.trim().slice(1) : amount.trim().replace(/^\+/, '')
  return (
    <span className={cn('tnum whitespace-nowrap', neg ? 'text-bark' : 'text-needle')}>
      {neg ? '−' : '+'}
      {formatAmount(abs, { symbol: token, maxDecimals: 4 })}
    </span>
  )
}

/** Transaction log: newest first, monospace hashes, explorer links. */
export function ActivityTable({ items, showClaim }: { items: ActivityItem[]; showClaim?: boolean }) {
  return (
    <div className="scrollbar-thin relative overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-[13px]">
        <thead>
          <tr className="stretch-cond border-b border-line text-left text-[12px] text-muted">
            <th scope="col" className="py-2 pl-4 pr-3 font-medium sm:pl-6">
              Time (UTC)
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Event
            </th>
            {showClaim ? (
              <th scope="col" className="py-2 pr-3 font-medium">
                Claim
              </th>
            ) : null}
            <th scope="col" className="py-2 pr-3 font-medium">
              Actor
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Flow
            </th>
            <th scope="col" className="py-2 pr-4 font-medium sm:pr-6">
              Transaction
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} className="border-b border-line align-top last:border-0 hover:bg-frost">
              <td className="tnum whitespace-nowrap py-2 pl-4 pr-3 text-[12px] text-muted sm:pl-6">{formatDate(a.at, 'short')}</td>
              <td className="py-2 pr-3">
                <span className="font-medium">{ACTIVITY_LABEL[a.type]}</span>
                {a.outcome ? <span className="ml-1.5 text-muted">{a.side ? `${a.side} ` : ''}{a.outcome.toUpperCase()}</span> : null}
                <p className="wrap-anywhere text-[12px] text-muted">{a.summary}</p>
              </td>
              {showClaim ? (
                <td className="py-2 pr-3">
                  <Link href={`/claims/${a.claimId}`} className="mono-cond text-[11.5px] text-needle hover:underline" title={a.claimTitle}>
                    {formatClaimNumber(a.claimNumber)}
                  </Link>
                </td>
              ) : null}
              <td className="mono-cond py-2 pr-3 text-[11.5px]">{shortHash(a.actor)}</td>
              <td className="py-2 pr-3 text-right">
                <SignedAmount amount={a.amount} token={a.token} />
              </td>
              <td className="py-2 pr-4 sm:pr-6">
                <span className="flex items-center gap-2">
                  {a.status && a.status !== 'confirmed' ? (
                    <span className={cn('text-[11.5px] font-medium', a.status === 'failed' ? 'text-flare' : 'text-resin')}>{a.status}</span>
                  ) : null}
                  <ExternalLink href={explorerTxUrl(a.chainId, a.txHash)} className="mono-cond text-[11.5px]">
                    {shortHash(a.txHash)}
                  </ExternalLink>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
