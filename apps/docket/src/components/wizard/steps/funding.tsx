'use client'

import type { FundingInput } from '@pine/core'
import { formatAmount } from '@pine/core'
import { CHAINS, SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useWallet } from '@pine/react'
import { Field, Input, MarginNote, Select } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { CostBreakdown, FundingTotals } from '@/components/funding/cost-breakdown'
import { useWizard } from '../context'

export function FundingStep() {
  const { composer, errorFor } = useWizard()
  const f = composer.fundingInput
  const plan = composer.funding
  const wallet = useWallet()
  const frozen = composer.fundingFrozen
  const set = (patch: Partial<FundingInput>) => composer.update({ funding: patch })
  const sym = plan?.collateral.symbol ?? CHAINS[f.chainId]?.collateral.symbol ?? 'sDAI'
  const pct = Math.round((f.initialYesPrice ?? 0.15) * 100)

  return (
    <fieldset disabled={frozen} className="min-w-0 space-y-8">
      {frozen ? (
        <Notice tone="neutral" title="Funding is underway">
          A funding transaction has already confirmed, so these amounts can no longer change.
        </Notice>
      ) : null}

      <Field
        id="f-chain"
        label="Chain"
        hint="Where the market, its pools and the oracle live."
        error={errorFor('funding.chainId')}
        guidance={
          <>
            <p>Gnosis is the default: gas is cheap and Seer markets there use sDAI as collateral.</p>
            <p>Arbitration and exhibits always happen on Ethereum, whichever chain you choose.</p>
          </>
        }
      >
        <Select id="f-chain" value={String(f.chainId)} onChange={(e) => set({ chainId: Number(e.target.value) })} className="max-w-xs">
          {SUPPORTED_CHAIN_IDS.map((id) => (
            <option key={id} value={id}>
              {CHAINS[id]?.name ?? id}
              {CHAINS[id] && !CHAINS[id]!.verified ? ' (unverified)' : ''}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id="f-liquidity"
        label="Liquidity to deposit"
        hint={`In ${sym}. This becomes outcome tokens and pool positions.`}
        error={errorFor('funding.liquidity')}
        guidance={
          <>
            <p>
              <strong>This is capital at risk.</strong> Its value moves with trading and the outcome. You can lose part or all of it.
            </p>
            <p>{COPY.liquidityIsNotBounty}</p>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input id="f-liquidity" inputMode="decimal" className="w-44" value={f.liquidity} aria-invalid={!!errorFor('funding.liquidity')} onChange={(e) => set({ liquidity: e.target.value.trim() })} />
          <span className="font-bold">{sym}</span>
        </div>
      </Field>

      <Field
        id="f-limit"
        label="Spending limit"
        hint="The most this filing may spend in total, including gas and fees."
        error={errorFor('funding.spendingLimit')}
        guidance={
          <>
            <p>{COPY.spendingLimit}</p>
            <p>Any step that would go over the limit is blocked before your wallet is asked to sign.</p>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input id="f-limit" inputMode="decimal" className="w-44" value={f.spendingLimit} aria-invalid={!!errorFor('funding.spendingLimit')} onChange={(e) => set({ spendingLimit: e.target.value.trim() })} />
          <span className="font-bold">{sym}</span>
        </div>
      </Field>

      <Field
        id="f-price"
        label="Starting implied chance"
        hint="Where the Yes price starts. Traders move it from there."
        error={errorFor('funding.initialYesPrice')}
        guidance={
          <>
            <p>Your own estimate of how likely a qualifying counterexample is. A low start means investigators who find one can buy Yes cheaply.</p>
            <p>It is not a statement about code quality.</p>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-4">
          <input
            id="f-price"
            type="range"
            min={1}
            max={99}
            value={pct}
            onChange={(e) => set({ initialYesPrice: Number(e.target.value) / 100 })}
            className="w-64 max-w-full accent-[var(--color-violet)]"
            aria-valuetext={`${pct} percent`}
          />
          <span className="text-2xl font-[800] tabular">{pct}%</span>
        </div>
      </Field>

      <Field
        id="f-range-lo"
        label="Price band for your liquidity"
        hint="Concentrated liquidity only trades inside this band."
        error={errorFor('funding.priceRange')}
        guidance={
          <p>
            A narrow band gives deeper markets near the start price, but if the price leaves the band your position ends up almost
            entirely in one outcome.
          </p>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="f-range-lo"
            aria-label="Low end, percent"
            inputMode="decimal"
            className="w-24"
            value={String(Math.round(f.priceRange[0] * 100))}
            onChange={(e) => set({ priceRange: [Number(e.target.value) / 100, f.priceRange[1]] })}
          />
          <span>% to</span>
          <Input
            aria-label="High end, percent"
            inputMode="decimal"
            className="w-24"
            value={String(Math.round(f.priceRange[1] * 100))}
            onChange={(e) => set({ priceRange: [f.priceRange[0], Number(e.target.value) / 100] })}
          />
          <span>%</span>
        </div>
      </Field>

      {plan ? (
        <div className="grid gap-x-10 gap-y-8 border-t-2 border-ink pt-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h3 className="text-xl">What this plan costs</h3>
            <p className="mt-1 text-[15px] text-graphite">Every line is computed from the amounts above. Estimates are marked.</p>
            <FundingTotals plan={plan} className="mt-4" />
            {!plan.withinLimit ? (
              <Notice tone="critical" title="This plan goes over your spending limit" className="mt-4">
                Raise the limit to at least {formatAmount(plan.totals.maxSpend, { symbol: sym, maxDecimals: 4 })}, or lower the liquidity.
              </Notice>
            ) : null}
            {plan.warnings.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {plan.warnings.map((w) => (
                  <li key={w} className="border-l-4 border-wheat-line bg-wheat px-3 py-2 text-[15px]">
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}
            {wallet.balance && Number(wallet.balance.amount) < Number(plan.totals.maxSpend) ? (
              <p className="mt-4 text-[15px] text-ochre">
                The connected wallet holds {formatAmount(wallet.balance.amount, { symbol: wallet.balance.symbol, maxDecimals: 2 })}, less
                than this plan needs.
              </p>
            ) : null}
          </div>
          <div>
            <h3 className="text-xl">Line by line</h3>
            <CostBreakdown plan={plan} className="mt-4" />
          </div>
        </div>
      ) : null}

      <aside className="lg:hidden">
        <MarginNote title="Withdrawing later">
          <p>Liquidity stays withdrawable by default. Withdrawing returns what the position is worth then, which may be less than you put in.</p>
        </MarginNote>
      </aside>
    </fieldset>
  )
}
