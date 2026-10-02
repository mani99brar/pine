'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ClipboardCopy, FileUp, GitCommitHorizontal, GitPullRequest } from 'lucide-react'
import type { ClaimDetail } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { formatClaimNumber, formatDate, shortSha, timeRemaining } from '@pine/core'
import { useActivity, useClaim } from '@pine/react'
import { cn } from '@/lib/cn'
import { useKeys } from '@/lib/use-keys'
import { useNowTick } from '@/lib/use-now'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useClipboard } from '@/components/ui/copy-button'
import { EmptyState } from '@/components/ui/empty-state'
import { ExternalLink } from '@/components/ui/external-link'
import { HashChip } from '@/components/ui/hash-chip'
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { useClaimContext } from '@/components/shell/workbench'
import { StatusBadge } from './status'
import { OverviewTab } from './overview-tab'
import { MarketTab } from './market-tab'
import { EvidenceTab } from './evidence-tab'
import { OracleTab } from './oracle-tab'
import { AgentTab, useAgentArtifacts } from './agent-tab'
import { ActivityTable } from './activity-table'
import { FailedPanel, NextStepCard, OutcomePanel, PositionPanel, RecoveryPanel } from './state-panels'

import { CLAIM_TABS, type ClaimTab } from '@/lib/claim-tabs'

export function ClaimWorkspace({ id, initialTab }: { id: string; initialTab: ClaimTab }) {
  const q = useClaim(id, { live: true })
  const [tab, setTabState] = React.useState<ClaimTab>(initialTab)
  const now = useNowTick(15_000)

  if (q.isLoading) return <WorkspaceSkeleton />
  if (q.isError)
    return (
      <EmptyState
        tone="error"
        title="This claim could not be loaded"
        action={
          <Button variant="secondary" onClick={() => void q.refetch()}>
            Retry
          </Button>
        }
      >
        {(q.error as Error)?.message ?? 'The data source did not respond.'}
      </EmptyState>
    )
  if (!q.data)
    return (
      <EmptyState
        title={`No claim with id “${id}”`}
        action={
          <>
            <Button asChild variant="secondary">
              <Link href="/claims">Browse claims</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/new">Verify a commit</Link>
            </Button>
          </>
        }
      >
        It may have been published from another browser in demo mode, or the id is mistyped. Claim ids look like pine-0042.
      </EmptyState>
    )
  return <Loaded claim={q.data} tab={tab} setTabState={setTabState} now={now} />
}

