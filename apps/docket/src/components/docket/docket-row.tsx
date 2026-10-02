import Link from 'next/link'
import type { ClaimSummary } from '@pine/core'
import { formatAmount, formatClaimNumber, formatDate, formatPrice, shortSha } from '@pine/core'
import { cn } from '@/lib/cn'
import { StageTag } from '@/components/ui/stage'
import { ProcedureMini } from '@/components/claim/procedure'
import { Relative } from '@/components/ui/when'
import { formatCompactUtc } from '@/lib/format'

/** A claim as a docket entry: number, filed date, title, parties, stage, deadline, implied chance. */
export function DocketRow({ claim: c, compact = false }: { claim: ClaimSummary; compact?: boolean }) {
  const number = formatClaimNumber(c.number)
  const open = c.status === 'open'
  const hasPrice = typeof c.yesPrice === 'number' && c.status !== 'publishing' && c.status !== 'failed'
  return (
    <article
      className={cn(
        'group relative grid gap-x-6 gap-y-2 border-b border-rule bg-sheet px-4 py-4 transition-colors hover:bg-[#fafbfd] sm:px-5',
        'md:grid-cols-[8.5rem_minmax(0,1fr)_12rem]',
        !compact && 'xl:grid-cols-[8.5rem_minmax(0,1fr)_21rem]',
      )}
      aria-labelledby={`row-${c.id}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:block">
        <p className="font-[800] text-violet tabular">{number}</p>
        <p className="text-sm text-graphite md:mt-0.5">
          Filed <time dateTime={c.createdAt}>{formatDate(c.createdAt, 'short')}</time>
        </p>
      </div>

      <div className="min-w-0">
        <h3 id={`row-${c.id}`} className="record-title untrusted text-[1.15rem] leading-7 font-semibold">
          <Link href={`/claims/${c.id}`} className="no-underline after:absolute after:inset-0 after:content-[''] group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">
            {c.title}
          </Link>
        </h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-graphite">
          <span>
            {c.source.owner}/{c.source.repo} at <code className="font-mono text-[13px] text-ink">{shortSha(c.source.commitSha)}</code>
          </span>
          <span>
            {c.policy.id}@{c.policy.version}
          </span>
          {c.sponsored ? <span className="rounded-xs border border-rule px-1 text-xs font-bold">Sponsored</span> : null}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <StageTag status={c.status} outcome={c.outcome} />
          <ProcedureMini status={c.status} />
          <span className="text-sm text-graphite">
            {c.evidenceCount === 0 ? 'No exhibits' : `${c.evidenceCount} exhibit${c.evidenceCount === 1 ? '' : 's'}`}
          </span>
        </div>
      </div>

      <div className={cn('grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-1', !compact && 'xl:grid-cols-[11.5rem_minmax(0,1fr)]')}>
      <div className="text-sm">
        <p className="text-graphite">{open ? 'Evidence deadline' : 'Evidence deadline passed'}</p>
        <p className="font-bold tabular">{formatCompactUtc(c.evidenceDeadline)}</p>
        {open ? (
          <p className={cn('font-bold', isClosingSoon(c.evidenceDeadline) ? 'text-ochre' : 'text-graphite')}>
            <Relative at={c.evidenceDeadline} />
          </p>
        ) : null}
      </div>

      {!compact ? (
        <div className="text-sm xl:text-right">
          {hasPrice ? (
            <>
              <p className="text-graphite">Implied chance</p>
              <p className="text-lg leading-6 font-[800] tabular">{formatPrice(c.yesPrice!)}</p>
              <p className="text-graphite">{formatAmount(c.liquidity, { symbol: c.collateralSymbol, compact: true })} liquidity</p>
            </>
          ) : (
            <p className="text-graphite">No price yet</p>
          )}
        </div>
      ) : null}
      </div>
    </article>
  )
}

function isClosingSoon(iso: string) {
  const ms = new Date(iso).getTime() - Date.now()
  return ms > 0 && ms < 72 * 3600_000
}
