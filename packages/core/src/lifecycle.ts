/**
 * Claim lifecycle: status/outcome metadata, status derivation from chain state, and "what happens next".
 */
import { getChainOrDefault } from './chains'
import { COPY } from './copy'
import { fromScaled, toScaled } from './decimal'
import { formatAmount, formatDate, formatDuration } from './format'
import type {
  ClaimDetail,
  ClaimStatus,
  IsoDate,
  MarketState,
  OracleState,
  Outcome,
  PublicationStep,
  RealityAnswer,
  TxStepId,
} from './types'

export type StatusTone = 'neutral' | 'active' | 'warning' | 'critical' | 'muted'

export const STATUS_META: Record<ClaimStatus, { label: string; description: string; tone: StatusTone }> = {
  draft: {
    label: 'Draft',
    description: 'Not published yet. Terms can still change.',
    tone: 'muted',
  },
  publishing: {
    label: 'Publishing',
    description: 'Partially created or funded. The remaining steps can be resumed.',
    tone: 'warning',
  },
  open: {
    label: 'Open for evidence',
    description: 'The evidence window is open and the market is trading.',
    tone: 'active',
  },
  awaiting_answer: {
    label: 'Awaiting answer',
    description: 'The evidence deadline has passed. Waiting for an answer on Reality.eth.',
    tone: 'neutral',
  },
  answer_proposed: {
    label: 'Answer proposed',
    description: 'An answer has been posted with a bond and can be challenged until its timeout.',
    tone: 'warning',
  },
  disputed: {
    label: 'Disputed',
    description: 'The answer has been challenged and bonds are escalating.',
    tone: 'critical',
  },
  arbitration: {
    label: 'In arbitration',
    description: 'Escalated to Kleros. Jurors are reviewing the evidence.',
    tone: 'critical',
  },
  resolved: {
    label: 'Resolved',
    description: 'The oracle answer is final. See the outcome.',
    tone: 'neutral',
  },
  settled: {
    label: 'Settled',
    description: 'Resolved, and nothing is left to redeem or withdraw for this account.',
    tone: 'muted',
  },
  failed: {
    label: 'Failed',
    description: 'Creation failed and cannot be resumed.',
    tone: 'critical',
  },
}

export const OUTCOME_META: Record<Outcome, { label: string; long: string; tone: 'counterexample' | 'held' | 'invalid' }> = {
  yes: { label: COPY.outcome.yes, long: COPY.outcomeLong.yes, tone: 'counterexample' },
  no: { label: COPY.outcome.no, long: COPY.outcomeLong.no, tone: 'held' },
  invalid: { label: COPY.outcome.invalid, long: COPY.outcomeLong.invalid, tone: 'invalid' },
}

/** Ordered lifecycle phases for timelines/steppers. */
export const STATUS_ORDER: ClaimStatus[] = [
  'draft',
  'publishing',
  'open',
  'awaiting_answer',
  'answer_proposed',
  'disputed',
  'arbitration',
  'resolved',
  'settled',
]

export const REALITY_ANSWER_LABEL: Record<RealityAnswer, string> = {
  yes: 'Yes',
  no: 'No',
  invalid: 'Invalid',
  too_soon: 'Answered too soon',
}

