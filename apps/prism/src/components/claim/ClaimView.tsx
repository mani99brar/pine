'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useClaim } from '@pine/react'
import type { ClaimDetail } from '@pine/core'
import { formatClaimNumber, OUTCOME_META, shortHash, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ArrowLeft } from 'lucide-react'
import { ClaimCrystal } from '@/components/crystal/ClaimCrystal'
import { PrismBeam, pricesFrom } from '@/components/prism/PrismBeam'
import { PriceChart } from '@/components/charts/PriceChart'
import { DepthAndImpact } from '@/components/charts/DepthChart'
import { FamilyIcon, OutcomeIcon } from '@/components/icons'
import { StatusBadge } from './StatusBadge'
import { LifecyclePath, MarketFacts, NextStepCard, StartFromTerms } from './Overview'
import { QuestionSection } from './QuestionSection'
import { EvidenceFeed } from './EvidenceFeed'
import { OraclePanel } from './OraclePanel'
import { AgentBrief, ClaimActivity } from './AgentAndActivity'
import { PositionPanel, PublishingRecovery } from './Actions'
import { ButtonLink } from '@/components/ui/Button'
import { Container, EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives'
import { FAMILY_VAR, OUTCOME_HEX } from '@/lib/crystal'
import { isResolved } from '@/lib/claims'
import { cn } from '@/lib/cn'

const SECTIONS = [
  { id: 'claim', label: 'Claim' },
  { id: 'market', label: 'Market' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'oracle', label: 'Oracle' },
  { id: 'agent', label: 'Agent brief' },
  { id: 'activity', label: 'Activity' },
]

function SectionNav() {
  const [active, setActive] = useState('claim')
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean) as HTMLElement[]
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (vis[0]) setActive(vis[0].target.id)
      },
      { rootMargin: '-30% 0px -60% 0px' },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])
  return (
    <nav aria-label="Claim sections" className="glass-float sticky top-16 z-[40] -mx-4 border-x-0 px-4 sm:mx-0 sm:border-x sm:px-2 sm:[border-radius:10px_3px_10px_3px]">
      <ul className="flex gap-1 overflow-x-auto py-2">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? 'location' : undefined}
              className={cn('block whitespace-nowrap rounded-[5px] px-3 py-1.5 text-[0.875rem] font-medium transition-colors', active === s.id ? 'bg-lumen text-umbra' : 'text-lumen-2 hover:text-lumen')}
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function OutcomeBanner({ claim }: { claim: ClaimDetail }) {
  if (!claim.outcome || !isResolved(claim.status)) return null
  const meta = OUTCOME_META[claim.outcome]
  const extra = claim.outcome === 'no' ? COPY.noIsNotSafety : claim.outcome === 'invalid' ? COPY.invalidIsNotRefund : COPY.noMergeAuthority
  return (
    <div className={cn('cut-xl relative overflow-hidden border p-5 sm:p-6', claim.outcome === 'yes' ? 'border-[rgba(255,107,131,0.45)] bg-[rgba(255,107,131,0.07)]' : claim.outcome === 'invalid' ? 'frosted border-edge bg-[rgba(220,214,232,0.05)]' : 'border-edge bg-[rgba(169,180,193,0.05)]')}>
      <p className="flex items-center gap-2.5">
        <OutcomeIcon outcome={claim.outcome} size={22} style={{ color: OUTCOME_HEX[claim.outcome] }} />
        <span className="t-h3" style={{ color: claim.outcome === 'yes' ? OUTCOME_HEX.yes : undefined }}>
          {meta.label}
        </span>
      </p>
      <p className="mt-2 max-w-[72ch] text-[0.96875rem] text-lumen-2">{meta.long}</p>
      <p className="mt-2 max-w-[72ch] text-[0.875rem] text-lumen-3">{extra}</p>
    </div>
  )
}

function Loading() {
  return (
    <Container className="pt-10" wide>
      <div className="flex gap-6">
        <Skeleton className="h-44 w-28" />
        <div className="flex-1">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-4 h-12 w-3/4" />
          <Skeleton className="mt-3 h-5 w-1/2" />
        </div>
      </div>
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <span className="sr-only" role="status">
        Loading the claim
      </span>
    </Container>
  )
}

