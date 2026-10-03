'use client'

import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatDate, nextStep, REALITY_ANSWER_LABEL } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ArrowDown, FilePlus2, Gavel, RotateCcw, Scale } from 'lucide-react'
import { StageBand } from '@/components/ui/stage'
import { ButtonLink } from '@/components/ui/button'
import { ExternalLink } from '@/components/ui/external-link'
import { When, useClientNow } from '@/components/ui/when'
import { ACTOR_EXPLAINER, ACTOR_LABEL } from '@/lib/procedure'

/** An oracle answer with what it means, so "Yes" is never read as "yes, the code works". */
function answerWithMeaning(a: keyof typeof REALITY_ANSWER_LABEL | undefined): string {
  if (!a) return '?'
  if (a === 'yes') return `“Yes” (${COPY.outcome.yes.toLowerCase()})`
  if (a === 'no') return `“No” (${COPY.outcome.no.toLowerCase()})`
  return `“${REALITY_ANSWER_LABEL[a]}”`
}

/** One plain sentence: where the claim stands right now. */
export function standingSentence(c: ClaimDetail): string {
  const timely = c.evidence.filter((e) => e.timely).length
  const counter = c.evidence.filter((e) => e.timely && e.kind === 'counterexample').length
  const o = c.oracle
  const bondToken = o?.bondToken ?? 'xDAI'
  switch (c.status) {
    case 'draft':
      return 'This claim is still a draft. Nothing has been published.'
    case 'publishing': {
      const steps = c.publication?.steps ?? []
      const done = steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped').length
      const created = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed') || !!c.market
      return `Filing started but did not finish: ${done} of ${steps.length} steps are confirmed.${created ? ' The market exists, so the terms are already frozen.' : ''}`
    }
    case 'failed':
      return 'This filing failed and cannot be resumed. What reached the chain, and why it stopped, is set out under “Filing failed” below.'
    case 'open': {
      if (timely === 0) return 'The evidence window is open. No exhibits have been filed yet.'
      const sealed = c.evidence.filter((e) => e.timely && e.kind === 'commitment').length
      const parts = [
        counter ? `${counter} presented as ${counter === 1 ? 'a counterexample' : 'counterexamples'}` : 'none presented as a counterexample',
        sealed ? `${sealed} sealed, so ${sealed === 1 ? 'its' : 'their'} contents stay hidden until revealed` : '',
      ].filter(Boolean)
      return `The evidence window is open. ${timely} exhibit${timely === 1 ? ' has' : 's have'} been filed so far: ${parts.join(', and ')}.`
    }
    case 'awaiting_answer':
      return `The evidence deadline passed on ${formatDate(c.evidenceDeadline, 'long')}. ${timely} timely exhibit${timely === 1 ? ' is' : 's are'} on file. The question now needs an answer on Reality.eth.`
    case 'answer_proposed': {
      const a = o?.history[o.history.length - 1]
      return a
        ? `An answer of ${answerWithMeaning(a.answer)} was posted on ${formatDate(a.at, 'long')}, backed by a bond of ${formatAmount(a.bond)} ${bondToken}.`
        : 'An answer has been posted and is in its challenge window.'
    }
    case 'disputed': {
      const n = o?.history.length ?? 0
      return `The answer has changed ${Math.max(0, n - 1)} time${n - 1 === 1 ? '' : 's'}. The current answer is ${answerWithMeaning(o?.currentAnswer)}, backed by ${formatAmount(o?.currentBond ?? '0')} ${bondToken}.`
    }
    case 'arbitration': {
      const arb = o?.arbitration
      const opened = `Arbitration was requested${arb?.requestedAt ? ` on ${formatDate(arb.requestedAt, 'long')}` : ''}${arb?.disputeId ? ` as Kleros dispute #${arb.disputeId}` : ''}.`
      const ruling = arb?.ruling ? answerWithMeaning(arb.ruling) : 'on the question'
      if (arb?.status === 'appeal_period') return `${opened} Jurors have ruled ${ruling}. The ruling can still be appealed.`
      if (arb?.status === 'ruled') return `${opened} Jurors have ruled ${ruling}. The ruling now has to be reported to Reality.eth.`
      return `${opened} Jurors are reviewing the timely exhibits.`
    }
    case 'resolved':
    case 'settled':
      if (c.outcome === 'yes') return `Final: ${COPY.outcome.yes}. ${COPY.outcomeLong.yes}`
      if (c.outcome === 'no') return `Final: ${COPY.outcome.no}. ${COPY.noIsNotSafety}`
      return `Final: ${COPY.outcome.invalid}. ${COPY.invalidIsNotRefund}`
  }
}

function PrimaryAction({ claim }: { claim: ClaimDetail }) {
  switch (claim.status) {
    case 'open':
      return (
        <ButtonLink href={`/claims/${claim.id}/evidence`} icon={<FilePlus2 aria-hidden />}>
          File an exhibit
        </ButtonLink>
      )
    case 'publishing':
      return (
        <ButtonLink href="#filing" icon={<RotateCcw aria-hidden />}>
          Finish filing
        </ButtonLink>
      )
    case 'answer_proposed':
    case 'disputed':
    case 'awaiting_answer':
      return (
        <>
          <ButtonLink href="#oracle" variant="secondary" icon={<Scale aria-hidden />}>
            {claim.status === 'awaiting_answer' ? 'How answering works' : 'See the answer and how to challenge'}
          </ButtonLink>
          {claim.oracle?.realityUrl ? (
            <ExternalLink href={claim.oracle.realityUrl} className="self-center">
              Open on Reality.eth
            </ExternalLink>
          ) : null}
        </>
      )
    case 'arbitration':
      return claim.oracle?.arbitration.klerosUrl ? (
        <ButtonLink href="#oracle" variant="secondary" icon={<Gavel aria-hidden />}>
          Follow the arbitration
        </ButtonLink>
      ) : null
    case 'failed':
      return (
        <ButtonLink href="/file" variant="secondary" icon={<FilePlus2 aria-hidden />}>
          Start a new filing
        </ButtonLink>
      )
    case 'resolved':
      return (
        <ButtonLink href="#position" variant="secondary" icon={<ArrowDown aria-hidden />}>
          Check what you can redeem
        </ButtonLink>
      )
    default:
      return null
  }
}

