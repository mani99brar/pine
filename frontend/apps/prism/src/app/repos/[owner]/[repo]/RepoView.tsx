'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { CommitSummary, PullSummary } from '@pine/core'
import { formatAmount, formatRelative, shortSha } from '@pine/core'
import { useClaims, useGitHubCommits, useGitHubPullCommits, useGitHubPulls, useGitHubRepo, usePine } from '@pine/react'
import { ArrowLeft, GitCommitHorizontal, GitPullRequest, Lock, Star } from 'lucide-react'
import { identityReady, useApiIdentity } from '@/components/composer/api/identity'
import { ButtonLink } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/interactive'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { ClaimRow } from '@/components/table/ClaimRow'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { ApiRepoGate } from '../../ReposView'

function CommitRow({ c, owner, repo, claimed, now }: { c: CommitSummary; owner: string; repo: string; claimed?: { id: string; number: number }; now: number | null }) {
  const first = c.message.split('\n')[0] ?? ''
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="flex items-start gap-2">
          <GitCommitHorizontal size={15} aria-hidden className="mt-1 shrink-0 text-lumen-3" />
          <span className="untrusted min-w-0 font-medium text-lumen [white-space:normal]">{first || '(no commit message)'}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 pl-6 text-[0.8125rem] text-lumen-3">
          <code className="t-code text-lumen-2">{shortSha(c.sha)}</code>
          <span>{c.author.login ?? c.author.name}</span>
          {now && <span>{formatRelative(c.author.date, new Date(now))}</span>}
          {c.stats && (
            <span className="tnum">
              +{c.stats.additions} −{c.stats.deletions}
            </span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6 sm:pl-0">
        {claimed && (
          <Link href={`/claims/${claimed.id}`} className="tag text-lumen hover:border-edge-strong">
            Claimed in PINE-{String(claimed.number).padStart(4, '0')}
          </Link>
        )}
        <ButtonLink href={`/compose?source=${encodeURIComponent(`${owner}/${repo}@${c.sha}`)}`} size="sm" variant="glass">
          Start a claim on this commit
        </ButtonLink>
      </div>
    </li>
  )
}

function PullRow({ p, active, onSelect, stats }: { p: PullSummary; active: boolean; onSelect: () => void; stats: boolean }) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn(
          'relative grid w-full gap-1 px-4 py-3.5 text-left transition-colors focus-visible:-outline-offset-2',
          active ? 'bg-smoke-3 shadow-[inset_3px_0_0_var(--hb)]' : 'hover:bg-[rgba(255,236,220,0.03)]',
        )}
      >
        <span className="flex items-start gap-2">
          <GitPullRequest size={15} aria-hidden className={cn('mt-1 shrink-0', p.state === 'open' ? 'text-hb' : 'text-lumen-3')} />
          <span className="untrusted min-w-0 font-medium text-lumen [white-space:normal]">
            #{p.number} {p.title}
          </span>
        </span>
        <span className="flex flex-wrap gap-x-3 pl-6 text-[0.8125rem] text-lumen-3">
          <span>{p.state}{p.draft ? ', draft' : ''}</span>
          <span>{p.author.login}</span>
          {stats && (
            <span className="tnum">
              {p.commits} commits, +{p.additions} −{p.deletions}
            </span>
          )}
          {p.labels.slice(0, 3).map((l) => (
            <span key={l} className="untrusted">
              {l}
            </span>
          ))}
        </span>
      </button>
    </li>
  )
}

