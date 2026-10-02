'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowRight, Bell, CircleDot, Coins, FileUp, Hammer, Wallet } from 'lucide-react'
import type { ClaimSummary, OutcomePosition } from '@pine/core'
import { formatAmount, formatClaimNumber, formatPrice, shortSha, timeRemaining } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useAccount, useClaims, useDrafts, usePortfolio, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { useNowTick } from '@/lib/use-now'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { DeadlineBar } from '@/components/ui/instruments'
import { Figure, PageHeader } from '@/components/ui/page-header'
import { Pane } from '@/components/ui/pane'
import { Skeleton, SkeletonRows } from '@/components/ui/skeleton'
import { StatusDot, statusLabel } from '@/components/claim/status'

interface Alert {
  id: string
  tone: 'resin' | 'flare' | 'needle' | 'muted'
  icon: React.ReactNode
  text: React.ReactNode
  href: string
  action: string
}

const OUTCOME_NAME = { yes: 'Yes', no: 'No', invalid: 'Invalid result' } as const

export function Dashboard() {
  const wallet = useWallet()
  const { account, status } = useAccount()
  const now = useNowTick(30_000)
  const portfolio = usePortfolio(wallet.address)
  const claims = useClaims({ limit: 200 })
  const { drafts } = useDrafts()
  const login = account?.github.login
  const mine = React.useMemo(
    () =>
      (claims.data?.items ?? []).filter(
        (c) => (wallet.address && c.creator.toLowerCase() === wallet.address.toLowerCase()) || (login && c.creatorGithub === login),
      ),
    [claims.data, wallet.address, login],
  )
  const p = portfolio.data
  const sym = claims.data?.items[0]?.collateralSymbol ?? 'sDAI'
  const unfinished = drafts.filter((d) => d.publication?.steps?.some((s) => s.status !== 'confirmed' && s.status !== 'skipped'))

  const alerts: Alert[] = []
  for (const c of mine) {
    if (c.status === 'publishing')
      alerts.push({ id: `pub-${c.id}`, tone: 'resin', icon: <Hammer size={14} />, text: <>Publishing stopped part-way on {formatClaimNumber(c.number)}. Liquidity is not fully added.</>, href: `/claims/${c.id}`, action: 'Finish publishing' })
    if (c.status === 'open' && Date.parse(c.evidenceDeadline) - now.getTime() < 48 * 3600_000)
      alerts.push({ id: `dl-${c.id}`, tone: 'resin', icon: <CircleDot size={14} />, text: <>Evidence closes on {formatClaimNumber(c.number)} in {timeRemaining(c.evidenceDeadline, now).label}.</>, href: `/claims/${c.id}?tab=evidence`, action: 'Review evidence' })
    if (c.status === 'answer_proposed' || c.status === 'disputed' || c.status === 'arbitration')
      alerts.push({ id: `or-${c.id}`, tone: 'flare', icon: <Bell size={14} />, text: <>{statusLabel(c.status)} on {formatClaimNumber(c.number)}. Check the answer before it finalizes.</>, href: `/claims/${c.id}?tab=oracle`, action: 'Open oracle' })
  }
  for (const pos of p?.positions ?? [])
    if (pos.redeemable)
      alerts.push({ id: `rd-${pos.claimId}-${pos.outcome}`, tone: 'needle', icon: <Coins size={14} />, text: <>{formatAmount(pos.redeemableAmount ?? pos.value, { symbol: sym })} redeemable on {formatClaimNumber(pos.claimNumber)}.</>, href: `/claims/${pos.claimId}`, action: 'Redeem' })
  for (const d of unfinished)
    alerts.push({ id: `dr-${d.id}`, tone: 'resin', icon: <FileUp size={14} />, text: <>Publication of “{d.spec.title || 'untitled draft'}” is incomplete.</>, href: `/new?draft=${d.id}`, action: 'Resume' })

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description={
          wallet.isConnected
            ? 'Your claims, positions, liquidity and anything that needs a decision.'
            : 'Connect a wallet to see positions and liquidity. Claims you create with your GitHub account show here too.'
        }
        actions={
          <>
            {!wallet.isConnected ? (
              <Button variant="secondary" onClick={() => wallet.connect()}>
                <Wallet size={14} aria-hidden /> Connect wallet
              </Button>
            ) : null}
            <Button asChild variant="primary" kbd="n">
              <Link href="/new">New verification</Link>
            </Button>
          </>
        }
      />

      <dl className="grid grid-cols-2 gap-px border-b border-line bg-line lg:grid-cols-5">
        <Figure label="My claims" value={claims.isLoading ? <Skeleton className="h-6 w-10" /> : mine.length} hint={`${mine.filter((c) => c.status === 'open').length} open`} />
        <Figure label="Positions value" value={p ? formatAmount(p.totals.positionsValue, { symbol: sym, maxDecimals: 2 }) : wallet.isConnected ? <Skeleton className="h-6 w-20" /> : 'none'} hint="Marked at last price" />
        <Figure label="Liquidity value" value={p ? formatAmount(p.totals.liquidityValue, { symbol: sym, maxDecimals: 2 }) : wallet.isConnected ? <Skeleton className="h-6 w-20" /> : 'none'} hint="Withdrawable, not guaranteed" />
        <Figure label="Redeemable" value={p ? formatAmount(p.totals.redeemable, { symbol: sym, maxDecimals: 2 }) : 'none'} tone={p && Number(p.totals.redeemable) > 0 ? 'good' : 'default'} hint="Resolved positions that pay" />
        <Figure label="Needs attention" value={alerts.length} tone={alerts.length ? 'alert' : 'default'} hint="Alerts below" />
      </dl>

      <div className="grid xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 divide-y divide-line border-line bg-surface xl:border-r">
          <Pane title="My claims" className="border-0" actions={<Link href="/claims?view=mine" className="text-[12.5px] text-needle hover:underline">Open in explorer</Link>}>
            {claims.isLoading ? (
              <SkeletonRows rows={4} />
            ) : mine.length === 0 ? (
              <EmptyState
                title={status === 'signed_in' || wallet.isConnected ? 'You have not published a claim yet' : 'Sign in or connect a wallet to see your claims'}
                action={
                  <Button asChild variant="secondary">
                    <Link href="/new">Verify a commit</Link>
                  </Button>
                }
              >
                Claims created by your wallet or your GitHub account appear here with their deadlines and oracle status.
              </EmptyState>
            ) : (
              <ClaimRows claims={mine} now={now} />
            )}
          </Pane>
          <Pane title="Outcome positions" className="border-0" description={COPY.priceLabel}>
            {!wallet.isConnected ? (
              <EmptyState title="No wallet connected">Positions are read from your connected wallet.</EmptyState>
            ) : portfolio.isLoading ? (
              <SkeletonRows rows={3} />
            ) : (p?.positions.length ?? 0) === 0 ? (
              <EmptyState title="No outcome tokens">Buying Yes or No tokens on Seer adds a position here.</EmptyState>
            ) : (
              <PositionsTable positions={p!.positions} sym={sym} />
            )}
          </Pane>
          <Pane title="Liquidity positions" className="border-0" description={COPY.liquidityIsNotBounty}>
            {!wallet.isConnected ? (
              <EmptyState title="No wallet connected">LP positions are read from your connected wallet.</EmptyState>
            ) : (p?.liquidity.length ?? 0) === 0 ? (
              <EmptyState title="No liquidity positions">Publishing a claim, or adding liquidity on the DEX, creates one.</EmptyState>
            ) : (
              <div className="scrollbar-thin relative overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead>
                    <tr className="stretch-cond border-b border-line text-left text-[12px] text-muted">
                      <th className="py-2 pl-4 font-medium">Claim</th>
                      <th className="py-2 pl-4 font-medium">Pool</th>
                      <th className="py-2 pl-4 text-right font-medium">Deposited</th>
                      <th className="py-2 pl-4 text-right font-medium">Current value</th>
                      <th className="py-2 pl-4 text-right font-medium">Fees earned</th>
                      <th className="py-2 pl-4 pr-4 font-medium">Range</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p!.liquidity.map((l) => (
                      <tr key={l.tokenId} className="border-b border-line last:border-0">
                        <td className="py-2 pl-4">
                          <Link href={`/claims/${l.claimId}`} className="hover:text-needle">
                            <span className="mono-cond mr-2 text-[11.5px] text-muted">{formatClaimNumber(l.claimNumber)}</span>
                            <span className="line-clamp-1">{l.claimTitle}</span>
                          </Link>
                        </td>
                        <td className="py-2 pl-4">{l.outcome.toUpperCase()}</td>
                        <td className="tnum py-2 pl-4 text-right">{formatAmount(l.deposited, { maxDecimals: 2 })}</td>
                        <td className={cn('tnum py-2 pl-4 text-right', Number(l.currentValue) < Number(l.deposited) && 'text-flare')}>{formatAmount(l.currentValue, { maxDecimals: 2 })}</td>
                        <td className="tnum py-2 pl-4 text-right">{formatAmount(l.feesEarned, { maxDecimals: 4 })}</td>
                        <td className="py-2 pl-4 pr-4 text-muted">{l.inRange ? 'in range' : 'out of range'}{l.withdrawable ? '' : ', locked'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Pane>
        </div>
        <aside className="divide-y divide-line border-t border-line bg-frost xl:border-t-0" aria-label="Alerts">
          <div className="px-4 py-4">
            <h2 className="stretch-cond text-[13px] font-semibold">Needs attention</h2>
            {alerts.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted">Nothing needs a decision right now. Deadlines, oracle answers, redemptions and stalled publications show up here.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {alerts.map((a) => (
                  <li key={a.id} className="rounded-ctl border border-line bg-surface">
                    <Link href={a.href} className="group flex items-start gap-2.5 px-3 py-2.5">
                      <span className={cn('mt-0.5', a.tone === 'resin' && 'text-resin', a.tone === 'flare' && 'text-flare', a.tone === 'needle' && 'text-needle')}>{a.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px]">{a.text}</span>
                        <span className="mt-0.5 flex items-center gap-1 text-[12px] font-medium text-needle">
                          {a.action} <ArrowRight size={11} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {p ? (
            <div className="px-4 py-4">
              <h2 className="stretch-cond text-[13px] font-semibold">Funding reconciliation</h2>
              <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1.5 text-[13px]">
                <dt className="text-muted">Deposited, all time</dt>
                <dd className="tnum text-right">{formatAmount(p.totals.depositedAllTime, { symbol: sym, maxDecimals: 2 })}</dd>
                <dt className="text-muted">Withdrawn and redeemed</dt>
                <dd className="tnum text-right">{formatAmount(p.totals.withdrawnAllTime, { symbol: sym, maxDecimals: 2 })}</dd>
                <dt className="text-muted">Fees and gas paid</dt>
                <dd className="tnum text-right">{formatAmount(p.totals.feesPaidAllTime, { symbol: sym, maxDecimals: 4 })}</dd>
                <dt className="text-muted">Still redeemable</dt>
                <dd className="tnum text-right font-medium text-needle">{formatAmount(p.totals.redeemable, { symbol: sym, maxDecimals: 2 })}</dd>
              </dl>
              <Link href="/activity" className="mt-2 inline-block text-[12.5px] text-needle hover:underline">
                Full transaction history
              </Link>
            </div>
          ) : null}
          <div className="px-4 py-4 text-[12px] text-muted">
            <p>{COPY.noMergeAuthority}</p>
          </div>
        </aside>
      </div>
    </div>
  )
}

function ClaimRows({ claims, now }: { claims: ClaimSummary[]; now: Date }) {
  return (
    <ul className="divide-y divide-line">
      {claims.map((c) => {
        const rem = timeRemaining(c.evidenceDeadline, now)
        return (
          <li key={c.id}>
            <Link href={`/claims/${c.id}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 hover:bg-frost md:grid-cols-[auto_minmax(0,1fr)_auto_140px]">
              <StatusDot status={c.status} outcome={c.outcome} />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                <span className="block truncate text-[11.5px] text-muted">
                  <span className="mono-cond">
                    {formatClaimNumber(c.number)} {c.source.repo}@{shortSha(c.source.commitSha)}
                  </span>{' '}
                  {statusLabel(c.status, c.outcome)}
                </span>
              </span>
              <span className="tnum text-[13px] font-semibold">{typeof c.yesPrice === 'number' ? formatPrice(c.yesPrice) : ''}</span>
              <span className="hidden flex-col items-end gap-1 md:flex">
                <span className="tnum text-[11.5px] text-muted">{rem.past ? `closed ${rem.label} ago` : `${rem.label} left`}</span>
                <DeadlineBar start={c.createdAt} end={c.evidenceDeadline} now={now} width={120} />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function PositionsTable({ positions, sym }: { positions: OutcomePosition[]; sym: string }) {
  return (
    <div className="scrollbar-thin relative overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="stretch-cond border-b border-line text-left text-[12px] text-muted">
            <th className="py-2 pl-4 font-medium">Claim</th>
            <th className="py-2 pl-4 font-medium">Outcome</th>
            <th className="py-2 pl-4 text-right font-medium">Tokens</th>
            <th className="py-2 pl-4 text-right font-medium">Mark</th>
            <th className="py-2 pl-4 pr-4 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos) => (
            <tr key={`${pos.claimId}-${pos.outcome}`} className="border-b border-line last:border-0">
              <td className="py-2 pl-4">
                <Link href={`/claims/${pos.claimId}`} className="flex items-center gap-2 hover:text-needle">
                  <StatusDot status={pos.status} />
                  <span className="mono-cond text-[11.5px] text-muted">{formatClaimNumber(pos.claimNumber)}</span>
                  <span className="line-clamp-1">{pos.claimTitle}</span>
                </Link>
              </td>
              <td className="whitespace-nowrap py-2 pl-4">{OUTCOME_NAME[pos.outcome]}</td>
              <td className="tnum py-2 pl-4 text-right">{formatAmount(pos.balance, { maxDecimals: 2 })}</td>
              <td className="tnum py-2 pl-4 text-right">{formatPrice(pos.markPrice)}</td>
              <td className="tnum py-2 pl-4 pr-4 text-right">
                {pos.redeemable ? (
                  <span className="font-medium text-needle">{formatAmount(pos.redeemableAmount ?? pos.value, { symbol: sym, maxDecimals: 2 })} redeemable</span>
                ) : (
                  formatAmount(pos.value, { symbol: sym, maxDecimals: 2 })
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
