'use client'

import { useState } from 'react'
import type { Address } from '@pine/core'
import { formatAmount, fromScaled, toScaled } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useApiFunding, useWallet } from '@pine/react'
import { Button } from '@/components/ui/Button'
import { FormField, Notice } from '@/components/ui/primitives'
import { TxSteps } from '@/components/tx/TxSteps'
import { WriteErrorNotice } from './WriteError'

// Optional liquidity after the claim is confirmed (api mode): a YES sell-ladder that Pine computes. The figures come
// first (no plan is built), the user acknowledges the maximum loss, then the plan is verified in the browser (value equal
// to the budget, approvals only to the position manager for this market's YES token and within the spending limit).

const XDAI = 18
const PRICE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,18})?$/
const MAX_BUDGET = 10_000n * 10n ** 18n

function wei(value: string): bigint | null {
  const v = value.trim()
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  const s = toScaled(v, XDAI)
  return s && s.exact ? s.value : null
}

const xdai = (w: string) => (/^\d+$/.test(w) ? formatAmount(fromScaled(BigInt(w), XDAI), { maxDecimals: 4 }) : '—')

function inputProblem(budget: bigint | null, limit: bigint | null, lower: string, upper: string): string | null {
  if (budget === null || budget <= 0n) return 'Enter a budget in xDAI, for example 25.'
  if (budget > MAX_BUDGET) return 'Pine builds ladders of at most 10,000 xDAI.'
  if (limit === null || limit <= 0n) return 'Enter your spending limit in xDAI.'
  if (budget > limit) return 'The budget is above your spending limit. Lower the budget or raise the limit.'
  if (!PRICE.test(lower) || !PRICE.test(upper)) return 'Enter the YES prices as decimals, for example 0.05 and 0.5.'
  const lo = toScaled(lower, XDAI)?.value ?? -1n
  const hi = toScaled(upper, XDAI)?.value ?? -1n
  if (lo < 10n ** 16n || hi > 95n * 10n ** 16n || lo >= hi) return 'Choose a YES price range with 0.01 ≤ lower < upper ≤ 0.95.'
  return null
}

