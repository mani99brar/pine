'use client'

import { useMemo, useState } from 'react'
import { Slider as RSlider } from 'radix-ui'
import type { ClaimDraft, CostLine, DepthSnapshot, FundingPlan } from '@pine/core'
import { estimateFunding, formatAmount, formatPrice } from '@pine/core'
import { SUPPORTED_CHAIN_IDS, getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ClaimComposer } from '@pine/react'
import { AlertTriangle, Lock } from 'lucide-react'
import { Slider, Switch } from '@/components/ui/interactive'
import { Field, Input, Select } from '@/components/ui/form'
import { Note } from '@/components/ui/primitives'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { DepthBars } from '@/components/glyphs/DepthBars'
import { depthByBand } from '@/lib/depth'
import { StageHeader, StageIssues, StageNav } from './shared'
import { cn } from '@/lib/cn'

const LIQ_MIN = 1
const LIQ_MAX = 5000

function liqToSlider(v: number): number {
  const x = Math.max(LIQ_MIN, Math.min(LIQ_MAX, v || LIQ_MIN))
  return (Math.log10(x) / Math.log10(LIQ_MAX)) * 100
}
function sliderToLiq(s: number): number {
  const raw = 10 ** ((s / 100) * Math.log10(LIQ_MAX))
  const mag = raw < 10 ? 1 : raw < 100 ? 5 : raw < 1000 ? 25 : 100
  return Math.max(LIQ_MIN, Math.round(raw / mag) * mag)
}

/** A rough depth book for a uniform concentrated position over [lo, hi] starting at p. */
export function previewDepth(liquidity: number, p: number, lo: number, hi: number): DepthSnapshot {
  const half = liquidity / 2
  const levels: DepthSnapshot['levels'] = []
  for (const b of [0.01, 0.02, 0.05, 0.1, 0.2, 0.4]) {
    const askP = Math.min(0.99, p + b)
    const bidP = Math.max(0.01, p - b)
    const askFrac = hi > p ? Math.min(1, Math.max(0, (Math.min(askP, hi) - p) / (hi - p))) : 0
    const bidFrac = p > lo ? Math.min(1, Math.max(0, (p - Math.max(bidP, lo)) / (p - lo))) : 0
    levels.push({ price: askP, size: (half * askFrac) / askP, side: 'ask' })
    levels.push({ price: bidP, size: (half * bidFrac) / Math.max(0.01, bidP), side: 'bid' })
  }
  return { outcome: 'yes', mid: p, levels, at: new Date(0).toISOString() }
}

const KIND_STYLE: Record<CostLine['kind'], { label: string; swatch: string; help: string }> = {
  spent: { label: 'Spent', swatch: 'bg-ink', help: 'Paid and gone: gas and fees.' },
  at_risk: { label: 'At risk', swatch: 'bg-[repeating-linear-gradient(-45deg,var(--ink)_0_2px,var(--fog-2)_2px_6px)]', help: 'Your deposit. Its value moves with trading and the outcome.' },
  reserved: { label: 'Reserved', swatch: 'border-[1.5px] border-dotted border-ink bg-sheet', help: 'Only spent if a condition occurs (answering, arbitration).' },
  withdrawable: { label: 'Withdrawable', swatch: 'border-b-[3px] border-ink', help: 'Can be withdrawn at market value, not guaranteed.' },
}

