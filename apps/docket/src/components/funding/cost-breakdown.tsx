import type { CostKind, CostLine, FundingPlan } from '@pine/core'
import { formatAmount } from '@pine/core'
import { cn } from '@/lib/cn'

const KIND_ORDER: CostKind[] = ['at_risk', 'spent', 'reserved', 'withdrawable']

export const KIND_META: Record<CostKind, { title: string; plain: string; bar: string }> = {
  at_risk: {
    title: 'Exposed to loss',
    plain: 'Deposited into the market. Its value moves with trading and the outcome, and you can lose part or all of it.',
    bar: 'bg-red',
  },
  spent: {
    title: 'Paid and gone',
    plain: 'Network gas and fees. Not recoverable whatever the outcome.',
    bar: 'bg-ink',
  },
  reserved: {
    title: 'Only if the answer is disputed',
    plain: 'Oracle bonds and arbitration fees. Paid by whoever chooses to answer or escalate, which may be you.',
    bar: 'bg-plum',
  },
  withdrawable: {
    title: 'Withdrawable, not guaranteed',
    plain: 'What you could pull back out. Its value at that moment may be less than you put in.',
    bar: 'bg-slate',
  },
}

const PAYER: Record<CostLine['payer'], string> = {
  you: 'You',
  answerer: 'Whoever answers',
  challenger: 'Whoever challenges',
  platform: 'Pine',
  sponsor: 'Sponsor',
}

/**
 * Every cost line from a FundingPlan, grouped by what happens to the money.
 * Nothing in fine print: payer, estimate flag and whether it counts toward the limit are on every line.
 */
export function CostBreakdown({ plan, className, dense = false }: { plan: FundingPlan; className?: string; dense?: boolean }) {
  const groups = KIND_ORDER.map((k) => ({ kind: k, lines: plan.costs.filter((c) => c.kind === k) })).filter((g) => g.lines.length)
  return (
    <div className={cn('space-y-5', className)}>
      {groups.map((g) => (
        <section key={g.kind} aria-labelledby={`cost-${g.kind}`} className="print-avoid-break">
          <div className="flex items-start gap-3">
            <span aria-hidden className={cn('mt-1 h-5 w-1.5 shrink-0', KIND_META[g.kind].bar)} />
            <div className="min-w-0">
              <h4 id={`cost-${g.kind}`} className="font-bold">
                {KIND_META[g.kind].title}
              </h4>
              {!dense ? <p className="text-sm text-graphite">{KIND_META[g.kind].plain}</p> : null}
            </div>
          </div>
          <ul className="mt-2 divide-y divide-rule border-y border-rule text-[15px]">
            {g.lines.map((l) => (
              <li key={l.key} className="py-2.5">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="font-bold">{l.label}</span>
                  <span className="shrink-0 text-right whitespace-nowrap tabular">
                    {l.estimate ? <span className="text-graphite">about </span> : null}
                    <strong>{formatAmount(l.amount, { symbol: l.currency, maxDecimals: 6 })}</strong>
                  </span>
                </div>
                {!dense ? <p className="mt-0.5 text-sm text-graphite">{l.note}</p> : null}
                <p className="mt-0.5 text-xs text-graphite">
                  Paid by {PAYER[l.payer].toLowerCase()}
                  {!l.countsTowardLimit ? '. Not counted in your spending limit.' : '. Counted in your spending limit.'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** The headline totals of a plan, as a ruled summary. */
export function FundingTotals({ plan, className }: { plan: FundingPlan; className?: string }) {
  const sym = plan.collateral.symbol
  const rows = [
    { k: 'Most you can spend under this plan', v: plan.totals.maxSpend, strong: true, note: 'Counted against your spending limit.' },
    { k: 'Exposed to loss', v: plan.totals.exposedToLoss, tone: 'text-red', note: 'Your liquidity deposit.' },
    { k: 'Not recoverable', v: plan.totals.nonRecoverable, note: 'Gas and fees, gone in any outcome.' },
    { k: 'Withdrawable, at whatever it is worth then', v: plan.totals.withdrawable },
    { k: 'Extra if you answer or escalate a dispute', v: plan.totals.reservedIfDisputed, about: true, note: 'Bonds and the ETH arbitration fee, converted at an estimate. Not counted in your limit unless you choose to fund it.' },
  ]
  return (
    <dl className={cn('divide-y divide-rule border-y-2 border-ink', className)}>
      {rows.map((r) => (
        <div key={r.k} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
          <dt className="min-w-0">
            <span className={cn(r.strong && 'font-bold')}>{r.k}</span>
            {r.note ? <span className="block text-sm text-graphite">{r.note}</span> : null}
          </dt>
          <dd className={cn('text-lg font-bold whitespace-nowrap tabular', r.tone)}>
            {'about' in r && r.about ? <span className="text-base font-normal text-graphite">about </span> : null}
            {formatAmount(r.v, { symbol: sym, maxDecimals: 4 })}
          </dd>
        </div>
      ))}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
        <dt>
          <span className="font-bold">Room left under your limit</span>
          <span className="block text-sm text-graphite">
            Limit {formatAmount(plan.input.spendingLimit, { symbol: sym })}
          </span>
        </dt>
        <dd className={cn('text-lg font-bold tabular', !plan.withinLimit && 'text-red')}>
          {plan.withinLimit ? formatAmount(plan.headroom, { symbol: sym, maxDecimals: 4 }) : 'Over the limit'}
        </dd>
      </div>
    </dl>
  )
}
