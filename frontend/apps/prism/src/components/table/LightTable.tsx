'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useInfiniteClaims, usePine } from '@pine/react'
import type { ClaimQuery, ClaimSort, PolicyFamilyId } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Search, X } from 'lucide-react'
import { Constellation, ConstellationLegend, nothingPriced } from './Constellation'
import { ClaimRow } from './ClaimRow'
import { Segmented } from '@/components/ui/interactive'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/primitives'
import { ButtonLink } from '@/components/ui/Button'
import { FamilyIcon } from '@/components/icons'
import { STATUS_GROUPS, type StatusGroup } from '@/lib/claims'
import { FAMILY_NAME, FAMILY_VAR } from '@/lib/crystal'
import { useMediaQuery, useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const SORTS: { value: ClaimSort; label: string }[] = [
  { value: 'deadline', label: 'Deadline soonest' },
  { value: 'newest', label: 'Newest' },
  { value: 'liquidity', label: 'Most liquidity' },
  { value: 'volume', label: 'Most volume' },
  { value: 'yes_price', label: 'Highest Yes price' },
  { value: 'activity', label: 'Recent activity' },
]

/** The Pine backend lists claims newest first (deadline order is applied per page); it has no liquidity, volume, price or activity data to sort by. */
const API_SORTS: ClaimSort[] = ['deadline', 'newest']

type View = 'constellation' | 'list'

export function LightTable() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [, startTransition] = useTransition()
  const wide = useMediaQuery('(min-width: 768px)', true)

  const { env } = usePine()
  const backend = env.dataSource === 'api'
  const sorts = backend ? SORTS.filter((s) => API_SORTS.includes(s.value)) : SORTS
  const groupParam = (params.get('status') ?? '').split(',').filter(Boolean) as StatusGroup['id'][]
  const family = (params.get('family') ?? '') as PolicyFamilyId | ''
  const requestedSort = (params.get('sort') as ClaimSort | null) ?? 'deadline'
  const sort = sorts.some((s) => s.value === requestedSort) ? requestedSort : 'deadline'
  const viewParam = params.get('view') as View | null
  const view: View = viewParam ?? (wide ? 'constellation' : 'list')
  const [search, setSearch] = useState(params.get('q') ?? '')

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  const statuses = useMemo(() => STATUS_GROUPS.filter((g) => groupParam.includes(g.id)).flatMap((g) => g.statuses), [groupParam])
  const query: ClaimQuery = useMemo(
    () => ({
      ...(statuses.length ? { status: statuses } : {}),
      ...(family ? { family } : {}),
      ...(params.get('q') ? { search: params.get('q') ?? undefined } : {}),
      ...(params.get('repo') ? { repo: params.get('repo') ?? undefined } : {}),
      sort,
      limit: 60,
    }),
    [statuses, family, sort, params],
  )
  const q = useInfiniteClaims(query)
  const claims = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data])
  const total = q.data?.pages[0]?.total
  const now = useNowMs()
  const filtered = groupParam.length > 0 || Boolean(family) || Boolean(params.get('q')) || Boolean(params.get('repo'))

  const toggleGroup = (id: StatusGroup['id']) => {
    const set = new Set(groupParam)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    setParam({ status: [...set].join(',') || null })
  }

  return (
    <div>
      {/* Controls */}
      <div className="glass cut-lg grid gap-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <form
            role="search"
            className="relative min-w-[14rem] flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              setParam({ q: search.trim() || null })
            }}
          >
            <label htmlFor="table-search" className="sr-only">
              Search claims
            </label>
            <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lumen-3" />
            <input
              id="table-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => search.trim() !== (params.get('q') ?? '') && setParam({ q: search.trim() || null })}
              placeholder="Search titles, repositories, commits or violations"
              className="field pl-9"
            />
          </form>
          <label htmlFor="table-sort" className="sr-only">
            Sort
          </label>
          <select id="table-sort" className="field w-auto min-w-[12rem]" value={sort} onChange={(e) => setParam({ sort: e.target.value === 'deadline' ? null : e.target.value })}>
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <Segmented<View>
            label="View"
            value={view}
            onChange={(v) => setParam({ view: v })}
            options={[
              { value: 'constellation', label: 'Light table' },
              { value: 'list', label: 'List' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Status</legend>
            {STATUS_GROUPS.map((g) => (
              <button key={g.id} type="button" className="chip" aria-pressed={groupParam.includes(g.id)} onClick={() => toggleGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">Policy family</legend>
            {(['FUNC', 'BOT', 'SC'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className="chip"
                aria-pressed={family === f}
                onClick={() => setParam({ family: family === f ? null : f })}
                title={FAMILY_NAME[f]}
              >
                <span style={{ color: FAMILY_VAR[f] }}>
                  <FamilyIcon family={f} size={15} />
                </span>
                {f}
              </button>
            ))}
          </fieldset>
          {filtered && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setSearch('')
                setParam({ status: null, family: null, q: null, repo: null })
              }}
            >
              <X size={14} aria-hidden /> Clear filters
            </button>
          )}
          <p className="ml-auto text-[0.8125rem] text-lumen-3" aria-live="polite">
            {q.isLoading ? 'Loading claims' : `${total ?? claims.length}${total === undefined && q.hasNextPage ? '+' : ''} claim${(total ?? claims.length) === 1 ? '' : 's'}`}
            {params.get('repo') ? ` in ${params.get('repo')}` : ''}
          </p>
        </div>
      </div>

      {/* Results */}
      <div className="mt-6">
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading || now === null ? (
          <div className="glass cut-xl p-6">
            <Skeleton className="h-[22rem] w-full" />
          </div>
        ) : claims.length === 0 ? (
          <EmptyState
            title={filtered ? 'No claims match these filters' : 'The light table is empty'}
            action={filtered ? undefined : <ButtonLink href="/compose">Compose the first claim</ButtonLink>}
          >
            {filtered ? 'Clear a filter or search for a different repository, commit or violation.' : 'Published claims appear here as soon as their markets exist.'}
          </EmptyState>
        ) : (
          <>
            {view === 'constellation' && (
              <section aria-label="Light table view" className="glass cut-xl relative mb-6 overflow-hidden p-2 sm:p-4">
                <a
                  href="#claims-list"
                  className="cut-sm sr-only z-20 bg-lumen px-3 py-2 text-[0.875rem] font-semibold text-umbra focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
                >
                  Skip the {claims.length} crystals and go to the list
                </a>
                <Constellation claims={claims} nowMs={now} />
                <div className="grid gap-4 px-2 pb-1 pt-4">
                  <ConstellationLegend />
                  <p className="text-[0.8125rem] text-lumen-3">
                    {nothingPriced(claims)
                      ? 'Position is the time to the evidence deadline. Prices are not part of this list: open a claim to see its pool prices.'
                      : `Height is the Yes price, the ${COPY.priceLabel.toLowerCase()}.`}{' '}
                    {backend ? 'Liquidity is not indexed, so every crystal has the same size.' : 'Size is liquidity.'} Left of the slit the evidence deadline has passed. {COPY.volumeCaveat}
                  </p>
                </div>
              </section>
            )}
            <section id="claims-list" tabIndex={-1} aria-label="Claims list" className={cn('glass cut-xl scroll-mt-24 overflow-hidden focus:outline-none')}>
              <ul className="divide-y divide-[var(--edge)]">
                {claims.map((c) => (
                  <ClaimRow key={c.id} claim={c} nowMs={now} />
                ))}
              </ul>
            </section>
            {q.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <button type="button" className="btn btn-glass" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                  {q.isFetchingNextPage ? 'Loading more' : 'Load more claims'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
