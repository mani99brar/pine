'use client'

import { useMemo, useState } from 'react'
import type { ClaimQuery, ClaimStatus, ClaimSummary, PolicyFamilyId } from '@pine/core'
import { formatAmount } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useClaims } from '@pine/react'
import { LayoutGrid, List, Map as MapIcon, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import { ClaimTile, ClaimTileSkeleton } from './ClaimTile'
import { ClaimListHeader, ClaimRow } from './ClaimRow'
import { FieldMap } from './FieldMap'
import { BoardLegend } from './BoardLegend'
import { useDepthMap, useUrlState } from '@/lib/hooks'
import { depthWithin5 } from '@/lib/depth'
import { useNowMs } from '@/lib/now'
import { Chip, Segmented } from '@/components/ui/interactive'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Select } from '@/components/ui/form'
import { cn } from '@/lib/cn'

const STATUS_GROUPS: { value: string; label: string; statuses: ClaimStatus[] }[] = [
  { value: 'open', label: 'Open for evidence', statuses: ['open'] },
  { value: 'oracle', label: 'Answering and disputes', statuses: ['awaiting_answer', 'answer_proposed', 'disputed', 'arbitration'] },
  { value: 'resolved', label: 'Resolved', statuses: ['resolved', 'settled'] },
  { value: 'all', label: 'Everything', statuses: [] },
]

export type BoardSort = 'closing' | 'thin' | 'move' | 'newest'
const SORTS: { value: BoardSort; label: string }[] = [
  { value: 'closing', label: 'Closing soon' },
  { value: 'thin', label: 'Thin depth' },
  { value: 'move', label: 'Biggest 24h move' },
  { value: 'newest', label: 'Newest' },
]

const FAMILIES: PolicyFamilyId[] = ['FUNC', 'BOT', 'SC']
const KEYS = ['q', 'status', 'family', 'repo', 'sort', 'view', 'sponsored'] as const

