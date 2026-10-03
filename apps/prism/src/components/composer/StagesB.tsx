'use client'

import Link from 'next/link'
import type { ClaimDraft, CostKind, FundingInput } from '@pine/core'
import { formatAmount, formatPrice, SUPPORTED_CHAIN_IDS } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { usePublishClaim, useWallet, type ClaimComposer } from '@pine/react'
import { ArrowLeft, Lock, RotateCw, Wallet } from 'lucide-react'
import { motion } from 'motion/react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { FormField, Notice } from '@/components/ui/primitives'
import { HashChip } from '@/components/ui/interactive'
import { PrismBeam } from '@/components/prism/PrismBeam'
import { TxSteps } from '@/components/tx/TxSteps'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { issueFor, issuesFor, StageHeader, StageIssues, StageNav, UI_STEPS, type StepNav, type UiStep } from './shared'

const KIND: Record<CostKind, { label: string; color: string; help: string }> = {
  spent: { label: 'Spent', color: 'var(--lumen-2)', help: 'Paid and gone (gas, fees).' },
  at_risk: { label: 'At risk', color: 'var(--ha)', help: 'Deposited and exposed to market loss.' },
  reserved: { label: 'Only if needed', color: 'var(--na)', help: 'Spent only if a condition occurs (bonds, arbitration).' },
  withdrawable: { label: 'Withdrawable', color: 'var(--hb)', help: 'Recoverable by withdrawing; value not guaranteed.' },
}

