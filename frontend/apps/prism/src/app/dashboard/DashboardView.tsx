'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { ClaimSummary, OutcomePosition } from '@pine/core'
import { formatAmount, formatPriceCents } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useClaims, useDrafts, usePine, usePortfolio, useWallet } from '@pine/react'
import { AlertTriangle, Coins, Hourglass, Wrench } from 'lucide-react'
import { ClaimRow } from '@/components/table/ClaimRow'
import { StatusBadge } from '@/components/claim/StatusBadge'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { Button, ButtonLink } from '@/components/ui/Button'
import { AnimatedNumber } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '@/components/ui/primitives'
import { OUTCOME_HEX } from '@/lib/crystal'
import { claimLabel, isResolved, timeLeft } from '@/lib/claims'
import { useMounted, useNowMs } from '@/lib/hooks'

interface Alert {
  id: string
  icon: React.ReactNode
  title: string
  detail: string
  href: string
  action: string
  tone: 'caution' | 'info' | 'critical'
}

function alertsFor(mine: ClaimSummary[], positions: OutcomePosition[], unfinished: number, now: number, sym: string): Alert[] {
  const out: Alert[] = []
  for (const p of positions.filter((x) => x.redeemable)) {
    out.push({
      id: `redeem-${p.claimId}-${p.outcome}`,
      icon: <Coins size={16} aria-hidden className="text-hb" />,
      title: `Redeemable: ${claimLabel({ number: p.claimNumber, id: p.claimId })}`,
      detail: `${formatAmount(p.redeemableAmount ?? p.value, { maxDecimals: 2 })} ${sym} redeemable under Seer's native payout rules.`,
      href: `/claims/${p.claimId}`,
      action: 'Redeem',
      tone: 'info',
    })
  }
  for (const c of mine) {
    if (c.status === 'open') {
      const tl = timeLeft(c.evidenceDeadline, now)
      if (!tl.past && tl.ms < 24 * 3_600_000)
        out.push({ id: `deadline-${c.id}`, icon: <Hourglass size={16} aria-hidden className="text-na" />, title: `Evidence closes soon: ${claimLabel(c)}`, detail: `${tl.label} on “${c.title}”.`, href: `/claims/${c.id}`, action: 'Open claim', tone: 'caution' })
    }
    if (c.status === 'answer_proposed')
      out.push({ id: `answer-${c.id}`, icon: <AlertTriangle size={16} aria-hidden className="text-na" />, title: `Answer proposed: ${claimLabel(c)}`, detail: 'An oracle answer is standing. It finalizes unless challenged within the fixed 3.5-day timeout.', href: `/claims/${c.id}#oracle`, action: 'Review answer', tone: 'caution' })
    if (c.status === 'disputed' || c.status === 'arbitration')
      out.push({ id: `dispute-${c.id}`, icon: <AlertTriangle size={16} aria-hidden className="text-ha" />, title: `${c.status === 'arbitration' ? 'In arbitration' : 'Disputed'}: ${claimLabel(c)}`, detail: 'Bonds are escalating or Kleros jurors are reviewing evidence.', href: `/claims/${c.id}#oracle`, action: 'Follow it', tone: 'critical' })
    if (c.status === 'publishing')
      out.push({ id: `pub-${c.id}`, icon: <Wrench size={16} aria-hidden className="text-na" />, title: `Finish publishing: ${claimLabel(c)}`, detail: 'The market was partly created. Resume the remaining steps.', href: `/claims/${c.id}`, action: 'Finish publishing', tone: 'caution' })
  }
  if (unfinished > 0)
    out.push({ id: 'drafts', icon: <Wrench size={16} aria-hidden className="text-na" />, title: `${unfinished} unfinished publication${unfinished === 1 ? '' : 's'} in drafts`, detail: 'Resume from the step where it stopped.', href: '/drafts', action: 'Open drafts', tone: 'caution' })
  return out
}