function toDate(iso: IsoDate | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Time until `to`. `ms` is negative when `to` is in the past; `label` is the absolute duration
 * ("2d 4h", "4h 12m", "<1m") — render "ago"/"left" yourself using `past`.
 */
export function timeRemaining(to: IsoDate, now: Date = new Date()): { ms: number; label: string; past: boolean } {
  const d = toDate(to)
  if (!d) return { ms: 0, label: '—', past: true }
  const ms = d.getTime() - now.getTime()
  return { ms, label: formatDuration(ms), past: ms <= 0 }
}

/** Steps that must be confirmed (or skipped) before a claim counts as published. */
const REQUIRED_PUBLICATION_STEPS: TxStepId[] = ['upload_manifest', 'create_market', 'approve_collateral', 'split_position', 'add_liquidity_yes']

export interface DeriveStatusInput {
  publication?: { steps: PublicationStep[]; resumable?: boolean }
  market?: MarketState
  oracle?: OracleState
  evidenceDeadline: IsoDate
  now?: Date
  /** Additive: true while the claim only exists as a local draft */
  draft?: boolean
  /** Additive: resolved and the viewing account has nothing left to redeem or withdraw */
  settled?: boolean
}

function mapFinal(answer: RealityAnswer | undefined): Outcome | undefined {
  if (answer === 'yes' || answer === 'no' || answer === 'invalid') return answer
  return undefined
}

/**
 * Derive the lifecycle status from publication progress, market and oracle state and the clock.
 *
 * Precedence: draft → failed/publishing (publication incomplete) → resolved/settled (finalized, or the
 * current answer's timeout has passed with no arbitration) → arbitration → disputed (more than one answer)
 * → answer_proposed → open (before the evidence deadline) → awaiting_answer.
 * A final "answered too soon" answer maps to awaiting_answer (the question must be reopened).
 */
export function deriveStatus(input: DeriveStatusInput): { status: ClaimStatus; outcome?: Outcome } {
  const now = input.now ?? new Date()
  if (input.draft) return { status: 'draft' }

  const pub = input.publication
  if (pub && pub.steps.length > 0) {
    const anyFailed = pub.steps.some((s) => s.status === 'failed')
    const marketStep = pub.steps.find((s) => s.id === 'create_market')
    const marketConfirmed = !!input.market || marketStep?.status === 'confirmed'
    const incomplete = pub.steps.some(
      (s) => REQUIRED_PUBLICATION_STEPS.includes(s.id) && s.status !== 'confirmed' && s.status !== 'skipped',
    )
    if (anyFailed && pub.resumable === false) return { status: 'failed' }
    if (!marketConfirmed) return { status: anyFailed && pub.resumable === false ? 'failed' : 'publishing' }
    if (incomplete) return { status: 'publishing' }
  } else if (!input.market) {
    return { status: 'draft' }
  }

  const oracle = input.oracle
  if (oracle) {
    if (oracle.isFinalized) {
      const outcome = mapFinal(oracle.finalAnswer ?? oracle.currentAnswer)
      if (outcome) return { status: input.settled ? 'settled' : 'resolved', outcome }
      return { status: 'awaiting_answer' }
    }
    const arb = oracle.arbitration
    if (arb && arb.requested && (arb.status === 'pending' || arb.status === 'appeal_period' || arb.status === 'ruled')) {
      return { status: 'arbitration' }
    }
    if (oracle.currentAnswer) {
      const finalizesAt = toDate(oracle.finalizesAt)
      if (finalizesAt && finalizesAt.getTime() <= now.getTime()) {
        const outcome = mapFinal(oracle.currentAnswer)
        if (outcome) return { status: input.settled ? 'settled' : 'resolved', outcome }
        return { status: 'awaiting_answer' }
      }
      return { status: oracle.history.length > 1 ? 'disputed' : 'answer_proposed' }
    }
  }

  const deadline = toDate(input.evidenceDeadline)
  if (deadline && now.getTime() < deadline.getTime()) return { status: 'open' }
  return { status: 'awaiting_answer' }
}

export type NextStepActor = 'anyone' | 'investigators' | 'answerers' | 'creator' | 'arbitrator' | 'holders'

export interface NextStep {
  title: string
  detail: string
  at?: IsoDate
  actor: NextStepActor
}

const STEP_LABEL: Record<TxStepId, string> = {
  upload_manifest: 'pin the manifest',
  create_market: 'create the market',
  approve_collateral: 'approve collateral',
  split_position: 'split collateral into outcome tokens',
  add_liquidity_yes: 'add Yes liquidity',
  add_liquidity_no: 'add No liquidity',
  register_claim: 'register the claim',
  upload_evidence: 'upload the evidence package',
  submit_evidence: 'submit evidence on-chain',
  redeem_positions: 'redeem positions',
  approve_outcome_tokens: 'approve outcome tokens',
}

function doubled(bond: string | undefined): string | undefined {
  if (!bond) return undefined
  const scaled = toScaled(bond, 18)
  if (!scaled || scaled.value <= 0n) return undefined
  // display only; on-chain Reality.eth enforces >= 2x the previous bond
  return formatAmount(fromScaled(scaled.value * 2n, 18), { maxDecimals: 6 })
}

/** Plain-language "what happens next, who acts, when" for a claim. */
export function nextStep(claim: ClaimDetail, now: Date = new Date()): NextStep {
  const oracle = claim.oracle
  const bondToken = oracle?.bondToken ?? claim.manifest?.claim?.oracle?.bondToken ?? 'xDAI'
  const deadline = claim.evidenceDeadline
  const deadlineText = formatDate(deadline, 'utc')

  switch (claim.status) {
    case 'draft':
      return {
        title: 'Finish the draft',
        detail: 'The creator can still edit every term. Nothing is on-chain until the market is created.',
        actor: 'creator',
      }
    case 'publishing': {
      const steps = claim.publication?.steps ?? []
      const done = steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped').length
      const next = steps.find((s) => s.status !== 'confirmed' && s.status !== 'skipped')
      const marketCreated = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed') || !!claim.market
      return {
        title: 'Resume publication',
        detail:
          `${done} of ${steps.length || '?'} steps complete.` +
          (next ? ` The creator can resume and ${STEP_LABEL[next.id]}.` : '') +
          (marketCreated ? ' The market already exists, so its terms are frozen.' : ' Terms can still change until the market is created.'),
        actor: 'creator',
      }
    }
    case 'failed':
      return {
        title: 'Publication failed',
        detail:
          claim.publication?.note ??
          'This publication cannot be resumed. Check the transaction history for anything already on-chain; a changed claim needs a new market.',
        actor: 'creator',
      }
    case 'open':
      return {
        title: 'Evidence window open',
        detail: `Investigators can submit evidence until ${deadlineText}. ${COPY.deadlineIsNotTradingCutoff}`,
        at: deadline,
        actor: 'investigators',
      }
    case 'awaiting_answer': {
      if (oracle?.isFinalized && (oracle.finalAnswer ?? oracle.currentAnswer) === 'too_soon') {
        return {
          title: 'Question must be reopened',
          detail: `The final answer was "answered too soon". ${COPY.answeredTooSoon} Anyone can reopen it.`,
          actor: 'anyone',
        }
      }
      const opening = oracle?.openingTime ?? claim.manifest?.claim?.oracle?.openingTime
      const openingDate = toDate(opening)
      const minBond = oracle?.minBond ?? claim.manifest?.claim?.oracle?.minBond
      const bondText = minBond ? ` with a bond of at least ${formatAmount(minBond)} ${bondToken}` : ' with a bond'
      if (openingDate && openingDate.getTime() > now.getTime()) {
        return {
          title: 'Waiting for the oracle to open',
          detail: `The evidence deadline has passed. From ${formatDate(opening as string, 'utc')} anyone can answer on Reality.eth${bondText}.`,
          at: opening,
          actor: 'answerers',
        }
      }
      return {
        title: 'Waiting for an answer',
        detail: `Anyone can post an answer on Reality.eth${bondText}. Timely evidence submitted before ${deadlineText} is what the answer must reflect.`,
        at: opening,
        actor: 'answerers',
      }
    }
    case 'answer_proposed': {
      const answer = oracle?.currentAnswer ? REALITY_ANSWER_LABEL[oracle.currentAnswer] : 'The current answer'
      const finalizes = oracle?.finalizesAt
      const challenge = doubled(oracle?.currentBond)
      return {
        title: `Answer "${answer}" proposed`,
        detail:
          `Answer stands unless challenged by ${finalizes ? formatDate(finalizes, 'utc') : 'the end of its timeout'}; ` +
          `anyone can challenge by doubling the bond${challenge ? ` (at least ${challenge} ${bondToken})` : ''}.`,
        at: finalizes,
        actor: 'anyone',
      }
    }
    case 'disputed': {
      const answer = oracle?.currentAnswer ? REALITY_ANSWER_LABEL[oracle.currentAnswer] : 'The latest answer'
      const finalizes = oracle?.finalizesAt
      const challenge = doubled(oracle?.currentBond)
      const fee = oracle?.arbitration?.cost
      const arbCfg = getChainOrDefault(claim.chainId).arbitration
      return {
        title: 'Answer disputed',
        detail:
          `"${answer}" stands unless challenged by ${finalizes ? formatDate(finalizes, 'utc') : 'the end of its timeout'}. ` +
          `Anyone can post a different answer by doubling the bond${challenge ? ` (at least ${challenge} ${bondToken})` : ''}, ` +
          `or request Kleros arbitration by paying the arbitration fee in ${arbCfg.feeCurrency} on Ethereum${fee ? ` (${formatAmount(fee)} ${arbCfg.feeCurrency})` : ` (about ${arbCfg.feeEstimate} ${arbCfg.feeCurrency})`}.`,
        at: finalizes,
        actor: 'anyone',
      }
    }
    case 'arbitration': {
      const arb = oracle?.arbitration
      if (arb?.status === 'appeal_period' || arb?.status === 'ruled') {
        return {
          title: arb.status === 'ruled' ? 'Ruling given' : 'Appeal period',
          detail:
            arb.status === 'ruled'
              ? 'Kleros has ruled. The ruling is reported to Reality.eth, which then finalizes the market.'
              : `Kleros jurors have ruled${arb.ruling ? ` "${REALITY_ANSWER_LABEL[arb.ruling]}"` : ''}; the ruling can be appealed${arb.appealDeadline ? ` until ${formatDate(arb.appealDeadline, 'utc')}` : ''}. Appeals require funding.`,
          at: arb.appealDeadline,
          actor: 'anyone',
        }
      }
      return {
        title: 'In Kleros arbitration',
        detail: (() => {
          const a = getChainOrDefault(claim.chainId).arbitration
          return `Kleros jurors are reviewing; ruling expected about ${a.typicalRulingDays} days after the dispute is created, plus about ${a.typicalAppealDays} days per appeal round. The ruling is then relayed to Reality.eth, which finalizes the answer.`
        })(),
        at: arb?.appealDeadline,
        actor: 'arbitrator',
      }
    }
    case 'resolved': {
      if (claim.outcome === 'yes') {
        return {
          title: 'Counterexample demonstrated',
          detail: 'Holders of Yes tokens can redeem them for collateral. Liquidity providers can withdraw their remaining positions.',
          actor: 'holders',
        }
      }
      if (claim.outcome === 'no') {
        return {
          title: 'No qualifying counterexample submitted',
          detail: `Holders of No tokens can redeem them for collateral. ${COPY.noIsNotSafety}`,
          actor: 'holders',
        }
      }
      return {
        title: 'Resolved invalid',
        detail: `Token holders can redeem according to Seer's native rules for invalid outcomes. ${COPY.invalidIsNotRefund}`,
        actor: 'holders',
      }
    }
    case 'settled':
      return {
        title: 'Settled',
        detail: 'This claim is final and this account has nothing left to redeem or withdraw.',
        actor: 'holders',
      }
  }
}

/** Remaining time to the evidence deadline, rounded for headings: "2d 4h left" / "ended 3h ago". */
export function deadlineLabel(deadline: IsoDate, now: Date = new Date()): string {
  const t = timeRemaining(deadline, now)
  return t.past ? `ended ${t.label} ago` : `${t.label} left`
}
