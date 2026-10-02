'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { RepoSummary } from '@pine/core'
import { formatAmount, formatRelative } from '@pine/core'
import { useAccount, useClaims, useDebouncedValue, useGitHubRepoSearch, useGitHubViewerRepos } from '@pine/react'
import { GitPullRequest, Lock, Search, Star } from 'lucide-react'
import { Input } from '@/components/ui/form'
import { ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { SectionHeading, Skeleton } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/now'

function RepoRow({ r, claims }: { r: RepoSummary; claims: number }) {
  const now = useNowMs()
  return (
    <li>
      <Link
        href={`/repos/${r.owner}/${r.name}`}
        aria-disabled={r.private}
        className="grid gap-2 rounded-[var(--radius-tile)] border border-line bg-sheet px-4 py-3.5 transition-colors hover:border-ink sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-[650]">
            {r.fullName}
            {r.private && (
              <span className="inline-flex items-center gap-1 rounded-full bg-fog-2 px-2 py-0.5 text-[0.72rem] font-[650] text-ink-2">
                <Lock size={11} aria-hidden /> private, not supported
              </span>
            )}
          </p>
          {r.description && <p className="untrusted mt-0.5 line-clamp-1 text-[0.86rem] text-ink-2 [white-space:normal]">{r.description}</p>}
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.78rem] text-ink-3">
            {r.language && <span>{r.language}</span>}
            <span className="inline-flex items-center gap-1">
              <Star size={12} aria-hidden /> {formatAmount(r.stars, { compact: true, maxDecimals: 1 })}
            </span>
            {r.openPullRequests !== undefined && (
              <span className="inline-flex items-center gap-1">
                <GitPullRequest size={12} aria-hidden /> {r.openPullRequests} open
              </span>
            )}
            {r.license && <span>{r.license}</span>}
            <span>updated {now === null ? '' : formatRelative(r.updatedAt, new Date(now))}</span>
          </p>
        </div>
        {claims > 0 && (
          <span className="justify-self-start rounded-full bg-ink px-2.5 py-1 text-[0.75rem] font-[650] text-on-ink sm:justify-self-end">
            {claims} {claims === 1 ? 'claim' : 'claims'} on the board
          </span>
        )}
      </Link>
    </li>
  )
}

export function ReposView() {
  const account = useAccount()
  const [q, setQ] = useState('')
  const dq = useDebouncedValue(q.trim(), 300)
  const viewer = useGitHubViewerRepos({ limit: 50 })
  const search = useGitHubRepoSearch(dq)
  const claims = useClaims({ limit: 200 })
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of claims.data?.items ?? []) {
      const k = `${c.source.owner}/${c.source.repo}`.toLowerCase()
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [claims.data])
  const count = (r: RepoSummary) => counts.get(r.fullName.toLowerCase()) ?? 0
  const signedIn = account.status === 'signed_in'

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading
        as="h1"
        title="Repositories"
        description="Pick a repository, then a pull request and the exact commit you want to put a claim on. Public repositories only."
      />

      <div className="relative mt-8">
        <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <label htmlFor="repo-search" className="sr-only">
          Search public repositories
        </label>
        <Input id="repo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search public repositories, e.g. kleros/gateway" className="h-12 pl-10 text-[1rem]" />
      </div>

      {dq ? (
        <section className="mt-8" aria-labelledby="results" aria-live="polite">
          <h2 id="results" className="t-h3">
            Results for &ldquo;{dq}&rdquo;
          </h2>
          {search.isLoading ? (
            <div className="mt-3 grid gap-2">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : search.isError ? (
            <ErrorState className="mt-3" title="Search failed" error={search.error} onRetry={() => search.refetch()} />
          ) : (search.data?.length ?? 0) === 0 ? (
            <EmptyState className="mt-3" title="No public repository matches" body="Check the spelling, or paste a pull request URL straight into the composer." action={<ButtonLink href="/compose">Open the composer</ButtonLink>} />
          ) : (
            <ul className="mt-3 grid gap-2">
              {search.data!.map((r) => (
                <RepoRow key={r.id} r={r} claims={count(r)} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="mt-10" aria-labelledby="yours">
        <h2 id="yours" className="t-h2">
          Your repositories
        </h2>
        {!signedIn ? (
          <EmptyState
            className="mt-4"
            title="Sign in to list your repositories"
            body="Pine uses GitHub's read-only public scope. You can still search any public repository above."
            action={<ButtonLink href="/account">Sign in with GitHub</ButtonLink>}
          />
        ) : viewer.isLoading ? (
          <div className="mt-4 grid gap-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : viewer.isError ? (
          <ErrorState className="mt-4" title="Your repositories could not be loaded" error={viewer.error} onRetry={() => viewer.refetch()} />
        ) : (viewer.data?.items.length ?? 0) === 0 ? (
          <EmptyState className="mt-4" title="No public repositories on this account" body="Search for any public repository above instead." />
        ) : (
          <ul className="mt-4 grid gap-2">
            {viewer.data!.items.map((r) => (
              <RepoRow key={r.id} r={r} claims={count(r)} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
