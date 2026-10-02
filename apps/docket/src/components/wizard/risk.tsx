'use client'

import type { FundingPlan } from '@pine/core'
import { formatAmount } from '@pine/core'
import { CHAINS } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/field'
import { useAcknowledgements } from '@/lib/ack'

export interface RiskItem {
  id: string
  label: ReactNode
  description: ReactNode
}

export function planSignature(plan: FundingPlan | undefined): string {
  if (!plan) return 'none'
  const t = plan.totals
  return [plan.input.chainId, plan.input.liquidity, plan.input.spendingLimit, t.maxSpend, t.exposedToLoss, t.nonRecoverable].join('|')
}

export function riskItems(plan: FundingPlan, bond?: { minBond?: string; token?: string }): RiskItem[] {
  const sym = plan.collateral.symbol
  const fmt = (v: string) => formatAmount(v, { symbol: sym, maxDecimals: 4 })
  const chain = CHAINS[plan.input.chainId]
  const arb = chain?.arbitration
  return [
    {
      id: 'loss',
      label: <>I may lose part or all of the {fmt(plan.totals.exposedToLoss)} I deposit as liquidity.</>,
      description: 'Its value moves with trading and with the outcome. Concentrated liquidity can end up almost entirely in the losing outcome.',
    },
    {
      id: 'fees',
      label: <>About {fmt(plan.totals.nonRecoverable)} of gas and fees is gone in any outcome.</>,
      description: 'Network gas for creating the market, approving, splitting and adding liquidity. Gas figures are estimates until your wallet shows them.',
    },
    {
      id: 'bonds',
      label: (
        <>
          Oracle bonds and arbitration are paid by whoever answers or escalates, and that may be me.
        </>
      ),
      description: (
        <>
          A first answer needs a bond of at least {bond?.minBond ?? chain?.defaultMinBond ?? '?'} {bond?.token ?? chain?.nativeSymbol ?? ''}. Arbitration
          costs about {arb ? `${formatAmount(arb.feeEstimate)} ${arb.feeCurrency}` : 'a fee'} on Ethereum. Neither is in my spending limit
          unless I budget for it.
        </>
      ),
    },
    {
      id: 'withdraw',
      label: <>My liquidity stays withdrawable, but only at whatever it is worth at the time.</>,
      description: 'Withdrawing early reduces depth for investigators. A withdrawable position is not a guaranteed return.',
    },
    {
      id: 'meaning',
      label: <>Liquidity is not a bounty, and a No outcome is not proof my code is correct.</>,
      description: (
        <>
          {COPY.liquidityIsNotBounty} {COPY.invalidIsNotRefund}
        </>
      ),
    },
    {
      id: 'frozen',
      label: <>The terms freeze when the market is created.</>,
      description: COPY.frozenTerms,
    },
  ]
}

export function RiskAcknowledgement({ draftId, plan, bond }: { draftId: string; plan: FundingPlan; bond?: { minBond?: string; token?: string } }) {
  const items = riskItems(plan, bond)
  const ack = useAcknowledgements(draftId, planSignature(plan))
  return (
    <fieldset className="space-y-4">
      <legend className="sr-only">Risk acknowledgements</legend>
      {items.map((it) => (
        <div key={it.id} className="border-b border-rule pb-4 last:border-b-0">
          <Checkbox
            id={`ack-${it.id}`}
            checked={ack.has(it.id)}
            onChange={(e) => ack.toggle(it.id, e.target.checked)}
            label={it.label}
            description={it.description}
          />
        </div>
      ))}
      <p className="text-sm text-graphite" aria-live="polite">
        {ack.items.length} of {items.length} acknowledged. Changing any amount clears these, so you always confirm the numbers you will
        actually spend.
      </p>
    </fieldset>
  )
}