export function RepoView({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const now = useNowMs()
  const prState = (params.get('state') as 'open' | 'closed' | 'all' | null) ?? 'open'
  const prNumber = params.get('pr') ? Number(params.get('pr')) : undefined
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params.toString())
    if (v === null) next.delete(k)
    else next.set(k, v)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }
  const repoQ = useGitHubRepo(owner, repo)
  const pulls = useGitHubPulls(owner, repo, prState)
  const prCommits = useGitHubPullCommits(owner, repo, prNumber)
  const branch = useGitHubCommits(owner, repo)
  // The backend's GitHub route resolved the repository: filter claims by its numeric id (the on-chain identity), not
  // by the owner/name a claim document states.
  const claimsQ = useClaims({ repo: `${owner}/${repo}`, repositoryId: repoQ.data?.id, limit: 50 })
  const claims = useMemo(() => claimsQ.data?.items ?? [], [claimsQ.data])
  const bySha = useMemo(() => new Map(claims.map((c) => [c.source.commitSha.toLowerCase(), { id: c.id, number: c.number }])), [claims])
  const r = repoQ.data
  const pr = pulls.data?.find((p) => p.number === prNumber)
  // api mode: Pine reads GitHub through the session's linked account. It serves no stars, no pull request counts or
  // line stats and no branch history, so those are left out rather than shown as zeros.
  const api = usePine().env.dataSource === 'api'
  const identity = useApiIdentity()

  if (api && !identityReady(identity, 'github'))
    return <ApiRepoGate className="mt-10" reason={`Pine reads ${owner}/${repo}, its pull requests and their commits through your linked GitHub account.`} />
  if (repoQ.isLoading) return <Skeleton className="mt-10 h-72 w-full" />
  if (repoQ.isError) {
    const msg = repoQ.error instanceof Error ? repoQ.error.message : String(repoQ.error ?? '')
    // "Not found or private" is an answer, not a failure: retrying will not change it.
    if (/not found|private|404/i.test(msg))
      return (
        <EmptyState
          className="mt-10"
          title={`No public repository at ${owner}/${repo}`}
          icon={<CrystalGlyph seed={`repo:${owner}/${repo}`} hue="#A69789" state="unlit" size={84} decorative />}
          action={
            <div className="flex flex-wrap gap-3">
              <ButtonLink href="/repos">Search repositories</ButtonLink>
              <ButtonLink href="/compose" variant="glass">
                Paste a pull request instead
              </ButtonLink>
            </div>
          }
        >
          It may be misspelled, renamed or private. Pine pins commits from public repositories only, so anyone can check them.
        </EmptyState>
      )
    return <ErrorState className="mt-10" error={repoQ.error} onRetry={() => void repoQ.refetch()} />
  }
  if (!r)
    return (
      <EmptyState className="mt-10" title="Repository not found" action={<ButtonLink href="/repos">Back to repositories</ButtonLink>}>
        GitHub has no public repository called {owner}/{repo}, or it is not reachable right now.
      </EmptyState>
    )

  return (
    <div>
      <Link href="/repos" className="mt-6 inline-flex items-center gap-1.5 text-[0.875rem] text-lumen-3 hover:text-lumen">
        <ArrowLeft size={14} aria-hidden /> Repositories
      </Link>
      <header className="pb-8 pt-6">
        <h1 className="t-h1 chroma [overflow-wrap:anywhere]">{r.fullName}</h1>
        {r.description && <p className="untrusted t-lead mt-3 max-w-[62ch] [white-space:normal]">{r.description}</p>}
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.875rem] text-lumen-3">
          {r.language && <span>{r.language}</span>}
          {!api && (
            <span className="inline-flex items-center gap-1">
              <Star size={13} aria-hidden /> {formatAmount(r.stars, { compact: true, maxDecimals: 1 })}
            </span>
          )}
          {r.license && <span>{r.license}</span>}
          <span>default branch {r.defaultBranch}</span>
          <a className="link" href={r.htmlUrl} target="_blank" rel="noopener noreferrer nofollow">
            Open on GitHub
          </a>
        </p>
      </header>

      {r.private ? (
        <EmptyState title="Private repositories are not supported yet" icon={<Lock size={22} aria-hidden />}>
          Claims must be checkable by anyone, so Pine only pins commits from public repositories.
        </EmptyState>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section aria-labelledby="prs-title">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="prs-title" className="t-h3">
                Pull requests
              </h2>
              <Segmented
                label="Pull request state"
                size="sm"
                value={prState}
                onChange={(v) => setParam('state', v === 'open' ? null : v)}
                options={[
                  { value: 'open', label: 'Open' },
                  { value: 'closed', label: 'Closed' },
                  { value: 'all', label: 'All' },
                ]}
              />
            </div>
            {pulls.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : pulls.isError ? (
              <ErrorState error={pulls.error} onRetry={() => void pulls.refetch()} />
            ) : (pulls.data?.length ?? 0) === 0 ? (
              <EmptyState title={`No ${prState === 'all' ? '' : prState + ' '}pull requests`}>You can still claim a commit from the default branch.</EmptyState>
            ) : (
              <ul className="glass cut-xl divide-y divide-[var(--edge)] overflow-hidden">
                {pulls.data!.map((p) => (
                  <PullRow key={p.number} p={p} stats={!api} active={p.number === prNumber} onSelect={() => setParam('pr', p.number === prNumber ? null : String(p.number))} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="commits-title" aria-live="polite">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 id="commits-title" className="t-h3">
                {pr ? `Commits in #${pr.number}` : api ? 'Commits' : `Recent commits on ${r.defaultBranch}`}
              </h2>
              {pr && (
                <ButtonLink href={`/compose?source=${encodeURIComponent(`${owner}/${repo}/pull/${pr.number}`)}`} size="sm">
                  Claim the head commit
                </ButtonLink>
              )}
            </div>
            {!pr && api ? (
              <EmptyState title="Pick a pull request">Pine lists commits through pull requests. Choose one to see its commits and claim one of them.</EmptyState>
            ) : (pr ? prCommits : branch).isLoading ? (
              <Skeleton className="h-60 w-full" />
            ) : (pr ? prCommits : branch).isError ? (
              <ErrorState error={(pr ? prCommits : branch).error} onRetry={() => void (pr ? prCommits : branch).refetch()} />
            ) : ((pr ? prCommits.data : branch.data)?.length ?? 0) === 0 ? (
              <EmptyState title="No commits found" />
            ) : (
              <ul className="glass cut-xl divide-y divide-[var(--edge)] overflow-hidden">
                {[...((pr ? prCommits.data : branch.data) ?? [])].reverse().slice(0, 20).map((c) => (
                  <CommitRow key={c.sha} c={c} owner={owner} repo={repo} claimed={bySha.get(c.sha.toLowerCase())} now={now} />
                ))}
              </ul>
            )}
            {pr && <p className="mt-2 text-[0.8125rem] text-lumen-3">A claim covers one exact commit. Later pushes to this pull request need a new claim.</p>}
          </section>
        </div>
      )}

      {claims.length > 0 && (
        <section className="mt-14" aria-labelledby="repo-claims">
          <h2 id="repo-claims" className="t-h3 mb-3">
            Claims on this repository
          </h2>
          <ul className="glass cut-xl divide-y divide-[var(--edge)] overflow-hidden">
            {claims.map((c) => (
              <ClaimRow key={c.id} claim={c} nowMs={now} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
