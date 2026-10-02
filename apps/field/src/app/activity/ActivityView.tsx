'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ActivityItem, ActivityType } from '@pine/core'
import { formatAmount, formatClaimNumber } from '@pine/core'
import { useActivity, usePortfolio, useWallet } from '@pine/react'
import { Wallet } from 'lucide-react'
import { ACTIVITY_LABEL, ActivityList } from '@/components/claim/ActivityList'
import { Chip, Segmented } from '@/components/ui/interactive'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Note, SectionHeading, Skeleton } from '@/components/ui/primitives'
import { cn } from '@/lib/cn'

const GROUPS: { label: string; types: ActivityType[] }[] = [
  { label: 'Funding', types: ['manifest_pinned', 'market_created', 'approval', 'split', 'merge', 'liquidity_added', 'liquidity_removed'] },
  { label: 'Trades', types: ['trade'] },
  { label: 'Evidence', types: ['evidence_submitted'] },
  { label: 'Oracle', types: ['answer_posted', 'arbitration_requested', 'ruling', 'finalized'] },
  { label: 'Redemptions', types: ['redeemed'] },
]

interface Row {
  claimId: string
  claimNumber: number
  claimTitle: string
  out: Record<string, number>
  in: Record<string, number>
}

function addTo(m: Record<string, number>, token: string, v: number) {
  m[token] = (m[token] ?? 0) + v
}

function fmtMap(m: Record<string, number>): string {
  const e = Object.entries(m).filter(([, v]) => Math.abs(v) > 1e-12)
  if (!e.length) return '—'
  return e.map(([t, v]) => `${formatAmount(v, { maxDecimals: 4 })} ${t}`).join(', ')
}

