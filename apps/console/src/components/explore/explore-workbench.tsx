'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Popover } from 'radix-ui'
import { ArrowDown, ArrowUp, Bookmark, PanelRightClose, PanelRightOpen, Search, X } from 'lucide-react'
import type { ClaimSummary } from '@pine/core'
import { POLICIES, formatAmount, formatClaimNumber, formatDate, formatPrice, shortSha, timeRemaining } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useAccount, useClaims, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { useKeys } from '@/lib/use-keys'
import { useNowTick } from '@/lib/use-now'
import { useLocalStorageState } from '@/lib/hooks'
import { BUILT_IN_VIEWS, sortClaims, type ExploreFilters, type SortKey } from '@/lib/views'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { DeadlineBar } from '@/components/ui/instruments'
import { EmptyState } from '@/components/ui/empty-state'
import { SkeletonRows } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/ui/tooltip'
import { StatusDot, statusColor, statusLabel } from '@/components/claim/status'
import { RowSparkline } from './row-sparkline'
import { ClaimPreview } from './claim-preview'

interface SavedView {
  id: string
  name: string
  filters: Omit<ExploreFilters, 'view'> & { base: string }
}
const SAVED_KEY = 'pine-console:saved-views'
const PREVIEW_KEY = 'pine-console:preview-open'

