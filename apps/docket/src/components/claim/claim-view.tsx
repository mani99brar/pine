'use client'

import Link from 'next/link'
import { useMemo, type ReactNode } from 'react'
import type { ClaimDetail } from '@pine/core'
import { formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useClaim, usePine } from '@pine/react'
import { FilePlus2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { procedureFor } from '@/lib/procedure'
import { questionAnnotations } from '@/lib/annotations'
import { Page, Skeleton, EmptyState } from '@/components/ui/layout'
import { ButtonLink } from '@/components/ui/button'
import { HashValue } from '@/components/ui/copy'
import { Notice } from '@/components/ui/notice'
import { ClaimHeader } from './claim-header'
import { ProcedureRail, ProcedureStrip } from './procedure'
import { WhereThisStands } from './standing'
import { AnnotatedQuestion } from './annotated-question'
import { TermsOnRecord } from './terms'
import { Exhibit } from './exhibits'
import { OracleSection, OutcomeSection } from './oracle'
import { MarketSection } from './market'
import { PositionSection } from './position'
import { AgentBriefSection } from './agent-brief'
import { RecordSection } from './record'
import { PublicationRecovery } from './publication'

function DocSection({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('scroll-mt-6 border-t-2 border-ink pt-6', className)}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 max-w-[46rem]">
          <h2 id={`${id}-title`} className="text-2xl">
            {title}
          </h2>
          {description ? <p className="mt-1 text-graphite">{description}</p> : null}
        </div>
        {action ? <div className="print:hidden">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

const MORE_LINKS = [
  { href: '#question', label: 'The question on record' },
  { href: '#market', label: 'Market' },
  { href: '#agent', label: 'Agent brief' },
  { href: '#record', label: 'The record' },
]

export function ClaimView({ id, initial }: { id: string; initial: ClaimDetail | null }) {
  const q = useClaim(id, { live: true })
  const claim = q.data ?? initial
  if (!claim) {
    if (q.isLoading) return <ClaimSkeleton />
    return (
      <Page>
        <EmptyState
          title="No claim is on the docket under this number"
          action={
            <>
              <ButtonLink href="/docket">Search the docket</ButtonLink>
              <ButtonLink href="/file" variant="secondary">
                File a verification
              </ButtonLink>
            </>
          }
        >
          Check the docket number. Claims you filed in demo mode live only in the browser where you filed them.
        </EmptyState>
      </Page>
    )
  }
  return <ClaimDocument claim={claim} />
}

function ClaimDocument({ claim }: { claim: ClaimDetail }) {
  const { storage } = usePine()
  const stages = useMemo(() => procedureFor(claim), [claim])
  const annotations = useMemo(() => questionAnnotations(claim.manifest), [claim.manifest])
  const gateway = (uri: string) => {
    try {
      return storage.gatewayUrl(uri)
    } catch {
      return uri
    }
  }
  const timely = claim.evidence.filter((e) => e.timely)
  const late = claim.evidence.filter((e) => !e.timely)
  const ordered = [...timely, ...late]

  return (
    <Page>
      <ClaimHeader claim={claim} />
      <ProcedureStrip stages={stages} className="mb-6 lg:hidden print:hidden" />
      <div className="lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-10 xl:gap-12">
        <aside className="hidden lg:block print:hidden">
          <div className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto pb-6">
            <ProcedureRail stages={stages} />
            <nav aria-label="More on this page" className="mt-6 border-t border-rule pt-4">
              <h2 className="text-sm font-bold text-graphite">Also on this page</h2>
              <ul className="mt-2 space-y-1.5 text-[15px]">
                {MORE_LINKS.map((l) => (
                  <li key={l.href}>
                    <a href={l.href} className="link">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </aside>

        <article className="min-w-0 space-y-12 border border-rule bg-sheet px-4 py-6 sm:px-8 sm:py-8 xl:px-12 xl:py-10" data-print="flat">
          <WhereThisStands claim={claim} />

          {claim.status === 'publishing' || claim.status === 'failed' ? (
            <DocSection
              id="filing"
              title={claim.status === 'failed' ? 'Filing failed' : 'Finish filing'}
              description="Filing happens in ordered steps. Confirmed steps are not repeated."
            >
              <PublicationRecovery claim={claim} />
            </DocSection>
          ) : null}

          <DocSection
            id="question"
            title="The question on record"
            description="Exactly what the oracle will answer. It is hashed and cannot change. Hover or focus a marked term to see what binds."
          >
            <AnnotatedQuestion text={claim.manifest.question.text} annotations={annotations} idPrefix="claim-q" />
            <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-graphite">
              <span>
                Outcomes: {claim.manifest.question.outcomes.join(', ')}, and Invalid result (added by Seer)
              </span>
              <span className="inline-flex items-center gap-1">
                Question hash <HashValue value={claim.manifest.question.hash} display={shortHash(claim.manifest.question.hash, 8)} label="question hash" />
              </span>
            </div>
          </DocSection>

          <DocSection id="terms" title="Terms on record" description="Everything the question refers to, as frozen in the manifest when the market was created.">
            <TermsOnRecord
              manifest={claim.manifest}
              manifestUri={claim.manifestUri}
              manifestHash={claim.manifestHash}
              gatewayUrl={claim.manifestUri ? gateway(claim.manifestUri) : undefined}
            />
          </DocSection>

          <DocSection
            id="exhibits"
            title={`Exhibits${claim.evidence.length ? ` (${claim.evidence.length})` : ''}`}
            description={
              <>
                Exhibits filed before <strong className="text-ink">{formatDate(claim.evidenceDeadline, 'long')}</strong> are timely. The block
                timestamp decides, not the time an exhibit was written.
              </>
            }
            action={
              claim.status === 'open' ? (
                <ButtonLink href={`/claims/${claim.id}/evidence`} icon={<FilePlus2 aria-hidden />}>
                  File an exhibit
                </ButtonLink>
              ) : null
            }
          >
            {ordered.length === 0 ? (
              <EmptyState
                title="No exhibits on file"
                action={
                  claim.status === 'open' ? (
                    <ButtonLink href={`/claims/${claim.id}/evidence`} variant="secondary">
                      File the first exhibit
                    </ButtonLink>
                  ) : null
                }
              >
                {claim.status === 'open'
                  ? 'Anyone may investigate the pinned commit and file a reproducible counterexample before the deadline.'
                  : 'Nobody filed an exhibit before the deadline.'}
              </EmptyState>
            ) : (
              <div className="space-y-5">
                <p className="text-sm text-graphite measure">
                  {COPY.evidenceIsNotPayment} Exhibits are lettered in filing order; late filings are listed last.
                </p>
                {ordered.map((e, i) => (
                  <Exhibit key={e.id} evidence={e} index={i} gatewayUrl={gateway} />
                ))}
              </div>
            )}
          </DocSection>

          <DocSection id="oracle" title="Oracle answer and disputes" description="Who answers the question, how an answer can be challenged, and what arbitration costs.">
            <OracleSection claim={claim} />
          </DocSection>

          <DocSection id="outcome" title="Outcome">
            <OutcomeSection claim={claim} />
          </DocSection>

          <DocSection id="market" title="Market" description="Prices come from trading on Seer. Read them after the procedure, not instead of it.">
            <MarketSection claim={claim} />
          </DocSection>

          <DocSection id="position" title="Funding and your position">
            <PositionSection claim={claim} />
          </DocSection>

          <DocSection id="agent" title="Agent brief" className="print:hidden">
            <AgentBriefSection claim={claim} />
          </DocSection>

          <DocSection id="record" title="The record">
            <RecordSection claim={claim} />
          </DocSection>

          <Notice tone="neutral" className="print-avoid-break">
            {COPY.noMergeAuthority} {COPY.noAttackAuthorization}
          </Notice>
          <p className="text-sm text-graphite">
            Looking for related work? <Link href={`/docket?repo=${claim.source.owner}/${claim.source.repo}`} className="link">Other claims on {claim.source.owner}/{claim.source.repo}</Link>
          </p>
        </article>
      </div>
    </Page>
  )
}

export function ClaimSkeleton() {
  return (
    <Page>
      <div aria-busy="true" aria-label="Loading claim" className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="mt-8 lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)] lg:gap-10">
          <div className="hidden space-y-4 lg:block">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <div className="space-y-4 border border-rule bg-sheet p-8">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </div>
    </Page>
  )
}
