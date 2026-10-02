'use client'

import * as React from 'react'
import Link from 'next/link'
import { GitCommitHorizontal, GitPullRequest, Search, Star } from 'lucide-react'
import type { CommitSummary, PullSummary, RepoSummary } from '@pine/core'
import { formatClaimNumber, formatRelative, shortSha } from '@pine/core'
import {
  useClaims,
  useGitHubCommits,
  useGitHubPull,
  useGitHubPullCommits,
  useGitHubPulls,
  useGitHubRepo,
  useGitHubRepoSearch,
  useGitHubViewerRepos,
} from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ExternalLink } from '@/components/ui/external-link'
import { Input, Segmented } from '@/components/ui/field'
import { PageHeader } from '@/components/ui/page-header'
import { Pane } from '@/components/ui/pane'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { SkeletonRows } from '@/components/ui/skeleton'
import { StatusDot, statusLabel } from '@/components/claim/status'

const firstLine = (m: string) => m.split('\n')[0] ?? m

function verifyHref(owner: string, repo: string, sha: string, pr?: number) {
  const src = pr ? `https://github.com/${owner}/${repo}/pull/${pr}/commits/${sha}` : `${owner}/${repo}@${sha}`
  return `/new?source=${encodeURIComponent(src)}`
}

function ghError(e: unknown) {
  const err = e as { status?: number; message?: string } | null
  if (err?.status === 429) return 'GitHub rate limit reached. Wait a minute and retry, or sign in with GitHub for a higher limit.'
  if (err?.status === 404) return 'Not found on GitHub. Pine reads public repositories only.'
  return err?.message ?? 'GitHub did not respond.'
}

function RepoRow({ r }: { r: RepoSummary }) {
  return (
    <li>
      <Link href={`/repos/${r.owner}/${r.name}`} className="flex items-start gap-3 px-4 py-3 hover:bg-frost sm:px-6">
        <span className="min-w-0 flex-1">
          <span className="mono-cond block truncate text-[13px] font-medium">{r.fullName}</span>
          <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{r.description ?? 'No description'}</span>
          <span className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-muted">
            {r.language ? <span>{r.language}</span> : null}
            <span className="flex items-center gap-1">
              <Star size={11} aria-hidden /> {r.stars.toLocaleString('en-US')}
            </span>
            {typeof r.openPullRequests === 'number' ? <span>{r.openPullRequests} open PRs</span> : null}
            {r.license ? <span>{r.license}</span> : null}
            <span>updated {formatRelative(r.updatedAt)}</span>
          </span>
        </span>
      </Link>
    </li>
  )
}

export function ReposIndex() {
  const [q, setQ] = React.useState('')
  const viewer = useGitHubViewerRepos({ limit: 50 })
  const search = useGitHubRepoSearch(q)
  const searching = q.trim().length >= 2
  const list = searching ? (search.data ?? []) : (viewer.data?.items ?? [])
  const loading = searching ? search.isLoading : viewer.isLoading
  const error = searching ? search.error : viewer.error
  return (
    <div>
      <PageHeader
        title="Repositories"
        description="Browse public repositories, then a pull request or branch, then the exact commit to verify. Pine never writes to GitHub."
        actions={
          <div className="relative w-[min(340px,100%)]">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input data-slash-focus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search public repositories" className="pl-8" aria-label="Search repositories" />
          </div>
        }
      />
      <Pane title={searching ? `Results for “${q.trim()}”` : 'Your repositories'} className="border-0">
        {loading ? (
          <SkeletonRows rows={5} />
        ) : error ? (
          <EmptyState
            tone="error"
            title="Repositories could not be loaded"
            action={
              <Button variant="secondary" onClick={() => void (searching ? search.refetch() : viewer.refetch())}>
                Retry
              </Button>
            }
          >
            {ghError(error)}
          </EmptyState>
        ) : list.length === 0 ? (
          <EmptyState title={searching ? 'No public repositories match' : 'No repositories yet'}>
            {searching ? 'Try the owner name, or paste a pull request URL into the command palette (⌘K).' : 'Sign in with GitHub to list your public repositories, or search above.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((r) => (
              <RepoRow key={r.id} r={r} />
            ))}
          </ul>
        )}
      </Pane>
    </div>
  )
}