function Loaded({
  claim,
  tab,
  setTabState,
  now,
}: {
  claim: ClaimDetail
  tab: ClaimTab
  setTabState: (t: ClaimTab) => void
  now: Date
}) {
  const router = useRouter()
  const { copy } = useClipboard()
  const artifacts = useAgentArtifacts(claim)
  const activity = useActivity({ claimId: claim.id, limit: 100 })
  const number = formatClaimNumber(claim.number)

  useClaimContext({ id: claim.id, number: claim.number, title: claim.title, status: claim.status })

  const setTab = React.useCallback(
    (t: ClaimTab) => {
      setTabState(t)
      const url = new URL(window.location.href)
      if (t === 'overview') url.searchParams.delete('tab')
      else url.searchParams.set('tab', t)
      window.history.replaceState(null, '', url.pathname + url.search)
    },
    [setTabState],
  )

  const copyBrief = React.useCallback(() => {
    if (artifacts) void copy(artifacts.markdown, `agent brief for ${number}`)
  }, [artifacts, copy, number])

  React.useEffect(() => {
    const h = () => copyBrief()
    window.addEventListener('pine:copy-brief', h)
    return () => window.removeEventListener('pine:copy-brief', h)
  }, [copyBrief])

  const keys: Record<string, () => void> = { b: copyBrief }
  CLAIM_TABS.forEach((t, i) => (keys[String(i + 1)] = () => setTab(t)))
  if (claim.status === 'open') keys.e = () => router.push(`/claims/${claim.id}/evidence/new`)
  useKeys(keys)

  const deadline = timeRemaining(claim.evidenceDeadline, now)
  const src = claim.manifest.source

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as ClaimTab)} className="flex min-h-full flex-col">
      <header className="border-b border-line bg-surface px-4 pb-0 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="mono-cond text-[12px] text-muted">{number}</span>
          <StatusBadge status={claim.status} outcome={claim.outcome} size="md" />
          {claim.status === 'open' ? (
            <span className={cn('tnum text-[13px]', deadline.ms < 48 * 3600_000 ? 'font-medium text-resin' : 'text-muted')}>
              Evidence closes in {deadline.label}
              <span className="ml-1.5 hidden text-muted sm:inline">({formatDate(claim.evidenceDeadline, 'utc')})</span>
            </span>
          ) : null}
          {claim.sponsored ? <span className="rounded-chip border border-line px-1.5 text-[11.5px] text-muted">sponsored</span> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" kbd="b" onClick={copyBrief} className="hidden sm:inline-flex">
              <ClipboardCopy size={13} aria-hidden /> Copy agent brief
            </Button>
            {claim.status === 'open' ? (
              <Button asChild variant="primary" size="sm">
                <Link href={`/claims/${claim.id}/evidence/new`}>
                  <FileUp size={13} aria-hidden /> Submit evidence
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
        <h1 className="stretch-wide mt-2 max-w-[60ch] text-[22px] font-[650] leading-[1.2] tracking-[-0.005em] sm:text-[26px]">{claim.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted">
          <ExternalLink href={src.commit.htmlUrl} icon={false} className="text-bark hover:text-needle">
            <GitCommitHorizontal size={14} aria-hidden className="text-faint" />
            <span className="mono-cond text-[12px]">
              {src.owner}/{src.repo}@{shortSha(src.commit.sha)}
            </span>
          </ExternalLink>
          {src.pullRequest ? (
            <ExternalLink href={src.pullRequest.htmlUrl} icon={false} className="min-w-0 text-bark hover:text-needle">
              <GitPullRequest size={14} aria-hidden className="text-faint" />
              <span className="truncate">
                #{src.pullRequest.number} <span className="wrap-anywhere">{src.pullRequest.title}</span>
              </span>
            </ExternalLink>
          ) : null}
          <Link href={`/policies/${claim.policy.id}?version=${claim.policy.version}`} className="mono-cond text-[12px] text-bark hover:text-needle">
            {claim.policy.id}@{claim.policy.version}
          </Link>
          <HashChip label="manifest" value={claim.manifestHash} />
        </div>
        <div className="mt-3">
          <TabsList
            className="-mx-4 border-b-0 px-2 sm:-mx-6 sm:px-4"
            tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'market', label: 'Market' },
              { value: 'evidence', label: 'Evidence', count: claim.evidence.length },
              { value: 'oracle', label: 'Oracle', alert: claim.status === 'answer_proposed' || claim.status === 'disputed' || claim.status === 'arbitration' },
              { value: 'agent', label: 'Agent' },
              { value: 'activity', label: 'Activity' },
            ]}
            trailing={
              <span className="ml-auto hidden shrink-0 items-center gap-1 self-center pr-2 text-[11.5px] text-muted lg:flex">
                <Kbd>1</Kbd>–<Kbd>6</Kbd> tabs <Kbd className="ml-2">e</Kbd> evidence <Kbd className="ml-2">b</Kbd> brief
              </span>
            }
          />
        </div>
      </header>

      <OutcomePanel claim={claim} />
      <RecoveryPanel claim={claim} />
      <FailedPanel claim={claim} />

      <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
        <div className="min-w-0 flex-1 bg-surface">
            <TabsContent value="overview" className="focus:outline-none">
              <OverviewTab claim={claim} now={now} />
            </TabsContent>
            <TabsContent value="market" className="focus:outline-none">
              <MarketTab claim={claim} />
            </TabsContent>
            <TabsContent value="evidence" className="focus:outline-none">
              <EvidenceTab claim={claim} />
            </TabsContent>
            <TabsContent value="oracle" className="focus:outline-none">
              <OracleTab claim={claim} now={now} />
            </TabsContent>
            <TabsContent value="agent" className="focus:outline-none">
              <AgentTab claim={claim} />
            </TabsContent>
            <TabsContent value="activity" className="focus:outline-none">
              {activity.isLoading ? (
                <SkeletonRows rows={5} />
              ) : activity.data?.items.length ? (
                <ActivityTable items={activity.data.items} />
              ) : (
                <EmptyState title="No on-chain activity recorded yet">Market creation, liquidity, trades, evidence and oracle answers appear here as they are indexed.</EmptyState>
              )}
            </TabsContent>
        </div>
        <aside className="shrink-0 divide-y divide-line border-t border-line bg-frost xl:w-[320px] xl:border-l xl:border-t-0" aria-label="Claim status">
          <NextStepCard claim={claim} now={now} />
          <PositionPanel claim={claim} />
          <div className="space-y-2 px-4 py-4 text-[12px] text-muted">
            <p>{COPY.noMergeAuthority}</p>
            <p>{COPY.notAReview}</p>
          </div>
        </aside>
      </div>
    </Tabs>
  )
}

function WorkspaceSkeleton() {
  return (
    <div role="status" aria-label="Loading claim">
      <div className="border-b border-line bg-surface px-4 pb-3 pt-4 sm:px-6">
        <div className="flex gap-3">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-6 w-36" />
        </div>
        <Skeleton className="mt-3 h-7 w-[min(560px,90%)]" />
        <Skeleton className="mt-3 h-4 w-[min(420px,80%)]" />
        <div className="mt-4 flex gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-16" />
          ))}
        </div>
      </div>
      <div className="flex">
        <div className="flex-1 space-y-4 bg-surface p-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <div className="hidden w-[320px] space-y-3 border-l border-line p-4 xl:block">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  )
}
