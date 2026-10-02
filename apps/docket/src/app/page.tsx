import Link from 'next/link'
import type { ClaimDetail, ClaimSummary, FundingPlan } from '@pine/core'
import { estimateFunding, formatClaimNumber, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ArrowRight, Check, FilePlus2, Minus, X } from 'lucide-react'
import { ButtonLink } from '@/components/ui/button'
import { StageTag } from '@/components/ui/stage'
import { AnnotatedQuestion } from '@/components/claim/annotated-question'
import { DocketRow } from '@/components/docket/docket-row'
import { CostBreakdown, FundingTotals } from '@/components/funding/cost-breakdown'
import { questionAnnotations } from '@/lib/annotations'
import { PROCEDURE } from '@/lib/procedure'
import { serverData, safely } from '@/lib/server-data'
import { cn } from '@/lib/cn'

export const dynamic = 'force-dynamic'

const GET = [
  'A public, hashed record of one bounded claim: the exact commit, environment, policy version and an absolute UTC deadline.',
  'A prediction market that gives independent investigators, human or AI, a reason to look for a reproducible counterexample.',
  'Exhibits filed on-chain, where the block timestamp proves whether they were on time.',
  'A procedural answer: an oracle backed by bonds, and Kleros arbitration if the answer is disputed.',
  'A machine-readable brief, so agents reproduce against the right pins instead of whatever is on main today.',
]

const NOT_GET = [
  'An audit, a certification or a “safe” verdict. No counterexample is not proof of correctness.',
  'Guaranteed investigators, a full review or a written report.',
  'A bounty. Your liquidity is capital at risk, not a reward pool, and nobody is promised a payment.',
  'A refund if the question resolves invalid.',
  'Any merge, deploy or action on your repository. You decide what to merge.',
]

const DURATIONS: Record<string, string> = {
  evidence: 'You choose: at least 24 hours',
  challenge: '3.5 days after each answer',
  arbitration: 'About 2 weeks, plus 11 days per appeal',
}