/** The budget bar: spent + at risk against your spending limit, with headroom and the limit marked. */
function BudgetBar({ plan, symbol }: { plan: FundingPlan; symbol: string }) {
  const limit = Number(plan.input.spendingLimit) || 0
  const spent = Number(plan.totals.nonRecoverable) || 0
  const atRisk = Number(plan.totals.exposedToLoss) || 0
  const maxSpend = Number(plan.totals.maxSpend) || 0
  const scale = Math.max(limit, maxSpend, 1)
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / scale) * 100))}%`
  const over = maxSpend > limit
  return (
    <figure aria-label={`Budget: ${formatAmount(maxSpend, { maxDecimals: 2 })} of ${formatAmount(limit, { maxDecimals: 2 })} ${symbol} spending limit used`}>
      <div className="relative h-9">
        <div className="absolute inset-0 rounded-[3px] border-[1.5px] border-dashed border-line-strong" />
        <div className="absolute inset-y-0 left-0 rounded-l-[3px] bg-ink" style={{ width: pct(spent) }} />
        <div
          className="absolute inset-y-0 bg-[repeating-linear-gradient(-45deg,var(--ink)_0_2px,var(--fog-2)_2px_7px)]"
          style={{ left: pct(spent), width: pct(atRisk) }}
        />
        {over && <div className="absolute inset-y-0 bg-flare/80 hatch-yes" style={{ left: pct(limit), right: 0 }} />}
        <div className="absolute -bottom-2 -top-2 w-[3px] -translate-x-1/2 bg-lumen shadow-[0_0_0_1.5px_var(--ink)]" style={{ left: pct(limit) }} />
      </div>
      <div className="relative mt-3 h-14 text-[0.75rem] sm:h-10">
        <span className="absolute left-0 top-0 text-ink-3">0</span>
        <span
          className={cn('absolute top-0 whitespace-nowrap font-[650]', limit / scale > 0.8 ? '-translate-x-full text-right' : '-translate-x-1/2 text-center')}
          style={{ left: pct(limit) }}
        >
          Limit {formatAmount(limit, { maxDecimals: 2 })} {symbol}
        </span>
        <span className="absolute top-4 h-3 border-x-[1.5px] border-b-[1.5px] border-ink" style={{ left: pct(spent), width: pct(atRisk) }} aria-hidden />
        <span className="absolute right-0 top-[2.15rem] text-ink-2" style={{ left: pct(spent) }}>
          deposit is withdrawable at market value, not guaranteed
        </span>
      </div>
    </figure>
  )
}

function RangeSlider({ value, onChange, label }: { value: [number, number]; onChange: (v: [number, number]) => void; label: string }) {
  return (
    <RSlider.Root
      className="relative flex h-8 w-full touch-none select-none items-center"
      value={[value[0] * 100, value[1] * 100]}
      min={1}
      max={99}
      step={1}
      minStepsBetweenThumbs={5}
      onValueChange={(v) => onChange([(v[0] ?? 2) / 100, (v[1] ?? 80) / 100])}
      aria-label={label}
    >
      <RSlider.Track className="relative h-[6px] grow rounded-full bg-fog-2 shadow-[inset_0_0_0_1px_var(--line)]">
        <RSlider.Range className="absolute h-full rounded-full bg-ink" />
      </RSlider.Track>
      {[0, 1].map((i) => (
        <RSlider.Thumb
          key={i}
          aria-label={i === 0 ? 'Low end of the price range' : 'High end of the price range'}
          className="block h-6 w-3 rounded-[3px] border-2 border-sheet bg-ink shadow-[0_0_0_1.5px_var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1.5px_var(--ink),0_0_0_5px_var(--lumen)]"
        />
      ))}
    </RSlider.Root>
  )
}

export function StageFunding({ c }: { c: ClaimComposer }) {
  const f = c.fundingInput
  const chain = getChainOrDefault(f.chainId)
  const symbol = chain.collateral.symbol
  const [selfAnswer, setSelfAnswer] = useState(false)
  const [budgetDispute, setBudgetDispute] = useState(false)
  const plan = useMemo(() => estimateFunding(f, { selfAnswer, includeDisputeCosts: budgetDispute }), [f, selfAnswer, budgetDispute])
  const liq = Number(f.liquidity) || 0
  const depth = useMemo(() => previewDepth(liq, f.initialYesPrice, f.priceRange[0], f.priceRange[1]), [liq, f.initialYesPrice, f.priceRange])
  const within5 = depthByBand(depth, [0.05])[0] ?? 0
  const disabled = c.fundingFrozen

  const setFunding = (patch: Partial<ClaimDraft['funding']>) =>
    c.update((d: ClaimDraft) => ({ ...d, funding: { ...d.funding, ...patch } }))

  const groups = (['spent', 'at_risk', 'reserved'] as const).map((k) => ({ kind: k, lines: plan.costs.filter((l) => l.kind === k) }))

  return (
    <div>
      <StageHeader stage="funding">
        Liquidity lets people trade on the question, which is what makes the price informative. It is your capital at risk, not a bounty, and nobody is promised a payment.
      </StageHeader>

      {disabled && (
        <Note className="mb-6" icon={<Lock size={15} aria-hidden />}>
          A funding step has already confirmed, so funding can no longer change for this publication.
        </Note>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Inputs */}
        <div className="grid content-start gap-7">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="liq-input" className="t-h3">
                Liquidity
              </label>
              <span className="flex items-baseline gap-2">
                <Input
                  id="liq-input"
                  inputMode="decimal"
                  value={f.liquidity}
                  disabled={disabled}
                  onChange={(e) => setFunding({ liquidity: e.target.value.replace(',', '.') })}
                  className="t-figure h-11 w-28 text-right text-[1.4rem]"
                  aria-describedby="liq-help"
                />
                <span className="font-[650]">{symbol}</span>
              </span>
            </div>
            <Slider
              value={liqToSlider(liq)}
              onChange={(s) => setFunding({ liquidity: String(sliderToLiq(s)) })}
              min={0}
              max={100}
              step={0.5}
              label="Liquidity"
              valueText={`${formatAmount(liq, { maxDecimals: 2 })} ${symbol}`}
              className="mt-2"
            />
            <p id="liq-help" className="flex justify-between text-[0.72rem] text-ink-3">
              <span>1</span>
              <span>{formatAmount(LIQ_MAX, { compact: true })}</span>
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Spending limit" htmlFor="limit" help={COPY.spendingLimit} error={!plan.withinLimit && Number(f.spendingLimit) > 0 ? 'The plan exceeds this limit.' : undefined}>
              <div className="flex items-center gap-2">
                <Input id="limit" inputMode="decimal" value={f.spendingLimit} disabled={disabled} onChange={(e) => setFunding({ spendingLimit: e.target.value.replace(',', '.') })} className="t-figure text-right text-[1.15rem]" />
                <span className="font-[650]">{symbol}</span>
              </div>
            </Field>
            <Field label="Chain" htmlFor="chain" help={`Collateral ${symbol}; gas and bonds in ${chain.nativeSymbol}.`}>
              <Select id="chain" value={String(f.chainId)} disabled={disabled || c.frozen} onChange={(e) => setFunding({ chainId: Number(e.target.value) })}>
                {SUPPORTED_CHAIN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {getChainOrDefault(id).name}
                    {getChainOrDefault(id).testnet ? ' (testnet)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <p className="t-h3">Starting price</p>
              <span className="t-figure text-[1.4rem] text-flare-ink">{formatPrice(f.initialYesPrice)}</span>
            </div>
            <p className="text-[0.84rem] text-ink-2">Where the knot starts: your opening view of the chance a qualifying counterexample is accepted.</p>
            <Slider
              value={Math.round(f.initialYesPrice * 100)}
              onChange={(v) => setFunding({ initialYesPrice: v / 100 })}
              min={1}
              max={95}
              step={1}
              label="Initial Yes price"
              valueText={formatPrice(f.initialYesPrice)}
              tone="flare"
              className="mt-2"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <p className="t-h3">Liquidity range</p>
              <span className="t-figure text-[1.1rem]">
                {formatPrice(f.priceRange[0])} to {formatPrice(f.priceRange[1])}
              </span>
            </div>
            <p className="text-[0.84rem] text-ink-2">Your liquidity only provides depth while the price stays inside this band.</p>
            <RangeSlider value={f.priceRange} onChange={(v) => setFunding({ priceRange: v })} label="Liquidity price range" />
          </div>

          <div className="grid gap-4 rounded-[var(--radius-tile)] border border-line bg-sheet p-4">
            <p className="text-[0.84rem] font-[650]">For your own budgeting</p>
            <Switch id="self-answer" checked={selfAnswer} onChange={setSelfAnswer} label="I will post the first oracle answer myself" description={`Counts the ${chain.defaultMinBond} ${chain.nativeSymbol} minimum bond toward your limit.`} />
            <Switch
              id="budget-dispute"
              checked={budgetDispute}
              onChange={setBudgetDispute}
              label="Budget for a possible arbitration fee"
              description={`About ${chain.arbitration.feeEstimate} ${chain.arbitration.feeCurrency}, paid on ${getChainOrDefault(chain.arbitration.chainId).name} only if you request arbitration.`}
            />
          </div>
        </div>

        {/* Live breakdown */}
        <div className="grid content-start gap-6">
          <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5" aria-labelledby="budget-title" aria-live="polite">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="budget-title" className="t-h3">
                Against your limit
              </h3>
              <p className={cn('text-[0.88rem]', plan.withinLimit ? 'text-ink-2' : 'font-[650] text-flare-ink')}>
                {plan.withinLimit ? (
                  <>
                    <span className="t-figure text-[1.15rem] text-ink">{formatAmount(plan.headroom, { maxDecimals: 2 })}</span> {symbol} headroom
                  </>
                ) : (
                  'Over the limit'
                )}
              </p>
            </div>
            <div className="mt-5">
              <BudgetBar plan={plan} symbol={symbol} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <div>
                <dt className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  <span aria-hidden className={cn('h-2.5 w-2.5', KIND_STYLE.spent.swatch)} /> Spent
                </dt>
                <dd className="t-figure mt-0.5 text-[1.15rem]">{formatAmount(plan.totals.nonRecoverable, { maxDecimals: 4 })}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  <span aria-hidden className={cn('h-2.5 w-2.5', KIND_STYLE.at_risk.swatch)} /> At risk
                </dt>
                <dd className="t-figure mt-0.5 text-[1.15rem]">{formatAmount(plan.totals.exposedToLoss, { maxDecimals: 2 })}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  <span aria-hidden className={cn('h-2.5 w-2.5', KIND_STYLE.reserved.swatch)} /> Reserved if disputed
                </dt>
                <dd className="t-figure mt-0.5 text-[1.15rem]">{formatAmount(plan.totals.reservedIfDisputed, { maxDecimals: 2 })}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-[0.75rem] text-ink-3">
                  <span aria-hidden className={cn('h-2.5 w-2.5', KIND_STYLE.withdrawable.swatch)} /> Withdrawable
                </dt>
                <dd className="t-figure mt-0.5 text-[1.15rem]">{formatAmount(plan.totals.withdrawable, { maxDecimals: 2 })}</dd>
              </div>
            </dl>
            <p className="mt-2 text-[0.75rem] text-ink-3">
              Totals in {symbol}. Gas and bonds in {chain.nativeSymbol}, and the {chain.arbitration.feeEstimate} {chain.arbitration.feeCurrency} arbitration fee, are converted at deliberately conservative rates, so
              &ldquo;reserved if disputed&rdquo; is an upper bound. Neither counts toward your limit unless you opt in below.
            </p>
          </section>

          <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5" aria-labelledby="buys-title">
            <h3 id="buys-title" className="t-h3">
              What this liquidity buys
            </h3>
            <p className="mt-1 text-[0.84rem] text-ink-2">A rough preview of executable depth if the market opened at your starting price.</p>
            <TensionBar yes={f.initialYesPrice} className="mt-5" />
            <div className="relative mt-2 h-4" aria-hidden>
              <span
                className="absolute top-0 h-3 border-x-[1.5px] border-b-[1.5px] border-ink-3"
                style={{ left: `calc(3px + (100% - 6px) * ${f.priceRange[0]})`, width: `calc((100% - 6px) * ${f.priceRange[1] - f.priceRange[0]})` }}
              />
            </div>
            <p className="text-[0.75rem] text-ink-3">Bracket: your liquidity range.</p>
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <DepthBars depth={depth} symbol={symbol} size="lg" caption={false} />
              <p className="text-[0.9rem] text-ink-2">
                About <span className="t-figure text-[1.35rem] text-ink">{formatAmount(within5, { maxDecimals: 0 })}</span> {symbol} tradable within 5 pts of the starting price.
              </p>
            </div>
          </section>

          <section aria-labelledby="lines-title">
            <h3 id="lines-title" className="sr-only">
              Cost lines
            </h3>
            <p className="mb-2 text-[0.84rem] font-[650]">Every cost line, who pays it, and whether it counts toward your limit</p>
            {groups.map((g) => (
              <details key={g.kind} open={g.kind !== 'spent'} className="group mt-2 rounded-[var(--radius-tile)] border border-line bg-sheet first:mt-0">
                <summary className="flex list-none items-center gap-2 px-3.5 py-2.5 text-[0.84rem] font-[650] [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0', KIND_STYLE[g.kind].swatch)} />
                  {KIND_STYLE[g.kind].label}
                  <span className="min-w-0 truncate font-[450] text-ink-3">{KIND_STYLE[g.kind].help}</span>
                  <span className="ml-auto shrink-0 text-[0.78rem] font-[550] text-ink-3">
                    {g.lines.length} {g.lines.length === 1 ? 'line' : 'lines'}
                    <span aria-hidden className="ml-1.5 inline-block transition-transform group-open:rotate-90">›</span>
                  </span>
                </summary>
                <ul className="divide-y divide-line border-t border-line">
                  {g.lines.map((l) => (
                    <li key={l.key} className="grid grid-cols-[1fr_auto] gap-x-4 px-3.5 py-2.5 text-[0.84rem]">
                      <span className="font-[600]">
                        {l.label}
                        {l.estimate && <span className="ml-1.5 text-[0.72rem] font-[500] text-ink-3">estimate</span>}
                      </span>
                      <span className="text-right">
                        <span className="t-figure text-[1rem]">{formatAmount(l.amount, { maxDecimals: 5 })}</span> <span className="text-ink-3">{l.currency}</span>
                      </span>
                      <span className="col-span-2 mt-0.5 text-[0.78rem] text-ink-3">
                        Paid by {l.payer === 'you' ? 'you' : l.payer}. {l.countsTowardLimit ? 'Counts toward your limit.' : 'Not in your limit.'} {l.note}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>

          {plan.warnings.length > 0 && (
            <div className="rounded-[var(--radius-tile)] border-l-[3px] border-lumen bg-lumen-wash px-4 py-3">
              <p className="flex items-center gap-1.5 text-[0.84rem] font-[650]">
                <AlertTriangle size={14} aria-hidden /> Worth knowing
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-[0.84rem] text-ink-2">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <Note tone="boundary" className="mt-8" title="Liquidity is not a bounty">
        {COPY.liquidityIsNotBounty} {COPY.exactApproval}
      </Note>

      <StageIssues c={c} stage="funding" className="mt-6" />
      <StageNav c={c} />
    </div>
  )
}