function CommitRow({ c, owner, repo, pr, head }: { c: CommitSummary; owner: string; repo: string; pr?: number; head?: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
      <GitCommitHorizontal size={14} aria-hidden className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <ExternalLink href={c.htmlUrl} icon={false} className="mono-cond shrink-0 text-[11.5px] text-bark hover:text-needle">
            {shortSha(c.sha)}
          </ExternalLink>
          {head ? <span className="rounded-chip bg-sunken px-1 text-[11px] text-muted">head</span> : null}
          <span className="wrap-anywhere line-clamp-1 text-[13.5px]">{firstLine(c.message)}</span>
        </span>
        <span className="text-[12px] text-muted">
          {c.author.login ?? c.author.name}, {formatRelative(c.author.date)}
          {c.stats ? (
            <span className="ml-2">
              <span className="text-needle">+{c.stats.additions}</span> <span className="text-flare">−{c.stats.deletions}</span>
            </span>
          ) : null}
        </span>
      </span>
      <Button asChild size="sm" variant={head ? 'primary' : 'secondary'}>
        <Link href={verifyHref(owner, repo, c.sha, pr)}>Verify this commit</Link>
      </Button>
    </li>
  )
}

function ClaimsForRepo({ owner, repo, pr }: { owner: string; repo: string; pr?: number }) {
  const claims = useClaims({ repo: `${owner}/${repo}`, limit: 50 })
  const items = (claims.data?.items ?? []).filter((c) => !pr || c.source.prNumber === pr)
  if (claims.isLoading) return <SkeletonRows rows={2} />
  if (!items.length) return <p className="px-4 py-4 text-[13px] text-muted sm:px-6">No claims published for this {pr ? 'pull request' : 'repository'} yet.</p>
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.id}>
          <Link href={`/claims/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-frost sm:px-6">
            <StatusDot status={c.status} outcome={c.outcome} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
              <span className="mono-cond text-[11px] text-muted">
                {formatClaimNumber(c.number)} @{shortSha(c.source.commitSha)} {c.policy.id}
              </span>
            </span>
            <span className="text-[12px] text-muted">{statusLabel(c.status, c.outcome)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function PullRow({ p, owner, repo }: { p: PullSummary; owner: string; repo: string }) {
  return (
    <li>
      <Link href={`/repos/${owner}/${repo}/pull/${p.number}`} className="flex items-start gap-3 px-4 py-3 hover:bg-frost sm:px-6">
        <GitPullRequest size={15} aria-hidden className={cn('mt-0.5 shrink-0', p.state === 'open' ? 'text-needle' : p.state === 'merged' ? 'text-violet' : 'text-muted')} />
        <span className="min-w-0 flex-1">
          <span className="wrap-anywhere line-clamp-2 block text-[14px] font-medium">{p.title}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-muted">
            <span>#{p.number}</span>
            <span>{p.draft ? 'draft' : p.state}</span>
            <span>by {p.author.login}</span>
            <span>
              {p.commits} commits, <span className="text-needle">+{p.additions}</span> <span className="text-flare">−{p.deletions}</span>
            </span>
            <span>updated {formatRelative(p.updatedAt)}</span>
            {p.labels.slice(0, 3).map((l) => (
              <span key={l} className="rounded-chip border border-line px-1 text-[11px]">
                {l}
              </span>
            ))}
          </span>
        </span>
        <span className="mono-cond hidden text-[11.5px] text-muted sm:block">head {shortSha(p.headSha)}</span>
      </Link>
    </li>
  )
}

export function RepoDetail({ owner, repo }: { owner: string; repo: string }) {
  const r = useGitHubRepo(owner, repo)
  const [state, setState] = React.useState<'open' | 'closed' | 'all'>('open')
  const pulls = useGitHubPulls(owner, repo, state)
  const commits = useGitHubCommits(owner, repo, r.data?.defaultBranch)
  if (r.isError)
    return (
      <EmptyState tone="error" title={`Could not open ${owner}/${repo}`} action={<Button asChild variant="secondary"><Link href="/repos">All repositories</Link></Button>}>
        {ghError(r.error)}
      </EmptyState>
    )
  return (
    <div>
      <PageHeader
        title={<span className="mono-cond text-[24px] font-semibold sm:text-[28px]">{owner}/{repo}</span>}
        description={r.data?.description ?? (r.isLoading ? 'Loading…' : undefined)}
        actions={<ExternalLink href={`https://github.com/${owner}/${repo}`}>Open on GitHub</ExternalLink>}
      />
      <div className="grid grid-cols-1 bg-surface xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:divide-x xl:divide-line">
        <Pane
          title="Pull requests"
          className="border-0"
          actions={
            <Segmented
              label="State"
              size="xs"
              value={state}
              onChange={setState}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'closed', label: 'Closed' },
                { value: 'all', label: 'All' },
              ]}
            />
          }
        >
          {pulls.isLoading ? (
            <SkeletonRows rows={4} />
          ) : (pulls.data ?? []).length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-6">No {state === 'all' ? '' : state} pull requests.</p>
          ) : (
            <ul className="divide-y divide-line">
              {pulls.data!.map((p) => (
                <PullRow key={p.number} p={p} owner={owner} repo={repo} />
              ))}
            </ul>
          )}
        </Pane>
        <div className="divide-y divide-line border-t border-line xl:border-t-0">
          <Pane title={`Commits on ${r.data?.defaultBranch ?? 'default branch'}`} className="border-0">
            {commits.isLoading ? (
              <SkeletonRows rows={4} />
            ) : (
              <ul className="divide-y divide-line">
                {[...(commits.data ?? [])].slice(0, 12).map((c, i) => (
                  <CommitRow key={c.sha} c={c} owner={owner} repo={repo} head={i === 0} />
                ))}
              </ul>
            )}
          </Pane>
          <Pane title="Claims on this repository" className="border-0">
            <ClaimsForRepo owner={owner} repo={repo} />
          </Pane>
        </div>
      </div>
    </div>
  )
}

