'use client'

import Link from 'next/link'
import { FileUp, X } from 'lucide-react'
import type { ClaimSummary } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { formatAmount, formatClaimNumber, formatDate, formatPrice, nextStep, shortSha } from '@pine/core'
import { useClaim } from '@pine/react'
import { Button } from '@/components/ui/button'
import { HashChip } from '@/components/ui/hash-chip'
import { Kbd } from '@/components/ui/kbd'
import { PriceGauge } from '@/components/ui/instruments'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/claim/status'
import { useNowTick } from '@/lib/use-now'

export function ClaimPreview({ id, summary, onClose }: { id: string; summary: ClaimSummary; onClose: () => void }) {
  const { data: claim, isLoading } = useClaim(id)
  const now = useNowTick(30_000)
  const step = claim ? nextStep(claim, now) : undefined
  return (
    <div className="sticky top-12 flex max-h-[calc(100dvh-48px-28px)] flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="mono-cond text-[11.5px] text-muted">{formatClaimNumber(summary.number)}</span>
        <StatusBadge status={summary.status} outcome={summary.outcome} />
        <button type="button" onClick={onClose} className="ml-auto rounded-chip p-1 text-muted hover:bg-sunken hover:text-bark" aria-label="Close preview">
          <X size={14} aria-hidden />
        </button>
      </div>
      <div className="space-y-4 px-4 py-4">
        <h2 className="text-[17px] font-semibold leading-snug">{summary.title}</h2>
        <div>
          <p className="stretch-cond mb-1 text-[12px] text-muted">Question</p>
          {isLoading || !claim ? (
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-[92%]" />
              <Skeleton className="h-3 w-[70%]" />
            </div>
          ) : (
            <blockquote className="mono-cond wrap-anywhere border-l-2 border-needle pl-3 text-[11.5px] leading-[1.6] text-bark">
              {claim.manifest.question.text}
            </blockquote>
          )}
        </div>
        {typeof summary.yesPrice === 'number' ? (
          <div>
            <div className="flex items-baseline justify-between">
              <p className="stretch-cond text-[12px] text-muted">YES price</p>
              <p className="tnum text-xl font-semibold">{formatPrice(summary.yesPrice)}</p>
            </div>
            <PriceGauge value={summary.yesPrice} previous={summary.yesPrice24hAgo} width={340} showScale className="mt-1 w-full" />
            <p className="mt-1 text-[11.5px] leading-[1.45] text-muted">{COPY.priceLabel}. Not a probability that bugs exist.</p>
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
          <div>
            <dt className="text-muted">Commit</dt>
            <dd className="mono-cond truncate text-[11.5px]">
              {summary.source.repo}@{shortSha(summary.source.commitSha)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Policy</dt>
            <dd className="mono-cond text-[11.5px]">
              {summary.policy.id}@{summary.policy.version}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Liquidity</dt>
            <dd className="tnum">{formatAmount(summary.liquidity, { symbol: summary.collateralSymbol })}</dd>
          </div>
          <div>
            <dt className="text-muted">Evidence deadline</dt>
            <dd className="tnum">{formatDate(summary.evidenceDeadline, 'utc')}</dd>
          </div>
        </dl>
        {claim ? (
          <div className="flex flex-wrap gap-1.5">
            <HashChip label="manifest" value={claim.manifestHash} />
            <HashChip label="question" value={claim.manifest.question.hash} />
          </div>
        ) : null}
        {step ? (
          <div className="rounded-ctl border border-line bg-surface px-3 py-2.5">
            <p className="stretch-cond text-[12px] text-muted">Next step</p>
            <p className="mt-0.5 text-[13px] font-medium">{step.title}</p>
            <p className="mt-0.5 text-[12px] text-muted">{step.detail}</p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" size="sm">
            <Link href={`/claims/${id}`}>
              Open workspace <Kbd className="border-needle-ink/30 bg-transparent text-needle-ink/80 shadow-none">↵</Kbd>
            </Link>
          </Button>
          {summary.status === 'open' ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={`/claims/${id}/evidence/new`}>
                <FileUp size={13} aria-hidden /> Submit evidence
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
