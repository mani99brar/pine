'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import type { Address, ClaimDetail, LiquidityPosition, OutcomePosition, Portfolio } from '@pine/core'
import { formatAmount, formatPriceCents } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ApiDataProvider } from '@pine/data'
import { useApiExits, useApiFunding, usePine, useWallet, type ApiPlanRunner, type LadderQuote } from '@pine/react'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Notice, Skeleton } from '@/components/ui/primitives'
import { apiDetailFactsOf } from '@/lib/claims'
import { OUTCOME_HEX } from '@/lib/crystal'
import { useMounted } from '@/lib/hooks'
import { ApiSessionGate, PlanControls, PlanProgress, WriteErrorNotice, parseAmountWei, useSessionReady } from './ApiActionKit'

const OUTCOME_NAME = { yes: 'Yes', no: 'No', invalid: 'Invalid result' } as const
const PRICE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,18})?$/
const UINT = /^(?:0|[1-9][0-9]{0,77})$/

/** The wallet's outcome tokens and LP positions in one market (api mode: GET /funding/positions/:wallet?market=). */
function useMarketPortfolio(address: Address | undefined, market: Address | undefined) {
  const { data } = usePine()
  const provider = data instanceof ApiDataProvider ? data : null
  return useQuery<Portfolio | null>({
    queryKey: ['pine', 'portfolio', address?.toLowerCase(), 'market', market?.toLowerCase()],
    queryFn: () => (provider && address && market ? provider.getMarketPortfolio(address, market) : Promise.resolve(null)),
    enabled: Boolean(provider && address && market),
    staleTime: 15_000,
  })
}

/** Refreshes holdings once a plan's wallet steps are done. */
function useRefreshWhenDone(runner: ApiPlanRunner) {
  const qc = useQueryClient()
  const state = runner.runner.state
  const prev = useRef(state)
  useEffect(() => {
    if (prev.current !== 'done' && state === 'done') void qc.invalidateQueries({ queryKey: ['pine', 'portfolio'] })
    prev.current = state
  }, [state, qc])
}

function units(wei: string, maxDecimals = 4): string {
  return UINT.test(wei) ? formatAmount(formatUnits(BigInt(wei), 18), { maxDecimals }) : '—'
}

function weiOf(decimal: string): bigint {
  try {
    return parseUnits(decimal, 18)
  } catch {
    return 0n
  }
}

function PositionRow({ p, sym, resolved }: { p: OutcomePosition; sym: string; resolved: boolean }) {
  // Unpriced outcomes (no pool, or Invalid) have no mark: say so instead of valuing them at 0.
  const priced = resolved || p.markPrice > 0
  return (
    <li className="cut-sm grid grid-cols-[auto_1fr_auto] items-center gap-3 border border-edge bg-void px-3 py-2.5">
      <span aria-hidden className="h-6 w-[3px] rounded-full" style={{ background: OUTCOME_HEX[p.outcome] }} />
      <div className="min-w-0">
        <p className="text-[0.875rem] font-semibold text-lumen">
          {formatAmount(p.balance, { maxDecimals: 4 })} {OUTCOME_NAME[p.outcome]} tokens
        </p>
        <p className="tnum text-[0.78rem] text-lumen-3">{resolved ? `pays ${formatPriceCents(p.markPrice)} ${sym} each` : priced ? `pool price ${formatPriceCents(p.markPrice)} ${sym} each` : 'not priced: no pool price'}</p>
      </div>
      <p className="tnum text-right text-[0.875rem] text-lumen">
        {priced ? `${formatAmount(p.value, { maxDecimals: 2 })} ${sym}` : '—'}
        {p.redeemable && <span className="block text-[0.75rem] text-hb">redeemable</span>}
      </p>
    </li>
  )
}