export function PullDetail({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const pull = useGitHubPull(owner, repo, number)
  const commits = useGitHubPullCommits(owner, repo, number)
  const p = pull.data
  if (pull.isError)
    return (
      <EmptyState tone="error" title={`Could not open ${owner}/${repo}#${number}`} action={<Button asChild variant="secondary"><Link href={`/repos/${owner}/${repo}`}>Back to repository</Link></Button>}>
        {ghError(pull.error)}
      </EmptyState>
    )
  const list = [...(commits.data ?? [])].reverse()
  return (
    <div>
      <PageHeader
        title={p ? <span className="wrap-anywhere">{p.title}</span> : `#${number}`}
        description={
          p ? (
            <span className="flex flex-wrap gap-x-3">
              <span className="mono-cond text-[12.5px]">
                {owner}/{repo}#{number}
              </span>
              <span>{p.draft ? 'draft' : p.state}</span>
              <span>by {p.author.login}</span>
              <span className="mono-cond text-[12px]">
                {p.headRef} into {p.baseRef}
              </span>
            </span>
          ) : undefined
        }
        actions={
          p ? (
            <>
              <ExternalLink href={p.htmlUrl}>Open on GitHub</ExternalLink>
              <Button asChild variant="primary">
                <Link href={verifyHref(owner, repo, p.headSha, number)}>Verify head commit</Link>
              </Button>
            </>
          ) : null
        }
      />
      <div className="grid grid-cols-1 bg-surface xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] xl:divide-x xl:divide-line">
        <div className="divide-y divide-line">
          <Pane title="Commits" className="border-0" description="Each commit is a separate verification target. A claim never follows the branch.">
            {commits.isLoading ? (
              <SkeletonRows rows={4} />
            ) : (
              <ul className="divide-y divide-line">
                {list.map((c, i) => (
                  <CommitRow key={c.sha} c={c} owner={owner} repo={repo} pr={number} head={i === 0} />
                ))}
              </ul>
            )}
          </Pane>
          <Pane title="Claims on this pull request" className="border-0">
            <ClaimsForRepo owner={owner} repo={repo} pr={number} />
          </Pane>
        </div>
        <Pane title="Description" className="border-0 border-t border-line xl:border-t-0" description="Author-supplied text, sanitized">
          <div className="px-4 py-4 sm:px-6">
            {p?.body ? <SafeMarkdown compact>{p.body}</SafeMarkdown> : <p className="text-[13px] text-muted">No description.</p>}
            {p ? (
              <p className="mt-4 text-[12px] text-muted">
                {p.changedFiles} files changed, <span className="text-needle">+{p.additions}</span> <span className="text-flare">−{p.deletions}</span>. Pine shows this pull request for
                context only; it never merges, comments or deploys.
              </p>
            ) : null}
          </div>
        </Pane>
      </div>
    </div>
  )
}
