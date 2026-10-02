'use client'

import Link from 'next/link'
import type { ActivityItem, ActivityType } from '@pine/core'
import { explorerTxUrl, formatAmount, formatClaimNumber, formatDate, shortHash } from '@pine/core'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  Box,
  FileText,
  Flag,
  Gavel,
  KeyRound,
  Layers,
  MessageSquareQuote,
  Repeat2,
  Scale,
  Split,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/cn'

const ICON: Record<ActivityType, LucideIcon> = {
  market_created: Box,
  manifest_pinned: FileText,
  liquidity_added: ArrowDownToLine,
  liquidity_removed: ArrowUpFromLine,
  split: Split,
  merge: Layers,
  trade: Repeat2,
  evidence_submitted: FileText,
  answer_posted: MessageSquareQuote,
  arbitration_requested: Scale,
  ruling: Gavel,
  finalized: Flag,
  redeemed: BadgeCheck,
  approval: KeyRound,
}

export const ACTIVITY_LABEL: Record<ActivityType, string> = {
  market_created: 'Market created',
  manifest_pinned: 'Manifest pinned',
  liquidity_added: 'Liquidity added',
  liquidity_removed: 'Liquidity removed',
  split: 'Split',
  merge: 'Merge',
  trade: 'Trade',
  evidence_submitted: 'Evidence',
  answer_posted: 'Answer',
  arbitration_requested: 'Arbitration',
  ruling: 'Ruling',
  finalized: 'Finalized',
  redeemed: 'Redeemed',
  approval: 'Approval',
}

export function ActivityRow({ a, showClaim }: { a: ActivityItem; showClaim?: boolean }) {
  const Icon = ICON[a.type] ?? FileText
  const amt = a.amount ? Number(a.amount) : undefined
  return (
    <li className="grid grid-cols-[2rem_1fr_auto] items-start gap-x-3 gap-y-1 py-3">
      <span aria-hidden className={cn('mt-0.5 flex h-8 w-8 items-center justify-center rounded-full', a.status === 'failed' ? 'border-2 border-dashed border-flare-ink text-flare-ink' : 'bg-fog-2 text-ink')}>
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8rem] text-ink-3">
          <span className="font-[650] text-ink-2">{ACTIVITY_LABEL[a.type]}</span>
          {showClaim && (
            <Link href={`/claims/${a.claimId}`} className="t-figure text-[0.86rem] text-ink-2 hover:underline">
              {formatClaimNumber(a.claimNumber)}
            </Link>
          )}
          <span>{formatDate(a.at, 'long')}</span>
          {a.status === 'pending' && <span className="font-[650] text-lumen-ink">pending</span>}
          {a.status === 'failed' && <span className="font-[650] text-flare-ink">failed</span>}
        </p>
        <p className="untrusted mt-0.5 text-[0.9rem] [white-space:normal]">{a.summary}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-[0.75rem] text-ink-3">
          <code className="t-code">{shortHash(a.actor)}</code>
          <a href={explorerTxUrl(a.chainId, a.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
            tx {shortHash(a.txHash)}
          </a>
        </p>
      </div>
      <div className="text-right">
        {amt !== undefined && Number.isFinite(amt) && (
          <p className={cn('t-figure text-[1.05rem]', amt < 0 ? 'text-ink' : 'text-ink')}>
            {amt > 0 ? '+' : amt < 0 ? '−' : ''}
            {formatAmount(Math.abs(amt), { maxDecimals: 4 })}
            <span className="ml-1 font-sans text-[0.72rem] font-[450] text-ink-3">{a.token}</span>
          </p>
        )}
      </div>
    </li>
  )
}

export function ActivityList({ items, showClaim, className }: { items: ActivityItem[]; showClaim?: boolean; className?: string }) {
  return (
    <ul className={cn('divide-y divide-line', className)}>
      {items.map((a) => (
        <ActivityRow key={a.id} a={a} showClaim={showClaim} />
      ))}
    </ul>
  )
}