function LiquidityRow({ l, onWithdraw, busy, canAct }: { l: LiquidityPosition; onWithdraw: () => void; busy: boolean; canAct: boolean }) {
  return (
    <li className="cut-sm flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border border-edge bg-void px-3 py-2.5 text-[0.84375rem]">
      <div className="min-w-0">
        <p className="text-lumen">
          {l.outcome === 'yes' ? 'Yes' : 'No'} pool position <span className="t-code text-lumen-2">#{l.tokenId}</span>
        </p>
        <p className="text-[0.78rem] text-lumen-3">
          {l.inRange ? 'In range.' : 'Out of range.'} {l.withdrawable ? 'Holds liquidity or fees to withdraw.' : 'Empty.'} Its value is not indexed by Pine.
        </p>
      </div>
      {canAct && (
        <Button size="sm" variant="glass" disabled={busy} onClick={onWithdraw}>
          {l.withdrawable ? 'Withdraw' : 'Burn the empty position'}
        </Button>
      )}
    </li>
  )
}

/** Exits: withdraw an LP position, merge full sets back to xDAI, redeem winning tokens. */
function Exits({ claim, positions, lps, resolved }: { claim: ClaimDetail; positions: OutcomePosition[]; lps: LiquidityPosition[]; resolved: boolean }) {
  const market = (claim.marketAddress ?? claim.id) as Address
  const exits = useApiExits(market)
  useRefreshWhenDone(exits.runner)
  const [amount, setAmount] = useState('')
  const balance = (o: 'yes' | 'no' | 'invalid') => weiOf(positions.find((p) => p.outcome === o)?.balance ?? '0')
  const sets = [balance('yes'), balance('no'), balance('invalid')].reduce((a, b) => (b < a ? b : a))
  const amountWei = parseAmountWei(amount)
  const redeemable = positions.some((p) => p.redeemable)
  const busy = exits.busy
  const ready = useSessionReady()
  const canMerge = !resolved && sets > 0n
  const canRedeem = resolved && redeemable
  return (
    <div className="grid gap-4">
      {lps.length > 0 && (
        <div>
          <p className="text-[0.8125rem] font-semibold text-lumen">Liquidity you provide</p>
          <ul className="mt-2 grid gap-2">
            {lps.map((l) => (
              <LiquidityRow key={l.tokenId} l={l} busy={busy} canAct={ready} onWithdraw={() => void exits.withdrawPosition(l.tokenId)} />
            ))}
          </ul>
          <p className="mt-2 text-[0.78rem] text-lumen-3">{COPY.liquidityIsNotBounty}</p>
        </div>
      )}
      {!ready && (lps.length > 0 || canMerge || canRedeem) && <ApiSessionGate purpose="withdraw, merge or redeem" />}
      {ready && (
        <>
          {canMerge && (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (amountWei !== null && amountWei <= sets) void exits.merge(amountWei)
              }}
            >
              <label htmlFor="merge-amount" className="label mb-0">
                Merge full sets back to xDAI
              </label>
              <p className="help -mt-1">One Yes, one No and one Invalid-result token make a full set worth 1 sDAI. You hold {formatAmount(formatUnits(sets, 18), { maxDecimals: 4 })} full sets.</p>
              <div className="flex flex-wrap items-center gap-2">
                <input id="merge-amount" className="field tnum w-36" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amount !== '' && (amountWei === null || amountWei > sets)} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setAmount(formatUnits(sets, 18))}>
                  Use all {formatAmount(formatUnits(sets, 18), { maxDecimals: 4 })}
                </Button>
                <Button type="submit" size="sm" variant="glass" disabled={amountWei === null || amountWei > sets || busy}>
                  Merge
                </Button>
              </div>
            </form>
          )}
          {canRedeem && (
            <div>
              <p className="text-[0.9rem] text-lumen-2">Redeem your winning outcome tokens for collateral under Seer&apos;s native payout rules.</p>
              <Button size="sm" className="mt-2" disabled={busy} onClick={() => void exits.redeem()}>
                Redeem winning tokens
              </Button>
              {claim.outcome === 'invalid' && <p className="mt-2 text-[0.78rem] text-lumen-3">{COPY.invalidIsNotRefund}</p>}
            </div>
          )}
          <WriteErrorNotice error={exits.error} />
          <PlanProgress runner={exits.runner} chainId={claim.chainId} />
          <PlanControls runner={exits.runner} busy={busy} onRetry={() => void exits.runner.run()} onAbandon={exits.abandon} />
          {exits.plan?.recovery && <Notice tone="caution">{exits.plan.recovery}</Notice>}
          {exits.plan && exits.runner.runner.state === 'done' && (
            <p className="text-[0.84375rem] text-lumen-2" role="status">
              Sent. Pine sees the {exits.plan.kind} plan as {exits.plan.state}.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Figure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cut-sm border border-edge bg-void px-3 py-2">
      <dt className="text-[0.75rem] text-lumen-3">{label}</dt>
      <dd className="tnum mt-0.5 text-[0.9rem] text-lumen">{children}</dd>
    </div>
  )
}