export function ActivityView() {
  const wallet = useWallet()
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [group, setGroup] = useState<string | null>(null)
  const effective = scope === 'mine' && wallet.address ? 'mine' : 'all'
  const types = GROUPS.find((g) => g.label === group)?.types
  const q = useActivity({ account: effective === 'mine' ? wallet.address : undefined, types, limit: 200 })
  const full = useActivity({ account: effective === 'mine' ? wallet.address : undefined, limit: 500 })
  const portfolio = usePortfolio(effective === 'mine' ? wallet.address : undefined)
  const items = q.data?.items ?? []

  const recon = useMemo(() => {
    const rows = new Map<string, Row>()
    const totalsOut: Record<string, number> = {}
    const totalsIn: Record<string, number> = {}
    let pending = 0
    let failed = 0
    for (const a of (full.data?.items ?? []) as ActivityItem[]) {
      if (a.status === 'pending') pending++
      if (a.status === 'failed') {
        failed++
        continue
      }
      if (!a.amount || !a.token) continue
      const v = Number(a.amount)
      if (!Number.isFinite(v) || v === 0) continue
      let r = rows.get(a.claimId)
      if (!r) {
        r = { claimId: a.claimId, claimNumber: a.claimNumber, claimTitle: a.claimTitle, out: {}, in: {} }
        rows.set(a.claimId, r)
      }
      if (v < 0) {
        addTo(r.out, a.token, -v)
        addTo(totalsOut, a.token, -v)
      } else {
        addTo(r.in, a.token, v)
        addTo(totalsIn, a.token, v)
      }
    }
    return { rows: [...rows.values()].sort((a, b) => b.claimNumber - a.claimNumber), totalsOut, totalsIn, pending, failed }
  }, [full.data])

  const p = portfolio.data
  const symbol = 'sDAI'
  const historyOut = recon.totalsOut[symbol] ?? 0
  const deposited = p ? Number(p.totals.depositedAllTime) : undefined
  const diff = deposited !== undefined ? Math.abs(deposited - historyOut) : undefined

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading
        as="h1"
        title="Activity and reconciliation"
        description="Every transaction behind the board, with money in and out per claim, so funding and redemptions add up."
        action={
          <Segmented
            label="Whose activity"
            value={effective}
            onChange={(v) => setScope(v)}
            options={[
              { value: 'mine', label: 'This wallet' },
              { value: 'all', label: 'Everything' },
            ]}
          />
        }
      />

      {scope === 'mine' && !wallet.isConnected && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-[var(--radius-tile)] border border-dashed border-line-strong p-4">
          <p className="text-[0.9rem] text-ink-2">Connect a wallet to reconcile your own funding and redemptions. Showing all activity meanwhile.</p>
          <Button size="sm" variant="secondary" onClick={() => wallet.connect()} icon={<Wallet size={14} aria-hidden />}>
            {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
          </Button>
        </div>
      )}

      {effective === 'mine' && (
        <section className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" aria-labelledby="recon">
          <div className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5">
            <h2 id="recon" className="t-h3">
              Does it add up?
            </h2>
            {portfolio.isLoading || full.isLoading ? (
              <Skeleton className="mt-4 h-32" />
            ) : (
              <>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
                  <div>
                    <dt className="text-[0.78rem] text-ink-3">Out, from your history</dt>
                    <dd className="mt-0.5 text-[0.95rem] font-[600]">{fmtMap(recon.totalsOut)}</dd>
                  </div>
                  <div>
                    <dt className="text-[0.78rem] text-ink-3">In, from your history</dt>
                    <dd className="mt-0.5 text-[0.95rem] font-[600]">{fmtMap(recon.totalsIn)}</dd>
                  </div>
                  {p && (
                    <>
                      <div>
                        <dt className="text-[0.78rem] text-ink-3">Deposited, per the indexer</dt>
                        <dd className="t-figure mt-0.5 text-[1.3rem]">
                          {formatAmount(p.totals.depositedAllTime, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[0.78rem] text-ink-3">Withdrawn, per the indexer</dt>
                        <dd className="t-figure mt-0.5 text-[1.3rem]">
                          {formatAmount(p.totals.withdrawnAllTime, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[0.78rem] text-ink-3">Fees paid</dt>
                        <dd className="t-figure mt-0.5 text-[1.3rem]">
                          {formatAmount(p.totals.feesPaidAllTime, { maxDecimals: 4 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-[0.78rem] text-ink-3">Redeemable now</dt>
                        <dd className="t-figure mt-0.5 text-[1.3rem]">
                          {formatAmount(p.totals.redeemable, { maxDecimals: 2 })} <span className="font-sans text-[0.78rem] font-[450] text-ink-3">{symbol}</span>
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
                {diff !== undefined && (
                  <p className={cn('mt-4 text-[0.84rem]', diff > 0.01 ? 'text-ink' : 'text-ink-2')}>
                    {diff > 0.01
                      ? `The indexer and your history differ by ${formatAmount(diff, { maxDecimals: 4 })} ${symbol}. Liquidity added on the DEX is recorded there without an amount here; check the pool positions on your dashboard.`
                      : 'Your history and the indexer agree on what you deposited.'}
                  </p>
                )}
                {(recon.pending > 0 || recon.failed > 0) && (
                  <p className="mt-2 text-[0.8rem] text-ink-3">
                    {recon.pending} pending and {recon.failed} failed transactions are excluded from the totals. Failed transactions moved no collateral.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="min-w-0 relative overflow-x-auto rounded-[var(--radius-tile)] border border-line bg-sheet">
            <table className="w-full min-w-[34rem] text-[0.86rem]">
              <caption className="sr-only">Money in and out per claim</caption>
              <thead>
                <tr className="border-b border-line text-left text-[0.78rem] text-ink-3">
                  <th className="px-4 py-2.5 font-[600]">Claim</th>
                  <th className="px-4 py-2.5 text-right font-[600]">Out</th>
                  <th className="px-4 py-2.5 text-right font-[600]">In</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recon.rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-ink-3">
                      No money movements yet.
                    </td>
                  </tr>
                ) : (
                  recon.rows.map((r) => (
                    <tr key={r.claimId}>
                      <td className="max-w-[18rem] px-4 py-3">
                        <Link href={`/claims/${r.claimId}`} className="block truncate hover:underline">
                          <span className="t-figure mr-2 text-ink-2">{formatClaimNumber(r.claimNumber)}</span>
                          {r.claimTitle}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right">{fmtMap(r.out)}</td>
                      <td className="px-4 py-3 text-right">{fmtMap(r.in)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-10" aria-labelledby="hist">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="hist" className="t-h2">
            History
          </h2>
          <div className="scrollbar-none -mx-1 flex max-w-full gap-2 relative overflow-x-auto px-1 py-0.5">
            <Chip active={group === null} onClick={() => setGroup(null)}>
              All
            </Chip>
            {GROUPS.map((g) => (
              <Chip key={g.label} active={group === g.label} onClick={() => setGroup(group === g.label ? null : g.label)}>
                {g.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="mt-4 rounded-[var(--radius-tile)] border border-line bg-sheet px-4">
          {q.isError ? (
            <ErrorState className="my-4" error={q.error} onRetry={() => q.refetch()} />
          ) : q.isLoading ? (
            <div className="grid gap-3 py-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : items.length === 0 ? (
            <EmptyState className="my-4 border-0" title="Nothing here yet" body={group ? `No ${group.toLowerCase()} activity. Try another filter.` : 'Transactions appear here as soon as they are indexed.'} />
          ) : (
            <ActivityList items={items} showClaim />
          )}
        </div>
        <Note className="mt-4">
          Activity types: {Object.values(ACTIVITY_LABEL).join(', ')}. Amounts are signed from the actor&apos;s perspective. Bonds and arbitration fees are in the chain&apos;s native token.
        </Note>
      </section>
    </div>
  )
}