export function ExploreWorkbench({ initial }: { initial: ExploreFilters }) {
  const router = useRouter()
  const [f, setF] = React.useState<ExploreFilters>(initial)
  const [selectedRaw, setSelected] = React.useState(0)
  const [previewOpen, setPreviewOpen] = useLocalStorageState(PREVIEW_KEY, true)
  const [saved, setSaved] = useLocalStorageState<SavedView[]>(SAVED_KEY, [])
  const searchRef = React.useRef<HTMLInputElement>(null)
  const tableRef = React.useRef<HTMLTableSectionElement>(null)
  const now = useNowTick(30_000)
  const wallet = useWallet()
  const { account } = useAccount()

  // Keep the URL shareable without a navigation.
  React.useEffect(() => {
    const p = new URLSearchParams()
    if (f.view !== 'all') p.set('view', f.view)
    if (f.q) p.set('q', f.q)
    if (f.policy) p.set('policy', f.policy)
    if (f.repo) p.set('repo', f.repo)
    if (f.sort !== 'deadline') p.set('sort', f.sort)
    if (f.dir !== 'asc') p.set('dir', f.dir)
    const qs = p.toString()
    window.history.replaceState(null, '', qs ? `/claims?${qs}` : '/claims')
  }, [f])

  const all = useClaims({ limit: 200, sort: 'newest' })
  const items = React.useMemo(() => all.data?.items ?? [], [all.data])

  const ctx = React.useMemo(
    () => ({ now: now.getTime(), me: wallet.address, login: account?.github.login }),
    [now, wallet.address, account],
  )
  const savedView = saved.find((s) => s.id === f.view)
  const baseView = BUILT_IN_VIEWS.find((v) => v.id === (savedView ? savedView.filters.base : f.view)) ?? BUILT_IN_VIEWS[0]!

  const rows = React.useMemo(() => {
    const q = f.q.trim().toLowerCase()
    const filtered = items.filter((c) => {
      if (!baseView.match(c, ctx)) return false
      if (f.policy && c.policy.id !== f.policy) return false
      if (f.repo && `${c.source.owner}/${c.source.repo}` !== f.repo) return false
      if (q) {
        const hay = [
          formatClaimNumber(c.number),
          c.title,
          c.violation,
          c.source.owner,
          c.source.repo,
          c.source.commitSha,
          c.policy.id,
          c.source.prTitle ?? '',
          ...c.tags,
        ]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return sortClaims(filtered, f.sort, f.dir)
  }, [items, baseView, ctx, f])

  const repos = React.useMemo(() => [...new Set(items.map((c) => `${c.source.owner}/${c.source.repo}`))].sort(), [items])
  const counts = React.useMemo(
    () => Object.fromEntries(BUILT_IN_VIEWS.map((v) => [v.id, items.filter((c) => v.match(c, ctx)).length])),
    [items, ctx],
  )

  const selected = Math.min(selectedRaw, Math.max(rows.length - 1, 0))

  const current: ClaimSummary | undefined = rows[selected]

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, i))
    setSelected(next)
    const el = tableRef.current?.querySelector<HTMLElement>(`[data-row="${next}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }

  useKeys({
    j: () => focusRow(selected + 1),
    k: () => focusRow(selected - 1),
    ArrowDown: (e) => {
      if ((e.target as HTMLElement)?.closest?.('[data-explore-table]')) {
        e.preventDefault()
        focusRow(selected + 1)
      }
    },
    ArrowUp: (e) => {
      if ((e.target as HTMLElement)?.closest?.('[data-explore-table]')) {
        e.preventDefault()
        focusRow(selected - 1)
      }
    },
    Enter: (e) => {
      if ((e.target as HTMLElement)?.closest?.('a,button')) return
      if (current) router.push(`/claims/${current.id}`)
    },
    ' ': (e) => {
      if ((e.target as HTMLElement)?.closest?.('a,button')) return
      e.preventDefault()
      togglePreview()
    },
    Escape: () => {
      if (document.activeElement === searchRef.current) searchRef.current?.blur()
    },
  })

  function togglePreview() {
    setPreviewOpen((o) => !o)
  }

  const set = (patch: Partial<ExploreFilters>) => {
    setF((cur) => ({ ...cur, ...patch }))
    setSelected(0)
  }
  const sortBy = (key: SortKey) =>
    setF((cur) => ({ ...cur, sort: key, dir: cur.sort === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : key === 'deadline' ? 'asc' : 'desc' }))

  const saveView = (name: string) => {
    if (!name.trim()) return
    const v: SavedView = { id: `saved-${Date.now()}`, name, filters: { q: f.q, policy: f.policy, repo: f.repo, sort: f.sort, dir: f.dir, base: baseView.id } }
    setSaved([...saved, v])
    setF((cur) => ({ ...cur, view: v.id }))
  }
  const removeView = (id: string) => {
    setSaved(saved.filter((s) => s.id !== id))
    if (f.view === id) set({ view: 'all' })
  }
  const applySaved = (v: SavedView) => setF({ view: v.id, q: v.filters.q, policy: v.filters.policy, repo: v.filters.repo, sort: v.filters.sort, dir: v.filters.dir })

  const filtersActive = !!(f.q || f.policy || f.repo)

  return (
    <div className="flex min-h-[calc(100dvh-48px-28px)] flex-col xl:flex-row">
      {/* Table */}
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Claims">
        <div className="scrollbar-thin flex items-end gap-0 relative overflow-x-auto border-b border-line bg-frost px-2 pt-2 sm:px-3" role="toolbar" aria-label="Views">
          {BUILT_IN_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => set({ view: v.id })}
              aria-pressed={f.view === v.id}
              title={v.description}
              className={cn(
                'relative flex h-9 shrink-0 items-center gap-1.5 rounded-t-ctl px-3 text-[13px] text-muted transition-colors hover:text-bark',
                f.view === v.id && 'border border-b-0 border-line bg-surface font-medium text-bark after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-surface',
              )}
            >
              {v.label}
              <span className={cn('tnum text-[11.5px]', f.view === v.id ? 'text-needle' : 'text-faint')}>{all.isLoading ? '' : (counts[v.id] ?? 0)}</span>
            </button>
          ))}
          {saved.map((v) => (
            <span key={v.id} className="group relative flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => applySaved(v)}
                aria-pressed={f.view === v.id}
                className={cn(
                  'flex h-9 items-center gap-1.5 rounded-t-ctl pl-3 pr-6 text-[13px] text-muted hover:text-bark',
                  f.view === v.id && 'border border-b-0 border-line bg-surface font-medium text-bark',
                )}
              >
                <Bookmark size={12} aria-hidden /> {v.name}
              </button>
              <button
                type="button"
                onClick={() => removeView(v.id)}
                className="absolute right-1 rounded-chip p-0.5 text-faint opacity-0 hover:text-flare focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Delete saved view ${v.name}`}
              >
                <X size={11} aria-hidden />
              </button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2 sm:px-4">
          <div className="relative min-w-[180px] flex-1 sm:max-w-[300px]">
            <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              ref={searchRef}
              data-slash-focus
              value={f.q}
              onChange={(e) => set({ q: e.target.value })}
              placeholder="Filter claims"
              aria-label="Filter claims"
              className="pl-8 pr-8"
            />
            <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
          </div>
          <Select value={f.policy} onChange={(e) => set({ policy: e.target.value })} aria-label="Policy" className="w-auto min-w-[120px]">
            <option value="">All policies</option>
            {POLICIES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} {p.status === 'gated' ? '(gated)' : ''}
              </option>
            ))}
          </Select>
          <Select value={f.repo} onChange={(e) => set({ repo: e.target.value })} aria-label="Repository" className="w-auto min-w-[140px] max-w-[220px]">
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          {filtersActive ? (
            <Button variant="quiet" size="sm" onClick={() => set({ q: '', policy: '', repo: '' })}>
              Clear
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <SaveViewPopover suggested={f.q || f.repo || f.policy || baseView.label} onSave={saveView} />
            <Tooltip content={previewOpen ? 'Hide preview (Space)' : 'Show preview (Space)'}>
              <button
                type="button"
                onClick={togglePreview}
                className="hidden size-7 items-center justify-center rounded-ctl text-muted hover:bg-sunken hover:text-bark xl:flex"
                aria-label={previewOpen ? 'Hide preview pane' : 'Show preview pane'}
                aria-pressed={previewOpen}
              >
                {previewOpen ? <PanelRightClose size={15} aria-hidden /> : <PanelRightOpen size={15} aria-hidden />}
              </button>
            </Tooltip>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 relative overflow-x-auto bg-surface" data-explore-table>
          {all.isError ? (
            <EmptyState
              tone="error"
              title="Claims could not be loaded"
              action={
                <Button onClick={() => void all.refetch()} variant="secondary">
                  Retry
                </Button>
              }
            >
              The data source did not respond: {(all.error as Error)?.message ?? 'unknown error'}. Check the indexer URL in your environment, then retry.
            </EmptyState>
          ) : all.isLoading ? (
            <SkeletonRows rows={9} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={items.length === 0 ? 'No claims published yet' : 'No claims match this view'}
              action={
                items.length === 0 ? (
                  <Button asChild variant="primary">
                    <Link href="/new">Verify a commit</Link>
                  </Button>
                ) : (
                  <>
                    <Button variant="secondary" onClick={() => set({ view: 'all', q: '', policy: '', repo: '' })}>
                      Show all claims
                    </Button>
                    <Button asChild variant="ghost">
                      <Link href="/new">Verify a commit</Link>
                    </Button>
                  </>
                )
              }
            >
              {items.length === 0
                ? 'Publish the first claim: pin a commit, choose a policy and state one bounded requirement.'
                : `${baseView.label} has nothing that matches${filtersActive ? ' the current filters' : ''}. Clear filters or switch views.`}
            </EmptyState>
          ) : (
            <>
            <ul className="divide-y divide-line md:hidden" aria-label="Claims">
              {rows.map((c, i) => (
                <MobileClaimRow key={c.id} c={c} now={now} selected={i === selected} />
              ))}
            </ul>
            <table className="hidden w-full min-w-[760px] table-fixed border-collapse text-left text-[13px] md:table">
              <caption className="sr-only">
                Claims, {rows.length} shown. Use j and k to move, Enter to open, Space to toggle the preview.
              </caption>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="stretch-cond border-b border-line text-[12px] text-muted">
                  <th scope="col" className="w-9 py-2 pl-4 font-medium">
                    <span className="sr-only">Status</span>
                  </th>
                  <SortTh label="Claim" k="newest" f={f} onSort={sortBy} />
                  <SortTh
                    label="YES"
                    k="yes"
                    f={f}
                    onSort={sortBy}
                    title={COPY.priceLabel}
                    className="w-[178px]"
                  />
                  <SortTh label="Liquidity" k="liquidity" f={f} onSort={sortBy} align="right" className="w-[96px]" />
                  <SortTh label="Evid." k="evidence" f={f} onSort={sortBy} align="right" className="w-[60px]" title="Evidence submissions" />
                  <SortTh label="Evidence window" k="deadline" f={f} onSort={sortBy} className="w-[156px] pl-3 pr-4" title="Time left, or the claim status once the evidence deadline has passed" />
                </tr>
              </thead>
              <tbody ref={tableRef}>
                {rows.map((c, i) => (
                  <ClaimRow
                    key={c.id}
                    c={c}
                    i={i}
                    selected={i === selected}
                    now={now}
                    onSelect={() => setSelected(i)}
                    onOpen={() => router.push(`/claims/${c.id}`)}
                  />
                ))}
              </tbody>
            </table>
            </>
          )}
        </div>
        {rows.length ? (
          <div className="hidden items-center gap-4 border-t border-line bg-frost px-4 py-1.5 text-[11.5px] text-muted sm:flex">
            <span className="tnum">
              {rows.length} of {items.length} claims
            </span>
            <span className="flex items-center gap-1">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> open
            </span>
            <span className="hidden items-center gap-1 xl:flex">
              <Kbd>Space</Kbd> preview
            </span>
            <span className="ml-auto max-w-[60ch] truncate" title={COPY.priceCaveat}>
              YES = {COPY.priceLabel.toLowerCase()}
            </span>
          </div>
        ) : null}
      </section>

      {previewOpen && current ? (
        <aside className="hidden w-[360px] shrink-0 border-l border-line bg-frost xl:block" aria-label="Preview">
          <ClaimPreview id={current.id} summary={current} onClose={togglePreview} />
        </aside>
      ) : null}
    </div>
  )
}

