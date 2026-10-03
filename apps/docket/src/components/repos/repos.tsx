'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimSummary, CommitSummary, PullSummary, RepoSummary } from '@pine/core'
import { formatClaimNumber, formatDate, shortSha } from '@pine/core'
import {
  useAccount,
  useClaims,
  useGitHubCommits,
  useGitHubPull,
  useGitHubPullCommits,
  useGitHubPulls,
  useGitHubRepo,
  useGitHubRepoSearch,
  useGitHubViewerRepos,
} from '@pine/react'
import { FilePlus2, GitCommitHorizontal, GitPullRequest, Search, Star } from 'lucide-react'
import { cn } from '@/lib/cn'
import { plural } from '@/lib/format'
import { Button, ButtonLink } from '@/components/ui/button'
import { Breadcrumbs, EmptyState, Skeleton } from '@/components/ui/layout'
import { ExternalLink } from '@/components/ui/external-link'
import { Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { StageTag } from '@/components/ui/stage'
import { GitHubMark } from '@/components/ui/github-mark'

function fileHref(ref: string) {
  return `/file?ref=${encodeURIComponent(ref)}`
}

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  )
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : 'GitHub did not respond.'
}

export function RepositoryList() {
  const account = useAccount()
  const [q, setQ] = useState('')
  const viewer = useGitHubViewerRepos()
  const search = useGitHubRepoSearch(q.trim().length >= 2 ? q.trim() : '')
  const searching = q.trim().length >= 2
  const list = searching ? search.data : viewer.data?.items
  const loading = searching ? search.isLoading : viewer.isLoading
  const error = searching ? search.error : viewer.error

  return (
    <div className="space-y-6">
      {account.status === 'signed_out' ? (
        <Notice
          tone="info"
          title="Sign in to see your own repositories"
          action={
            <Button size="sm" variant="ink" icon={<GitHubMark className="size-4" />} onClick={() => void account.signIn(account.providers.github ? 'github' : 'demo')}>
              Sign in with GitHub
            </Button>
          }
        >
          You can still search any public repository below. Pine only reads public code.
        </Notice>
      ) : null}
      <div className="border border-rule bg-sheet p-4 sm:p-5">
        <label htmlFor="repo-search" className="font-bold">
          Find a public repository
        </label>
        <div className="relative mt-2">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-graphite" />
          <Input id="repo-search" type="search" className="h-12 pl-10" placeholder="owner/name or keywords" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <h2 className="text-2xl">{searching ? `Results for “${q.trim()}”` : 'Your public repositories'}</h2>
      {loading ? (
        <ListSkeleton />
      ) : error ? (
        <Notice tone="critical" title="Repositories could not be loaded">
          {errorText(error)}
        </Notice>
      ) : !list || list.length === 0 ? (
        <EmptyState title={searching ? 'No repositories match' : 'No repositories to show'}>
          {searching ? 'Try the exact owner/name.' : 'Sign in, or search for any public repository above.'}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule bg-sheet">
          {list.map((r) => (
            <RepoRow key={r.id} repo={r} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RepoRow({ repo: r }: { repo: RepoSummary }) {
  return (
    <li className="group relative grid gap-2 px-4 py-4 hover:bg-[#fafbfd] sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5">
      <div className="min-w-0">
        <Link href={`/repositories/${r.owner}/${r.name}`} className="font-bold no-underline after:absolute after:inset-0 group-hover:underline">
          {r.fullName}
        </Link>
        {r.private ? <span className="ml-2 text-sm font-bold text-red">Private: not supported</span> : null}
        {r.description ? <p className="untrusted mt-0.5 text-[15px] text-graphite">{r.description}</p> : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-4 text-sm text-graphite sm:justify-end">
        {r.language ? <span>{r.language}</span> : null}
        <span className="inline-flex items-center gap-1">
          <Star aria-hidden className="size-3.5" /> {r.stars}
        </span>
        <span>{plural(r.openPullRequests ?? 0, 'open pull request')}</span>
        <span>Updated {formatDate(r.updatedAt, 'short')}</span>
      </p>
    </li>
  )
}

export function RepositoryDetail({ owner, name }: { owner: string; name: string }) {
  const repo = useGitHubRepo(owner, name)
  const [state, setState] = useState<'open' | 'closed' | 'all'>('open')
  const pulls = useGitHubPulls(owner, name, state)
  const commits = useGitHubCommits(owner, name, repo.data?.defaultBranch)
  const claims = useClaims({ repo: `${owner}/${name}`, sort: 'newest', limit: 20 })
  const r = repo.data

  if (repo.isLoading) return <ListSkeleton />
  if (!r)
    return (
      <EmptyState title={`${owner}/${name} was not found`} action={<ButtonLink href="/repositories">Back to repositories</ButtonLink>}>
        It may be private or misspelled. Pine supports public repositories only.
      </EmptyState>
    )

  return (
    <>
      <Breadcrumbs items={[{ href: '/repositories', label: 'Repositories' }, { label: r.fullName }]} />
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 max-w-[48rem]">
          <h1 className="text-3xl break-words">{r.fullName}</h1>
          {r.description ? <p className="untrusted mt-2 text-lg text-graphite">{r.description}</p> : null}
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm text-graphite">
            {r.license ? <span>{r.license}</span> : null}
            {r.language ? <span>{r.language}</span> : null}
            <span>Default branch {r.defaultBranch}</span>
            <ExternalLink href={r.htmlUrl}>Open on GitHub</ExternalLink>
          </p>
        </div>
      </header>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-labelledby="prs" className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="prs" className="text-2xl">
              Pull requests
            </h2>
            <div role="group" aria-label="Pull request state" className="inline-flex border border-rule-strong">
              {(['open', 'closed', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => setState(s)}
                  className={cn('px-3 py-1.5 text-sm font-bold capitalize', state === s ? 'bg-ink text-white' : 'bg-sheet hover:bg-bond')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          {pulls.isLoading ? (
            <div className="mt-4">
              <ListSkeleton />
            </div>
          ) : !pulls.data || pulls.data.length === 0 ? (
            <p className="mt-4 text-graphite">No {state === 'all' ? '' : state} pull requests.</p>
          ) : (
            <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
              {pulls.data.map((p) => (
                <PullRow key={p.number} owner={owner} name={name} pull={p} />
              ))}
            </ul>
          )}

          <h2 className="mt-12 text-2xl">Recent commits on {r.defaultBranch}</h2>
          <CommitRows commits={commits.data} loading={commits.isLoading} refFor={(c) => `${owner}/${name}@${c.sha}`} claims={claims.data?.items} />
        </section>

        <aside aria-labelledby="claims-here">
          <h2 id="claims-here" className="text-xl">
            Claims on this repository
          </h2>
          {claims.isLoading ? (
            <Skeleton className="mt-3 h-24 w-full" />
          ) : !claims.data || claims.data.items.length === 0 ? (
            <p className="mt-2 text-[15px] text-graphite">None yet. Pick a commit to file the first.</p>
          ) : (
            <ul className="mt-3 divide-y divide-rule border-y border-rule bg-sheet">
              {claims.data.items.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link href={`/claims/${c.id}`} className="link font-[800] tabular">
                      {formatClaimNumber(c.number)}
                    </Link>
                    <StageTag status={c.status} outcome={c.outcome} />
                  </p>
                  <p className="record-title untrusted mt-1">{c.title}</p>
                  <p className="text-sm text-graphite">
                    At <code className="font-mono">{shortSha(c.source.commitSha)}</code>
                    {c.source.prNumber ? `, PR #${c.source.prNumber}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  )
}

function PullRow({ owner, name, pull: p }: { owner: string; name: string; pull: PullSummary }) {
  return (
    <li className="group relative grid gap-2 px-4 py-4 hover:bg-[#fafbfd] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
      <div className="min-w-0">
        <p className="flex items-start gap-2">
          <GitPullRequest aria-hidden className={cn('mt-1 size-4 shrink-0', p.state === 'open' ? 'text-violet' : 'text-graphite')} />
          <Link href={`/repositories/${owner}/${name}/pull/${p.number}`} className="untrusted min-w-0 font-bold no-underline after:absolute after:inset-0 group-hover:underline">
            #{p.number} {p.title}
          </Link>
        </p>
        <p className="mt-1 pl-6 text-sm text-graphite">
          {p.state === 'merged' ? 'Merged' : p.state === 'closed' ? 'Closed' : p.draft ? 'Draft' : 'Open'}. {p.commits} commits by {p.author.login}, updated{' '}
          {formatDate(p.updatedAt, 'short')}. <span className="text-ink">+{p.additions}</span> / <span className="text-ink">−{p.deletions}</span>
        </p>
        {p.labels.length ? (
          <p className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
            {p.labels.map((l) => (
              <span key={l} className="untrusted rounded-xs border border-rule px-1.5 text-xs text-graphite">
                {l}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <code className="hidden font-mono text-[13px] text-graphite sm:block">{shortSha(p.headSha)}</code>
    </li>
  )
}

function CommitRows({
  commits,
  loading,
  refFor,
  headSha,
  claims = [],
}: {
  commits?: CommitSummary[]
  loading: boolean
  refFor: (c: CommitSummary) => string
  headSha?: string
  claims?: ClaimSummary[]
}) {
  if (loading)
    return (
      <div className="mt-4">
        <ListSkeleton />
      </div>
    )
  if (!commits || commits.length === 0) return <p className="mt-4 text-graphite">No commits found.</p>
  return (
    <ol className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
      {commits.map((c) => (
        <li key={c.sha} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
          <div className="min-w-0">
            <p className="flex items-start gap-2">
              <GitCommitHorizontal aria-hidden className="mt-1 size-4 shrink-0 text-graphite" />
              <span className="min-w-0">
                <span className="untrusted font-bold">{c.message.split('\n')[0]}</span>
                {headSha === c.sha ? <span className="ml-2 rounded-xs bg-violet-wash px-1.5 text-xs font-bold text-violet">Latest</span> : null}
                {claims
                  .filter((x) => x.source.commitSha.toLowerCase() === c.sha.toLowerCase())
                  .map((x) => (
                    <Link key={x.id} href={`/claims/${x.id}`} className="ml-2 rounded-xs border border-rule px-1.5 text-xs font-bold text-ink no-underline hover:border-violet">
                      Already claimed in {formatClaimNumber(x.number)}
                    </Link>
                  ))}
              </span>
            </p>
            <p className="mt-0.5 pl-6 text-sm text-graphite">
              <code className="font-mono text-ink">{shortSha(c.sha)}</code> by {c.author.login ?? c.author.name}, {formatDate(c.author.date, 'long')}
              {c.stats ? (
                <>
                  , +{c.stats.additions} / −{c.stats.deletions}
                </>
              ) : null}
            </p>
          </div>
          <ButtonLink href={fileHref(refFor(c))} size="sm" variant={headSha === c.sha ? 'primary' : 'secondary'} icon={<FilePlus2 aria-hidden />}>
            File for this commit
          </ButtonLink>
        </li>
      ))}
    </ol>
  )
}

export function PullDetail({ owner, name, number }: { owner: string; name: string; number: number }) {
  const pull = useGitHubPull(owner, name, number)
  const commits = useGitHubPullCommits(owner, name, number)
  const claims = useClaims({ repo: `${owner}/${name}`, limit: 50 })
  const p = pull.data
  if (pull.isLoading) return <ListSkeleton />
  if (!p)
    return (
      <EmptyState title={`Pull request #${number} was not found`} action={<ButtonLink href={`/repositories/${owner}/${name}`}>Back to {owner}/{name}</ButtonLink>} />
    )
  const related = (claims.data?.items ?? []).filter((c) => c.source.prNumber === number)
  return (
    <>
      <Breadcrumbs
        items={[
          { href: '/repositories', label: 'Repositories' },
          { href: `/repositories/${owner}/${name}`, label: `${owner}/${name}` },
          { label: `#${number}` },
        ]}
      />
      <header className="mb-8 max-w-[52rem]">
        <p className="text-sm font-bold text-graphite">
          Pull request #{p.number}, {p.state === 'merged' ? 'merged' : p.state}
        </p>
        <h1 className="untrusted mt-1 text-[2rem] leading-[2.5rem]">{p.title}</h1>
        <p className="mt-2 text-[15px] text-graphite">
          {p.author.login} wants to merge <code className="font-mono">{p.headRef}</code> into <code className="font-mono">{p.baseRef}</code>.{' '}
          <ExternalLink href={p.htmlUrl}>Open on GitHub</ExternalLink>
        </p>
      </header>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-10">
          <section aria-labelledby="pick">
            <h2 id="pick" className="text-2xl">
              Choose the commit to file about
            </h2>
            <p className="mt-1 text-graphite measure">
              A claim pins one exact commit. Later pushes to this pull request will not be covered; they would need a new claim. Newest first.
            </p>
            <CommitRows
              commits={commits.data ? [...commits.data].reverse() : undefined}
              loading={commits.isLoading}
              headSha={p.headSha}
              refFor={(c) => `https://github.com/${owner}/${name}/pull/${number}/commits/${c.sha}`}
              claims={claims.data?.items}
            />
          </section>
          {p.body ? (
            <section aria-labelledby="desc">
              <h2 id="desc" className="text-xl">
                Description, as written on GitHub
              </h2>
              <div className="mt-3 max-h-[32rem] overflow-y-auto border border-rule bg-sheet px-5 py-4">
                <SafeMarkdown>{p.body.slice(0, 20000)}</SafeMarkdown>
              </div>
            </section>
          ) : null}
        </div>
        <aside className="space-y-6">
          <div>
            <h2 className="text-xl">Claims on this pull request</h2>
            {related.length === 0 ? (
              <p className="mt-2 text-[15px] text-graphite">None yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-rule border-y border-rule bg-sheet">
                {related.map((c) => (
                  <li key={c.id} className="px-4 py-3">
                    <p className="flex flex-wrap items-center gap-2">
                      <Link href={`/claims/${c.id}`} className="link font-[800] tabular">
                        {formatClaimNumber(c.number)}
                      </Link>
                      <StageTag status={c.status} outcome={c.outcome} />
                    </p>
                    <p className="text-sm text-graphite">
                      At <code className="font-mono">{shortSha(c.source.commitSha)}</code>
                      {c.source.commitSha === p.headSha ? ', the latest commit' : ', an earlier commit'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-l-4 border-violet-line pl-4 text-sm text-graphite">
            <p className="font-bold text-violet">Pine never merges</p>
            <p className="mt-1">Whatever a claim shows, you decide whether to merge this pull request on GitHub.</p>
          </div>
        </aside>
      </div>
    </>
  )
}