const PAYER: Record<string, string> = { you: 'You', answerer: 'Answerer', challenger: 'Challenger', platform: 'Platform', sponsor: 'Sponsor' }

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export function StageFunding({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const f = c.fundingInput
  const plan = c.funding
  const dis = c.fundingFrozen
  const chain = getChainOrDefault(f.chainId)
  const sym = chain.collateral.symbol
  const setFunding = (patch: Partial<FundingInput>) => c.update((d: ClaimDraft) => ({ ...d, funding: { ...d.funding, ...patch } }))
  const need = Number(plan?.totals.maxSpend ?? 0)
  const limit = Number(f.spendingLimit) || 0
  const pct = limit > 0 ? Math.min(100, (need / limit) * 100) : 100

  return (
    <div>
      <StageHeader step="funding">
        Liquidity lets the market trade. {COPY.liquidityIsNotBounty} Every cost below is checked against your spending limit, and approvals are for the exact amount only.
      </StageHeader>
      <div className="grid gap-6">
        <div className="grid gap-6 md:grid-cols-3">
          <FormField id="chain" label="Chain" help={chain.verified ? `Collateral ${sym}. Bonds in ${chain.nativeSymbol}.` : COPY.unverifiedChain}>
            <select id="chain" className="field" value={f.chainId} disabled={dis || c.frozen} onChange={(e) => setFunding({ chainId: Number(e.target.value) })}>
              {SUPPORTED_CHAIN_IDS.map((id) => (
                <option key={id} value={id}>
                  {getChainOrDefault(id).name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="liquidity" label={`Liquidity (${sym})`} help="Your deposit, split into outcome tokens and placed in the pools." error={issueFor(c, 'funding.liquidity')}>
            <input id="liquidity" className="field tnum" inputMode="decimal" value={f.liquidity} disabled={dis} onChange={(e) => setFunding({ liquidity: e.target.value.replace(',', '.') })} />
          </FormField>
          <FormField id="spending-limit" label={`Spending limit (${sym})`} help="A hard cap. Any step that would exceed it is blocked." error={issueFor(c, 'funding.spendingLimit')}>
            <input id="spending-limit" className="field tnum" inputMode="decimal" value={f.spendingLimit} disabled={dis} onChange={(e) => setFunding({ spendingLimit: e.target.value.replace(',', '.') })} />
          </FormField>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <label htmlFor="yes-price" className="label">
              Starting Yes price: <span className="tnum">{formatPrice(f.initialYesPrice)}</span>
            </label>
            <input
              id="yes-price"
              type="range"
              min={0.02}
              max={0.8}
              step={0.01}
              value={f.initialYesPrice}
              disabled={dis}
              onChange={(e) => setFunding({ initialYesPrice: Number(e.target.value) })}
              className="prism-range w-full"
            />
            <p className="help mt-1">Where the market opens. It is your starting guess of the {COPY.priceLabel.toLowerCase()}, not a fact about the code.</p>
          </div>
          <div>
            <p className="label">Price range for concentrated liquidity</p>
            <div className="grid grid-cols-2 gap-2">
              <input
                aria-label="Lowest price"
                className="field tnum"
                inputMode="decimal"
                value={f.priceRange[0]}
                disabled={dis}
                onChange={(e) => setFunding({ priceRange: [Number(e.target.value) || 0, f.priceRange[1]] })}
              />
              <input
                aria-label="Highest price"
                className="field tnum"
                inputMode="decimal"
                value={f.priceRange[1]}
                disabled={dis}
                onChange={(e) => setFunding({ priceRange: [f.priceRange[0], Number(e.target.value) || 0] })}
              />
            </div>
            <p className="help mt-1">Narrow ranges concentrate depth but can leave you holding almost entirely the losing outcome.</p>
          </div>
        </div>

        <div className="cut-lg well p-4">
          <p className="text-[0.8125rem] text-lumen-3">Opening split at your starting price</p>
          <PrismBeam prices={{ yes: f.initialYesPrice, no: Math.max(0, 1 - f.initialYesPrice), invalid: 0 }} compactLabels />
        </div>

        {/* Limit meter */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[0.9375rem] text-lumen-2">
              Needs up to <span className="t-figure text-[1.35rem] text-lumen">{formatAmount(need, { maxDecimals: 2 })}</span> of your <span className="t-figure text-[1.35rem] text-lumen">{formatAmount(limit, { maxDecimals: 2 })}</span> {sym} limit
            </p>
            <p className={cn('text-[0.875rem] font-semibold', plan?.withinLimit ? 'text-lumen-2' : 'text-ha')}>{plan?.withinLimit ? `${formatAmount(plan.headroom, { maxDecimals: 2 })} ${sym} headroom` : 'Over the limit'}</p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-void" role="img" aria-label={`${Math.round(pct)}% of the spending limit`}>
            <motion.div className="h-full rounded-full" style={{ background: plan?.withinLimit ? 'linear-gradient(90deg,#f5ede4,#5ad8ff)' : '#FF6B83' }} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} />
          </div>
        </div>

        {plan && (
          <div className="glass cut-lg overflow-hidden">
            <table className="w-full text-left text-[0.875rem]">
              <caption className="sr-only">Cost breakdown</caption>
              <thead>
                <tr className="border-b border-edge text-[0.78rem] text-lumen-3">
                  <th className="px-4 py-2.5 font-medium">Cost</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                  <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Kind</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Who pays</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--edge)]">
                {plan.costs.map((l) => (
                  <tr key={l.key} className="align-top">
                    <td className="px-4 py-3">
                      <p className="font-medium text-lumen">
                        {l.label}
                        {l.countsTowardLimit && <span className="ml-1.5 text-[0.72rem] font-normal text-lumen-3">counts toward limit</span>}
                      </p>
                      <p className="mt-0.5 text-[0.78rem] text-lumen-3">{l.note}</p>
                      <p className="mt-1 text-[0.75rem] sm:hidden" style={{ color: KIND[l.kind].color }}>
                        {KIND[l.kind].label}, paid by {PAYER[l.payer] ?? l.payer}
                      </p>
                    </td>
                    <td className="tnum whitespace-nowrap px-4 py-3 text-right text-lumen">
                      {l.estimate ? '≈ ' : ''}
                      {formatAmount(l.amount, { maxDecimals: 4 })} <span className="text-lumen-3">{l.currency}</span>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      <span className="inline-flex items-center gap-1.5 text-[0.8125rem]" title={KIND[l.kind].help}>
                        <span aria-hidden className="h-2 w-2 rotate-45" style={{ background: KIND[l.kind].color }} />
                        {KIND[l.kind].label}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 text-[0.8125rem] text-lumen-2 md:table-cell">{PAYER[l.payer] ?? l.payer}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="grid grid-cols-2 gap-px border-t border-edge bg-[var(--edge)] sm:grid-cols-4">
              {(
                [
                  ['Most you spend', plan.totals.maxSpend],
                  ['Exposed to loss', plan.totals.exposedToLoss],
                  ['Not recoverable', plan.totals.nonRecoverable],
                  ['Only if disputed', plan.totals.reservedIfDisputed],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="bg-smoke px-4 py-3">
                  <dt className="text-[0.75rem] text-lumen-3">{k}</dt>
                  <dd className="tnum mt-0.5 text-[0.96875rem] text-lumen">
                    {formatAmount(v, { maxDecimals: 2 })} {sym}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {plan && plan.warnings.length > 0 && (
          <Notice tone="caution" title="Check these">
            <ul className="mt-1 grid gap-1">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        )}
        {c.fundingFrozen && <Notice tone="boundary">Funding steps already confirmed, so these amounts are locked.</Notice>}
      </div>
      <StageIssues c={c} step="funding" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export function StageReview({ c, nav, acknowledged, setAcknowledged }: { c: ClaimComposer; nav: StepNav; acknowledged: boolean; setAcknowledged: (v: boolean) => void }) {
  const wallet = useWallet()
  const chain = getChainOrDefault(c.fundingInput.chainId)
  const byStep = UI_STEPS.map((s) => ({ s, issues: issuesFor(c, s.id) })).filter((x) => x.issues.length > 0 && x.s.id !== 'publish')
  return (
    <div>
      <StageHeader step="review">Read the claim the way an investigator will. Once the market exists nothing on this page can change.</StageHeader>
      <div className="grid gap-6">
        <div className="cut-xl well relative overflow-hidden p-5 sm:p-6">
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: 'linear-gradient(180deg,#5ad8ff,#ffb648,#ff6b83)' }} />
          <p className="text-[0.8125rem] text-lumen-3">The question</p>
          <p className="mt-2 text-[1.0625rem] leading-[1.65] text-lumen [overflow-wrap:anywhere]">{c.question?.text ?? 'Not complete yet.'}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {c.manifestHash && <HashChip value={c.manifestHash} label="Manifest hash" />}
            {c.question && <HashChip value={c.question.hash} label="Question hash" />}
            <HashChip value={c.spec.environment.envHash} label="Environment" />
          </div>
          {!wallet.isConnected && c.manifestHash && (
            <p className="mt-3 text-[0.8125rem] text-na">The manifest names its creator, so this hash changes once you connect the wallet that will publish.</p>
          )}
        </div>

        {byStep.length > 0 ? (
          <Notice tone="caution" title="Facets still uncut" role="status">
            <ul className="mt-1 grid gap-2">
              {byStep.map(({ s, issues }) => (
                <li key={s.id}>
                  <button type="button" className="link font-semibold text-lumen" onClick={() => nav.go(s.id as UiStep)}>
                    {s.label}
                  </button>
                  <ul className="mt-0.5 grid gap-0.5">
                    {issues.map((i) => (
                      <li key={i.path + i.message} className="[overflow-wrap:anywhere]">
                        {i.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Notice>
        ) : (
          <Notice tone="info" title="Every facet is cut">
            The claim is complete. Publishing seals it.
          </Notice>
        )}
        {!chain.verified && <Notice tone="caution">{COPY.unverifiedChain}</Notice>}

        <section aria-labelledby="risks-title" className="glass cut-lg p-5">
          <h3 id="risks-title" className="t-h4">
            Before you fund this market
          </h3>
          <ul className="mt-3 grid max-h-[22rem] gap-3 overflow-y-auto pr-2">
            {COPY.disclosures.map((d) => (
              <li key={d.id}>
                <p className="text-[0.9rem] font-semibold text-lumen">{d.title}</p>
                <p className="mt-0.5 text-[0.84375rem] leading-[1.55] text-lumen-2">{d.body}</p>
              </li>
            ))}
          </ul>
          <label className="mt-5 flex items-start gap-3 border-t border-edge pt-4">
            <input type="checkbox" className="facet-check" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            <span className="text-[0.9rem] text-lumen">
              I have read these risks. I understand my liquidity is capital at risk, that No is not a correctness verdict, and that Invalid is not a refund.
            </span>
          </label>
          <p className="mt-2 text-[0.78rem] text-lumen-3">
            <Link className="link" href="/risks">
              All risks and launch gates
            </Link>
          </p>
        </section>
      </div>
      <StageNav nav={nav} nextLabel="Continue to publish" nextDisabled={!acknowledged} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export function StagePublish({ c, nav, acknowledged }: { c: ClaimComposer; nav: StepNav; acknowledged: boolean }) {
  const pub = usePublishClaim(c.draft.id)
  const wallet = useWallet()
  const reduce = useReduceMotion()
  const sym = getChainOrDefault(c.fundingInput.chainId).collateral.symbol
  const started = pub.steps.some((s) => s.status !== 'idle')
  const need = Number(c.funding?.totals.maxSpend ?? 0)
  const limit = Number(c.fundingInput.spendingLimit) || 0

  if (pub.state === 'done') {
    return (
      <div>
        <motion.div className="glass cut-xl relative overflow-hidden p-6 sm:p-8" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: 'var(--spectrum)' }} />
          <p className="tag gap-1.5 text-lumen">
            <Lock size={12} aria-hidden /> Sealed and published
          </p>
          <h2 className="t-h1 mt-4 max-w-[18ch]">Your claim is on the light table.</h2>
          <p className="mt-3 max-w-[60ch] text-lumen-2">
            The market is open for evidence until the deadline. Investigators and agents can find it on the light table, in the agent API and in the feed. {COPY.noMergeAuthority}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {pub.claimId && <ButtonLink href={`/claims/${pub.claimId}`}>Watch it live</ButtonLink>}
            <ButtonLink href="/claims" variant="glass">
              Open the light table
            </ButtonLink>
            <ButtonLink href="/compose?new=1" variant="ghost">
              Compose another claim
            </ButtonLink>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div>
      <StageHeader step="publish">Each step asks your wallet for exactly one action. Progress is saved after every step, so you can close this tab and finish later from Drafts.</StageHeader>
      <div className="grid gap-4">
        {!acknowledged && !started && (
          <Notice tone="caution" title="Risks not acknowledged">
            Go back to review and acknowledge the risks first.{' '}
            <button type="button" className="link font-semibold" onClick={() => nav.go('review')}>
              Back to review
            </button>
          </Notice>
        )}
        {pub.frozen && (
          <Notice tone="boundary" title="Sealed: the market exists and the terms are frozen">
            {COPY.frozenTerms} The remaining steps only fund the market.
          </Notice>
        )}
        {!started && pub.blockers.length > 0 && (
          <Notice tone="caution" title="Before you can publish" role="status">
            <ul className="mt-1 grid gap-1">
              {pub.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </Notice>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="pub-steps">
          <h3 id="pub-steps" className="t-h4 mb-5">
            Publication steps
          </h3>
          {pub.steps.length > 0 ? <TxSteps runner={pub} chainId={c.fundingInput.chainId} /> : <p className="text-lumen-3">The steps appear once the claim is complete.</p>}
          {pub.error && (
            <Notice tone="critical" role="alert" className="mt-5">
              <span className="untrusted [white-space:normal]">{pub.error}</span>
            </Notice>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-edge pt-5">
            {!wallet.isConnected ? (
              <Button onClick={() => wallet.connect()} icon={<Wallet size={15} aria-hidden />}>
                {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
              </Button>
            ) : pub.state === 'failed' ? (
              <Button onClick={() => void pub.retry()} icon={<RotateCw size={15} aria-hidden />}>
                Retry from the failed step
              </Button>
            ) : (
              <Button onClick={() => void pub.start()} loading={pub.state === 'running'} disabled={!acknowledged || (!pub.ready && !started) || pub.state === 'running' || !!pub.awaitingManual}>
                {started ? 'Continue publishing' : 'Publish and seal'}
              </Button>
            )}
            <DemoFailToggle />
            {!pub.frozen && started && (
              <Button variant="ghost" onClick={() => nav.go('review')} icon={<ArrowLeft size={15} aria-hidden />}>
                Edit before the market exists
              </Button>
            )}
          </div>
        </section>
        <aside className="grid content-start gap-5">
          <section className="glass cut-lg p-5" aria-labelledby="pub-limit">
            <h3 id="pub-limit" className="t-h4">
              Spending limit
            </h3>
            <p className="mt-2 text-[0.9rem] text-lumen-2">
              This plan needs up to <span className="tnum font-semibold text-lumen">{formatAmount(need, { maxDecimals: 2 })}</span> of your{' '}
              <span className="tnum font-semibold text-lumen">{formatAmount(limit, { maxDecimals: 2 })}</span> {sym} limit. Spent so far: <span className="tnum text-lumen">{formatAmount(pub.spent, { maxDecimals: 2 })}</span> {sym}.
            </p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-void">
              <div className="h-full rounded-full bg-[linear-gradient(90deg,#f5ede4,#5ad8ff)]" style={{ width: `${limit > 0 ? Math.min(100, (Number(pub.spent) / limit) * 100) : 0}%` }} />
            </div>
            <p className="mt-3 text-[0.78rem] text-lumen-3">{COPY.spendingLimit}</p>
          </section>
          <Notice tone="boundary" title="What freezes, and when">
            {COPY.frozenTerms} If a later step fails, the market already exists: you finish funding from here or from Drafts.
          </Notice>
          <p className="text-[0.84375rem] text-lumen-2">
            Interrupted? Everything is saved.{' '}
            <Link href="/drafts" className="link">
              Drafts and unfinished publications
            </Link>
          </p>
        </aside>
      </div>
    </div>
  )
}