export function DashboardView() {
  const mounted = useMounted()
  const wallet = useWallet()
  // `api` mode: holdings come from the markets this wallet published or filed evidence on, valued at pool prices;
  // the backend does not value liquidity positions or keep deposit and fee totals.
  const backend = usePine().env.dataSource === 'api'
  const now = useNowMs()
  const portfolio = usePortfolio(wallet.address)
  const mine = useClaims(wallet.address ? { creator: wallet.address, sort: 'newest', limit: 50 } : { limit: 0 })
  const { drafts } = useDrafts()
  const unfinished = drafts.filter((d) => (d.publication?.steps?.length ?? 0) > 0 && !d.publication?.steps.every((s) => s.status === 'confirmed' || s.status === 'skipped')).length
  const myClaims = useMemo(() => (wallet.address ? (mine.data?.items ?? []) : []), [mine.data, wallet.address])
  const positions = useMemo(() => portfolio.data?.positions ?? [], [portfolio.data])
  const lps = portfolio.data?.liquidity ?? []
  const symbol = myClaims[0]?.collateralSymbol ?? 'sDAI'
  const alerts = useMemo(() => (now ? alertsFor(myClaims, positions, unfinished, now, symbol) : []), [myClaims, positions, unfinished, now, symbol])
  // Positions carry the claim status but not its outcome: look the outcome up so a resolved claim reads
  // "Counterexample demonstrated" (and so on) like everywhere else, not a generic "Resolved".
  const resolvedQ = useClaims({ status: ['resolved', 'settled'], limit: 100 })
  const outcomeOf = useMemo(() => new Map((resolvedQ.data?.items ?? []).map((c) => [c.id, c.outcome])), [resolvedQ.data])

  if (!mounted) return <Skeleton className="h-64 w-full" />
  if (!wallet.isConnected || !wallet.address)
    return (
      <EmptyState
        title="Connect a wallet to see your dashboard"
        icon={<CrystalGlyph seed="dashboard:unlit" hue="#A69789" state="unlit" size={84} decorative />}
        action={<Button onClick={() => wallet.connect()}>{wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}</Button>}
      >
        Your claims, outcome positions, liquidity and anything waiting on you appear here. Connecting a wallet signs nothing and spends nothing.
      </EmptyState>
    )
  if (portfolio.isError) return <ErrorState error={portfolio.error} onRetry={() => void portfolio.refetch()} />
  const t = portfolio.data?.totals
  const sym = symbol

  return (
    <div className="grid gap-12">
      <dl className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ['Outcome positions', t?.positionsValue, backend ? 'at pool prices; unpriced outcomes count 0' : undefined],
            ['Liquidity positions', backend ? null : t?.liquidityValue, backend ? 'not valued by Pine' : undefined],
            ['Redeemable now', t?.redeemable, undefined],
          ] as const
        ).map(([label, v, note]) => (
          <div key={label} className="glass cut-lg px-5 py-4">
            <dt className="text-[0.8125rem] text-lumen-3">{label}</dt>
            <dd className="t-figure mt-1 text-[2rem] text-lumen">
              {v === null ? (
                <span className="text-lumen-3">—</span>
              ) : v === undefined ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <AnimatedNumber value={Number(v)} format={(n) => formatAmount(n, { maxDecimals: 2 })} /> <span className="text-[1rem] text-lumen-3">{sym}</span>
                </>
              )}
            </dd>
            {note && <p className="mt-1 text-[0.75rem] text-lumen-3">{note}</p>}
          </div>
        ))}
      </dl>

      <section aria-labelledby="alerts-title">
        <h2 id="alerts-title" className="t-h3 mb-3">
          Waiting on you
        </h2>
        {alerts.length === 0 ? (
          <p className="text-lumen-2">Nothing needs your attention right now.</p>
        ) : (
          <ul className="grid gap-2">
            {alerts.map((a) => (
              <li key={a.id} className="glass cut-md flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                {a.icon}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-lumen">{a.title}</p>
                  <p className="text-[0.84375rem] text-lumen-2">{a.detail}</p>
                </div>
                <ButtonLink href={a.href} size="sm" variant="glass">
                  {a.action}
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="positions-title">
        <h2 id="positions-title" className="t-h3 mb-3">
          Outcome positions
        </h2>
        {backend && <p className="-mt-2 mb-3 text-[0.84375rem] text-lumen-3">In markets this wallet published or filed evidence on. Each claim page shows what you hold in its market.</p>}
        {portfolio.isLoading ? (
          <LoadingBlock />
        ) : positions.length === 0 ? (
          <p className="text-lumen-2">This wallet holds no outcome tokens.</p>
        ) : (
          <ul className="glass cut-xl divide-y divide-[var(--edge)]">
            {positions.map((p) => (
              <li key={`${p.claimId}-${p.outcome}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3">
                <span aria-hidden className="h-8 w-[3px] rounded-full" style={{ background: OUTCOME_HEX[p.outcome] }} />
                <div className="min-w-0">
                  <Link href={`/claims/${p.claimId}`} className="link block truncate font-semibold text-lumen">
                    {claimLabel({ number: p.claimNumber, id: p.claimId })} {p.claimTitle}
                  </Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[0.8125rem] text-lumen-3">
                    <StatusBadge status={p.status} outcome={outcomeOf.get(p.claimId)} size="sm" />
                    {formatAmount(p.balance, { maxDecimals: 2 })} {p.outcome === 'yes' ? 'Yes' : p.outcome === 'no' ? 'No' : 'Invalid result'} tokens{' '}
                    {backend && p.markPrice === 0 && !isResolved(p.status) ? 'not priced' : `at ${formatPriceCents(p.markPrice)}`}
                  </p>
                </div>
                <p className="tnum text-right text-lumen">
                  {backend && p.markPrice === 0 && !isResolved(p.status) ? (
                    <span className="text-lumen-3">—</span>
                  ) : (
                    <>
                      {formatAmount(p.value, { maxDecimals: 2 })} <span className="text-lumen-3">{sym}</span>
                    </>
                  )}
                  {p.redeemable && <span className="block text-[0.75rem] text-hb">redeemable</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lp-title">
        <h2 id="lp-title" className="t-h3 mb-1">
          Liquidity positions
        </h2>
        <p className="mb-3 text-[0.84375rem] text-lumen-3">{COPY.liquidityIsNotBounty}</p>
        {lps.length === 0 ? (
          <p className="text-lumen-2">No liquidity positions.</p>
        ) : (
          <ul className="glass cut-xl divide-y divide-[var(--edge)]">
            {lps.map((l) => (
              <li key={l.tokenId} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <Link href={`/claims/${l.claimId}`} className="link block truncate font-semibold text-lumen">
                    {claimLabel({ number: l.claimNumber, id: l.claimId })} {l.claimTitle}
                  </Link>
                  <p className="text-[0.8125rem] text-lumen-3">
                    {l.outcome === 'yes' ? 'Yes' : 'No'} pool{backend ? ` position #${l.tokenId}` : ''}, {l.inRange ? 'in range' : 'out of range'},{' '}
                    {backend ? (l.withdrawable ? 'holds liquidity or fees' : 'empty') : l.withdrawable ? 'withdrawable on the DEX' : 'not withdrawable now'}
                  </p>
                </div>
                <p className="tnum text-[0.875rem] text-lumen-2 sm:text-right">
                  {backend ? (
                    <span className="text-lumen-3">Value not indexed; withdraw from the claim page</span>
                  ) : (
                    <>
                      {formatAmount(l.currentValue, { maxDecimals: 2 })} now of {formatAmount(l.deposited, { maxDecimals: 2 })} deposited, fees {formatAmount(l.feesEarned, { maxDecimals: 2 })} {sym}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mine-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="mine-title" className="t-h3">
            Claims you created
          </h2>
          <Link href="/compose" className="link text-[0.875rem]">
            Compose a claim
          </Link>
        </div>
        {backend && <p className="-mt-1 mb-3 text-[0.84375rem] text-lumen-3">Listed once Pine has verified them against their claim documents, about a minute after publication.</p>}
        {mine.isLoading ? (
          <LoadingBlock />
        ) : myClaims.length === 0 ? (
          <p className="text-lumen-2">No claims created by this wallet yet.</p>
        ) : (
          <ul className="glass cut-xl divide-y divide-[var(--edge)] overflow-hidden">
            {myClaims.map((c) => (
              <ClaimRow key={c.id} claim={c} nowMs={now} />
            ))}
          </ul>
        )}
      </section>
      <p className="text-[0.84375rem] text-lumen-3">
        {backend ? 'The claims you published and the evidence you recorded are in the ' : 'Every deposit, withdrawal and fee is in the '}
        <Link href="/activity" className="link">
          activity ledger
        </Link>
        {backend ? '.' : ', reconciled against these totals.'}
      </p>
    </div>
  )
}
