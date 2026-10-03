'use client'

import { useMemo, useState, useEffect, useDeferredValue } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ClaimQuery, ClaimSort, ClaimSummary } from '@pine/core'
import { SUPPORTED_CHAIN_IDS, CHAINS } from '@pine/core/chains'
import { useClaims, usePolicies } from '@pine/react'
import { FilePlus2, Search, SlidersHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { DOCKET_GROUPS, docketGroup, type DocketGroup } from '@/lib/stage'
import { Input, Select } from '@/components/ui/field'
import { ButtonLink } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/layout'
import { Notice } from '@/components/ui/notice'
import { useClientNow } from '@/components/ui/when'
import { DocketRow } from './docket-row'

const SORTS: { id: ClaimSort; label: string }[] = [
  { id: 'deadline', label: 'Next deadline first' },
  { id: 'newest', label: 'Newest filings first' },
  { id: 'activity', label: 'Most recent activity' },
  { id: 'liquidity', label: 'Most liquidity' },
  { id: 'volume', label: 'Most volume' },
  { id: 'yes_price', label: 'Highest implied chance' },
]

const STAGE_FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All stages' },
  { id: 'attention', label: 'Needs attention now' },
  { id: 'open', label: 'Evidence window open' },
  { id: 'awaiting', label: 'Awaiting or weighing an answer' },
  { id: 'contested', label: 'Disputed or in arbitration' },
  { id: 'decided', label: 'Decided' },
  { id: 'incomplete', label: 'Filing incomplete' },
  { id: 'settled', label: 'Settled or closed' },
]

function useFilters() {
  const sp = useSearchParams()
  return {
    q: sp.get('q') ?? '',
    stage: sp.get('stage') ?? '',
    policy: sp.get('policy') ?? '',
    repo: sp.get('repo') ?? '',
    chain: sp.get('chain') ?? '',
    sort: (sp.get('sort') as ClaimSort) || 'deadline',
    grouped: sp.get('view') !== 'list',
  }
}

