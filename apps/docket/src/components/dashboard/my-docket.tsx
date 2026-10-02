'use client'

import Link from 'next/link'
import type { ClaimSummary, OutcomePosition } from '@pine/core'
import { formatAmount, formatClaimNumber, formatPrice } from '@pine/core'
import { useAccount, useClaims, useDrafts, usePortfolio, useWallet } from '@pine/react'
import { ArrowRight, FilePlus2, Wallet } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, ButtonLink } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/layout'
import { StageTag } from '@/components/ui/stage'
import { When, useClientNow } from '@/components/ui/when'
import { DocketRow } from '@/components/docket/docket-row'
import { formatCompactUtc } from '@/lib/format'

interface Attention {
  key: string
  claim?: ClaimSummary
  title: string
  detail: string
  href: string
  action: string
  tone: 'flag' | 'violet' | 'plum' | 'ink'
}

export function MyDocket() {
  const wallet = useWallet()
  const account = useAccount()
  const now = useClientNow(60_000)
  const address = wallet.address ?? account.account?.wallets.find((w) => w.primary)?.address
  const mine = useClaims({ creator: address, sort: 'deadline', limit: 100 })
  const portfolio = usePortfolio(address)
  const { drafts } = useDrafts()
  const myClaims = address ? (mine.data?.items ?? []).filter((c) => c.creator.toLowerCase() === address.toLowerCase()) : []

  if (!address) {
    return (
      <div className="grid gap-6 md:grid-cols-2">
        <EmptyState
          title="Connect a wallet to see your docket"
          icon={<Wallet aria-hidden className="size-7" />}
          action={
            <Button icon={<Wallet aria-hidden />} onClick={() => wallet.connect()}>
              Connect wallet
            </Button>
          }
        >
          Claims you filed, outcome tokens, liquidity and anything you can redeem are tied to your wallet address.
        </EmptyState>
        <EmptyState
          title={drafts.length ? `${drafts.length} draft${drafts.length === 1 ? '' : 's'} in this browser` : 'No drafts yet'}
          icon={<FilePlus2 aria-hidden className="size-7" />}
          action={
            <ButtonLink href={drafts.length ? '/filings' : '/file'} variant="secondary">
              {drafts.length ? 'Open drafts and filings' : 'File a verification'}
            </ButtonLink>
          }
        >
          Drafts do not need a wallet. You only connect one to publish.
        </EmptyState>
      </div>
    )
  }

  const positions = portfolio.data?.positions ?? []
  const lps = portfolio.data?.liquidity ?? []
  const redeemable = positions.filter((p) => p.redeemable)
  const attention: Attention[] = []
  for (const c of myClaims) {
    const n = formatClaimNumber(c.number)
    if (c.status === 'publishing')
      attention.push({ key: `${c.id}-pub`, claim: c, title: `Finish filing ${n}`, detail: 'The market exists but funding did not finish.', href: `/claims/${c.id}#filing`, action: 'Finish filing', tone: 'flag' })
    if (c.status === 'awaiting_answer')
      attention.push({ key: `${c.id}-ans`, claim: c, title: `${n} needs an oracle answer`, detail: 'If nobody answers on Reality.eth, the market never resolves. You may answer it yourself with a bond.', href: `/claims/${c.id}#oracle`, action: 'See how to answer', tone: 'violet' })
    if (c.status === 'answer_proposed' || c.status === 'disputed')
      attention.push({ key: `${c.id}-chal`, claim: c, title: `${n}: an answer is in its challenge window`, detail: 'Check it against the exhibits before it becomes final.', href: `/claims/${c.id}#oracle`, action: 'Check the answer', tone: 'plum' })
    if (c.status === 'arbitration')
      attention.push({ key: `${c.id}-arb`, claim: c, title: `${n} is in Kleros arbitration`, detail: 'Jurors are reviewing. You can follow the case and add arguments.', href: `/claims/${c.id}#oracle`, action: 'Follow the case', tone: 'plum' })
    if (c.status === 'open' && now && new Date(c.evidenceDeadline).getTime() - now.getTime() < 72 * 3600_000)
      attention.push({ key: `${c.id}-dl`, claim: c, title: `${n}: evidence window closes soon`, detail: `Closes ${formatCompactUtc(c.evidenceDeadline)}.`, href: `/claims/${c.id}#exhibits`, action: 'Review the exhibits', tone: 'ink' })
  }
  for (const p of redeemable)
    attention.push({
      key: `${p.claimId}-${p.outcome}-redeem`,
      title: `Redeem ${formatAmount(p.redeemableAmount ?? p.value, { maxDecimals: 2 })} from ${formatClaimNumber(p.claimNumber)}`,
      detail: `${p.outcome === 'invalid' ? 'Invalid result' : p.outcome === 'yes' ? 'Yes' : 'No'} tokens pay out under the market’s rules.`,
      href: `/claims/${p.claimId}#position`,
      action: 'Redeem',
      tone: 'violet',
    })

  const deadlines = [...myClaims]
    .filter((c) => c.status === 'open')
    .sort((a, b) => a.evidenceDeadline.localeCompare(b.evidenceDeadline))
    .slice(0, 6)
  const totals = portfolio.data?.totals
  const sym = myClaims[0]?.collateralSymbol ?? 'sDAI'

  return (
    <div className="space-y-12">
      <dl className="grid grid-cols-2 border-t border-l border-rule bg-sheet md:grid-cols-5">
        {[
          { k: 'Claims you filed', v: String(myClaims.length) },
          { k: 'Open for evidence', v: String(myClaims.filter((c) => c.status === 'open').length) },
          { k: 'Outcome tokens', v: totals ? formatAmount(totals.positionsValue, { symbol: sym, maxDecimals: 2 }) : '—' },
          { k: 'Liquidity, current value', v: totals ? formatAmount(totals.liquidityValue, { symbol: sym, maxDecimals: 2 }) : '—' },
          { k: 'Ready to redeem', v: totals ? formatAmount(totals.redeemable, { symbol: sym, maxDecimals: 2 }) : '—', strong: true },
        ].map((s) => (
          <div key={s.k} className="border-r border-b border-rule px-4 py-3">
            <dt className="text-sm text-graphite">{s.k}</dt>
            <dd className={cn('mt-0.5 text-xl font-[800] tabular', s.strong && 'text-violet')}>{portfolio.isLoading && s.k !== 'Claims you filed' && s.k !== 'Open for evidence' ? <Skeleton className="mt-1 h-6 w-24" /> : s.v}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="att">
        <h2 id="att" className="flex items-center gap-3 text-2xl">
          <span aria-hidden className="h-7 w-2 bg-flag" /> Needs your attention
        </h2>
        {mine.isLoading ? (
          <Skeleton className="mt-4 h-20 w-full" />
        ) : attention.length === 0 ? (
          <p className="mt-3 border border-dashed border-rule-strong bg-sheet px-5 py-4 text-graphite">
            Nothing needs you right now. Claims that need an answer, a decision or a redemption will appear here.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
            {attention.map((a) => (
              <li key={a.key} className="grid gap-3 px-4 py-4 sm:grid-cols-[0.5rem_minmax(0,1fr)_auto] sm:items-center sm:px-5">
                <span
                  aria-hidden
                  className={cn(
                    'hidden h-full w-2 sm:block',
                    a.tone === 'flag' && 'bg-flag',
                    a.tone === 'violet' && 'bg-violet',
                    a.tone === 'plum' && 'bg-plum',
                    a.tone === 'ink' && 'bg-ink',
                  )}
                />
                <div className="min-w-0">
                  <p className="font-bold">{a.title}</p>
                  <p className="text-[15px] text-graphite">{a.detail}</p>
                  {a.claim ? <p className="record-title untrusted mt-1 text-[15px] text-ink">{a.claim.title}</p> : null}
                </div>
                <ButtonLink href={a.href} variant="secondary" size="sm" iconAfter={<ArrowRight aria-hidden />}>
                  {a.action}
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deadlines.length > 0 ? (
        <section aria-labelledby="upcoming">
          <h2 id="upcoming" className="text-2xl">
            Upcoming deadlines
          </h2>
          <ol className="mt-4 border-l-2 border-ink">
            {deadlines.map((c) => (
              <li key={c.id} className="relative pb-4 pl-5 last:pb-0">
                <span aria-hidden className="absolute top-2 -left-[6px] size-2.5 rounded-full bg-ink" />
                <p className="font-bold">
                  <When at={c.evidenceDeadline} />
                </p>
                <p className="text-[15px]">
                  Evidence deadline for{' '}
                  <Link href={`/claims/${c.id}`} className="link">
                    {formatClaimNumber(c.number)}
                  </Link>
                  : <span className="untrusted">{c.title}</span>
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <section aria-labelledby="filed">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="filed" className="text-2xl">
            Claims you filed
          </h2>
          <Link href="/filings" className="link text-[15px]">
            Drafts and unfinished filings
          </Link>
        </div>
        {mine.isLoading ? (
          <Skeleton className="mt-4 h-32 w-full" />
        ) : myClaims.length === 0 ? (
          <EmptyState className="mt-4" title="You have not filed a claim from this wallet" action={<ButtonLink href="/file">File a verification</ButtonLink>}>
            Claims are tied to the wallet that created the market.
          </EmptyState>
        ) : (
          <div className="mt-4 border-t border-rule">
            {myClaims.map((c) => (
              <DocketRow key={c.id} claim={c} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="pos">
        <h2 id="pos" className="text-2xl">
          Outcome tokens you hold
        </h2>
        <p className="mt-1 text-[15px] text-graphite">Marked at the current market price, which can move before you sell or redeem.</p>
        {portfolio.isLoading ? <Skeleton className="mt-4 h-24 w-full" /> : <PositionsTable positions={positions} sym={sym} />}
      </section>

      <section aria-labelledby="lp">
        <h2 id="lp" className="text-2xl">
          Liquidity you provide
        </h2>
        <p className="mt-1 text-[15px] text-graphite">Withdrawable at any time, at whatever the position is worth then. Not a guaranteed return.</p>
        {lps.length === 0 ? (
          <p className="mt-3 text-graphite">No liquidity positions for this wallet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto border border-rule bg-sheet">
            <table className="w-full min-w-[44rem] text-left text-[15px]">
              <caption className="sr-only">Liquidity positions</caption>
              <thead className="border-b border-rule bg-bond text-sm text-graphite">
                <tr>
                  <th scope="col" className="px-4 py-2">Claim</th>
                  <th scope="col" className="px-4 py-2">Pool</th>
                  <th scope="col" className="px-4 py-2 text-right">Deposited</th>
                  <th scope="col" className="px-4 py-2 text-right">Worth now</th>
                  <th scope="col" className="px-4 py-2 text-right">Fees earned</th>
                  <th scope="col" className="px-4 py-2">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule tabular">
                {lps.map((l) => {
                  const diff = Number(l.currentValue) - Number(l.deposited)
                  return (
                    <tr key={l.tokenId}>
                      <td className="px-4 py-2.5">
                        <Link href={`/claims/${l.claimId}#position`} className="link">
                          {formatClaimNumber(l.claimNumber)}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">{l.outcome === 'yes' ? 'Yes' : 'No'} pool</td>
                      <td className="px-4 py-2.5 text-right">{formatAmount(l.deposited, { maxDecimals: 2 })}</td>
                      <td className={cn('px-4 py-2.5 text-right font-bold', diff < 0 && 'text-red')}>{formatAmount(l.currentValue, { maxDecimals: 2 })}</td>
                      <td className="px-4 py-2.5 text-right">{formatAmount(l.feesEarned, { maxDecimals: 2 })}</td>
                      <td className="px-4 py-2.5 text-sm">{l.inRange ? 'In range' : 'Out of range'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-[15px]">
          <Link href="/activity" className="link font-bold">
            See the full ledger of deposits, withdrawals and fees
          </Link>
        </p>
      </section>
    </div>
  )
}

function PositionsTable({ positions, sym }: { positions: OutcomePosition[]; sym: string }) {
  if (positions.length === 0) return <p className="mt-3 text-graphite">No outcome tokens in this wallet.</p>
  return (
    <div className="mt-4 overflow-x-auto border border-rule bg-sheet">
      <table className="w-full min-w-[44rem] text-left text-[15px]">
        <caption className="sr-only">Outcome token positions</caption>
        <thead className="border-b border-rule bg-bond text-sm text-graphite">
          <tr>
            <th scope="col" className="px-4 py-2">Claim</th>
            <th scope="col" className="px-4 py-2">Stage</th>
            <th scope="col" className="px-4 py-2">Outcome</th>
            <th scope="col" className="px-4 py-2 text-right">Tokens</th>
            <th scope="col" className="px-4 py-2 text-right">Mark</th>
            <th scope="col" className="px-4 py-2 text-right">Value</th>
            <th scope="col" className="px-4 py-2 text-right">Redeemable</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule tabular">
          {positions.map((p, i) => (
            <tr key={`${p.claimId}-${p.outcome}-${i}`}>
              <td className="px-4 py-2.5">
                <Link href={`/claims/${p.claimId}#position`} className="link">
                  {formatClaimNumber(p.claimNumber)}
                </Link>
                <span className="untrusted block max-w-[18rem] truncate text-sm text-graphite">{p.claimTitle}</span>
              </td>
              <td className="px-4 py-2.5">
                <StageTag status={p.status} />
              </td>
              <td className="px-4 py-2.5 font-bold">{p.outcome === 'invalid' ? 'Invalid result' : p.outcome === 'yes' ? 'Yes' : 'No'}</td>
              <td className="px-4 py-2.5 text-right">{formatAmount(p.balance, { maxDecimals: 2 })}</td>
              <td className="px-4 py-2.5 text-right">{formatPrice(p.markPrice)}</td>
              <td className="px-4 py-2.5 text-right">{formatAmount(p.value, { symbol: sym, maxDecimals: 2 })}</td>
              <td className="px-4 py-2.5 text-right font-bold">{p.redeemable ? formatAmount(p.redeemableAmount ?? p.value, { maxDecimals: 2 }) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