export function ApiLadder({ market, defaultLimit }: { market: Address; defaultLimit: string }) {
  const f = useApiFunding(market)
  const wallet = useWallet()
  const [budget, setBudget] = useState('')
  const [lower, setLower] = useState('0.05')
  const [upper, setUpper] = useState('0.5')
  const [limit, setLimit] = useState(defaultLimit)
  const quote = f.quote
  // The acknowledgement belongs to one set of figures: new figures (also when Pine refreshed them because the loss
  // grew) need a new one.
  const quoteKey = quote ? `${quote.budgetWei}|${quote.maxLossIfYesShares}|${quote.finalLowerPrice}|${quote.finalUpperPrice}` : ''
  const [acceptedKey, setAcceptedKey] = useState('')
  const accepted = quoteKey !== '' && acceptedKey === quoteKey

  const budgetWei = wei(budget)
  const limitWei = wei(limit)
  const problem = inputProblem(budgetWei, limitWei, lower.trim(), upper.trim())
  const steps = f.runner.runner.steps
  const running = f.runner.runner.state === 'running' || f.runner.phase === 'planning'
  const done = f.plan?.state === 'confirmed' || f.runner.runner.state === 'done'
  const matches = quote && budgetWei !== null && quote.budgetWei === budgetWei.toString() && quote.requestedLowerPrice === lower.trim() && quote.requestedUpperPrice === upper.trim()

  return (
    <section aria-labelledby="ladder-title" className="glass cut-xl p-5 sm:p-6">
      <h3 id="ladder-title" className="t-h3">
        Add liquidity <span className="text-[0.9rem] font-normal text-lumen-3">optional</span>
      </h3>
      <p className="mt-2 max-w-[64ch] text-[0.9375rem] leading-[1.55] text-lumen-2">
        A YES ladder sells YES between two prices so the market can trade. Pine computes the amounts and the maximum loss; nothing reaches your wallet until you
        accept that loss. {COPY.liquidityIsNotBounty}
      </p>
      {done ? (
        <Notice tone="info" className="mt-5" title="Liquidity added">
          Your position is in your wallet. Withdraw it from the claim page whenever you want.
        </Notice>
      ) : (
        <>
          <form
            className="mt-5 grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!problem && budgetWei !== null) void f.quoteLadder({ budgetWei, lowerPrice: lower.trim(), upperPrice: upper.trim() })
            }}
          >
            <FormField id="ladder-budget" label="Budget (xDAI)" help="xDAI split into outcome tokens for the ladder.">
              <input id="ladder-budget" className="field tnum" inputMode="decimal" value={budget} disabled={running} onChange={(e) => setBudget(e.target.value.replace(',', '.'))} placeholder="25" />
            </FormField>
            <FormField id="ladder-limit" label="Spending limit (xDAI)" help="A hard cap: the budget and every approval must stay within it.">
              <input id="ladder-limit" className="field tnum" inputMode="decimal" value={limit} disabled={running} onChange={(e) => setLimit(e.target.value.replace(',', '.'))} />
            </FormField>
            <FormField id="ladder-lower" label="Lowest YES price" help="At least 0.01.">
              <input id="ladder-lower" className="field tnum" inputMode="decimal" value={lower} disabled={running} onChange={(e) => setLower(e.target.value.replace(',', '.'))} />
            </FormField>
            <FormField id="ladder-upper" label="Highest YES price" help="At most 0.95.">
              <input id="ladder-upper" className="field tnum" inputMode="decimal" value={upper} disabled={running} onChange={(e) => setUpper(e.target.value.replace(',', '.'))} />
            </FormField>
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <Button type="submit" variant="glass" disabled={Boolean(problem) || f.busy} loading={f.busy && !running}>
                Get the figures
              </Button>
              <p className="text-[0.84375rem] text-lumen-2" role="status" aria-live="polite">
                {budget ? (problem ?? '') : 'Pine asks for nothing until you request the figures.'}
              </p>
            </div>
          </form>

          {quote && (
            <div className="cut-lg well mt-5 p-4" aria-live="polite">
              <p className="text-[0.8125rem] text-lumen-3">Pine&apos;s figures for this ladder</p>
              <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(10rem,max-content)_1fr]">
                <dt className="text-[0.84375rem] text-lumen-3">Budget</dt>
                <dd className="tnum text-lumen">{xdai(quote.budgetWei)} xDAI</dd>
                <dt className="text-[0.84375rem] text-lumen-3">YES price range</dt>
                <dd className="tnum text-lumen">
                  {quote.finalLowerPrice} to {quote.finalUpperPrice} <span className="text-lumen-3">(rounded to the pool&apos;s ticks)</span>
                </dd>
                <dt className="text-[0.84375rem] text-lumen-3">Maximum loss if Yes</dt>
                <dd className="tnum font-semibold text-ha">{xdai(quote.maxLossIfYesXdaiWei)} xDAI</dd>
              </dl>
              <label className="mt-4 flex items-start gap-3 border-t border-edge pt-4">
                <input type="checkbox" className="facet-check" checked={accepted} disabled={running || !matches} onChange={(e) => setAcceptedKey(e.target.checked ? quoteKey : '')} />
                <span className="text-[0.9rem] text-lumen">I accept losing up to {xdai(quote.maxLossIfYesXdaiWei)} xDAI if the outcome is Yes.</span>
              </label>
              {!matches && <p className="mt-2 text-[0.8125rem] text-na">You changed the budget or prices: get the figures again.</p>}
              <Button
                className="mt-4"
                disabled={!accepted || !matches || limitWei === null || running || !wallet.isConnected}
                loading={running}
                onClick={() => limitWei !== null && void f.fund({ quote, spendingLimitWei: limitWei })}
              >
                Add liquidity
              </Button>
            </div>
          )}
        </>
      )}

      {steps.length > 0 && (
        <div className="mt-6">
          <h4 className="t-h4 mb-4">Liquidity steps</h4>
          <TxSteps runner={f.runner.runner} chainId={100} />
        </div>
      )}
      {f.plan?.recovery && (
        <Notice tone="caution" className="mt-4" title="If a step failed">
          <span className="untrusted [white-space:normal]">{f.plan.recovery}</span>
        </Notice>
      )}
      {f.error && <WriteErrorNotice className="mt-4" error={f.error} />}
    </section>
  )
}