/** Package details write machine dates ("2026-10-05 22:00 UTC"); the rest of the page reads "Oct 5, 2026, 22:00 UTC". */
function humanDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?(?:Z| UTC)/g, (m, d: string, t: string) => {
    const iso = `${d}T${t}:00Z`
    return Number.isNaN(Date.parse(iso)) ? m : formatDate(iso, 'long')
  })
}

/** Name the next event rather than repeating the current stage, which the band above already states. */
function forwardLooking(claim: ClaimDetail, input: ReturnType<typeof nextStep>): ReturnType<typeof nextStep> {
  const raw = { ...input, detail: humanDates(input.detail) }
  switch (claim.status) {
    case 'open':
      return {
        ...raw,
        title: 'The evidence deadline passes',
        detail: `Until then, anyone may file a reproducible counterexample. Afterward the oracle opens for answers. ${COPY.deadlineIsNotTradingCutoff}`,
      }
    case 'awaiting_answer':
      return { ...raw, title: 'Someone answers the question on Reality.eth' }
    case 'answer_proposed':
      return { ...raw, title: 'The answer becomes final, unless challenged' }
    case 'disputed':
      return { ...raw, title: 'The latest answer becomes final, unless challenged or escalated' }
    case 'arbitration':
      return { ...raw, title: raw.title === 'Appeal period' ? 'The ruling stands, unless appealed' : raw.title === 'Ruling given' ? 'The ruling is reported to Reality.eth' : 'Kleros jurors rule' }
    case 'publishing':
      return { ...raw, title: 'The filer finishes filing', detail: raw.detail.replace(/\bThe creator\b/g, 'The filer').replace(/\bthe creator\b/g, 'the filer') }
    case 'failed':
      return {
        ...raw,
        title: 'Start a new filing',
        detail: 'A claim that never reached its market cannot be revived. A new filing, with a new deadline, gets a new market.',
      }
    case 'resolved':
      return {
        ...raw,
        title: 'Holders redeem',
        detail:
          claim.outcome === 'yes'
            ? 'Yes tokens redeem for collateral; No and Invalid-result tokens pay nothing. Liquidity providers can withdraw what their positions are worth.'
            : claim.outcome === 'no'
              ? 'No tokens redeem for collateral; Yes and Invalid-result tokens pay nothing. Liquidity providers can withdraw what their positions are worth.'
              : 'Only Invalid-result tokens redeem for collateral; Yes and No tokens pay nothing. Liquidity providers can withdraw what their positions are worth.',
      }
    case 'settled':
      return {
        ...raw,
        title: 'Nothing is pending',
        detail: 'The outcome is final and this claim’s positions have been redeemed or withdrawn. Anyone still holding winning tokens can redeem them at any time.',
      }
    default:
      return raw
  }
}

export function WhereThisStands({ claim }: { claim: ClaimDetail }) {
  const now = useClientNow(30_000)
  const raw = nextStep(claim, now ?? new Date())
  // When the next step is simply "keep going", name the event that ends the current stage instead.
  const step = forwardLooking(claim, raw)
  return (
    <section aria-labelledby="standing-title" id="standing" className="print-avoid-break">
      <h2 id="standing-title" className="sr-only">
        Where this stands
      </h2>
      <StageBand status={claim.status} outcome={claim.outcome} size="lg">
        <p className="text-lg leading-8 measure">{standingSentence(claim)}</p>
      </StageBand>
      <div className="grid border-x border-b border-rule bg-sheet md:grid-cols-3" data-print="flat">
        <div className="border-b border-rule p-5 md:border-r md:border-b-0">
          <h3 className="text-sm font-bold text-graphite">What happens next</h3>
          <p className="mt-1 text-lg font-bold">{step.title}</p>
          <p className="mt-1 text-[15px] leading-6">{step.detail}</p>
        </div>
        <div className="border-b border-rule p-5 md:border-r md:border-b-0">
          <h3 className="text-sm font-bold text-graphite">Who acts</h3>
          <p className="mt-1 text-lg font-bold">{ACTOR_LABEL[step.actor] ?? step.actor}</p>
          <p className="mt-1 text-[15px] leading-6">{ACTOR_EXPLAINER[step.actor]}</p>
        </div>
        <div className="p-5">
          <h3 className="text-sm font-bold text-graphite">By when</h3>
          {step.at ? (
            <p className="mt-1 text-lg font-bold">
              <When at={step.at} style="long" stacked relClassName="font-normal text-base" />
            </p>
          ) : (
            <p className="mt-1 text-lg font-bold">No fixed time</p>
          )}
          <p className="mt-1 text-[15px] leading-6 text-graphite">
            {step.at ? 'All times are UTC. The absolute time binds, not the countdown.' : 'This step has no deadline set by the protocol.'}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-4 print:hidden">
        <PrimaryAction claim={claim} />
      </div>
    </section>
  )
}
