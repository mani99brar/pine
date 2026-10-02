import type { ClaimStatus, Outcome } from '@pine/core'

/**
 * Docket-specific presentation of a claim's procedural stage.
 * Tones map to the palette in DESIGN.md. NO is "held" (slate), never success-green.
 */
export type StageTone = 'active' | 'waiting' | 'contested' | 'counterexample' | 'held' | 'invalid' | 'muted' | 'failed'

export interface StageView {
  label: string
  short: string
  tone: StageTone
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  yes: 'Counterexample demonstrated',
  no: 'No qualifying counterexample submitted',
  invalid: 'Resolved invalid',
}

const OUTCOME_SHORT: Record<Outcome, string> = {
  yes: 'Counterexample demonstrated',
  no: 'No qualifying counterexample',
  invalid: 'Resolved invalid',
}

export function outcomeTone(outcome: Outcome): StageTone {
  return outcome === 'yes' ? 'counterexample' : outcome === 'no' ? 'held' : 'invalid'
}

export function outcomeLabel(outcome: Outcome, short = false) {
  return short ? OUTCOME_SHORT[outcome] : OUTCOME_LABEL[outcome]
}

export function stageView(status: ClaimStatus, outcome?: Outcome): StageView {
  switch (status) {
    case 'draft':
      return { label: 'Draft, not filed', short: 'Draft', tone: 'muted' }
    case 'publishing':
      return { label: 'Filing incomplete', short: 'Filing incomplete', tone: 'waiting' }
    case 'open':
      return { label: 'Evidence window open', short: 'Evidence open', tone: 'active' }
    case 'awaiting_answer':
      return { label: 'Awaiting the oracle’s answer', short: 'Awaiting answer', tone: 'waiting' }
    case 'answer_proposed':
      return { label: 'Answer proposed, challenge window running', short: 'Challenge window', tone: 'waiting' }
    case 'disputed':
      return { label: 'Answer disputed, bonds escalating', short: 'Disputed', tone: 'contested' }
    case 'arbitration':
      return { label: 'In arbitration with Kleros', short: 'In arbitration', tone: 'contested' }
    case 'resolved':
      if (!outcome) return { label: 'Resolved', short: 'Resolved', tone: 'muted' }
      return { label: OUTCOME_LABEL[outcome], short: OUTCOME_SHORT[outcome], tone: outcomeTone(outcome) }
    case 'settled':
      return {
        label: outcome ? `Settled: ${OUTCOME_LABEL[outcome].toLowerCase()}` : 'Settled',
        short: 'Settled',
        tone: 'muted',
      }
    case 'failed':
      return { label: 'Filing failed', short: 'Filing failed', tone: 'failed' }
  }
}

/** Tailwind classes per tone: band = left bar + wash, tag = compact chip. */
export const TONE_CLASSES: Record<StageTone, { bar: string; wash: string; text: string; border: string; dot: string }> = {
  active: { bar: 'bg-violet', wash: 'bg-violet-wash', text: 'text-violet', border: 'border-violet-line', dot: 'bg-violet' },
  waiting: { bar: 'bg-ochre', wash: 'bg-wheat', text: 'text-ochre', border: 'border-wheat-line', dot: 'bg-ochre' },
  contested: { bar: 'bg-plum', wash: 'bg-mauve', text: 'text-plum', border: 'border-mauve-line', dot: 'bg-plum' },
  counterexample: { bar: 'bg-red', wash: 'bg-red-wash', text: 'text-red', border: 'border-red-line', dot: 'bg-red' },
  held: { bar: 'bg-slate', wash: 'bg-mist', text: 'text-slate', border: 'border-rule-strong', dot: 'bg-slate' },
  invalid: { bar: 'bg-graphite', wash: 'hatch', text: 'text-graphite', border: 'border-rule-strong', dot: 'bg-graphite' },
  muted: { bar: 'bg-rule-strong', wash: 'bg-bond', text: 'text-graphite', border: 'border-rule', dot: 'bg-rule-strong' },
  failed: { bar: 'bg-red', wash: 'bg-sheet', text: 'text-red', border: 'border-red-line', dot: 'bg-red' },
}

/** Grouping used by the docket: what needs attention first. */
export type DocketGroup = 'closing' | 'awaiting' | 'contested' | 'open' | 'decided' | 'incomplete' | 'settled'

export const DOCKET_GROUPS: { id: DocketGroup; title: string; description: string; attention: boolean }[] = [
  {
    id: 'closing',
    title: 'Evidence deadline within 72 hours',
    description: 'Investigators have little time left to file exhibits.',
    attention: true,
  },
  {
    id: 'awaiting',
    title: 'Awaiting or weighing the oracle’s answer',
    description: 'The deadline has passed. Someone must post an answer, or a posted answer is in its challenge window.',
    attention: true,
  },
  {
    id: 'contested',
    title: 'Disputed or in arbitration',
    description: 'An answer was challenged. Bonds are escalating, or Kleros jurors are deciding.',
    attention: true,
  },
  {
    id: 'incomplete',
    title: 'Filing incomplete',
    description: 'The market was created but funding did not finish. The filer can complete it.',
    attention: true,
  },
  { id: 'open', title: 'Evidence window open', description: 'Anyone may investigate and file exhibits.', attention: false },
  { id: 'decided', title: 'Decided', description: 'The oracle answer is final. Holders can redeem.', attention: false },
  { id: 'settled', title: 'Settled or closed', description: 'Nothing left to redeem, or the filing failed.', attention: false },
]

export function docketGroup(c: { status: ClaimStatus; evidenceDeadline: string }, now: Date): DocketGroup {
  switch (c.status) {
    case 'open': {
      const ms = new Date(c.evidenceDeadline).getTime() - now.getTime()
      return ms <= 72 * 3600_000 ? 'closing' : 'open'
    }
    case 'awaiting_answer':
    case 'answer_proposed':
      return 'awaiting'
    case 'disputed':
    case 'arbitration':
      return 'contested'
    case 'publishing':
      return 'incomplete'
    case 'resolved':
      return 'decided'
    default:
      return 'settled'
  }
}
