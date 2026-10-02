'use client'

import { useState } from 'react'
import type { PriceRange } from '@pine/core'
import { useActivity, useClaim, useDepth, useEvidence, usePriceHistory } from '@pine/react'
import { ClaimHeader } from './ClaimHeader'
import { InvestigatePanel } from './InvestigatePanel'
import { EvidenceFeed } from './EvidenceFeed'
import { OraclePanel } from './OraclePanel'
import { TermsPanel } from './TermsPanel'
import { ActivityList } from './ActivityList'
import { ImpactSimulator } from './ImpactSimulator'
import { NextStepCard, PositionPanel } from './SidePanels'
import { PublishingPanel } from './PublishingPanel'
import { TensionChart } from '@/components/charts/TensionChart'
import { DepthChart } from '@/components/charts/DepthChart'
import { Segmented, Tab, TabList, TabPanel, Tabs } from '@/components/ui/interactive'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Skeleton } from '@/components/ui/primitives'
import { ButtonLink } from '@/components/ui/Button'
import { LifecycleRope } from '@/components/landing/Lifecycle'

export function ClaimView({ id }: { id: string }) {
  const claimQ = useClaim(id, { live: true })
  const claim = claimQ.data
  const [rangeState, setRange] = useState<PriceRange | null>(null)
  const [scale, setScale] = useState<'fit' | 'full'>('fit')
  const [depthOutcome, setDepthOutcome] = useState<'yes' | 'no'>('yes')
  const hasMarket = !!claim?.market && claim.status !== 'publishing' && claim.status !== 'failed'
  const trading = hasMarket && claim?.status !== 'resolved' && claim?.status !== 'settled'
  const range: PriceRange = rangeState ?? (claim && !trading ? 'all' : '7d')
  const history = usePriceHistory(hasMarket ? id : undefined, range)
  const depth = useDepth(trading ? id : undefined, depthOutcome)
  const evidenceQ = useEvidence(claim ? id : undefined)
  const activityQ = useActivity(claim ? { claimId: id, limit: 50 } : undefined)
  const [tabState, setTab] = useState<string | null>(null)
  const tab = tabState ?? (claim?.status === 'open' ? 'investigate' : claim?.status === 'publishing' || claim?.status === 'failed' ? 'terms' : 'evidence')

  if (claimQ.isLoading) return <ClaimSkeleton />
  if (claimQ.isError) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-16 sm:px-6">
        <ErrorState title="This claim could not be loaded" error={claimQ.error} onRetry={() => claimQ.refetch()} />
      </div>
    )
  }
  if (!claim) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-16 sm:px-6">
        <EmptyState
          title="No claim with this id"
          body="It may have been mistyped, or it only exists as a draft in someone else's browser. Published claims are permanent, so check the link."
          action={<ButtonLink href="/board">Browse open claims</ButtonLink>}
        />
      </div>
    )
  }

  const evidence = evidenceQ.data ?? claim.evidence
  const recovering = claim.status === 'publishing' || claim.status === 'failed'

  return (
    <article>
      <ClaimHeader claim={claim} />

      <div className="mx-auto max-w-[1320px] px-4 pt-8 sm:px-6">
        <div className="mb-8 hidden md:block">
          <LifecycleRope current={claim.status} compact />
        </div>

        {recovering && (
          <div className="mb-8">
            <PublishingPanel claim={claim} />
          </div>
        )}

        {!hasMarket ? (
          recovering ? null : (
            <div className="max-w-[40rem]">
              <NextStepCard claim={claim} />
            </div>
          )
        ) : (
        <>
        <div className="mb-6 lg:hidden">
          <NextStepCard claim={claim} />
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:items-start">
          <div className="grid min-w-0 content-start gap-6">
            {hasMarket && (
              <section aria-labelledby="chart-title" className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 id="chart-title" className="t-h3">
                      Tension over time
                    </h2>
                    <p className="text-[0.8rem] text-ink-3">Hatched: implied chance of an accepted counterexample. Solid: none submitted.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Segmented
                      label="Vertical scale"
                      size="sm"
                      value={scale}
                      onChange={setScale}
                      options={[
                        { value: 'fit', label: 'Fit', title: 'Zoom to the data' },
                        { value: 'full', label: '0–100%', title: 'Full scale' },
                      ]}
                    />
                    <Segmented
                      label="Chart range"
                      size="sm"
                      value={range}
                      onChange={setRange}
                      options={[
                        { value: '24h', label: '24h' },
                        { value: '7d', label: '7d' },
                        { value: '30d', label: '30d' },
                        { value: 'all', label: 'All' },
                      ]}
                    />
                  </div>
                </div>
                <TensionChart points={history.data ?? []} events={claim.timeline} range={range} fit={scale === 'fit'} loading={history.isLoading || history.isFetching} />
              </section>
            )}
            {trading && (
              <section aria-labelledby="depth-title" className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 id="depth-title" className="t-h3">
                      Executable depth
                    </h2>
                    <p className="text-[0.8rem] text-ink-3">What can actually trade near the current price, not the headline liquidity.</p>
                  </div>
                  <Segmented
                    label="Depth for token"
                    size="sm"
                    value={depthOutcome}
                    onChange={setDepthOutcome}
                    options={[
                      { value: 'yes', label: 'Yes token' },
                      { value: 'no', label: 'No token' },
                    ]}
                  />
                </div>
                <DepthChart depth={depth.data} loading={depth.isLoading} symbol={claim.collateralSymbol} />
              </section>
            )}
          </div>

          <aside className="grid min-w-0 content-start gap-6">
            <div className="hidden lg:block">
              <NextStepCard claim={claim} />
            </div>
            {trading && <ImpactSimulator claim={claim} />}
            <PositionPanel claim={claim} />
          </aside>
        </div>
        </>
        )}

        <div className="mt-12">
          <Tabs value={tab} onValueChange={setTab}>
            <TabList label="Claim sections">
              <Tab value="investigate">Investigate</Tab>
              <Tab value="evidence" count={evidence.length}>
                Evidence
              </Tab>
              <Tab value="oracle">Oracle and dispute</Tab>
              <Tab value="activity" count={activityQ.data?.items.length}>
                Activity
              </Tab>
              <Tab value="terms">Terms</Tab>
            </TabList>
            <TabPanel value="investigate">
              <InvestigatePanel claim={claim} />
            </TabPanel>
            <TabPanel value="evidence">
              <EvidenceFeed claim={claim} evidence={evidence} />
            </TabPanel>
            <TabPanel value="oracle">
              <OraclePanel claim={claim} />
            </TabPanel>
            <TabPanel value="activity">
              {activityQ.isLoading ? (
                <div className="grid gap-3">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : (activityQ.data?.items.length ?? 0) === 0 ? (
                <EmptyState title="No activity yet" body="Trades, liquidity changes, evidence and oracle answers will appear here as they happen." />
              ) : (
                <ActivityList items={activityQ.data!.items} />
              )}
            </TabPanel>
            <TabPanel value="terms">
              <TermsPanel claim={claim} />
            </TabPanel>
          </Tabs>
        </div>
      </div>
    </article>
  )
}

export function ClaimSkeleton() {
  return (
    <div aria-busy className="mx-auto max-w-[1320px] px-4 pt-6 sm:px-6">
      <span className="sr-only">Loading claim</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-5 h-5 w-64" />
      <Skeleton className="mt-4 h-10 w-3/4" />
      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-56" />
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22.5rem]">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  )
}