function SaveViewPopover({ suggested, onSave }: { suggested: string; onSave: (name: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState('')
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setName(suggested)
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost" size="sm" title="Save the current filters as a view">
          <Bookmark size={13} aria-hidden /> Save view
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="animate-fade-in z-50 w-72 rounded-float border border-line bg-raised p-3 shadow-float">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSave(name)
              setOpen(false)
            }}
          >
            <label htmlFor="view-name" className="stretch-cond text-[12.5px] font-medium">
              Name this view
            </label>
            <Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
            <p className="mt-1.5 text-[11.5px] text-muted">Saves the current view, filters and sort in this browser.</p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={!name.trim()}>
                Save view
              </Button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function MobileClaimRow({ c, now, selected }: { c: ClaimSummary; now: Date; selected: boolean }) {
  const rem = timeRemaining(c.evidenceDeadline, now)
  return (
    <li className={cn(selected && 'bg-needle-soft/50')}>
      <Link href={`/claims/${c.id}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 px-4 py-3">
        <span className="pt-1">
          <StatusDot status={c.status} outcome={c.outcome} />
        </span>
        <span className="min-w-0">
          <span className="line-clamp-2 text-[14px] font-medium leading-snug">{c.title}</span>
          <span className="mono-cond mt-0.5 block truncate text-[11px] text-muted">
            {formatClaimNumber(c.number)} {c.source.owner}/{c.source.repo}@{shortSha(c.source.commitSha)}
          </span>
          <span className={cn('mt-0.5 block text-[12px]', c.status === 'open' ? (rem.ms < 48 * 3600_000 ? 'font-medium text-resin' : 'text-muted') : statusColor(c.status, c.outcome))}>
            {c.status === 'open' ? `${rem.label} left` : statusLabel(c.status, c.outcome)}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="tnum text-[15px] font-semibold">{typeof c.yesPrice === 'number' ? formatPrice(c.yesPrice) : ''}</span>
          {typeof c.yesPrice === 'number' ? <RowSparkline id={c.id} width={56} height={16} /> : <span className="text-[11.5px] text-faint">No market</span>}
          <span className="tnum text-[11px] text-muted">{Number(c.liquidity) > 0 ? formatAmount(c.liquidity, { symbol: c.collateralSymbol, compact: true }) : ''}</span>
        </span>
      </Link>
    </li>
  )
}

function SortTh({
  label,
  k,
  f,
  onSort,
  align,
  className,
  title,
}: {
  label: string
  k: SortKey
  f: ExploreFilters
  onSort: (k: SortKey) => void
  align?: 'right'
  className?: string
  title?: string
}) {
  const active = f.sort === k
  return (
    <th
      scope="col"
      aria-sort={active ? (f.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('py-2 pr-3 font-medium', align === 'right' && 'text-right', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        title={title}
        className={cn('inline-flex items-center gap-1 rounded-chip hover:text-bark', active && 'text-bark')}
      >
        {label}
        {active ? (
          f.dir === 'asc' ? (
            <ArrowUp size={11} aria-hidden />
          ) : (
            <ArrowDown size={11} aria-hidden />
          )
        ) : null}
      </button>
    </th>
  )
}

function ClaimRow({
  c,
  i,
  selected,
  now,
  onSelect,
  onOpen,
}: {
  c: ClaimSummary
  i: number
  selected: boolean
  now: Date
  onSelect: () => void
  onOpen: () => void
}) {
  const rem = timeRemaining(c.evidenceDeadline, now)
  const delta = typeof c.yesPrice === 'number' && typeof c.yesPrice24hAgo === 'number' ? c.yesPrice - c.yesPrice24hAgo : undefined
  return (
    <tr
      data-row={i}
      data-selected={selected || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn(
        'group cursor-default border-b border-line transition-colors hover:bg-frost',
        selected && 'bg-needle-soft/60 hover:bg-needle-soft/60 [&>td:first-child]:shadow-[inset_2px_0_0_var(--needle)]',
      )}
    >
      <td className="py-2.5 pl-4 align-top">
        <span className="mt-[3px] flex" title={statusLabel(c.status, c.outcome)}>
          <StatusDot status={c.status} outcome={c.outcome} />
          <span className="sr-only">{statusLabel(c.status, c.outcome)}</span>
        </span>
      </td>
      <td className="py-2 pr-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="mono-cond shrink-0 text-[11.5px] text-muted">{formatClaimNumber(c.number)}</span>
          <Link
            href={`/claims/${c.id}`}
            className="min-w-0 truncate font-medium text-bark hover:text-needle hover:underline"
            onFocus={onSelect}
            title={c.title}
          >
            {c.title}
          </Link>
          {c.sponsored ? <span className="shrink-0 rounded-chip border border-line px-1 text-[10.5px] text-muted">sponsored</span> : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2.5 text-[11.5px] text-muted">
          <span className="mono-cond min-w-0 truncate">
            {c.source.owner}/{c.source.repo}
            <span className="text-faint">@</span>
            {shortSha(c.source.commitSha)}
          </span>
          {c.source.prNumber ? <span className="shrink-0">#{c.source.prNumber}</span> : null}
          <span className="mono-cond shrink-0 text-[11px]" title={c.policy.title}>
            {c.policy.id}
          </span>
        </div>
      </td>
      <td className="py-2 pr-3">
        {typeof c.yesPrice === 'number' ? (
          <div className="flex items-center gap-2">
            <span className="tnum w-11 shrink-0 text-right font-semibold">{formatPrice(c.yesPrice)}</span>
            <RowSparkline id={c.id} width={64} height={18} />
            {typeof delta === 'number' && Math.abs(delta) >= 0.001 ? (
              <span className={cn('tnum w-9 shrink-0 text-[11px]', delta > 0 ? 'text-flare' : 'text-muted')} title="Change in YES price over 24h, in points">
                {delta > 0 ? '+' : '−'}
                {(Math.abs(delta) * 100).toFixed(1)}
              </span>
            ) : (
              <span className="w-9 shrink-0" />
            )}
          </div>
        ) : (
          <span className="text-faint">No market</span>
        )}
      </td>
      <td className="tnum py-2 pr-3 text-right">
        {Number(c.liquidity) > 0 ? formatAmount(c.liquidity, { symbol: c.collateralSymbol, compact: true }) : <span className="text-faint">0</span>}
      </td>
      <td className="tnum py-2 pr-3 text-right">{c.evidenceCount || <span className="text-faint">0</span>}</td>
      <td className="py-2 pl-3 pr-4">
        <div className="flex flex-col gap-1">
          {c.status === 'open' ? (
            <span className={cn('tnum text-[12.5px]', rem.ms < 48 * 3600_000 && 'font-medium text-resin')} title={`Evidence deadline ${formatDate(c.evidenceDeadline, 'utc')}`}>
              {rem.label} left
            </span>
          ) : (
            <span
              className={cn('text-[12px] leading-tight', statusColor(c.status, c.outcome))}
              title={`Evidence deadline ${formatDate(c.evidenceDeadline, 'utc')}${rem.past ? `, closed ${rem.label} ago` : ''}`}
            >
              {statusLabel(c.status, c.outcome)}
            </span>
          )}
          <DeadlineBar start={c.createdAt} end={c.evidenceDeadline} now={now} width={112} />
        </div>
      </td>
    </tr>
  )
}
