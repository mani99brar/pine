'use client'

import Link from 'next/link'
import type { ClaimSummary, DepthSnapshot } from '@pine/core'
import { formatClaimNumber, formatPrice, shortSha } from '@pine/core'
import { FileSearch, Sparkles } from 'lucide-react'
import { COPY } from '@pine/core/copy'
import { TensionBar, formatMove, movePts } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { OutcomeLabel, StatusPill } from '@/components/glyphs/Status'
import { cn } from '@/lib/cn'

export function MoveFigure({ yes, yes24hAgo, className }: { yes?: number; yes24hAgo?: number; className?: string }) {
  const pts = movePts(yes, yes24hAgo)
  if (pts === undefined) return null
  const flat = Math.abs(pts) < 0.05
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-[0.8rem] font-[650]',
        flat ? 'text-ink-3' : pts > 0 ? 'text-flare-ink' : 'text-cobalt-ink',
        className,
      )}
    >
      {!flat && (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden className={pts > 0 ? '' : 'rotate-180'}>
          <path d="M4 0.5 L7.5 7 L0.5 7 Z" fill="currentColor" />
        </svg>
      )}
      <span className="t-figure text-[0.88rem]">{formatMove(pts)}</span>
      <span className="font-[500] text-ink-3">24h</span>
    </span>
  )
}

export interface ClaimTileProps {
  claim: ClaimSummary
  depth?: DepthSnapshot | null
  depthLoading?: boolean
  /** Stagger delay for the orchestrated board load (ms) */
  settleDelay?: number
  className?: string
  /** Render as a static preview (composer) instead of a link */
  preview?: boolean
  numberLabel?: string
}

/** A claim on the board. The whole tile is one link; glyphs carry their own text alternatives. */
export function ClaimTile({ claim, depth, depthLoading, settleDelay, className, preview, numberLabel }: ClaimTileProps) {
  const resolved = claim.status === 'resolved' || claim.status === 'settled'
  const outcome = resolved ? claim.outcome : undefined
  const hasMarket = claim.yesPrice !== undefined && claim.status !== 'publishing' && claim.status !== 'failed'
  const evidenceOpen = claim.status === 'open'
  const gated = claim.policy.family === 'SC'

  const Root = preview ? PreviewRoot : Link
  return (
    <Root
      href={`/claims/${claim.id}`}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-[var(--radius-tile)] border border-line bg-sheet px-4 pb-4 pt-3.5 transition-[border-color,box-shadow] duration-150 hover:border-ink hover:shadow-[0_0_0_1px_var(--ink)]',
        className,
      )}
      style={settleDelay !== undefined ? { animation: `rise-in 420ms cubic-bezier(.2,.8,.2,1) ${Math.max(0, settleDelay - 120)}ms backwards` } : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="t-figure whitespace-nowrap text-[0.85rem] text-ink-2">{numberLabel ?? formatClaimNumber(claim.number)}</span>
        <PolicyMark family={claim.policy.family} code={claim.policy.id} gated={gated} size={14} className="text-[0.8rem]" />
        <span className="ml-auto flex items-center gap-1.5">
          {claim.sponsored && (
            <span className="inline-flex items-center gap-1 text-[0.75rem] font-[600] text-ink-2" title="Market funded through the sponsorship program">
              <Sparkles size={12} aria-hidden />
              Sponsored
            </span>
          )}
          {claim.status !== 'open' && <StatusPill status={claim.status} outcome={claim.outcome} size="sm" />}
        </span>
      </div>

      <h3 className="mt-2 line-clamp-2 min-h-[2.6em] text-[1.02rem] font-[650] leading-[1.3] text-ink [overflow-wrap:anywhere]">{claim.title}</h3>
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[0.8rem] text-ink-3">
        <span className="truncate">
          {claim.source.owner}/{claim.source.repo}
        </span>
        <code className="t-code shrink-0 text-[0.75rem] text-ink-2">@{shortSha(claim.source.commitSha)}</code>
        {claim.source.prNumber !== undefined && <span className="shrink-0">#{claim.source.prNumber}</span>}
      </p>

      <div className="mt-auto pt-4">
        {outcome ? (
          <div className="mb-3 min-h-[2.25rem] text-[0.86rem] leading-snug">
            <OutcomeLabel outcome={outcome} />
          </div>
        ) : hasMarket ? (
          <div className="mb-2.5 flex items-end justify-between gap-2">
            <span className="flex items-baseline gap-2">
              <span className="t-figure text-[1.65rem] text-flare-ink" title={COPY.priceLabel}>
                {formatPrice(claim.yesPrice!)}
              </span>
              <MoveFigure yes={claim.yesPrice} yes24hAgo={claim.yesPrice24hAgo} />
            </span>
          </div>
        ) : (
          <p className="mb-3 min-h-[2.25rem] text-[0.84rem] text-ink-2">
            {claim.status === 'publishing' ? 'Publication incomplete. The creator can finish it.' : 'No market. Creation did not complete.'}
          </p>
        )}
        <TensionBar yes={hasMarket ? claim.yesPrice : undefined} yes24hAgo={claim.yesPrice24hAgo} outcome={outcome} settleDelay={settleDelay} />

        <div className="mt-4 flex items-center justify-between gap-3">
          {evidenceOpen ? (
            <TimeRing start={claim.createdAt} end={claim.evidenceDeadline} size={30} labelPosition="beside" />
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[0.8rem] text-ink-3">
              <FileSearch size={14} aria-hidden />
              <span className="t-figure text-[0.92rem] text-ink-2">{claim.evidenceCount}</span> evidence
            </span>
          )}
          {hasMarket && !outcome ? (
            <DepthBars depth={depth} loading={depthLoading} symbol={claim.collateralSymbol} size="sm" />
          ) : evidenceOpen ? null : (
            <span className="text-[0.8rem] text-ink-3">{claim.traders} traders</span>
          )}
        </div>
      </div>
    </Root>
  )
}

function PreviewRoot({ className, style, children }: { href: string; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  )
}

export function ClaimTileSkeleton() {
  return (
    <div className="flex flex-col rounded-[var(--radius-tile)] border border-line bg-sheet px-4 pb-4 pt-3.5" aria-hidden>
      <span className="skeleton h-3.5 w-28" />
      <span className="skeleton mt-3 h-4 w-11/12" />
      <span className="skeleton mt-1.5 h-4 w-2/3" />
      <span className="skeleton mt-2 h-3 w-1/2" />
      <span className="skeleton mt-7 h-6 w-20" />
      <span className="skeleton mt-2.5 h-3.5 w-full" />
      <span className="mt-4 flex justify-between">
        <span className="skeleton h-7 w-16" />
        <span className="skeleton h-4 w-24" />
      </span>
    </div>
  )
}
