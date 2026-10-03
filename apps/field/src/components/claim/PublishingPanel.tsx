'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, ClaimDetail, TxStep } from '@pine/core'
import { buildPublishSteps, formatDate } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { DEFAULT_INITIAL_YES_PRICE, DEFAULT_PRICE_RANGE, useAccount, useDrafts, useTxRunner, usePine, useWallet } from '@pine/react'
import { CircleSlash, RotateCw, Wrench } from 'lucide-react'
import { TxSteps } from '@/components/tx/TxSteps'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Input } from '@/components/ui/form'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { cn } from '@/lib/cn'

/** A usable spending limit: a positive decimal string, or undefined. */
function usableLimit(v: string | undefined | null): string | undefined {
  const t = v?.trim()
  return t && /^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? t : undefined
}

interface MockWriter {
  updateClaim?: (id: string, patch: Partial<ClaimDetail>) => void
}

/**
 * Recovery for a partially published claim. Shows exactly what is already on-chain, then runs only
 * the outstanding steps ("Finish publishing"). Terms stay frozen once the market exists.
 */
export function PublishingPanel({ claim }: { claim: ClaimDetail }) {
  const pine = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const pub = claim.publication
  const done = new Set((pub?.steps ?? []).filter((s) => s.status === 'confirmed').map((s) => s.id))
  const marketExists = done.has('create_market')
  const isCreator = !!wallet.address && wallet.address.toLowerCase() === claim.creator.toLowerCase()
  const canAct = isCreator || (pine.demo && wallet.isConnected)

  // The runner enforces the spending limit only when it is given one, so never pass undefined: use the
  // claim's own limit, else the draft it was published from, else the account default, else ask.
  const account = useAccount()
  const { drafts } = useDrafts()
  const draftLimit = drafts.find((d) => d.publication?.claimId === claim.id)?.funding?.spendingLimit
  const [customLimit, setCustomLimit] = useState('')
  const [chosenLimit, setChosenLimit] = useState<string | undefined>(undefined)
  const limitSource = usableLimit(claim.funding?.spendingLimit)
    ? 'claim'
    : usableLimit(draftLimit)
      ? 'draft'
      : usableLimit(account.account?.preferences.defaultSpendingLimit)
        ? 'account'
        : chosenLimit
          ? 'custom'
          : null
  const spendingLimit =
    usableLimit(claim.funding?.spendingLimit) ?? usableLimit(draftLimit) ?? usableLimit(account.account?.preferences.defaultSpendingLimit) ?? chosenLimit

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
    // '0' blocks every collateral step until a limit is set; the button below is disabled too.
    spendingLimit: spendingLimit ?? '0',
    onDone: async () => {
      const w = pine.data as unknown as MockWriter
      if (pine.demo && typeof w.updateClaim === 'function') {
        // The pools now hold liquidity, so the market opens at the planned starting price.
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
      <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5 sm:p-6" aria-labelledby="failed-title">
        <h2 id="failed-title" className="t-h2 flex items-center gap-2">
          <CircleSlash size={20} aria-hidden /> Publication failed
        </h2>
        <p className="mt-2 max-w-[70ch] text-ink-2">
          {pub?.note ?? 'Creation stopped and cannot be resumed. Nothing beyond the confirmed steps below exists on-chain, and no market can be traded or answered.'}
        </p>
        <div className="mt-5">
          <StaticSteps claim={claim} />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href={`/compose?from=${claim.id}`}>Start a new claim from these terms</ButtonLink>
          <ButtonLink href="/drafts" variant="secondary">
            Drafts and publications
          </ButtonLink>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5 sm:p-6" aria-labelledby="pub-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-[70ch]">
          <h2 id="pub-title" className="t-h2 flex items-center gap-2">
            <Wrench size={20} aria-hidden /> Finish publishing
          </h2>
          <p className="mt-2 text-ink-2">
            {pub?.note ?? 'This claim was partly published.'} {marketExists ? COPY.frozenTerms : 'The market does not exist yet, so the terms can still change from the composer.'}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-[0.84rem] font-[650] text-ink-2">Already on-chain</p>
          <StaticSteps claim={claim} only="confirmed" />
        </div>
        <div>
          <p className="mb-3 text-[0.84rem] font-[650] text-ink-2">Still to do</p>
          {runner.steps.length > 0 ? (
            <TxSteps runner={runner} chainId={claim.chainId} />
          ) : (
            <p className="text-[0.88rem] text-ink-2">Nothing outstanding could be built for this chain.</p>
          )}
        </div>
      </div>

      {runner.error && (
        <p role="alert" className="mt-4 rounded-[3px] bg-flare-wash px-3 py-2 text-[0.86rem] text-flare-ink">
          {runner.error}
        </p>
      )}

      {!spendingLimit && runner.state !== 'done' && (
        <div className="mt-5 rounded-[3px] border-l-[3px] border-lumen bg-lumen-wash px-4 py-3" role="status">
          <p className="text-[0.9rem] font-[700]">Set a spending limit first</p>
          <p className="mt-1 text-[0.86rem] text-ink-2">
            This claim has no recorded spending limit, and no account default is set. Every remaining step is checked against the limit, so choose one before continuing.
          </p>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const v = usableLimit(customLimit.replace(',', '.'))
              if (v) setChosenLimit(v)
            }}
          >
            <label htmlFor="finish-limit" className="sr-only">
              Spending limit in {claim.collateralSymbol}
            </label>
            <Input id="finish-limit" inputMode="decimal" value={customLimit} onChange={(e) => setCustomLimit(e.target.value)} placeholder="e.g. 300" className="h-9 w-32 text-right" />
            <span className="font-[650]">{claim.collateralSymbol}</span>
            <Button type="submit" size="sm" disabled={!usableLimit(customLimit.replace(',', '.'))}>
              Use this limit
            </Button>
            <Link href="/account#prefs" className="text-[0.84rem] font-[620] underline underline-offset-2">
              Or set an account default
            </Link>
          </form>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        {!wallet.isConnected ? (
          <Button onClick={() => wallet.connect()}>{wallet.isDemo ? 'Connect demo wallet to continue' : 'Connect wallet to continue'}</Button>
        ) : runner.state === 'done' ? (
          <p className="font-[650]">Published. The market is fully funded and open for evidence.</p>
        ) : (
          <Button
            onClick={() => void (runner.state === 'failed' ? runner.retry() : runner.start())}
            loading={runner.state === 'running'}
            disabled={!canAct || !spendingLimit || runner.state === 'paused' || remaining.length === 0}
            icon={runner.state === 'failed' ? <RotateCw size={15} aria-hidden /> : undefined}
          >
            {runner.state === 'failed' ? 'Retry the failed step' : 'Finish publishing'}
          </Button>
        )}
        <DemoFailToggle />
        {!canAct && wallet.isConnected && <p className="text-[0.84rem] text-ink-2">Only the creator&apos;s wallet can finish this publication.</p>}
        <p className="w-full text-[0.8rem] text-ink-3">
          {COPY.spendingLimit}{' '}
          {spendingLimit ? (
            <>
              Spending limit for these steps: {spendingLimit} {claim.collateralSymbol}
              {limitSource === 'draft' ? ' (from your draft)' : limitSource === 'account' ? ' (your account default)' : limitSource === 'custom' ? ' (set here)' : ''}.
            </>
          ) : (
            'No spending limit set yet.'
          )}{' '}
          <Link href="/drafts" className="underline underline-offset-2">
            All in-progress publications
          </Link>
        </p>
      </div>
    </section>
  )
}

function StaticSteps({ claim, only }: { claim: ClaimDetail; only?: 'confirmed' }) {
  const steps = (claim.publication?.steps ?? []).filter((s) => (only ? s.status === only : true))
  if (steps.length === 0) return <p className="text-[0.88rem] text-ink-2">Nothing yet.</p>
  return (
    <ol className="grid gap-2">
      {steps.map((s) => (
        <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 text-[0.88rem]">
          <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 translate-y-[1px] rounded-full', s.status === 'confirmed' ? 'bg-ink' : s.status === 'failed' ? 'border-2 border-flare-ink' : 'border-2 border-line-strong')} />
          <span className="font-[600]">{STEP_LABEL[s.id] ?? s.id}</span>
          <span className={s.status === 'failed' ? 'font-[650] text-flare-ink' : 'text-ink-3'}>
            {s.status === 'idle' ? 'not started' : s.status === 'awaiting_signature' ? 'waiting for signature' : s.status}
            {s.at ? `, ${formatDate(s.at, 'long')}` : ''}
          </span>
          {s.error && <span className="untrusted w-full pl-5 text-[0.8rem] text-ink-2 [white-space:normal]">{s.error}</span>}
        </li>
      ))}
    </ol>
  )
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