export function DocketBrowser() {
  const f = useFilters()
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const now = useClientNow(60_000)
  const [search, setSearch] = useState(f.q)
  // On a phone, five full-width selects push the first claim two screens down. They fold away until asked for.
  const [showFilters, setShowFilters] = useState(false)
  const deferred = useDeferredValue(search)

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  useEffect(() => {
    const t = setTimeout(() => {
      if (deferred !== f.q) set({ q: deferred || null })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred])

  const query: ClaimQuery = {
    search: f.q || undefined,
    policyId: f.policy || undefined,
    repo: f.repo || undefined,
    chainId: f.chain ? Number(f.chain) : undefined,
    sort: f.sort,
    limit: 200,
  }
  const claims = useClaims(query)
  const all = useClaims({ limit: 200 })
  const policies = usePolicies()

  const repos = useMemo(() => {
    const set = new Set<string>()
    for (const c of all.data?.items ?? []) set.add(`${c.source.owner}/${c.source.repo}`)
    return [...set].sort()
  }, [all.data])

  const clock = now ?? new Date()
  const items = useMemo(() => {
    const list = claims.data?.items ?? []
    if (!f.stage) return list
    return list.filter((c) => {
      const g = docketGroup(c, clock)
      if (f.stage === 'attention') return DOCKET_GROUPS.find((x) => x.id === g)?.attention
      if (f.stage === 'open') return g === 'open' || g === 'closing'
      return g === f.stage
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims.data, f.stage, now])

  const groups = useMemo(() => {
    const map = new Map<DocketGroup, ClaimSummary[]>()
    for (const c of items) {
      const g = docketGroup(c, clock)
      map.set(g, [...(map.get(g) ?? []), c])
    }
    return DOCKET_GROUPS.map((g) => ({ ...g, items: map.get(g.id) ?? [] })).filter((g) => g.items.length > 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, now])

  const attention = groups.filter((g) => g.attention)
  const rest = groups.filter((g) => !g.attention)
  const filtered = !!(f.q || f.stage || f.policy || f.repo || f.chain)
  const activeFilters = [f.stage, f.policy, f.repo, f.chain].filter(Boolean).length + (f.sort && f.sort !== 'deadline' ? 1 : 0)

  return (
    <div>
      <form
        role="search"
        className="border border-rule bg-sheet p-4 sm:p-5"
        onSubmit={(e) => {
          e.preventDefault()
          set({ q: search || null })
        }}
      >
        <label htmlFor="docket-search" className="block font-bold">
          Search the docket
        </label>
        <p className="text-sm text-graphite">By title, repository, commit SHA, policy or docket number.</p>
        <div className="relative mt-2">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-graphite" />
          <Input
            id="docket-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="For example: gateway-balancer, 9f3c2e1 or PINE-0042"
            className="h-12 pl-10 text-[17px]"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls="docket-filters"
          onClick={() => setShowFilters((v) => !v)}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-violet underline underline-offset-4 sm:hidden"
        >
          <SlidersHorizontal aria-hidden className="size-4" />
          {showFilters ? 'Hide filters' : `Filters and order${activeFilters ? ` (${activeFilters} on)` : ''}`}
        </button>
        <div id="docket-filters" className={cn('mt-4 grid gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-5', !showFilters && 'hidden')}>
          <FilterSelect label="Stage" value={f.stage} onChange={(v) => set({ stage: v })} options={STAGE_FILTERS.map((s) => ({ value: s.id, label: s.label }))} />
          <FilterSelect
            label="Policy"
            value={f.policy}
            onChange={(v) => set({ policy: v })}
            options={[{ value: '', label: 'All policies' }, ...(policies.data ?? []).map((p) => ({ value: p.id, label: `${p.id}: ${p.title}` }))]}
          />
          <FilterSelect
            label="Repository"
            value={f.repo}
            onChange={(v) => set({ repo: v })}
            options={[{ value: '', label: 'All repositories' }, ...repos.map((r) => ({ value: r, label: r }))]}
          />
          <FilterSelect
            label="Chain"
            value={f.chain}
            onChange={(v) => set({ chain: v })}
            options={[{ value: '', label: 'All chains' }, ...SUPPORTED_CHAIN_IDS.map((id) => ({ value: String(id), label: CHAINS[id]?.name ?? String(id) }))]}
          />
          <FilterSelect label="Order" value={f.sort} onChange={(v) => set({ sort: v === 'deadline' ? null : v })} options={SORTS.map((s) => ({ value: s.id, label: s.label }))} />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
          <div role="group" aria-label="Layout" className="inline-flex border border-rule-strong">
            {[
              { v: 'grouped', label: 'Grouped by stage' },
              { v: 'list', label: 'Single list' },
            ].map((o) => {
              const on = (o.v === 'grouped') === f.grouped
              return (
                <button
                  key={o.v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ view: o.v === 'grouped' ? null : 'list' })}
                  className={cn('px-3 py-1.5 text-sm font-bold', on ? 'bg-ink text-white' : 'bg-sheet hover:bg-bond')}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
          {filtered ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm font-bold text-violet underline underline-offset-4"
              onClick={() => {
                setSearch('')
                router.replace(pathname, { scroll: false })
              }}
            >
              <X aria-hidden className="size-4" /> Clear search and filters
            </button>
          ) : null}
        </div>
      </form>

      <div className="mt-8" aria-live="polite" aria-busy={claims.isLoading}>
        {claims.isError ? (
          <Notice tone="critical" title="The docket could not be loaded" action={<button className="link" onClick={() => void claims.refetch()}>Try again</button>}>
            {(claims.error as Error)?.message ?? 'The data source did not respond.'}
          </Notice>
        ) : claims.isLoading ? (
          <DocketSkeleton />
        ) : items.length === 0 ? (
          <EmptyState
            title={filtered ? 'No claims match these filters' : 'The docket is empty'}
            action={
              filtered ? (
                <button
                  type="button"
                  className="link font-bold"
                  onClick={() => {
                    setSearch('')
                    router.replace(pathname, { scroll: false })
                  }}
                >
                  Clear search and filters
                </button>
              ) : (
                <ButtonLink href="/file" icon={<FilePlus2 aria-hidden />}>
                  File the first verification
                </ButtonLink>
              )
            }
          >
            {filtered ? 'Try a shorter search, or widen the stage and policy filters.' : 'Nobody has filed a claim yet.'}
          </EmptyState>
        ) : f.grouped ? (
          <div className="space-y-10">
            <p className="text-sm text-graphite measure">
              Showing {items.length} claim{items.length === 1 ? '' : 's'}. Each group is a stage of the procedure. “Implied chance” is the market-implied chance that a qualifying counterexample is accepted. It is not a probability that the code has bugs, and thin markets can be far from informed.
            </p>
            {attention.length > 0 ? (
              <section aria-labelledby="attention-title">
                <h2 id="attention-title" className="flex items-center gap-3 text-2xl">
                  <span aria-hidden className="h-7 w-2 bg-flag" /> Needs attention now
                </h2>
                <div className="mt-4 space-y-6">
                  {attention.map((g) => (
                    <Group key={g.id} title={g.title} description={g.description} items={g.items} />
                  ))}
                </div>
              </section>
            ) : null}
            {rest.map((g) => (
              <section key={g.id} aria-labelledby={`g-${g.id}`}>
                <h2 id={`g-${g.id}`} className="flex items-center gap-3 text-2xl">
                  <span aria-hidden className="h-7 w-2 bg-ink" /> {g.title}
                </h2>
                <p className="mt-1 text-graphite">{g.description}</p>
                <div className="mt-4 border-t border-rule">
                  {g.items.map((c) => (
                    <DocketRow key={c.id} claim={c} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-graphite measure">
              Showing {items.length} claim{items.length === 1 ? '' : 's'}, {SORTS.find((s) => s.id === f.sort)?.label.toLowerCase()}. “Implied chance” is the market-implied chance that a qualifying counterexample is accepted. It is not a probability that the code has bugs, and thin markets can be far from informed.
            </p>
            <div className="border-t border-rule">
              {items.map((c) => (
                <DocketRow key={c.id} claim={c} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Group({ title, description, items }: { title: string; description: string; items: ClaimSummary[] }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b-2 border-ink pb-1.5">
        <h3 className="text-lg font-bold">{title}</h3>
        <span className="text-sm text-graphite">
          {items.length} entr{items.length === 1 ? 'y' : 'ies'}
        </span>
      </div>
      <p className="mt-1.5 mb-1 text-[15px] text-graphite">{description}</p>
      <div className="border-t border-rule">
        {items.map((c) => (
          <DocketRow key={c.id} claim={c} />
        ))}
      </div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="block min-w-0">
      <span className="text-sm font-bold">{label}</span>
      <Select className="mt-1" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  )
}

export function DocketSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="border-t border-rule" aria-label="Loading claims">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid gap-4 border-b border-rule bg-sheet px-5 py-5 md:grid-cols-[8.5rem_minmax(0,1fr)_11.5rem]">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-5 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-5 w-40" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      ))}
    </div>
  )
}
