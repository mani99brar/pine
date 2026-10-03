'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, ClaimDetail, TxStep } from '@pine/core'
import { buildPublishSteps, formatAmount, formatDate, formatPriceCents } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { DEFAULT_INITIAL_YES_PRICE, DEFAULT_PRICE_RANGE, useAccount, useDrafts, usePine, usePortfolio, useRedeem, useTxRunner, useWallet } from '@pine/react'
import { CircleSlash, RotateCw, Wallet, Wrench } from 'lucide-react'
import { TxSteps } from '@/components/tx/TxSteps'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Notice, Skeleton } from '@/components/ui/primitives'
import { apiFactsOf, isResolved } from '@/lib/claims'
import { OUTCOME_HEX } from '@/lib/crystal'
import { useMounted } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { ApiPositionPanel } from './ApiPosition'

const OUTCOME_NAME = { yes: 'Yes', no: 'No', invalid: 'Invalid result' } as const

/** The connected wallet's position in this market, with redemption once resolved. */
export function PositionPanel({ claim }: { claim: ClaimDetail }) {
  if (apiFactsOf(claim)) return <ApiPositionPanel claim={claim} />
  return <LocalPositionPanel claim={claim} />
}

function LocalPositionPanel({ claim }: { claim: ClaimDetail }) {
  const mounted = useMounted()
  const wallet = useWallet()
  const portfolio = usePortfolio(wallet.address)
  const redeem = useRedeem(claim.id)
  const positions = (portfolio.data?.positions ?? []).filter((p) => p.claimId === claim.id)
  const lps = (portfolio.data?.liquidity ?? []).filter((l) => l.claimId === claim.id)
  const resolved = isResolved(claim.status)
  const sym = claim.collateralSymbol

  return (
    <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="pos-title">
      <h2 id="pos-title" className="t-h4">
        Your position
      </h2>
      {!mounted ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : !wallet.isConnected ? (
        <div className="mt-3">
          <p className="text-[0.9rem] text-lumen-2">Connect a wallet to see what you hold in this market.</p>
          <Button variant="glass" size="sm" className="mt-3" onClick={() => wallet.connect()} icon={<Wallet size={14} aria-hidden />}>
            {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
          </Button>
        </div>
      ) : portfolio.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : positions.length === 0 && lps.length === 0 ? (
        redeem.runner.state === 'done' ? (
          <div className="mt-3">
            <p className="text-[0.9rem] text-lumen">Redeemed. The collateral is back in your wallet.</p>
            <TxSteps runner={redeem.runner} chainId={claim.chainId} className="mt-4" />
          </div>
        ) : (
          <p className="mt-3 text-[0.9rem] text-lumen-2">This wallet holds no outcome tokens or liquidity in this market.</p>
        )
      ) : (
        <div className="mt-3 grid gap-4">
          {positions.length > 0 && (
            <ul className="grid gap-2">
              {positions.map((p) => (
                <li key={`${p.outcome}`} className="cut-sm grid grid-cols-[auto_1fr_auto] items-center gap-3 border border-edge bg-void px-3 py-2.5">
                  <span aria-hidden className="h-6 w-[3px] rounded-full" style={{ background: OUTCOME_HEX[p.outcome] }} />
                  <div className="min-w-0">
                    <p className="text-[0.875rem] font-semibold text-lumen">
                      {formatAmount(p.balance, { maxDecimals: 2 })} {OUTCOME_NAME[p.outcome]} tokens
                    </p>
                    <p className="tnum text-[0.78rem] text-lumen-3">
                      {p.avgPrice !== undefined ? `bought at ${formatPriceCents(p.avgPrice)}, ` : ''}now {formatPriceCents(p.markPrice)} {sym} each
                    </p>
                  </div>
                  <p className="tnum text-right text-[0.875rem] text-lumen">
                    {formatAmount(p.value, { maxDecimals: 2 })} {sym}
                    {p.redeemable && <span className="block text-[0.75rem] text-hb">redeemable</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {lps.length > 0 && (
            <div>
              <p className="text-[0.8125rem] font-semibold text-lumen">Liquidity you provide</p>
              <ul className="mt-2 grid gap-2">
                {lps.map((l) => (
                  <li key={l.tokenId} className="cut-sm border border-edge bg-void px-3 py-2.5 text-[0.84375rem]">
                    <p className="text-lumen">
                      {l.outcome === 'yes' ? 'Yes' : 'No'} pool: {formatAmount(l.currentValue, { maxDecimals: 2 })} {sym} now, {formatAmount(l.deposited, { maxDecimals: 2 })} deposited
                    </p>
                    <p className="text-[0.78rem] text-lumen-3">
                      Fees {formatAmount(l.feesEarned, { maxDecimals: 2 })} {sym}. {l.inRange ? 'In range.' : 'Out of range.'} {l.withdrawable ? 'Withdrawable on the DEX.' : 'Not withdrawable now.'}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[0.78rem] text-lumen-3">{COPY.liquidityIsNotBounty}</p>
            </div>
          )}
          {resolved && (
            <div className="border-t border-edge pt-4">
              {redeem.runner.state === 'done' ? (
                <p className="text-[0.9rem] text-lumen">Redeemed. Collateral is back in your wallet.</p>
              ) : Number(redeem.redeemable) > 0 ? (
                <>
                  <p className="text-[0.9rem] text-lumen-2">
                    You can redeem <span className="tnum font-semibold text-lumen">{formatAmount(redeem.redeemable, { maxDecimals: 2 })} {sym}</span> under Seer&apos;s native payout rules.
                  </p>
                  {redeem.runner.steps.some((s) => s.status !== 'idle') && <TxSteps runner={redeem.runner} chainId={claim.chainId} className="mt-4" />}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => void (redeem.runner.state === 'failed' ? redeem.runner.retry() : redeem.runner.start())}
                      loading={redeem.runner.state === 'running'}
                      disabled={redeem.blockers.length > 0}
                      icon={redeem.runner.state === 'failed' ? <RotateCw size={14} aria-hidden /> : undefined}
                    >
                      {redeem.runner.state === 'failed' ? 'Retry redemption' : 'Redeem'}
                    </Button>
                    <DemoFailToggle />
                  </div>
                </>
              ) : (
                <p className="text-[0.9rem] text-lumen-2">Nothing to redeem for this wallet.</p>
              )}
              {claim.outcome === 'invalid' && <p className="mt-2 text-[0.78rem] text-lumen-3">{COPY.invalidIsNotRefund}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function usableLimit(v: string | undefined | null): string | undefined {
  const t = v?.trim()
  return t && /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? t : undefined
}

const STEP_LABEL: Record<string, string> = {
  upload_manifest: 'Manifest pinned',
  create_market: 'Market created',
  approve_collateral: 'Collateral approved (exact amount)',
  split_position: 'Collateral split into outcome tokens',
  add_liquidity_yes: 'Yes liquidity added',
  add_liquidity_no: 'No liquidity added',
  register_claim: 'Claim registered',
}

function RecordedSteps({ claim, only }: { claim: ClaimDetail; only?: 'confirmed' }) {
  const steps = (claim.publication?.steps ?? []).filter((s) => (only ? s.status === only : true))
  if (!steps.length) return <p className="text-[0.875rem] text-lumen-3">Nothing yet.</p>
  return (
    <ol className="grid gap-2">
      {steps.map((s) => (
        <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 text-[0.875rem]">
          <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 translate-y-[1px] rotate-45', s.status === 'confirmed' ? 'bg-lumen' : s.status === 'failed' ? 'border-2 border-ha' : 'border border-edge-strong')} />
          <span className="font-semibold text-lumen">{STEP_LABEL[s.id] ?? s.id}</span>
          <span className={s.status === 'failed' ? 'font-semibold text-ha' : 'text-lumen-3'}>
            {s.status === 'idle' ? 'not started' : s.status}
            {s.at ? `, ${formatDate(s.at, 'short')}` : ''}
          </span>
          {s.error && <span className="untrusted w-full pl-5 text-[0.8125rem] text-lumen-2 [white-space:normal]">{s.error}</span>}
        </li>
      ))}
    </ol>
  )
}

interface MockWriter {
  updateClaim?: (id: string, patch: Partial<ClaimDetail>) => void
}

/**
 * Recovery for a partly published claim: shows exactly what is on-chain, then runs only the
 * outstanding steps ("Finish publishing"). The spending limit is always defined before any step runs.
 */
export function PublishingRecovery({ claim }: { claim: ClaimDetail }) {
  const pine = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const mounted = useMounted()
  const pub = claim.publication
  const done = new Set((pub?.steps ?? []).filter((s) => s.status === 'confirmed').map((s) => s.id))
  const marketExists = done.has('create_market')
  const isCreator = !!wallet.address && wallet.address.toLowerCase() === claim.creator.toLowerCase()
  const canAct = isCreator || (pine.demo && wallet.isConnected)

  const account = useAccount()
  const { drafts } = useDrafts()
  const draftLimit = drafts.find((d) => d.publication?.claimId === claim.id)?.funding?.spendingLimit
  const [custom, setCustom] = useState('')
  const [chosen, setChosen] = useState<string | undefined>()
  const fromClaim = usableLimit(claim.funding?.spendingLimit)
  const fromDraft = usableLimit(draftLimit)
  const fromAccount = usableLimit(account.account?.preferences.defaultSpendingLimit)
  const spendingLimit = fromClaim ?? fromDraft ?? fromAccount ?? chosen
  const limitSource = fromClaim ? 'from the claim' : fromDraft ? 'from your draft' : fromAccount ? 'your account default' : chosen ? 'set here' : null

  const remaining: TxStep[] = useMemo(() => {
    try {
      const all = buildPublishSteps({
        chainId: claim.chainId,
        manifestUri: claim.manifestUri,
        manifestHash: claim.manifestHash,
        question: claim.manifest.question,
        oracle: claim.manifest.claim.oracle,
        funding: {
          chainId: claim.chainId,
          liquidity: claim.funding?.liquidity ?? '25',
          spendingLimit: spendingLimit ?? '0',
          initialYesPrice: DEFAULT_INITIAL_YES_PRICE,
          priceRange: [...DEFAULT_PRICE_RANGE] as [number, number],
        },
        creator: claim.creator as Address,
        market: claim.marketAddress,
        allowPlaceholderAddresses: pine.demo,
      })
      return all.filter((s) => !done.has(s.id))
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim.id, pine.demo, pub?.steps?.length, spendingLimit])

  const runner = useTxRunner(`finish:${claim.id}`, remaining, {
    // '0' blocks every collateral step until a limit is chosen; the button is disabled too.
    spendingLimit: spendingLimit ?? '0',
    onDone: async () => {
      const w = pine.data as unknown as MockWriter
      if (pine.demo && typeof w.updateClaim === 'function') {
        const yes = DEFAULT_INITIAL_YES_PRICE
        const liquidity = claim.funding?.liquidity ?? '25'
        const half = String(Math.round((Number(liquidity) / 2) * 100) / 100)
        w.updateClaim(claim.id, {
          status: 'open',
          publication: undefined,
          yesPrice: yes,
          yesPrice24hAgo: yes,
          liquidity,
          market: claim.market
            ? {
                ...claim.market,
                liquidity,
                outcomes: claim.market.outcomes.map((o) => ({ ...o, price: o.index === 0 ? yes : o.index === 1 ? Math.round((1 - yes) * 10000) / 10000 : 0 })),
                pools: claim.market.pools.map((pl) => ({ ...pl, tvl: half })),
              }
            : claim.market,
        })
      }
      await qc.invalidateQueries({ queryKey: ['pine'] })
    },
  })

  if (claim.status === 'failed') {
    return (
      <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="failed-title">
        <h2 id="failed-title" className="t-h3 flex items-center gap-2">
          <CircleSlash size={20} aria-hidden className="text-lumen-3" /> Publication failed
        </h2>
        {/* The reason (pub.note) is in "What happens next"; this panel says what exists on-chain. */}
        <p className="mt-2 max-w-[70ch] text-lumen-2">Creation stopped and cannot be resumed. Only the confirmed steps below exist on-chain, and no market can be traded or answered.</p>
        <div className="mt-5">
          <RecordedSteps claim={claim} />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href={`/compose?from=${claim.id}`}>Start a new claim from these terms</ButtonLink>
          <ButtonLink href="/drafts" variant="glass">
            Drafts and publications
          </ButtonLink>
        </div>
      </section>
    )
  }

  return (
    <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="finish-title">
      <h2 id="finish-title" className="t-h3 flex items-center gap-2">
        <Wrench size={19} aria-hidden className="text-na" /> Finish publishing
      </h2>
      <p className="mt-2 max-w-[72ch] text-lumen-2">
        {pub?.note ?? 'This claim was partly published.'} {marketExists ? COPY.frozenTerms : 'The market does not exist yet, so the terms can still change from the composer.'}
      </p>
      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-[0.84375rem] font-semibold text-lumen-2">Already on-chain</p>
          <RecordedSteps claim={claim} only="confirmed" />
        </div>
        <div>
          <p className="mb-3 text-[0.84375rem] font-semibold text-lumen-2">Still to do</p>
          {runner.steps.length > 0 ? <TxSteps runner={runner} chainId={claim.chainId} /> : <p className="text-[0.875rem] text-lumen-3">Nothing outstanding could be built for this chain.</p>}
        </div>
      </div>
      {runner.error && (
        <Notice tone="critical" role="alert" className="mt-5">
          <span className="untrusted [white-space:normal]">{runner.error}</span>
        </Notice>
      )}
      {!spendingLimit && runner.state !== 'done' && (
        <Notice tone="caution" title="Set a spending limit first" className="mt-5" role="status">
          This claim has no recorded spending limit and your account has no default. Every remaining step is checked against the limit.
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const v = usableLimit(custom.replace(',', '.'))
              if (v) setChosen(v)
            }}
          >
            <label htmlFor="finish-limit" className="sr-only">
              Spending limit in {claim.collateralSymbol}
            </label>
            <input id="finish-limit" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. 300" className="field tnum w-32 text-right" />
            <span className="font-semibold text-lumen">{claim.collateralSymbol}</span>
            <Button type="submit" size="sm" disabled={!usableLimit(custom.replace(',', '.'))}>
              Use this limit
            </Button>
            <Link href="/account#preferences" className="link text-[0.84375rem]">
              Or set an account default
            </Link>
          </form>
        </Notice>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-edge pt-5">
        {!mounted ? null : !wallet.isConnected ? (
          <Button onClick={() => wallet.connect()} icon={<Wallet size={15} aria-hidden />}>
            {wallet.isDemo ? 'Connect demo wallet to continue' : 'Connect wallet to continue'}
          </Button>
        ) : runner.state === 'done' ? (
          <p className="font-semibold text-lumen">Published. The market is funded and open for evidence.</p>
        ) : (
          <Button
            onClick={() => void (runner.state === 'failed' ? runner.retry() : runner.start())}
            loading={runner.state === 'running'}
            disabled={!canAct || !spendingLimit || !!runner.awaitingManual || remaining.length === 0}
            icon={runner.state === 'failed' ? <RotateCw size={15} aria-hidden /> : undefined}
          >
            {runner.state === 'failed' ? 'Retry the failed step' : runner.steps.some((s) => s.status === 'confirmed') ? 'Continue publishing' : 'Finish publishing'}
          </Button>
        )}
        <DemoFailToggle />
        {!canAct && wallet.isConnected && <p className="text-[0.84375rem] text-lumen-3">Only the creator&apos;s wallet can finish this publication.</p>}
        <p className="w-full text-[0.8125rem] text-lumen-3">
          {COPY.spendingLimit} {spendingLimit ? `Spending limit for these steps: ${spendingLimit} ${claim.collateralSymbol} (${limitSource}).` : 'No spending limit set yet.'}{' '}
          <Link href="/drafts" className="link">
            All unfinished publications
          </Link>
        </p>
      </div>
    </section>
  )
}
