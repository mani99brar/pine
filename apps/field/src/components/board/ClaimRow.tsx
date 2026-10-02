'use client'

import Link from 'next/link'
import type { ClaimSummary, DepthSnapshot } from '@pine/core'
import { formatAmount, formatClaimNumber, formatPrice, shortSha } from '@pine/core'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { OutcomeSwatch, StatusPill } from '@/components/glyphs/Status'
import { MoveFigure } from './ClaimTile'
import { cn } from '@/lib/cn'

const GRID =
  'lg:grid lg:grid-cols-[minmax(0,2.4fr)_7.5rem_minmax(11rem,1.3fr)_6.5rem_8rem_9.5rem_5.5rem] lg:items-center lg:gap-x-5'

export function ClaimListHeader() {
  return (
    <div aria-hidden className={cn('hidden px-4 pb-2 text-[0.78rem] font-[600] text-ink-3', GRID)}>
      <span>Claim</span>
      <span>Policy</span>
      <span>Implied chance of accepted counterexample</span>
      <span>24h move</span>
      <span>Evidence window</span>
      <span>Executable depth</span>
      <span className="text-right">Liquidity</span>
    </div>
  )
}

export function ClaimRow({ claim, depth, depthLoading }: { claim: ClaimSummary; depth?: DepthSnapshot | null; depthLoading?: boolean }) {
  const resolved = claim.status === 'resolved' || claim.status === 'settled'
  const outcome = resolved ? claim.outcome : undefined
  const hasMarket = claim.yesPrice !== undefined && claim.status !== 'publishing' && claim.status !== 'failed'
  return (
    <li>
      <Link
        href={`/claims/${claim.id}`}
        className={cn(
          'grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 rounded-[var(--radius-tile)] border border-line bg-sheet px-4 py-3.5 transition-colors hover:border-ink',
          GRID,
        )}
      >
        <div className="col-span-2 min-w-0 lg:col-span-1">
          <div className="flex items-center gap-2 text-[0.8rem]">
            <span className="t-figure text-[0.85rem] text-ink-2">{formatClaimNumber(claim.number)}</span>
            <PolicyMark family={claim.policy.family} code={claim.policy.id} gated={claim.policy.family === 'SC'} size={12} className="text-[0.78rem] lg:hidden" />
            {claim.status !== 'open' && <StatusPill status={claim.status} size="sm" />}
          </div>
          <p className="mt-0.5 truncate font-[650] text-ink" title={claim.title}>{claim.title}</p>
          <p className="truncate text-[0.8rem] text-ink-3">
            {claim.source.owner}/{claim.source.repo} <code className="t-code text-[0.75rem] text-ink-2">@{shortSha(claim.source.commitSha)}</code>
          </p>
        </div>
        <div className="hidden lg:block">
          <PolicyMark family={claim.policy.family} code={claim.policy.id} gated={claim.policy.family === 'SC'} size={14} />
        </div>
        <div className="col-span-2 min-w-0 lg:col-span-1">
          {outcome ? (
            <span className="inline-flex items-center gap-2 text-[0.84rem] font-[620]">
              <OutcomeSwatch outcome={outcome} />
              {outcome === 'yes' ? 'Counterexample demonstrated' : outcome === 'no' ? 'No qualifying counterexample submitted' : 'Resolved invalid'}
            </span>
          ) : (
            <div className="flex items-center gap-3">
              <span className="t-figure w-[3.4rem] shrink-0 text-[1.15rem] text-flare-ink">{hasMarket ? formatPrice(claim.yesPrice!) : '—'}</span>
              <TensionBar yes={hasMarket ? claim.yesPrice : undefined} yes24hAgo={claim.yesPrice24hAgo} size="sm" className="min-w-0 flex-1" />
            </div>
          )}
        </div>
        <div>{hasMarket && !outcome ? <MoveFigure yes={claim.yesPrice} yes24hAgo={claim.yesPrice24hAgo} /> : <span className="text-ink-3">—</span>}</div>
        <div>
          {claim.status === 'open' ? (
            <TimeRing start={claim.createdAt} end={claim.evidenceDeadline} size={26} labelPosition="beside" />
          ) : (
            <span className="text-[0.84rem] text-ink-3">closed</span>
          )}
        </div>
        <div>{hasMarket && !outcome ? <DepthBars depth={depth} loading={depthLoading} symbol={claim.collateralSymbol} size="sm" /> : <span className="text-ink-3">—</span>}</div>
        <div className="text-right">
          <span className="t-figure text-[1rem]">{formatAmount(claim.liquidity, { compact: true, maxDecimals: 1 })}</span>{' '}
          <span className="text-[0.78rem] text-ink-3">{claim.collateralSymbol}</span>
        </div>
      </Link>
    </li>
  )
}