export function ClaimView({ id }: { id: string }) {
  const q = useClaim(id, { live: true })
  const loaded = Boolean(q.data)
  // Sections render after the claim loads, so honour #evidence / #oracle links once they exist.
  useEffect(() => {
    if (!loaded || typeof window === 'undefined' || !window.location.hash) return
    const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }))
  }, [loaded])
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <Container className="pt-14">
        <ErrorState title="This claim could not be loaded" error={q.error} onRetry={() => void q.refetch()} />
      </Container>
    )
  const claim = q.data
  if (!claim)
    return (
      <Container className="pt-14">
        <EmptyState title="No claim at this address" action={<ButtonLink href="/claims">Open the light table</ButtonLink>}>
          There is no published claim with the id <span className="t-code">{id}</span>. It may have been mistyped, or it may exist only in another browser&apos;s demo data.
        </EmptyState>
      </Container>
    )

  const resolved = isResolved(claim.status)
  const unfinished = claim.status === 'publishing' || claim.status === 'failed'
  const prices = pricesFrom(claim)
  const fam = claim.policy.family

  return (
    <Container wide className="pb-10">
      <div className="pt-6">
        <Link href="/claims" className="inline-flex items-center gap-1.5 text-[0.875rem] text-lumen-3 hover:text-lumen">
          <ArrowLeft size={14} aria-hidden /> Light table
        </Link>
      </div>

      {/* Header */}
      <header className="mt-6 grid gap-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-8">
        <div className="flex justify-center sm:block">
          <ClaimCrystal claim={claim} size={212} animateFracture={claim.outcome === 'yes'} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="tnum text-[0.9375rem] font-semibold text-lumen-3">{formatClaimNumber(claim.number)}</span>
            <Link href={`/policies/${claim.policy.id}`} className="tag hover:text-lumen">
              <span style={{ color: FAMILY_VAR[fam] }}>
                <FamilyIcon family={fam} size={13} />
              </span>
              {claim.policy.id}@{claim.policy.version}
            </Link>
            <StatusBadge status={claim.status} outcome={claim.outcome} />
            {claim.sponsored && <span className="tag">Sponsored</span>}
          </div>
          <h1 className="t-h1 chroma mt-3 max-w-[26ch] [overflow-wrap:anywhere]">{claim.title}</h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.9rem] text-lumen-2">
            <a className="link" href={`https://github.com/${claim.source.owner}/${claim.source.repo}`} target="_blank" rel="noopener noreferrer nofollow">
              {claim.source.owner}/{claim.source.repo}
            </a>
            <a className="t-code link text-[0.8125rem]" href={claim.manifest.source.commit.htmlUrl} target="_blank" rel="noopener noreferrer nofollow" title={claim.source.commitSha}>
              commit {shortSha(claim.source.commitSha)}
            </a>
            {claim.manifest.source.pullRequest && (
              <a className="link" href={claim.manifest.source.pullRequest.htmlUrl} target="_blank" rel="noopener noreferrer nofollow">
                PR #{claim.manifest.source.pullRequest.number}
              </a>
            )}
            <span className="text-lumen-3">
              by {claim.creatorGithub ?? <span className="t-code">{shortHash(claim.creator)}</span>}
            </span>
          </p>
          <div className="mt-6 max-w-[48rem]">
            <LifecyclePath claim={claim} />
          </div>
        </div>
      </header>

      {/* Light split + next step */}
      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(20rem,1fr)]">
        <div className="grid content-start gap-6">
          {unfinished ? (
            <PublishingRecovery claim={claim} />
          ) : (
            <section className="glass cut-xl p-5 sm:p-7" aria-labelledby="split-title">
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
                <h2 id="split-title" className="t-h3">
                  {resolved ? 'Where the light settled' : 'The market, as light'}
                </h2>
                <p className="text-[0.8125rem] text-lumen-3">Beam widths are prices</p>
              </div>
              <PrismBeam prices={prices} outcome={resolved ? claim.outcome : undefined} noMarket={!claim.market} />
              {resolved ? (
                <p className="mt-4 text-[0.84375rem] text-lumen-2">The oracle answer is final, so the light shows only the settled outcome. Market prices no longer describe an open question.</p>
              ) : (
                <p className="mt-4 text-[0.84375rem] text-lumen-2">
                  <strong className="font-semibold text-lumen">{COPY.priceLabel}.</strong> {COPY.priceCaveat}
                </p>
              )}
            </section>
          )}
          <OutcomeBanner claim={claim} />
        </div>
        <aside className="grid content-start gap-6">
          <NextStepCard claim={claim} />
          {!unfinished && (
            <div className="flex flex-wrap gap-3">
              {claim.status === 'open' && <ButtonLink href={`/claims/${claim.id}/evidence`}>Submit evidence</ButtonLink>}
              {claim.market && (
                <ButtonLink href={claim.market.seerUrl} external variant="glass">
                  {resolved ? 'View on Seer' : 'Trade on Seer'}
                </ButtonLink>
              )}
            </div>
          )}
          {!unfinished && <PositionPanel claim={claim} />}
        </aside>
      </div>

      <div className="mt-12">
        <SectionNav />
      </div>

      <section id="claim" className="scroll-mt-32 pt-12" aria-labelledby="claim-title">
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="claim-title" className="t-h2">
            The claim
          </h2>
          <StartFromTerms claim={claim} />
        </div>
        <QuestionSection claim={claim} />
      </section>

      <section id="market" className="scroll-mt-32 pt-16" aria-labelledby="market-title">
        <h2 id="market-title" className="t-h2 mb-6">
          Market
        </h2>
        {claim.market ? (
          <div className="grid gap-6">
            <div className="glass cut-xl p-5 sm:p-6">
              <PriceChart claimId={claim.id} evidence={claim.evidence} deadline={claim.evidenceDeadline} />
            </div>
            <div className="glass cut-xl p-5 sm:p-6">
              <DepthAndImpact claimId={claim.id} collateral={claim.collateralSymbol} />
            </div>
            <div className="glass cut-xl p-5 sm:p-6">
              <MarketFacts claim={claim} />
            </div>
          </div>
        ) : (
          <EmptyState title="No market yet">The market does not exist yet, so there is no price, depth or volume. Finish publishing to create it.</EmptyState>
        )}
      </section>

      <section id="evidence" className="scroll-mt-32 pt-16" aria-labelledby="evidence-title">
        <h2 id="evidence-title" className="t-h2 mb-4">
          Evidence
        </h2>
        <EvidenceFeed claim={claim} />
      </section>

      <section id="oracle" className="scroll-mt-32 pt-16" aria-labelledby="oracle-title">
        <h2 id="oracle-title" className="t-h2 mb-6">
          Oracle and arbitration
        </h2>
        <OraclePanel claim={claim} />
      </section>

      <section id="agent" className="scroll-mt-32 pt-16" aria-labelledby="agent-title">
        <h2 id="agent-title" className="t-h2 mb-6">
          Agent brief
        </h2>
        <AgentBrief claim={claim} />
      </section>

      <section id="activity" className="scroll-mt-32 pt-16" aria-labelledby="activity-title">
        <h2 id="activity-title" className="t-h2 mb-6">
          Activity
        </h2>
        <ClaimActivity claim={claim} />
      </section>
    </Container>
  )
}
