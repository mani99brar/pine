'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import type { ClaimSummary } from '@pine/core'
import { formatAmount, formatClaimNumber, formatPrice } from '@pine/core'
import { useAccount, useClaims, useDrafts, usePortfolio, useWallet } from '@pine/react'
import { AlertTriangle, ArrowRight, Bell, Clock, Coins, FileSearch, Gavel, Plus, Wallet, Wrench } from 'lucide-react'
import { ClaimTile, ClaimTileSkeleton } from '@/components/board/ClaimTile'
import { OutcomeSwatch, StatusPill } from '@/components/glyphs/Status'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { Button, ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { SectionHeading, Skeleton } from '@/components/ui/primitives'
import { useDepthMap } from '@/lib/hooks'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

interface Alert {
  key: string
  tone: 'act' | 'watch'
  icon: React.ReactNode
  title: string
  body: string
  href: string
  cta: string
}

function buildAlerts(mine: ClaimSummary[], now: number | null, redeemable: number, outOfRange: number, unfinished: number, symbol: string): Alert[] {
  const out: Alert[] = []
  for (const c of mine) {
    const n = formatClaimNumber(c.number)
    if (c.status === 'publishing')
      out.push({ key: `pub-${c.id}`, tone: 'act', icon: <Wrench size={16} />, title: `${n} is only partly published`, body: 'The market exists but funding stopped. Finish the remaining steps.', href: `/claims/${c.id}`, cta: 'Finish publishing' })
    if (c.status === 'answer_proposed')
      out.push({ key: `ans-${c.id}`, tone: 'watch', icon: <Clock size={16} />, title: `${n} has a proposed answer`, body: 'It finalizes after its 3.5-day challenge window unless someone posts a different answer with double the bond.', href: `/claims/${c.id}`, cta: 'Review the answer' })
    if (c.status === 'disputed' || c.status === 'arbitration')
      out.push({ key: `dis-${c.id}`, tone: 'watch', icon: <Gavel size={16} />, title: `${n} is ${c.status === 'disputed' ? 'disputed' : 'in arbitration'}`, body: 'Bonds are escalating or jurors are reviewing evidence. Arbitration is paid in ETH on Ethereum by whoever requests it.', href: `/claims/${c.id}`, cta: 'Follow the dispute' })
    if (c.status === 'open' && now !== null && new Date(c.evidenceDeadline).getTime() - now < 86_400_000)
      out.push({ key: `dl-${c.id}`, tone: 'watch', icon: <Clock size={16} />, title: `${n} closes for evidence within 24 hours`, body: 'After the deadline someone needs to post the answer on Reality.eth.', href: `/claims/${c.id}`, cta: 'Open the claim' })
    if (c.status === 'open' && c.evidenceCount > 0)
      out.push({ key: `ev-${c.id}`, tone: 'watch', icon: <FileSearch size={16} />, title: `${n} has ${c.evidenceCount} evidence ${c.evidenceCount === 1 ? 'item' : 'items'}`, body: 'Read them as untrusted content and reproduce only in isolation.', href: `/claims/${c.id}`, cta: 'Read the evidence' })
  }
  if (redeemable > 0)
    out.unshift({ key: 'redeem', tone: 'act', icon: <Coins size={16} />, title: `${formatAmount(redeemable, { maxDecimals: 2 })} ${symbol} redeemable`, body: 'Resolved markets where your outcome tokens pay out.', href: '#redeemable', cta: 'See positions' })
  if (outOfRange > 0)
    out.push({ key: 'range', tone: 'watch', icon: <AlertTriangle size={16} />, title: `${outOfRange} liquidity ${outOfRange === 1 ? 'position is' : 'positions are'} out of range`, body: 'Out-of-range liquidity provides no depth and sits entirely in one outcome.', href: '#liquidity', cta: 'See liquidity' })
  if (unfinished > 0)
    out.push({ key: 'drafts', tone: 'act', icon: <Wrench size={16} />, title: `${unfinished} publication${unfinished === 1 ? '' : 's'} in progress`, body: 'Resume from the first incomplete step.', href: '/drafts', cta: 'Open drafts' })
  return out
}

export function DashboardView() {
  const wallet = useWallet()
  const account = useAccount()
  const now = useNowMs()
  const portfolio = usePortfolio(wallet.address)
  const all = useClaims({ limit: 200 })
  const { drafts } = useDrafts()
  const login = account.account?.github.login
  const linked = new Set((account.account?.wallets ?? []).map((w) => w.address.toLowerCase()))
  if (wallet.address) linked.add(wallet.address.toLowerCase())
  const mine = useMemo(
    () => (all.data?.items ?? []).filter((c) => linked.has(c.creator.toLowerCase()) || (!!login && c.creatorGithub === login)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all.data, login, wallet.address, account.account],
  )
  const depth = useDepthMap(mine.map((c) => c.id))
  const p = portfolio.data
  const symbol = mine[0]?.collateralSymbol ?? 'sDAI'
  const unfinished = drafts.filter((d) => d.publication?.steps.length).length
  const outOfRange = (p?.liquidity ?? []).filter((l) => !l.inRange).length
  const alerts = buildAlerts(mine, now, Number(p?.totals.redeemable ?? 0), outOfRange, unfinished, symbol)

  if (!wallet.isConnected && account.status !== 'signed_in') {
    return (
      <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-10 sm:px-6">
        <SectionHeading as="h1" title="Your field" description="Your claims, positions, liquidity and anything that needs you, in one place." />
        <EmptyState
          className="mt-8"
          title="Connect a wallet or sign in to see your field"
          body="Positions and liquidity are read from the connected wallet. Claims you published are matched by wallet and, when you are signed in, by your GitHub account."
          action={
            <>
              <Button onClick={() => wallet.connect()} icon={<Wallet size={16} aria-hidden />}>
                {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
              </Button>
              <ButtonLink href="/account" variant="secondary">
                Sign in with GitHub
              </ButtonLink>
            </>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="t-display-l">Your field</h1>
          <p className="mt-2 text-ink-2">
            {login ? `@${login}` : 'Not signed in'}
            {wallet.address ? `, wallet ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}${wallet.isDemo ? ' (simulated)' : ''}` : ''}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          {(
            [
              ['Positions', p?.totals.positionsValue],
              ['Liquidity', p?.totals.liquidityValue],
              ['Redeemable', p?.totals.redeemable],
              ['Your claims', String(mine.length)],
            ] as const
          ).map(([k, v], i) => (
            <div key={k}>
              <dt className="text-[0.78rem] text-ink-3">{k}</dt>
              <dd className="t-figure mt-1 text-[1.8rem]">
                {portfolio.isLoading && i < 3 ? '…' : i < 3 ? formatAmount(v ?? '0', { maxDecimals: 2 }) : v}
                {i < 3 && <span className="ml-1 font-sans text-[0.8rem] font-[450] text-ink-3">{symbol}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Alerts */}
      <section className="mt-10" aria-labelledby="alerts">
        <h2 id="alerts" className="t-h2 flex items-center gap-2">
          <Bell size={20} aria-hidden /> Needs your attention
        </h2>
        {alerts.length === 0 ? (
          <p className="mt-3 text-ink-2">Nothing right now. Alerts appear when evidence arrives, an answer is proposed, a deadline is close or something can be redeemed.</p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {alerts.map((a) => (
              <li key={a.key} className={cn('flex flex-col rounded-[var(--radius-tile)] bg-sheet p-4', a.tone === 'act' ? 'border-[1.5px] border-ink' : 'border border-line')}>
                <p className="flex items-start gap-2 font-[650]">
                  <span aria-hidden className={cn('mt-0.5 shrink-0', a.tone === 'act' ? 'text-ink' : 'text-ink-2')}>
                    {a.icon}
                  </span>
                  {a.title}
                </p>
                <p className="mt-1 pl-6 text-[0.86rem] text-ink-2">{a.body}</p>
                <Link href={a.href} className="mt-3 inline-flex items-center gap-1 pl-6 text-[0.86rem] font-[650] underline underline-offset-2">
                  {a.cta} <ArrowRight size={13} aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* My claims */}
      <section className="mt-12" aria-labelledby="mine">
        <SectionHeading
          id="mine"
          title="Claims you put on the board"
          action={
            <ButtonLink href="/compose" size="sm" icon={<Plus size={15} aria-hidden />}>
              New claim
            </ButtonLink>
          }
        />
        {all.isError ? (
          <ErrorState className="mt-4" error={all.error} onRetry={() => all.refetch()} />
        ) : all.isLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <ClaimTileSkeleton />
            <ClaimTileSkeleton />
          </div>
        ) : mine.length === 0 ? (
          <EmptyState className="mt-4" title="You have not published a claim yet" body="Pin a commit you care about and let the field try to break it." action={<ButtonLink href="/compose">Put a claim on the board</ButtonLink>} />
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {mine.map((c) => (
              <li key={c.id} className="flex">
                <ClaimTile claim={c} depth={depth.map[c.id]} depthLoading={depth.loading[c.id]} className="w-full" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Positions */}
      <section className="mt-12" aria-labelledby="redeemable">
        <SectionHeading id="redeemable" title="Outcome positions" description="Tokens held by the connected wallet. Redeemable once the market resolves in your favour." />
        {!wallet.isConnected ? (
          <Button className="mt-4" variant="secondary" onClick={() => wallet.connect()} icon={<Wallet size={16} aria-hidden />}>
            Connect a wallet to see positions
          </Button>
        ) : portfolio.isLoading ? (
          <Skeleton className="mt-4 h-40" />
        ) : (p?.positions.length ?? 0) === 0 ? (
          <p className="mt-3 text-ink-2">No outcome tokens in this wallet.</p>
        ) : (
          <div className="mt-4 relative overflow-x-auto rounded-[var(--radius-tile)] border border-line bg-sheet">
            <table className="w-full min-w-[46rem] text-[0.88rem]">
              <thead>
                <tr className="border-b border-line text-left text-[0.78rem] text-ink-3">
                  <th className="px-4 py-2.5 font-[600]">Claim</th>
                  <th className="px-4 py-2.5 font-[600]">Outcome</th>
                  <th className="px-4 py-2.5 text-right font-[600]">Tokens</th>
                  <th className="px-4 py-2.5 text-right font-[600]">Avg price</th>
                  <th className="px-4 py-2.5 text-right font-[600]">Mark</th>
                  <th className="px-4 py-2.5 text-right font-[600]">Value</th>
                  <th className="px-4 py-2.5 font-[600]">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p!.positions.map((pos) => (
                  <tr key={`${pos.claimId}-${pos.outcome}`} className={pos.redeemable ? 'bg-fog-2/50' : undefined}>
                    <td className="max-w-[18rem] px-4 py-3">
                      <Link href={`/claims/${pos.claimId}`} className="block truncate font-[600] hover:underline">
                        <span className="t-figure mr-2 text-ink-2">{formatClaimNumber(pos.claimNumber)}</span>
                        {pos.claimTitle}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2">
                        <OutcomeSwatch outcome={pos.outcome} />
                        {pos.outcome === 'yes' ? 'Yes' : pos.outcome === 'no' ? 'No' : 'Invalid result'}
                      </span>
                    </td>
                    <td className="t-figure px-4 py-3 text-right text-[1rem]">{formatAmount(pos.balance, { maxDecimals: 2 })}</td>
                    <td className="t-figure px-4 py-3 text-right text-[1rem]">{pos.avgPrice !== undefined ? formatPrice(pos.avgPrice) : '—'}</td>
                    <td className="t-figure px-4 py-3 text-right text-[1rem]">{formatPrice(pos.markPrice)}</td>
                    <td className="t-figure px-4 py-3 text-right text-[1rem]">{formatAmount(pos.value, { maxDecimals: 2 })}</td>
                    <td className="px-4 py-3">
                      {pos.redeemable ? (
                        <Link href={`/claims/${pos.claimId}`} className="inline-flex items-center gap-1 rounded-full bg-ink px-2.5 py-1 text-[0.75rem] font-[650] text-on-ink">
                          Redeem {formatAmount(pos.redeemableAmount ?? pos.value, { maxDecimals: 2 })}
                        </Link>
                      ) : (
                        <StatusPill status={pos.status} size="sm" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Liquidity */}
      <section className="mt-12" aria-labelledby="liquidity">
        <SectionHeading id="liquidity" title="Liquidity positions" description="Withdrawable at market value on the DEX. Not a guaranteed return, and not a bounty." />
        {!wallet.isConnected ? null : portfolio.isLoading ? (
          <Skeleton className="mt-4 h-32" />
        ) : (p?.liquidity.length ?? 0) === 0 ? (
          <p className="mt-3 text-ink-2">No liquidity positions in this wallet.</p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {p!.liquidity.map((l) => {
              const dep = Number(l.deposited)
              const cur = Number(l.currentValue)
              const ratio = dep > 0 ? cur / dep : 1
              return (
                <li key={l.tokenId} className="rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Link href={`/claims/${l.claimId}`} className="min-w-0 font-[650] hover:underline">
                      <span className="t-figure mr-2 text-ink-2">{formatClaimNumber(l.claimNumber)}</span>
                      {l.claimTitle}
                    </Link>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.75rem] font-[700]',
                        l.inRange ? 'bg-fog-2 text-ink' : 'bg-lumen-wash text-lumen-ink shadow-[inset_0_0_0_1.5px_var(--lumen)]',
                      )}
                    >
                      {l.inRange ? 'In range' : 'Out of range'}
                    </span>
                  </div>
                  <p className="mt-1 flex items-center gap-2 text-[0.8rem] text-ink-3">
                    <OutcomeSwatch outcome={l.outcome} /> {l.outcome === 'yes' ? 'Yes' : 'No'} pool, position #{l.tokenId}
                  </p>
                  <div className="mt-3 grid grid-cols-3 gap-3 text-[0.8rem]">
                    <div>
                      <p className="text-ink-3">Deposited</p>
                      <p className="t-figure text-[1.15rem]">{formatAmount(l.deposited, { maxDecimals: 2 })}</p>
                    </div>
                    <div>
                      <p className="text-ink-3">Worth now</p>
                      <p className="t-figure text-[1.15rem]">{formatAmount(l.currentValue, { maxDecimals: 2 })}</p>
                    </div>
                    <div>
                      <p className="text-ink-3">Fees accrued</p>
                      <p className="t-figure text-[1.15rem]">{formatAmount(l.feesEarned, { maxDecimals: 2 })}</p>
                    </div>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-fog-2" role="img" aria-label={`Worth ${Math.round(ratio * 100)}% of what was deposited`}>
                    <div className="h-full bg-ink" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                  </div>
                  <p className="mt-2 text-[0.75rem] text-ink-3">{l.withdrawable ? 'Withdraw on the DEX at any time.' : 'Not withdrawable right now.'}</p>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {mine.some((c) => c.status === 'open') && (
        <section className="mt-12" aria-label="Your open claims at a glance">
          <h2 className="t-h3">Your open claims at a glance</h2>
          <ul className="mt-3 grid gap-2">
            {mine
              .filter((c) => c.status === 'open')
              .map((c) => (
                <li key={c.id} className="grid grid-cols-[6rem_1fr_3.5rem] items-center gap-4 text-[0.86rem]">
                  <Link href={`/claims/${c.id}`} className="t-figure text-ink-2 hover:underline">
                    {formatClaimNumber(c.number)}
                  </Link>
                  <TensionBar yes={c.yesPrice} yes24hAgo={c.yesPrice24hAgo} size="sm" />
                  <span className="t-figure text-right text-flare-ink">{c.yesPrice !== undefined ? formatPrice(c.yesPrice) : '—'}</span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  )
}
