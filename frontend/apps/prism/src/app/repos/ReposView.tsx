'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { RepoSummary } from '@pine/core'
import { formatAmount, formatRelative } from '@pine/core'
import { useAccount, useClaims, useDebouncedValue, useGitHubRepoSearch, useGitHubViewerRepos } from '@pine/react'
import { GitPullRequest, Lock, Search, Star } from 'lucide-react'
import { ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives'
import { useMounted, useNowMs } from '@/lib/hooks'

const SUGGESTIONS = ['kleros', 'acme-labs', 'northwind', 'tidewater', 'quarry']

function RepoRow({ r, claims, now }: { r: RepoSummary; claims: number; now: number | null }) {
  return (
    <li>
      <Link href={`/repos/${r.owner}/${r.name}`} className="group grid gap-2 px-4 py-4 transition-colors hover:bg-[rgba(255,236,220,0.03)] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-lumen group-hover:underline group-hover:decoration-[rgba(90,216,255,0.6)] group-hover:underline-offset-4">
            {r.fullName}
            {r.private && (
              <span className="tag gap-1 text-lumen-2">
                <Lock size={11} aria-hidden /> private, not supported yet
              </span>
            )}
          </p>
          {r.description && <p className="untrusted mt-0.5 line-clamp-1 text-[0.875rem] text-lumen-2 [white-space:normal]">{r.description}</p>}
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-lumen-3">
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
            {now && <span>updated {formatRelative(r.updatedAt, new Date(now))}</span>}
          </p>
        </div>
        {claims > 0 && <span className="tag justify-self-start text-lumen sm:justify-self-end">{claims} {claims === 1 ? 'claim' : 'claims'} on the light table</span>}
      </Link>
    </li>
  )
}

export function ReposView() {
  const mounted = useMounted()
  const account = useAccount()
  const now = useNowMs()
  const [q, setQ] = useState('')
  const dq = useDebouncedValue(q.trim(), 300)
  const viewer = useGitHubViewerRepos({ limit: 50 })
  const search = useGitHubRepoSearch(dq)
  const claims = useClaims({ limit: 200 })
  // Claims are counted by the repository identity they pin (the numeric GitHub id) when the data source knows it; the
  // owner/name a claim document states is only a fallback for sources without ids (demo data).
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of claims.data?.items ?? []) {
      const k = c.source.repoId !== undefined ? `id:${c.source.repoId}` : `${c.source.owner}/${c.source.repo}`.toLowerCase()
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [claims.data])
  const count = (r: RepoSummary) => counts.get(`id:${r.id}`) ?? counts.get(r.fullName.toLowerCase()) ?? 0
  const signedIn = account.status === 'signed_in'

  return (
    <div>
      <div className="relative">
        <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lumen-3" />
        <label htmlFor="repo-search" className="sr-only">
          Search public repositories
        </label>
        <input id="repo-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search public repositories, for example kleros/gateway" className="field h-13 pl-10 text-[1rem]" />
      </div>
      {!q && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.84375rem] text-lumen-3">
          <span>Try</span>
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="chip" onClick={() => setQ(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {dq && (
        <section className="mt-8" aria-labelledby="results" aria-live="polite">
          <h2 id="results" className="t-h3">
            Results for “{dq}”
          </h2>
          {search.isLoading ? (
            <Skeleton className="mt-3 h-40 w-full" />
          ) : search.isError ? (
            <ErrorState className="mt-3" title="Search failed" error={search.error} onRetry={() => void search.refetch()} />
          ) : (search.data?.length ?? 0) === 0 ? (
            <EmptyState className="mt-3" title="No public repository matches" action={<ButtonLink href="/compose">Open the composer</ButtonLink>}>
              Check the spelling, or paste a pull request URL straight into the composer.
            </EmptyState>
          ) : (
            <ul className="glass cut-xl mt-3 divide-y divide-[var(--edge)] overflow-hidden">
              {search.data!.map((r) => (
                <RepoRow key={r.id} r={r} claims={count(r)} now={now} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-12" aria-labelledby="yours">
        <h2 id="yours" className="t-h2">
          Your repositories
        </h2>
        {!mounted || account.status === 'loading' ? (
          <Skeleton className="mt-4 h-40 w-full" />
        ) : !signedIn ? (
          <EmptyState className="mt-4" title="Sign in to list your repositories" action={<ButtonLink href="/account">Sign in</ButtonLink>}>
            Pine uses GitHub&apos;s read-only <code className="t-code">read:user</code> scope. You can still search any public repository above.
          </EmptyState>
        ) : viewer.isLoading ? (
          <Skeleton className="mt-4 h-60 w-full" />
        ) : viewer.isError ? (
          <ErrorState className="mt-4" title="Your repositories could not be loaded" error={viewer.error} onRetry={() => void viewer.refetch()} />
        ) : (viewer.data?.items.length ?? 0) === 0 ? (
          <EmptyState className="mt-4" title="No public repositories on this account">
            Search for any public repository above instead.
          </EmptyState>
        ) : (
          <ul className="glass cut-xl mt-4 divide-y divide-[var(--edge)] overflow-hidden">
            {viewer.data!.items.map((r) => (
              <RepoRow key={r.id} r={r} claims={count(r)} now={now} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