/**
 * The YES liquidity ladder (useApiFunding): budget and price range in, the backend's loss figures out, then an explicit
 * spending limit and acknowledgement before any plan is made. No field has a default.
 */
function Ladder({ claim }: { claim: ClaimDetail }) {
  const market = (claim.marketAddress ?? claim.id) as Address
  const funding = useApiFunding(market)
  useRefreshWhenDone(funding.runner)
  const [budget, setBudget] = useState('')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [limit, setLimit] = useState('')
  const [ack, setAck] = useState(false)
  const budgetWei = parseAmountWei(budget)
  const limitWei = parseAmountWei(limit)
  const lo = lower.trim().replace(',', '.')
  const hi = upper.trim().replace(',', '.')
  const rangeOk = PRICE.test(lo) && PRICE.test(hi)
  const quote: LadderQuote | null = funding.quote && funding.quote.market === market.toLowerCase() ? funding.quote : null
  const quoteBudget = quote && UINT.test(quote.budgetWei) ? BigInt(quote.budgetWei) : null
  const overLimit = quoteBudget !== null && limitWei !== null && quoteBudget > limitWei
  const busy = funding.busy
  const sent = funding.runner.runner.steps.some((s) => s.status !== 'idle')
  return (
    <details className="cut-md border border-edge bg-void p-4" open={sent || undefined}>
      <summary className="cursor-pointer text-[0.9375rem] font-semibold text-lumen">Add liquidity</summary>
      <p className="mt-2 text-[0.84375rem] text-lumen-2">
        Splits xDAI into outcome tokens and places the Yes tokens in a single-sided Yes pool position over a price range. {COPY.liquidityIsNotBounty}
      </p>
      <ApiSessionGate purpose="add liquidity" className="mt-3">
        <form
          className="mt-3 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            setAck(false)
            if (budgetWei !== null && rangeOk) void funding.quoteLadder({ budgetWei, lowerPrice: lo, upperPrice: hi })
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="ladder-budget" className="label">
                Budget in xDAI
              </label>
              <input id="ladder-budget" className="field tnum" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={budget !== '' && budgetWei === null} />
            </div>
            <div>
              <label htmlFor="ladder-lower" className="label">
                Lowest Yes price
              </label>
              <input id="ladder-lower" className="field tnum" inputMode="decimal" placeholder="e.g. 0.05" value={lower} onChange={(e) => setLower(e.target.value)} aria-invalid={lower !== '' && !PRICE.test(lo)} />
            </div>
            <div>
              <label htmlFor="ladder-upper" className="label">
                Highest Yes price
              </label>
              <input id="ladder-upper" className="field tnum" inputMode="decimal" placeholder="e.g. 0.5" value={upper} onChange={(e) => setUpper(e.target.value)} aria-invalid={upper !== '' && !PRICE.test(hi)} />
            </div>
          </div>
          <p className="help -mt-1">Prices in sDAI per Yes token, between 0.01 and 0.95. Pine computes what you could lose before anything is sent.</p>
          <div>
            <Button type="submit" size="sm" variant="glass" disabled={budgetWei === null || !rangeOk || busy}>
              Show what I could lose
            </Button>
          </div>
        </form>

        {quote && (
          <form
            className="mt-4 grid gap-3 border-t border-edge pt-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (ack && limitWei !== null && !overLimit) void funding.fund({ quote, spendingLimitWei: limitWei })
            }}
          >
            <dl className="grid grid-cols-2 gap-2">
              <Figure label="Budget">{units(quote.budgetWei)} xDAI</Figure>
              <Figure label="Full sets">{units(quote.sets)}</Figure>
              <Figure label="Yes price range">
                {formatAmount(quote.finalLowerPrice, { maxDecimals: 4 })} to {formatAmount(quote.finalUpperPrice, { maxDecimals: 4 })} sDAI
              </Figure>
              <Figure label="Most you lose if Yes resolves">
                {units(quote.maxLossIfYesXdaiWei)} xDAI
                <span className="block text-[0.75rem] text-lumen-3">{units(quote.maxLossIfYesShares)} sDAI</span>
              </Figure>
            </dl>
            <div>
              <label htmlFor="ladder-limit" className="label">
                Spending limit in xDAI
              </label>
              <input id="ladder-limit" className="field tnum w-40" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={limit !== '' && (limitWei === null || overLimit)} aria-describedby="ladder-limit-help" />
              <p id="ladder-limit-help" className="help mt-1">
                The most this plan may take from your wallet; every token approval is capped by it too. {COPY.spendingLimit}
              </p>
              {overLimit && <p className="mt-1 text-[0.8125rem] text-ha">The budget is above this limit.</p>}
            </div>
            <label className="flex items-start gap-3 text-[0.875rem] text-lumen-2">
              <input type="checkbox" className="facet-check" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I understand I can lose up to {units(quote.maxLossIfYesXdaiWei)} xDAI of this budget if the claim resolves Yes, and that the position&apos;s value moves with trading.
              </span>
            </label>
            <div>
              <Button type="submit" size="sm" disabled={!ack || limitWei === null || overLimit || busy} loading={busy}>
                Add liquidity
              </Button>
            </div>
          </form>
        )}
        <WriteErrorNotice error={funding.error} className="mt-3" />
        <PlanProgress runner={funding.runner} chainId={claim.chainId} className="mt-4" />
        <div className="mt-3">
          <PlanControls runner={funding.runner} busy={busy} onRetry={() => void funding.runner.run()} onAbandon={funding.abandon} />
        </div>
        {funding.plan?.recovery && (
          <Notice tone="caution" className="mt-3">
            {funding.plan.recovery}
          </Notice>
        )}
      </ApiSessionGate>
    </details>
  )
}

