'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChevronRight, Snowflake, Wallet } from 'lucide-react'
import type { CostKind } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { formatAmount, formatDate, shortSha } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import type { PublishClaim } from '@pine/react'
import { useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { readLocal, writeLocal } from '@/lib/storage'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox, Field, Input } from '@/components/ui/field'
import { PriceGauge } from '@/components/ui/instruments'
import { DataList } from '@/components/ui/pane'
import { TxLog } from '@/components/ui/tx-log'
import { useComposerCtx, fieldId, sectionForPath, SECTIONS } from './context'
import { Section } from './section'

const KIND: Record<CostKind, { label: string; cls: string }> = {
  spent: { label: 'Spent', cls: 'text-bark border-line-strong' },
  at_risk: { label: 'At risk', cls: 'text-flare border-flare/40' },
  reserved: { label: 'Only if disputed', cls: 'text-violet border-violet/40' },
  withdrawable: { label: 'Withdrawable', cls: 'text-slate border-slate/40' },
}

/** Graduated meter of the plan's maximum spend against the spending limit. */
function LimitMeter({ spend, limit, symbol }: { spend: number; limit: number; symbol: string }) {
  const cap = Math.max(limit, spend, 1)
  const ticks = 40
  const spendFrac = spend / cap
  const limitFrac = limit / cap
  const over = spend > limit
  return (
    <div>
      <div className="relative h-6" aria-hidden>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const f = i / ticks
          const filled = f <= spendFrac
          return (
            <span
              key={i}
              className={cn('absolute bottom-0 w-px', filled ? (f > limitFrac ? 'bg-flare' : 'bg-bark') : 'bg-line-strong')}
              style={{ left: `${f * 100}%`, height: i % 5 === 0 ? 14 : 8 }}
            />
          )
        })}
        <span className="absolute -top-0.5 bottom-0 w-[2px] -translate-x-1/2 bg-needle" style={{ left: `${limitFrac * 100}%` }} />
        <span className="absolute -top-0.5 bottom-0 w-[3px] -translate-x-1/2 rounded-full bg-resin-fill" style={{ left: `${spendFrac * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11.5px] text-muted">
        <span className="tnum">0</span>
        <span className={cn('tnum font-medium', over ? 'text-flare' : 'text-bark')}>
          max spend {formatAmount(String(spend), { symbol, maxDecimals: 4 })} of limit {formatAmount(String(limit), { symbol })}
        </span>
      </div>
    </div>
  )
}

export function FundingSection() {
  const { c, err, touch } = useComposerCtx()
  const f = c.fundingInput
  const plan = c.funding
  const chain = getChainOrDefault(f.chainId)
  const sym = plan?.collateral.symbol ?? chain.collateral.symbol
  const frozen = c.fundingFrozen
  const setF = (patch: Partial<typeof f>) => c.update((d) => ({ ...d, funding: { ...d.funding, ...patch } }))
  const pct = (n: number) => String(Math.round(n * 1000) / 10)
  return (
    <Section
      id="funding"
      index={6}
      title="Funding"
      description={COPY.liquidityIsNotBounty}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Field label={`Liquidity (${sym})`} htmlFor={fieldId('funding.liquidity')} required error={err('funding.liquidity')} hint="Collateral you deposit into the outcome pools. It is capital at risk.">
          <Input id={fieldId('funding.liquidity')} inputMode="decimal" className="tnum" value={c.draft.funding?.liquidity ?? ''} disabled={frozen} onBlur={() => touch('funding.liquidity')} onChange={(e) => setF({ liquidity: e.target.value })} />
        </Field>
        <Field label={`Spending limit (${sym})`} htmlFor={fieldId('funding.spendingLimit')} required error={err('funding.spendingLimit')} hint="Every step is checked against it. Approvals are for the exact amount, never unlimited.">
          <Input id={fieldId('funding.spendingLimit')} inputMode="decimal" className="tnum" value={c.draft.funding?.spendingLimit ?? ''} disabled={frozen} onBlur={() => touch('funding.spendingLimit')} onChange={(e) => setF({ spendingLimit: e.target.value })} />
        </Field>
        <Field label="Initial YES price (%)" htmlFor={fieldId('funding.initialYesPrice')} error={err('funding.initialYesPrice')} hint="Where liquidity is centered. It is your starting estimate, not a claim about the code.">
          <div className="flex items-center gap-3">
            <Input
              id={fieldId('funding.initialYesPrice')}
              inputMode="decimal"
              className="tnum w-24"
              value={pct(f.initialYesPrice)}
              disabled={frozen}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setF({ initialYesPrice: Math.min(99, Math.max(1, n)) / 100 })
              }}
            />
            <PriceGauge value={f.initialYesPrice} width={180} showScale />
          </div>
        </Field>
        <Field label="Price range (%)" htmlFor={fieldId('funding.priceRange')} error={err('funding.priceRange')} hint="Concentrated liquidity band. Narrow bands deepen the book but can leave you holding one outcome.">
          <div className="flex items-center gap-2">
            <Input
              id={fieldId('funding.priceRange')}
              aria-label="Lower bound percent"
              inputMode="decimal"
              className="tnum w-20"
              value={pct(f.priceRange[0])}
              disabled={frozen}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setF({ priceRange: [Math.max(0.1, n) / 100, f.priceRange[1]] })
              }}
            />
            <span className="text-muted">to</span>
            <Input
              aria-label="Upper bound percent"
              inputMode="decimal"
              className="tnum w-20"
              value={pct(f.priceRange[1])}
              disabled={frozen}
              onChange={(e) => {
                const n = Number(e.target.value)
                if (Number.isFinite(n)) setF({ priceRange: [f.priceRange[0], Math.min(99.9, n) / 100] })
              }}
            />
          </div>
        </Field>
      </div>

      {plan ? (
        <>
          <LimitMeter spend={Number(plan.totals.maxSpend)} limit={Number(plan.input.spendingLimit) || 0} symbol={sym} />
          <div className="scrollbar-thin overflow-x-auto rounded-ctl border border-line">
            <table className="w-full min-w-[640px] text-[13px]">
              <caption className="sr-only">Cost breakdown</caption>
              <thead>
                <tr className="stretch-cond border-b border-line bg-sunken text-left text-[12px] text-muted">
                  <th className="px-3 py-1.5 font-medium">Cost</th>
                  <th className="px-3 py-1.5 font-medium">Kind</th>
                  <th className="px-3 py-1.5 font-medium">Paid by</th>
                  <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {plan.costs.map((cl) => (
                  <tr key={cl.key} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{cl.label}</span>
                      <p className="text-[12px] text-muted">{cl.note}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn('whitespace-nowrap rounded-chip border px-1.5 text-[11.5px]', KIND[cl.kind].cls)}>{KIND[cl.kind].label}</span>
                    </td>
                    <td className="px-3 py-2 text-muted">{cl.payer === 'you' ? 'You' : cl.payer}</td>
                    <td className="tnum whitespace-nowrap px-3 py-2 text-right">
                      {cl.estimate ? <span className="text-muted">~</span> : null}
                      {formatAmount(cl.amount, { symbol: cl.currency, maxDecimals: 5 })}
                      {!cl.countsTowardLimit ? <span className="block text-[11px] text-muted">outside limit</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DataList
            className="rounded-ctl border border-line"
            labelWidth="13rem"
            rows={[
              { label: 'Maximum spend (counts toward limit)', value: <span className="tnum font-semibold">{formatAmount(plan.totals.maxSpend, { symbol: sym, maxDecimals: 4 })}</span> },
              { label: 'Exposed to loss', value: <span className="tnum">{formatAmount(plan.totals.exposedToLoss, { symbol: sym, maxDecimals: 4 })}</span> },
              { label: 'Not recoverable', value: <span className="tnum">{formatAmount(plan.totals.nonRecoverable, { symbol: sym, maxDecimals: 4 })}</span>, hint: 'Gas and fees.' },
              { label: 'Reserved if disputed', value: <span className="tnum">{formatAmount(plan.totals.reservedIfDisputed, { symbol: sym, maxDecimals: 4 })}</span>, hint: 'Oracle bonds and arbitration, only if you choose to act.' },
              { label: 'Withdrawable later', value: <span className="tnum">{formatAmount(plan.totals.withdrawable, { symbol: sym, maxDecimals: 4 })}</span>, hint: 'Not guaranteed value: positions move with the market.' },
              {
                label: 'Headroom',
                value: <span className={cn('tnum font-medium', plan.withinLimit ? 'text-needle' : 'text-flare')}>{formatAmount(plan.headroom, { symbol: sym, maxDecimals: 4 })}</span>,
                hint: plan.withinLimit ? undefined : 'The plan exceeds your spending limit. Raise the limit or lower the liquidity.',
              },
            ]}
          />
          {plan.warnings.length ? (
            <Callout tone="warning" title="Check before funding">
              <ul className="list-disc space-y-0.5 pl-4">
                {plan.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
        </>
      ) : null}
      <Callout tone="info">{COPY.disclosures.find((d) => d.id === 'withdrawability')?.body}</Callout>
    </Section>
  )
}

export function ReviewSection({ publish, onFocusProblem }: { publish: PublishClaim; onFocusProblem: (path: string) => void }) {
  const { c, setShowAll } = useComposerCtx()
  const wallet = useWallet()
  const ackKey = `pine-console:ack:${c.draft.id}`
  const [ack, setAck] = React.useState(false)
  React.useEffect(() => setAck(readLocal(ackKey, false)), [ackKey])
  const issues = c.validation.issues
  const started = publish.steps.some((s) => s.status !== 'idle')
  const canPublish = c.validation.ok && ack && publish.ready && wallet.isConnected
  const spec = c.spec
  const src = c.draft.source
  return (
    <Section id="review" index={7} title="Review & publish" description="Read the terms the way an investigator will. After the market is created, nothing here can change.">
      <DataList
        className="rounded-ctl border border-line"
        labelWidth="9.5rem"
        rows={[
          { label: 'Claim', value: spec.title || <span className="text-faint">untitled</span>, hint: c.claimId ? `id ${c.claimId}` : undefined },
          { label: 'Commit', value: src ? <span className="mono-cond text-[12px]">{src.owner}/{src.repo}@{shortSha(src.commit.sha)}</span> : <span className="text-flare">not pinned</span> },
          { label: 'Policy', value: c.policy ? <span className="mono-cond text-[12px]">{c.policy.id}@{c.policy.version}</span> : <span className="text-flare">not chosen</span> },
          { label: 'Evidence deadline', value: <span className="tnum">{spec.evidence.deadline ? formatDate(spec.evidence.deadline, 'utc') : 'not set'}</span> },
          { label: 'Oracle opens', value: <span className="tnum">{formatDate(spec.oracle.openingTime, 'utc')}</span> },
          {
            label: 'Funding',
            value: c.funding ? (
              <span className="tnum">
                {formatAmount(c.fundingInput.liquidity, { symbol: c.funding.collateral.symbol })} liquidity, limit {formatAmount(c.fundingInput.spendingLimit, { symbol: c.funding.collateral.symbol })}
              </span>
            ) : null,
          },
        ]}
      />

      {issues.length ? (
        <div className="rounded-ctl border border-flare/30 bg-flare-soft/50 p-3">
          <p className="text-[13.5px] font-semibold">{issues.length} problem{issues.length === 1 ? '' : 's'} to resolve before publishing</p>
          <ul className="mt-1.5 space-y-0.5">
            {issues.slice(0, 8).map((i) => (
              <li key={i.path + i.message}>
                <button type="button" onClick={() => onFocusProblem(i.path)} className="group flex w-full items-start gap-2 rounded-chip px-1 py-0.5 text-left text-[13px] hover:bg-surface">
                  <ChevronRight size={13} aria-hidden className="mt-1 shrink-0 text-flare" />
                  <span className="min-w-0">
                    <span className="text-muted">{SECTIONS.find((s) => s.id === sectionForPath(i.path))?.label}: </span>
                    {i.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {issues.length > 8 ? <p className="mt-1 text-xs text-muted">and {issues.length - 8} more in the problems panel</p> : null}
        </div>
      ) : null}

      <details className="group rounded-ctl border border-line" open={!ack}>
        <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-[13.5px] font-semibold">
          <ChevronRight size={14} aria-hidden className="transition-transform group-open:rotate-90" />
          Risk disclosures ({COPY.disclosures.length})
          {ack ? <span className="ml-auto text-[12px] font-normal text-needle">acknowledged</span> : null}
        </summary>
        <dl className="max-h-[420px] divide-y divide-line overflow-y-auto border-t border-line">
          {COPY.disclosures.map((d) => (
            <div key={d.id} className="px-3 py-2.5">
              <dt className="text-[13px] font-semibold">{d.title}</dt>
              <dd className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{d.body}</dd>
            </div>
          ))}
        </dl>
      </details>
      <Checkbox
        id="ack"
        checked={ack}
        onChange={(v) => {
          setAck(v)
          writeLocal(ackKey, v)
        }}
        label="I have read these disclosures and understand that my liquidity is at risk, that No is not a correctness verdict, and that invalid is not a refund."
      />

      {publish.blockers.length && !started ? (
        <Callout tone="info" title="Before you can publish">
          <ul className="list-disc space-y-0.5 pl-4">
            {publish.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {!wallet.isConnected ? (
          <Button variant="secondary" onClick={() => wallet.connect()}>
            <Wallet size={14} aria-hidden /> Connect wallet to publish
          </Button>
        ) : null}
        {!started ? (
          <Button
            variant="primary"
            size="lg"
            disabled={!canPublish}
            onClick={() => {
              setShowAll(true)
              if (canPublish) void publish.start()
            }}
          >
            Publish claim and create market
          </Button>
        ) : null}
        {!c.validation.ok ? (
          <Button variant="quiet" onClick={() => setShowAll(true)}>
            Show all problems inline
          </Button>
        ) : null}
      </div>

      {started ? (
        <div className="space-y-3">
          <TxLog runner={publish} title="Publishing" startLabel="Publish" />
          {publish.frozen ? (
            <Callout tone="frozen" title="Terms are frozen">
              {COPY.frozenTerms}
            </Callout>
          ) : null}
          {publish.state === 'done' && publish.claimId ? (
            <Callout
              tone="info"
              title={`Published ${publish.claimId.toUpperCase()}`}
              action={
                <Button asChild variant="primary" size="sm">
                  <Link href={`/claims/${publish.claimId}`}>Open claim</Link>
                </Button>
              }
            >
              The claim is open for evidence. Share the agent brief from its Agent tab.
            </Callout>
          ) : null}
        </div>
      ) : null}
      {c.frozen ? (
        <p className="flex items-center gap-1.5 text-[12.5px] text-slate">
          <Snowflake size={13} aria-hidden /> Market created; source, policy, claim, environment and deadlines are read-only.
        </p>
      ) : null}
      <p className="text-xs text-muted">{COPY.noMergeAuthority}</p>
    </Section>
  )
}
