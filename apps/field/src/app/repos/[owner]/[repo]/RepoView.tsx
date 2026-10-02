'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { CommitSummary, PullSummary } from '@pine/core'
import { formatClaimNumber, formatRelative, shortSha } from '@pine/core'
import { useClaims, useGitHubCommits, useGitHubPullCommits, useGitHubPulls, useGitHubRepo } from '@pine/react'
import { ChevronRight, GitBranch, GitCommitHorizontal, GitPullRequest, Lock, Plus } from 'lucide-react'
import { ClaimTile } from '@/components/board/ClaimTile'
import { ExternalLink, Segmented } from '@/components/ui/interactive'
import { ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Note, Skeleton } from '@/components/ui/primitives'
import { useDepthMap, useUrlState } from '@/lib/hooks'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

function CommitRow({
  c,
  owner,
  repo,
  pr,
  claimed,
}: {
  c: CommitSummary
  owner: string
  repo: string
  pr?: PullSummary
  claimed?: { id: string; number: number }
}) {
  const now = useNowMs()
  const first = c.message.split('\n')[0] ?? ''
  const source = pr ? `https://github.com/${owner}/${repo}/pull/${pr.number}/commits/${c.sha}` : `${owner}/${repo}@${c.sha}`
  return (
    <li className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="flex items-start gap-2">
          <GitCommitHorizontal size={15} aria-hidden className="mt-1 shrink-0 text-ink-3" />
          <span className="untrusted min-w-0 font-[600] [white-space:normal]">{first || '(no message)'}</span>
        </p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-6 text-[0.78rem] text-ink-3">
          <code className="t-code text-ink-2">{shortSha(c.sha)}</code>
          <span>{c.author.login ?? c.author.name}</span>
          <span>{now === null ? '' : formatRelative(c.author.date, new Date(now))}</span>
          {c.stats && (
            <span>
              +{c.stats.additions} −{c.stats.deletions}
            </span>
          )}
          {c.verified && <span title="GitHub signature verification, not a Pine verdict">signed</span>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6 sm:pl-0">
        {claimed && (
          <Link href={`/claims/${claimed.id}`} className="rounded-full bg-fog-2 px-2.5 py-1 text-[0.75rem] font-[650] hover:underline">
            On the board: {formatClaimNumber(claimed.number)}
          </Link>
        )}
        <ButtonLink href={`/compose?source=${encodeURIComponent(source)}`} size="sm" variant={pr ? 'primary' : 'secondary'} icon={<Plus size={14} aria-hidden />}>
          Put this commit on the board
        </ButtonLink>
      </div>
    </li>
  )
}

export function RepoView({ owner, repo }: { owner: string; repo: string }) {
  const [s, set] = useUrlState(['pr', 'state'] as const)
  const prState = (s.state === 'closed' || s.state === 'all' ? s.state : 'open') as 'open' | 'closed' | 'all'
  const repoQ = useGitHubRepo(owner, repo)
  const pulls = useGitHubPulls(owner, repo, prState)
  const prNumber = s.pr ? Number(s.pr) : undefined
  const selectedPr = pulls.data?.find((p) => p.number === prNumber)
  const prCommits = useGitHubPullCommits(owner, repo, prNumber)
  const branchCommits = useGitHubCommits(owner, repo)
  const claimsQ = useClaims({ repo: `${owner}/${repo}`, limit: 50 })
  const claims = useMemo(() => claimsQ.data?.items ?? [], [claimsQ.data])
  const depth = useDepthMap(claims.map((c) => c.id))
  const bySha = useMemo(() => new Map(claims.map((c) => [c.source.commitSha.toLowerCase(), { id: c.id, number: c.number }])), [claims])
  const [view, setView] = useState<'prs' | 'branch'>('prs')
  const now = useNowMs()

  if (repoQ.isLoading) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-6" aria-busy>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="mt-8 h-64" />
      </div>
    )
  }
  if (repoQ.isError || !repoQ.data) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6">
        <ErrorState title={`${owner}/${repo} could not be found`} error={repoQ.error ?? 'The repository does not exist or is private. Pine supports public repositories only.'}>
          <ButtonLink href="/repos" variant="secondary" size="sm" className="mt-4">
            Back to repositories
          </ButtonLink>
        </ErrorState>
      </div>
    )
  }
  const r = repoQ.data
  const commits = view === 'branch' ? branchCommits : prCommits

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-6 sm:px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[0.84rem] text-ink-3">
        <Link href="/repos" className="hover:text-ink hover:underline">
          Repositories
        </Link>
        <ChevronRight size={13} aria-hidden />
        <span className="text-ink-2" aria-current="page">
          {r.fullName}
        </span>
      </nav>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="t-h1 [overflow-wrap:anywhere]">{r.fullName}</h1>
          {r.description && <p className="untrusted mt-2 max-w-[70ch] text-ink-2 [white-space:normal]">{r.description}</p>}
        </div>
        <ExternalLink href={r.htmlUrl}>Open on GitHub</ExternalLink>
      </div>
      {r.private && (
        <Note tone="caution" className="mt-4" icon={<Lock size={15} aria-hidden />}>
          Private repositories are not supported yet. Pine verifies public code only.
        </Note>
      )}

      {claims.length > 0 && (
        <section className="mt-8" aria-labelledby="repo-claims">
          <h2 id="repo-claims" className="t-h3">
            Already on the board
          </h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {claims.map((c) => (
              <li key={c.id} className="flex">
                <ClaimTile claim={c} depth={depth.map[c.id]} depthLoading={depth.loading[c.id]} className="w-full" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Segmented
          label="Source of commits"
          value={view}
          onChange={setView}
          options={[
            { value: 'prs', label: <><GitPullRequest size={14} aria-hidden />Pull requests</> },
            { value: 'branch', label: <><GitBranch size={14} aria-hidden />{r.defaultBranch}</> },
          ]}
        />
        {view === 'prs' && (
          <Segmented
            size="sm"
            label="Pull request state"
            value={prState}
            onChange={(v) => set({ state: v === 'open' ? null : v, pr: null })}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'closed', label: 'Closed' },
              { value: 'all', label: 'All' },
            ]}
          />
        )}
      </div>

      <div className={cn('mt-5 grid gap-6', view === 'prs' && 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]')}>
        {view === 'prs' && (
          <section aria-labelledby="prs-title" className="min-w-0">
            <h2 id="prs-title" className="sr-only">
              Pull requests
            </h2>
            {pulls.isLoading ? (
              <div className="grid gap-2">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : pulls.isError ? (
              <ErrorState error={pulls.error} onRetry={() => pulls.refetch()} />
            ) : (pulls.data?.length ?? 0) === 0 ? (
              <EmptyState title={`No ${prState === 'all' ? '' : prState + ' '}pull requests`} body={`Pick a commit from ${r.defaultBranch} instead.`} />
            ) : (
              <ul className="grid gap-2" role="list">
                {pulls.data!.map((p) => {
                  const active = p.number === prNumber
                  return (
                    <li key={p.number}>
                      <button
                        type="button"
                        onClick={() => set({ pr: String(p.number) })}
                        aria-pressed={active}
                        className={cn(
                          'w-full rounded-[var(--radius-tile)] border bg-sheet px-4 py-3 text-left transition-colors',
                          active ? 'border-ink shadow-[0_0_0_1px_var(--ink)]' : 'border-line hover:border-ink',
                        )}
                      >
                        <p className="flex items-start gap-2">
                          <GitPullRequest size={15} aria-hidden className="mt-1 shrink-0 text-ink-3" />
                          <span className="untrusted min-w-0 font-[620] [white-space:normal]">
                            <span className="t-figure mr-1.5 text-ink-2">#{p.number}</span>
                            {p.title}
                          </span>
                        </p>
                        <p className="mt-1 flex flex-wrap gap-x-3 pl-6 text-[0.78rem] text-ink-3">
                          <span>{p.state}{p.draft ? ', draft' : ''}</span>
                          <span>{p.author.login}</span>
                          <span>
                            {p.commits} {p.commits === 1 ? 'commit' : 'commits'}
                          </span>
                          <span>
                            +{p.additions} −{p.deletions}
                          </span>
                          <span>{now === null ? '' : formatRelative(p.updatedAt, new Date(now))}</span>
                        </p>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="commits-title" className="min-w-0">
          <h2 id="commits-title" className="t-h3 mb-3">
            {view === 'branch' ? `Recent commits on ${r.defaultBranch}` : selectedPr ? `Commits in #${selectedPr.number}` : 'Commits'}
          </h2>
          {view === 'prs' && !prNumber ? (
            <EmptyState title="Choose a pull request" body="Its commits appear here. You pin one exact commit; later pushes to the pull request need a new claim." />
          ) : commits.isLoading ? (
            <Skeleton className="h-40" />
          ) : commits.isError ? (
            <ErrorState error={commits.error} onRetry={() => commits.refetch()} />
          ) : (commits.data?.length ?? 0) === 0 ? (
            <EmptyState title="No commits found" />
          ) : (
            <ul className="divide-y divide-line rounded-[var(--radius-tile)] border border-line bg-sheet">
              {[...commits.data!].reverse().map((c) => (
                <CommitRow key={c.sha} c={c} owner={owner} repo={repo} pr={view === 'prs' ? selectedPr : undefined} claimed={bySha.get(c.sha.toLowerCase())} />
              ))}
            </ul>
          )}
          {view === 'prs' && selectedPr && <p className="mt-2 text-[0.78rem] text-ink-3">Newest first. The pull request&apos;s base commit is pinned too, for regression-only claims.</p>}
        </section>
      </div>
    </div>
  )
}