export default async function LandingPage() {
  const [open, stats] = await Promise.all([
    safely(() => serverData().listClaims({ status: 'open', sort: 'deadline', limit: 12 }), { items: [] as ClaimSummary[] }),
    safely(() => serverData().getStats(), null),
  ])
  const flagshipSummary = open.items.find((c) => c.source.repo.includes('gateway-balancer')) ?? open.items[0]
  const flagship: ClaimDetail | null = flagshipSummary ? await safely(() => serverData().getClaim(flagshipSummary.id), null) : null
  const plan: FundingPlan | null = (() => {
    try {
      return estimateFunding({ chainId: 100, liquidity: '25', spendingLimit: '50', initialYesPrice: 0.15, priceRange: [0.02, 0.8] })
    } catch {
      return null
    }
  })()

  return (
    <main id="main" tabIndex={-1} className="outline-none">
      {/* Hero */}
      <section className="border-b border-rule bg-sheet">
        <div className="mx-auto grid max-w-[86rem] gap-12 px-4 pt-12 pb-14 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:px-10 lg:pt-16 lg:pb-20">
          <div className="min-w-0 self-center">
            <h1 className="max-w-[17ch] text-[2.6rem] leading-[2.95rem] font-[800] tracking-[-0.03em] sm:text-4xl">
              Put one claim about one commit on the record.
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-8 text-ink">
              File a bounded claim about an exact commit and fund a prediction market that gives independent investigators, human or AI, a
              reason to look for a reproducible counterexample before a fixed UTC deadline. An oracle answers the question. Kleros
              arbitrates if the answer is disputed.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
              <ButtonLink href="/file" size="lg" icon={<FilePlus2 aria-hidden />}>
                File a verification
              </ButtonLink>
              <Link href="#procedure" className="link text-lg font-bold">
                See how a claim proceeds
              </Link>
            </div>
            <p className="mt-6 max-w-[34rem] text-[15px] text-graphite">
              Reading the docket needs no account. Filing needs GitHub sign-in to choose a public repository, and a wallet to fund the
              market. {COPY.notAReview}
            </p>
          </div>

          <div className="min-w-0">
            {flagship ? (
              <figure className="border border-rule bg-sheet shadow-[8px_8px_0_var(--color-bond)]">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
                  <span className="flex items-center gap-3">
                    <span className="font-[800] text-violet tabular">{formatClaimNumber(flagship.number)}</span>
                    <StageTag status={flagship.status} outcome={flagship.outcome} />
                  </span>
                  <span className="text-sm text-graphite">
                    {flagship.source.owner}/{flagship.source.repo} at <code className="font-mono">{shortSha(flagship.source.commitSha)}</code>
                  </span>
                </div>
                <div className="px-5 pt-5 pb-6 sm:px-7">
                  <figcaption className="text-sm font-bold text-graphite">The question on record, as an investigator reads it</figcaption>
                  <AnnotatedQuestion
                    className="mt-3"
                    layout="stacked"
                    idPrefix="hero-q"
                    notesTitle="What binds"
                    text={flagship.manifest.question.text}
                    annotations={questionAnnotations(flagship.manifest).filter((_, i) => i === 1 || i === 2 || i === 4 || i === 6)}
                  />
                  <p className="mt-5 text-[15px]">
                    <Link href={`/claims/${flagship.id}`} className="link font-bold">
                      Open the full case file for {formatClaimNumber(flagship.number)}
                    </Link>
                  </p>
                </div>
              </figure>
            ) : (
              <div className="border border-dashed border-rule-strong bg-sheet p-8 text-graphite">
                When claims are filed, the most urgent one is shown here with its question annotated.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Get / don't get */}
      <section aria-labelledby="get-title" className="mx-auto max-w-[86rem] px-4 py-16 sm:px-6 lg:px-10">
        <h2 id="get-title" className="max-w-[40rem] text-3xl tracking-[var(--tracking-display)]">
          What you are paying for, and what you are not
        </h2>
        <div className="mt-8 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="border-b-2 border-ink pb-2 text-xl">You get</h3>
            <ul className="divide-y divide-rule">
              {GET.map((t) => (
                <li key={t} className="flex gap-3 py-3.5">
                  <Check aria-hidden className="mt-1 size-5 shrink-0 text-violet" strokeWidth={2.75} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="border-b-2 border-ink pb-2 text-xl">You do not get</h3>
            <ul className="divide-y divide-rule">
              {NOT_GET.map((t) => (
                <li key={t} className="flex gap-3 py-3.5">
                  <X aria-hidden className="mt-1 size-5 shrink-0 text-red" strokeWidth={2.75} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Procedure */}
      <section id="procedure" aria-labelledby="procedure-title" className="scroll-mt-4 border-y border-rule bg-sheet">
        <div className="mx-auto max-w-[86rem] px-4 py-16 sm:px-6 lg:px-10">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-[44rem]">
              <h2 id="procedure-title" className="text-3xl tracking-[var(--tracking-display)]">
                How a claim proceeds
              </h2>
              <p className="mt-3 text-lg text-graphite">
                Eight stages, always in this order. Every claim page shows which stage it is in, who has to act next and by when.
              </p>
            </div>
            <Link href="/how-it-works" className="link font-bold">
              Read the full guide and glossary
            </Link>
          </div>
          <ol className="mt-10 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {PROCEDURE.map((p, i) => (
              <li key={p.id} className="relative border-t-4 border-ink pt-4">
                <span
                  className={cn(
                    'absolute -top-[1.15rem] left-0 flex size-8 items-center justify-center rounded-full text-sm font-[800] tabular',
                    p.optional ? 'border-2 border-dashed border-ink bg-sheet text-ink' : 'bg-ink text-white',
                  )}
                  aria-hidden
                >
                  {i + 1}
                </span>
                <h3 className="mt-2 text-lg font-bold">
                  <span className="sr-only">Stage {i + 1}: </span>
                  {p.title}
                  {p.optional ? <span className="font-normal text-graphite"> (only if disputed)</span> : null}
                </h3>
                <p className="mt-1 text-[15px] leading-6">{p.summary}</p>
                <p className="mt-2 text-sm text-graphite">
                  <strong className="text-ink">Who acts:</strong> {p.who}
                </p>
                {DURATIONS[p.id] ? (
                  <p className="mt-1 text-sm text-graphite">
                    <strong className="text-ink">How long:</strong> {DURATIONS[p.id]}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Outcomes */}
      <section aria-labelledby="outcomes-title" className="mx-auto max-w-[86rem] px-4 py-16 sm:px-6 lg:px-10">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <h2 id="outcomes-title" className="text-3xl tracking-[var(--tracking-display)]">
              How outcomes read
            </h2>
            <p className="mt-3 text-lg text-graphite measure">
              The market answers one narrow question. A counterexample is bad news for the code. No counterexample is a neutral result,
              never a clean bill of health.
            </p>
          </div>
          <dl className="space-y-3">
            <div className="flex gap-4 border-l-8 border-red bg-red-wash px-5 py-4">
              <div>
                <dt className="text-lg font-[800] text-red">Yes: {COPY.outcome.yes}</dt>
                <dd className="mt-1">{COPY.outcomeLong.yes} Read the exhibits and decide what to change.</dd>
              </div>
            </div>
            <div className="flex gap-4 border-l-8 border-slate bg-mist px-5 py-4">
              <div>
                <dt className="flex items-center gap-2 text-lg font-[800] text-slate">
                  <Minus aria-hidden className="size-5" strokeWidth={3} /> No: {COPY.outcome.no}
                </dt>
                <dd className="mt-1">{COPY.noIsNotSafety}</dd>
              </div>
            </div>
            <div className="hatch flex gap-4 border-l-8 border-graphite px-5 py-4">
              <div>
                <dt className="text-lg font-[800] text-graphite">Invalid: {COPY.outcome.invalid}</dt>
                <dd className="mt-1">{COPY.invalidIsNotRefund}</dd>
              </div>
            </div>
          </dl>
        </div>
      </section>

      {/* Costs */}
      {plan ? (
        <section aria-labelledby="costs-title" className="border-y border-rule bg-sheet">
          <div className="mx-auto grid max-w-[86rem] gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:px-10">
            <div>
              <h2 id="costs-title" className="text-3xl tracking-[var(--tracking-display)]">
                What it costs, itemized
              </h2>
              <p className="mt-3 text-lg text-graphite measure">
                An example filing on Gnosis with {plan.input.liquidity} {plan.collateral.symbol} of liquidity and a{' '}
                {plan.input.spendingLimit} {plan.collateral.symbol} spending limit. These are the planner&rsquo;s own numbers, the same
                ones you confirm before publishing.
              </p>
              <FundingTotals plan={plan} className="mt-8" />
              <p className="mt-4 text-sm text-graphite">{COPY.spendingLimit}</p>
            </div>
            <CostBreakdown plan={plan} />
          </div>
        </section>
      ) : null}

      {/* Live docket */}
      <section aria-labelledby="live-title" className="mx-auto max-w-[86rem] px-4 py-16 sm:px-6 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="live-title" className="text-3xl tracking-[var(--tracking-display)]">
              On the docket now
            </h2>
            <p className="mt-2 text-lg text-graphite">
              {stats ? `${stats.openClaims} claims are open for evidence. ` : ''}Soonest deadline first.
            </p>
          </div>
          <Link href="/docket" className="inline-flex items-center gap-1.5 font-bold text-violet underline underline-offset-4">
            Open the full docket <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
        {open.items.length > 0 ? (
          <div className="mt-6 border-t border-rule">
            {open.items.slice(0, 5).map((c) => (
              <DocketRow key={c.id} claim={c} />
            ))}
          </div>
        ) : (
          <p className="mt-6 border border-dashed border-rule-strong bg-sheet p-8 text-graphite">
            No claims are open right now. <Link href="/file" className="link">File the first one.</Link>
          </p>
        )}
      </section>

      {/* For investigators */}
      <section aria-labelledby="investigators-title" className="border-t border-rule bg-ink text-white">
        <div className="mx-auto grid max-w-[86rem] gap-8 px-4 py-14 sm:px-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-center lg:px-10">
          <div className="max-w-[46rem]">
            <h2 id="investigators-title" className="text-2xl">
              Investigating, or running an agent that does?
            </h2>
            <p className="mt-2 text-[#d5d8e2]">
              Every open claim is published with its pins, reproduction command and admissibility rules as JSON, Markdown, llms.txt and an
              Atom feed. {COPY.noAttackAuthorization}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/agents" variant="secondary">
              Agent API guide
            </ButtonLink>
            <a
              href="/llms.txt"
              className="inline-flex h-11 items-center rounded-sm border border-white/40 px-4 font-bold text-white no-underline hover:bg-white/10"
            >
              llms.txt
            </a>
          </div>
        </div>
      </section>
    </main>
  )
}