/** "Your position" for a backend claim: holdings in this market, exits, and liquidity while the evidence window is open. */
export function ApiPositionPanel({ claim }: { claim: ClaimDetail }) {
  const mounted = useMounted()
  const wallet = useWallet()
  const api = apiDetailFactsOf(claim)
  const market = (claim.marketAddress ?? claim.id) as Address
  const q = useMarketPortfolio(wallet.address, market)
  const positions = q.data?.positions ?? []
  const lps = q.data?.liquidity ?? []
  const resolved = api?.phase === 'resolved'
  const canFund = api?.phase === 'evidence_open' && !api.hidden
  const sym = claim.collateralSymbol
  return (
    <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="pos-title">
      <h2 id="pos-title" className="t-h4">
        Your position
      </h2>
      {!mounted ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : !wallet.isConnected || !wallet.address ? (
        <div className="mt-3">
          <p className="text-[0.9rem] text-lumen-2">Connect a wallet to see what you hold in this market.</p>
          <Button variant="glass" size="sm" className="mt-3" onClick={() => wallet.connect()} icon={<Wallet size={14} aria-hidden />}>
            Connect wallet
          </Button>
        </div>
      ) : q.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : (
        <div className="mt-3 grid gap-4">
          {q.isError && <p className="text-[0.875rem] text-na">Your holdings could not be read right now.</p>}
          {positions.length === 0 && lps.length === 0 ? (
            <p className="text-[0.9rem] text-lumen-2">This wallet holds no outcome tokens or liquidity in this market.</p>
          ) : (
            positions.length > 0 && (
              <ul className="grid gap-2">
                {positions.map((p) => (
                  <PositionRow key={p.outcome} p={p} sym={sym} resolved={resolved} />
                ))}
              </ul>
            )
          )}
          {(positions.length > 0 || lps.length > 0) && <Exits claim={claim} positions={positions} lps={lps} resolved={resolved} />}
          {canFund && <Ladder claim={claim} />}
        </div>
      )}
    </section>
  )
}
