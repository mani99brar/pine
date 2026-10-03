'use client'

import Link from 'next/link'
import type { ClaimSummary } from '@pine/core'
import { formatAmount, formatPrice, shortSha } from '@pine/core'
import { ClaimCrystal } from '@/components/crystal/ClaimCrystal'
import { PrismMini, pricesFrom } from '@/components/prism/PrismBeam'
import { StatusBadge } from '@/components/claim/StatusBadge'
import { FamilyIcon } from '@/components/icons'
import { FAMILY_VAR } from '@/lib/crystal'
import { apiFactsOf, apiOutcomePrices, claimLabel, isResolved, pulseSeconds, repoLabel, timeLeft } from '@/lib/claims'
import { cn } from '@/lib/cn'

export function ClaimRow({ claim, nowMs, className }: { claim: ClaimSummary; nowMs: number | null; className?: string }) {
  const api = apiFactsOf(claim)
  // Backend listings carry no prices, liquidity or evidence counts: those read "—" or are left out, never 0.
  const yes = api ? apiOutcomePrices(claim).yes : undefined
  const prices = api ? (yes !== undefined ? { yes, no: 0, invalid: 0 } : undefined) : pricesFrom(claim)
  const resolved = isResolved(claim.status)
  const tl = nowMs ? timeLeft(claim.evidenceDeadline, nowMs) : null
  return (
    <li className={cn('group relative [&:has(a:focus-visible)]:z-[1] [&:has(a:focus-visible)]:shadow-[inset_0_0_0_2px_var(--hb)] [&:has(a:focus-visible)]:bg-[rgba(90,216,255,0.04)]', className)}>
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-3 py-4 transition-colors group-hover:bg-[rgba(255,236,220,0.03)] sm:px-4 md:grid-cols-[3.5rem_minmax(0,1fr)_9.5rem_7rem_8rem]">
        <div className="row-span-2 flex justify-center md:row-span-1">
          <ClaimCrystal claim={claim} size={58} glow={!resolved} pulse={nowMs ? pulseSeconds(claim.evidenceDeadline, nowMs) : undefined} decorative />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className={cn('tnum text-[0.8125rem] font-semibold text-lumen-3', api && 't-code font-normal')} title={api ? `Market ${claim.marketAddress ?? claim.id}` : undefined}>
              {claimLabel(claim)}
            </span>
            <StatusBadge status={claim.status} outcome={claim.outcome} size="sm" />
            {api?.phase === 'reveal_open' && <span className="tag text-[0.75rem]">Reveal window</span>}
            {claim.sponsored && <span className="tag text-[0.75rem]">Sponsored</span>}
          </div>
          <Link href={`/claims/${claim.id}`} className="mt-1 block text-[1.02rem] font-semibold leading-snug text-lumen after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-[rgba(90,216,255,0.6)] hover:underline-offset-4 focus-visible:outline-none">
            {claim.title}
          </Link>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-lumen-3">
            <span className="inline-flex items-center gap-1.5" style={{ color: FAMILY_VAR[claim.policy.family] }}>
              <FamilyIcon family={claim.policy.family} size={14} />
              <span className="text-lumen-2">
                {claim.policy.id}
                {claim.policy.version ? `@${claim.policy.version}` : ''}
              </span>
            </span>
            <span className="truncate">{repoLabel(claim)}</span>
            <span className="t-code text-[0.75rem] text-lumen-2">{shortSha(claim.source.commitSha)}</span>
            {claim.source.prNumber && <span>PR #{claim.source.prNumber}</span>}
          </p>
        </div>
        <div className="col-start-2 flex items-center gap-3 md:col-start-auto">
          <PrismMini prices={resolved ? undefined : prices} outcome={resolved ? claim.outcome : undefined} width={58} />
          <div className="min-w-0">
            {resolved ? (
              <p className="text-[0.8125rem] leading-tight text-lumen-2">Resolved</p>
            ) : prices ? (
              <>
                <p className="t-figure text-[1.35rem] leading-none text-lumen">{formatPrice(prices.yes)}</p>
                <p className="mt-0.5 text-[0.75rem] leading-tight text-lumen-3">{api ? 'Yes pool price' : 'implied chance'}</p>
              </>
            ) : api ? (
              <>
                <p className="t-figure text-[1.35rem] leading-none text-lumen-3" aria-label="Not priced in this list">
                  —
                </p>
                <p className="mt-0.5 text-[0.75rem] leading-tight text-lumen-3">price on the claim</p>
              </>
            ) : (
              <p className="text-[0.8125rem] leading-tight text-lumen-3">No price yet</p>
            )}
          </div>
        </div>
        <div className="col-start-2 hidden md:col-start-auto md:block">
          {api ? (
            <>
              <p className="tnum text-[0.9375rem] text-lumen-3">—</p>
              <p className="text-[0.75rem] text-lumen-3">liquidity not indexed</p>
            </>
          ) : (
            <>
              <p className="tnum text-[0.9375rem] text-lumen">{formatAmount(claim.liquidity, { maxDecimals: 0 })}</p>
              <p className="text-[0.75rem] text-lumen-3">{claim.collateralSymbol} liquidity</p>
            </>
          )}
        </div>
        <div className="col-start-2 md:col-start-auto">
          {tl ? (
            <p className={cn('tnum text-[0.875rem]', !tl.past && tl.ms < 24 * 3_600_000 ? 'text-na' : tl.past ? 'text-lumen-3' : 'text-lumen-2')}>
              {claim.status === 'publishing' || claim.status === 'failed' ? 'Not open yet' : tl.past ? `Evidence ${tl.label}` : tl.label}
            </p>
          ) : (
            <span className="skeleton inline-block h-4 w-20" aria-hidden />
          )}
          {!api && <p className="text-[0.75rem] text-lumen-3">{claim.evidenceCount} evidence</p>}
        </div>
      </div>
    </li>
  )
}