export function BoardView() {
  const [s, set] = useUrlState(KEYS)
  const status = STATUS_GROUPS.find((g) => g.value === s.status) ?? STATUS_GROUPS[0]!
  const family = FAMILIES.includes(s.family as PolicyFamilyId) ? (s.family as PolicyFamilyId) : undefined
  const sort = (SORTS.find((x) => x.value === s.sort)?.value ?? 'closing') as BoardSort
  const view = s.view === 'list' || s.view === 'map' ? s.view : 'board'
  const [searchDraft, setSearchDraft] = useState(s.q ?? '')
  const [filtersOpen, setFiltersOpen] = useState(false)

  const query: ClaimQuery = {
    status: status.statuses.length ? status.statuses : undefined,
    family,
    repo: s.repo,
    search: s.q,
    sort: sort === 'newest' ? 'newest' : 'deadline',
    limit: 100,
  }
  const claimsQ = useClaims(query)
  // Facet counts come from the unfiltered list (all statuses) so chips can show what's there.
  const allQ = useClaims({ limit: 200 })
  const items = useMemo(() => claimsQ.data?.items ?? [], [claimsQ.data])
  const filtered = useMemo(() => (s.sponsored === '1' ? items.filter((c) => c.sponsored) : items), [items, s.sponsored])
  const ids = filtered.map((c) => c.id)
  const depth = useDepthMap(ids)
  const now = useNowMs()

  const sorted = useMemo(() => sortClaims(filtered, sort, depth.map), [filtered, sort, depth.map])

  const repos = useMemo(() => {
    const m = new Map<string, number>()
    ;(allQ.data?.items ?? []).forEach((c) => {
      const k = `${c.source.owner}/${c.source.repo}`
      m.set(k, (m.get(k) ?? 0) + 1)
    })
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [allQ.data])

  const famCount = (f: PolicyFamilyId) => (allQ.data?.items ?? []).filter((c) => c.policy.family === f).length
  const statusCount = (g: (typeof STATUS_GROUPS)[number]) =>
    (allQ.data?.items ?? []).filter((c) => g.statuses.length === 0 || g.statuses.includes(c.status)).length

  const openItems = sorted.filter((c) => c.status === 'open')
  const closingSoon = now === null ? 0 : openItems.filter((c) => new Date(c.evidenceDeadline).getTime() - now < 86_400_000).length
  const executable = openItems.reduce((sum, c) => sum + depthWithin5(depth.map[c.id]), 0)
  const symbol = sorted[0]?.collateralSymbol ?? 'sDAI'
  const activeFilters = [family, s.repo, s.q, s.sponsored].filter(Boolean).length + (status.value !== 'open' ? 1 : 0)

  const clearAll = () => {
    setSearchDraft('')
    set({ q: null, status: null, family: null, repo: null, sponsored: null })
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      {/* Masthead */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="max-w-[46rem]">
          <h1 className="t-display-l">The board</h1>
          <p className="mt-3 text-[1.05rem] text-ink-2">
            Every claim pins one commit and one bounded violation. Look for tension, time and thin depth, then open a claim to investigate.
          </p>
        </div>
        <dl className="grid grid-cols-3 gap-x-8 gap-y-2" aria-live="polite">
          <BoardStat label="Open now" value={claimsQ.isLoading ? '…' : String(openItems.length)} />
          <BoardStat label="Close within 24 h" value={claimsQ.isLoading ? '…' : String(closingSoon)} accent={closingSoon > 0} />
          <BoardStat label={`${symbol} executable ±5 pts`} value={claimsQ.isLoading ? '…' : formatAmount(executable, { compact: executable >= 10000, maxDecimals: 0 })} />
        </dl>
      </div>

      {/* Controls */}
      <div className="sticky top-16 z-30 -mx-4 mt-8 border-y border-line-strong bg-fog px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-center gap-2.5">
          <form
            role="search"
            className="relative min-w-0 flex-1 basis-[14rem]"
            onSubmit={(e) => {
              e.preventDefault()
              set({ q: searchDraft.trim() || null })
            }}
          >
            <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <label htmlFor="board-search" className="sr-only">
              Search claims, repositories and commit SHAs
            </label>
            <input
              id="board-search"
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onBlur={() => searchDraft.trim() !== (s.q ?? '') && set({ q: searchDraft.trim() || null })}
              placeholder="Search claims, repos, SHAs"
              className="h-10 w-full rounded-full border-[1.5px] border-line-strong bg-sheet pl-9 pr-9 text-[0.94rem] placeholder:text-ink-3 focus:border-ink focus:outline-none focus-visible:shadow-[0_0_0_3px_var(--lumen)]"
            />
            {searchDraft && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchDraft('')
                  set({ q: null })
                }}
                className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full hover:bg-ink/[0.07]"
              >
                <X size={14} aria-hidden />
              </button>
            )}
          </form>
          <Button variant="secondary" className="lg:hidden" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-controls="board-filters" icon={<SlidersHorizontal size={15} aria-hidden />}>
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
          <label className="flex items-center gap-2 text-[0.86rem] font-[600] text-ink-2">
            <span className="hidden sm:inline">Sort</span>
            <Select value={sort} onChange={(e) => set({ sort: e.target.value === 'closing' ? null : e.target.value })} className="h-10 w-auto min-w-[10.5rem] rounded-full" aria-label="Sort claims">
              {SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <Segmented
            label="Layout"
            value={view}
            onChange={(v) => set({ view: v === 'board' ? null : v })}
            options={[
              { value: 'board', label: <><LayoutGrid size={15} aria-hidden /><span className="hidden sm:inline">Board</span></>, title: 'Board' },
              { value: 'list', label: <><List size={15} aria-hidden /><span className="hidden sm:inline">List</span></>, title: 'List' },
              { value: 'map', label: <><MapIcon size={15} aria-hidden /><span className="hidden sm:inline">Map</span></>, title: 'Field map' },
            ]}
          />
        </div>

        <div id="board-filters" className={cn('mt-3 flex-wrap items-center gap-2', filtersOpen ? 'flex' : 'hidden lg:flex')}>
          <div className="scrollbar-none -mx-1 flex max-w-full gap-2 overflow-x-auto px-1 py-0.5">
            {STATUS_GROUPS.map((g) => (
              <Chip key={g.value} active={status.value === g.value} onClick={() => set({ status: g.value === 'open' ? null : g.value })} count={allQ.data ? statusCount(g) : undefined}>
                {g.label}
              </Chip>
            ))}
          </div>
          <span aria-hidden className="mx-1 hidden h-6 w-px bg-line-strong sm:block" />
          <div className="scrollbar-none -mx-1 flex max-w-full gap-2 overflow-x-auto px-1 py-0.5">
            {FAMILIES.map((f) => (
              <Chip
                key={f}
                active={family === f}
                onClick={() => set({ family: family === f ? null : f })}
                icon={<PolicyShape family={f} gated={f === 'SC'} size={13} />}
                count={allQ.data ? famCount(f) : undefined}
              >
                {f}
              </Chip>
            ))}
            <Chip active={s.sponsored === '1'} onClick={() => set({ sponsored: s.sponsored === '1' ? null : '1' })}>
              Sponsored
            </Chip>
          </div>
          <span aria-hidden className="mx-1 hidden h-6 w-px bg-line-strong sm:block" />
          <label className="flex items-center gap-2">
            <span className="sr-only">Repository</span>
            <Select value={s.repo ?? ''} onChange={(e) => set({ repo: e.target.value || null })} className="h-8 w-auto max-w-[15rem] rounded-full text-[0.84rem]" aria-label="Filter by repository">
              <option value="">All repositories</option>
              {repos.map(([r, n]) => (
                <option key={r} value={r}>
                  {r} ({n})
                </option>
              ))}
            </Select>
          </label>
          {activeFilters > 0 && (
            <button type="button" onClick={clearAll} className="ml-1 text-[0.84rem] font-[600] text-ink-2 underline underline-offset-[3px] hover:text-ink">
              Clear filters
            </button>
          )}
        </div>
      </div>

      <BoardLegend className="mt-5" />

      {/* Results */}
      <div className="mt-6" aria-busy={claimsQ.isLoading}>
        <p className="sr-only" aria-live="polite">
          {claimsQ.isLoading ? 'Loading claims' : `${sorted.length} claims shown`}
        </p>
        {claimsQ.isError ? (
          <ErrorState title="The board could not be loaded" error={claimsQ.error} onRetry={() => claimsQ.refetch()} />
        ) : claimsQ.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <ClaimTileSkeleton key={i} />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            title={activeFilters ? 'Nothing on the board matches these filters' : 'The board is empty'}
            body={
              activeFilters
                ? 'Clear a filter or search for a repository or commit SHA instead. Claims that have already resolved are under "Resolved".'
                : 'No claims are open right now. Pin a commit and publish the first bounded claim.'
            }
            action={
              <>
                {activeFilters > 0 && (
                  <Button variant="secondary" onClick={clearAll}>
                    Clear filters
                  </Button>
                )}
                <ButtonLink href="/compose" icon={<Plus size={16} aria-hidden />}>
                  Put a claim on the board
                </ButtonLink>
              </>
            }
          />
        ) : view === 'map' ? (
          <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-6">
            {status.value !== 'open' && (
              <p className="mb-4 text-[0.88rem] text-ink-2">The map plots claims whose evidence window is still open. Switch to the board or list to see the others.</p>
            )}
            <FieldMap claims={sorted} depths={depth.map} />
          </div>
        ) : view === 'list' ? (
          <>
            <ClaimListHeader />
            <ul className="flex flex-col gap-2">
              {sorted.map((c) => (
                <ClaimRow key={c.id} claim={c} depth={depth.map[c.id]} depthLoading={depth.loading[c.id]} />
              ))}
            </ul>
          </>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sorted.map((c, i) => (
              <li key={c.id} className="flex">
                <ClaimTile
                  claim={c}
                  depth={depth.map[c.id]}
                  depthLoading={depth.loading[c.id]}
                  settleDelay={staggerFor(i)}
                  className="w-full"
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-8 max-w-[80ch] text-[0.84rem] text-ink-3">
        {COPY.priceCaveat} {COPY.volumeCaveat}
      </p>
    </div>
  )
}

/** Diagonal wave: tiles further down-right settle later. Capped so long boards don't drag. */
function staggerFor(i: number): number {
  const cols = 4
  const r = Math.floor(i / cols)
  const c = i % cols
  return Math.min(900, (r + c) * 70)
}

function BoardStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.78rem] font-[550] leading-tight text-ink-3">{label}</dt>
      <dd className={cn('t-figure mt-1 text-[2rem]', accent ? 'text-lumen-ink' : 'text-ink')}>{value}</dd>
    </div>
  )
}

export function sortClaims(items: ClaimSummary[], sort: BoardSort, depth: Record<string, unknown>): ClaimSummary[] {
  const arr = [...items]
  const rank = (c: ClaimSummary) => (c.status === 'open' ? 0 : c.status === 'publishing' ? 2 : 1)
  if (sort === 'closing') {
    arr.sort((a, b) => rank(a) - rank(b) || new Date(a.evidenceDeadline).getTime() - new Date(b.evidenceDeadline).getTime())
  } else if (sort === 'newest') {
    arr.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  } else if (sort === 'move') {
    const mv = (c: ClaimSummary) => (c.yesPrice !== undefined && c.yesPrice24hAgo !== undefined ? Math.abs(c.yesPrice - c.yesPrice24hAgo) : -1)
    arr.sort((a, b) => mv(b) - mv(a))
  } else if (sort === 'thin') {
    const d = (c: ClaimSummary) =>
      c.yesPrice === undefined || c.status !== 'open' ? Number.POSITIVE_INFINITY : depthWithin5(depth[c.id] as Parameters<typeof depthWithin5>[0])
    arr.sort((a, b) => d(a) - d(b))
  }
  return arr
}
