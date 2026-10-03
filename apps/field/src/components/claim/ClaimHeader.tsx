'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatClaimNumber, formatDate, formatPrice, shortSha } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { ChevronRight, GitPullRequest, Sparkles } from 'lucide-react'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { OutcomeLabel, OutcomeSwatch, StatusPill } from '@/components/glyphs/Status'
import { MoveFigure } from '@/components/board/ClaimTile'
import { ExternalLink, HashChip } from '@/components/ui/interactive'
import { useDepth } from '@pine/react'
import { AgentBriefActions } from './InvestigatePanel'
import { ButtonLink } from '@/components/ui/Button'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Renders the question with its pinned values as code chips, without changing the text. */
export function QuestionText({ text, sha, className }: { text: string; sha?: string; className?: string }) {
  // Highlight 40-hex SHAs and 0x hashes inline; everything else is plain text.
  const parts = text.split(/(0x[0-9a-fA-F]{8,}|\b[0-9a-f]{40}\b)/g)
  return (
    <blockquote className={cn('border-l-[3px] border-ink pl-4 text-[1.02rem] leading-[1.6] text-ink [overflow-wrap:anywhere]', className)}>
      {parts.map((p, i) =>
        /^(0x[0-9a-fA-F]{8,}|[0-9a-f]{40})$/.test(p) ? (
          <code key={i} className="t-code rounded-[3px] bg-fog-2 px-1 text-[0.86em]" title={p}>
            {p === sha ? shortSha(p) : `${p.slice(0, 10)}…${p.slice(-4)}`}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </blockquote>
  )
}

export function ClaimHeader({ claim }: { claim: ClaimDetail }) {
  const chain = getChainOrDefault(claim.chainId)
  const resolved = claim.status === 'resolved' || claim.status === 'settled'
  const outcome = resolved ? claim.outcome : undefined
  const hasMarket = !!claim.market && claim.status !== 'publishing' && claim.status !== 'failed'
  const yes = claim.market?.outcomes.find((o) => o.index === 0)?.price ?? claim.yesPrice
  const no = claim.market?.outcomes.find((o) => o.index === 1)?.price
  const invalid = claim.market?.outcomes.find((o) => o.index === 2)?.price
  const depthQ = useDepth(hasMarket ? claim.id : undefined, 'yes')
  const src = claim.manifest.source

  return (
    <header className="border-b border-line-strong">
      <div className="mx-auto max-w-[1320px] px-4 pb-8 pt-6 sm:px-6">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[0.84rem] text-ink-3">
          <Link href="/board" className="hover:text-ink hover:underline">
            Board
          </Link>
          <ChevronRight size={13} aria-hidden />
          <span aria-current="page" className="text-ink-2">
            {formatClaimNumber(claim.number)}
          </span>
        </nav>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="t-figure text-[1.1rem] text-ink-2">{formatClaimNumber(claim.number)}</span>
          <Link href={`/policies/${claim.policy.id}?v=${claim.policy.version}`} className="rounded-[3px] hover:underline">
            <PolicyMark family={claim.policy.family} code={`${claim.policy.id}@${claim.policy.version}`} gated={claim.policy.family === 'SC'} />
          </Link>
          <StatusPill status={claim.status} outcome={claim.outcome} />
          {claim.sponsored && (
            <span className="inline-flex items-center gap-1 text-[0.8rem] font-[600] text-ink-2">
              <Sparkles size={13} aria-hidden /> Sponsored market
            </span>
          )}
          <span className="text-[0.84rem] text-ink-3">on {chain.name}</span>
          <span className="ml-auto hidden items-center gap-2 md:flex">
            <AgentBriefActions claim={claim} compact />
            {claim.status === 'open' && (
              <ButtonLink href={`/claims/${claim.id}/evidence`} size="sm" icon={<Plus size={14} aria-hidden />}>
                Submit evidence
              </ButtonLink>
            )}
          </span>
        </div>

        <h1 className="t-h1 mt-3 max-w-[38ch] [overflow-wrap:anywhere]">{claim.title}</h1>

        {/* On phones the header actions sit under the title instead of beside the status row. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 md:hidden">
          {claim.status === 'open' && (
            <ButtonLink href={`/claims/${claim.id}/evidence`} size="sm" icon={<Plus size={14} aria-hidden />}>
              Submit evidence
            </ButtonLink>
          )}
          <AgentBriefActions claim={claim} compact />
        </div>

        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.88rem] text-ink-2">
          <ExternalLink href={`https://github.com/${src.owner}/${src.repo}`}>
            {src.owner}/{src.repo}
          </ExternalLink>
          <HashChip value={src.commit.sha} display={shortSha(src.commit.sha)} label="commit" href={src.commit.htmlUrl} />
          {src.pullRequest && (
            <a href={src.pullRequest.htmlUrl} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-w-0 items-center gap-1.5 hover:underline">
              <GitPullRequest size={14} aria-hidden />
              <span className="untrusted line-clamp-1 [white-space:normal]">
                #{src.pullRequest.number} {src.pullRequest.title}
              </span>
            </a>
          )}
          {src.baseCommit && <HashChip value={src.baseCommit.sha} display={shortSha(src.baseCommit.sha)} label="base" href={src.baseCommit.htmlUrl} />}
        </p>

        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
          <div>
            <p className="mb-2 text-[0.8rem] font-[600] text-ink-3">The question, as published</p>
            <QuestionText text={claim.manifest.question.text} sha={src.commit.sha} />
          </div>

          <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
            {outcome ? (
              <>
                <OutcomeLabel outcome={outcome} long className="text-[1.05rem]" />
                <TensionBar outcome={outcome} size="lg" className="mt-5" />
                <p className="mt-4 text-[0.84rem] text-ink-2">
                  {outcome === 'no' ? COPY.noIsNotSafety : outcome === 'invalid' ? COPY.invalidIsNotRefund : 'Only YES tokens redeem for collateral. NO and Invalid tokens pay nothing.'}
                </p>
              </>
            ) : hasMarket && yes !== undefined ? (
              <>
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="t-figure-l text-flare-ink">{formatPrice(yes)}</p>
                    <p className="mt-1 max-w-[30ch] text-[0.8rem] text-ink-2">{COPY.priceLabel}</p>
                  </div>
                  <MoveFigure yes={yes} yes24hAgo={claim.yesPrice24hAgo} className="mb-1" />
                </div>
                <TensionBar yes={yes} yes24hAgo={claim.yesPrice24hAgo} invalid={invalid} size="lg" className="mt-5" />
                <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[0.8rem]">
                  <span className="inline-flex items-center gap-1.5 text-ink-2">
                    <OutcomeSwatch outcome="yes" /> Yes <span className="t-figure text-[0.95rem] text-flare-ink">{formatPrice(yes)}</span>
                  </span>
                  {no !== undefined && (
                    <span className="inline-flex items-center gap-1.5 text-ink-2">
                      <OutcomeSwatch outcome="no" /> No <span className="t-figure text-[0.95rem] text-cobalt-ink">{formatPrice(no)}</span>
                    </span>
                  )}
                  {invalid !== undefined && (
                    <span className="inline-flex items-center gap-1.5 text-ink-2">
                      <OutcomeSwatch outcome="invalid" /> Invalid result <span className="t-figure text-[0.95rem]">{formatPrice(invalid)}</span>
                    </span>
                  )}
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
                  {claim.status === 'open' ? (
                    <span className="inline-flex items-center gap-3">
                      <TimeRing start={claim.createdAt} end={claim.evidenceDeadline} size={52} />
                      <span className="text-[0.8rem] leading-tight text-ink-2">
                        to submit evidence
                        <br />
                        <span className="text-ink-3">closes {formatDate(claim.evidenceDeadline, 'long')}</span>
                      </span>
                    </span>
                  ) : (
                    <span className="text-[0.84rem] text-ink-2">Evidence closed {formatDate(claim.evidenceDeadline, 'long')}</span>
                  )}
                  <DepthBars depth={depthQ.data} loading={depthQ.isLoading} symbol={claim.collateralSymbol} size="md" />
                </div>
                <p className="mt-4 text-[0.78rem] text-ink-3">
                  <span className="t-figure text-[0.9rem] text-ink-2">{formatAmount(claim.liquidity, { maxDecimals: 0 })}</span> {claim.collateralSymbol} liquidity,{' '}
                  <span className="t-figure text-[0.9rem] text-ink-2">{formatAmount(claim.volume, { maxDecimals: 0 })}</span> volume,{' '}
                  <span className="t-figure text-[0.9rem] text-ink-2">{claim.traders}</span> traders. {COPY.volumeCaveat}
                </p>
              </>
            ) : (
              <>
                <TensionBar size="lg" />
                <p className="mt-4 font-[650]">{claim.status === 'failed' ? 'No market was created' : 'The market is not fully set up yet'}</p>
                <p className="mt-1 text-[0.86rem] text-ink-2">
                  {claim.status === 'failed'
                    ? 'Publication stopped before the market existed, so there is nothing to trade or answer.'
                    : 'Some publication steps are still outstanding. Details and recovery are below.'}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
