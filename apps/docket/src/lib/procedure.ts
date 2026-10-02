import type { ClaimDetail, IsoDate } from '@pine/core'

export type StageId = 'filed' | 'evidence' | 'deadline' | 'answer' | 'challenge' | 'arbitration' | 'final' | 'settlement'
export type StageState = 'done' | 'current' | 'upcoming' | 'skipped' | 'failed'

export interface ProcedureStage {
  id: StageId
  n: number
  title: string
  state: StageState
  at?: IsoDate
  /** "Filed", "Closes", "Opens", "Expected"… */
  atLabel?: string
  summary: string
  who: string
  anchor: string
  optional?: boolean
}

/** The eight stages of the procedure, in order, with generic explanations (used on landing and glossary too). */
export const PROCEDURE: { id: StageId; title: string; summary: string; who: string; anchor: string; optional?: boolean }[] = [
  {
    id: 'filed',
    title: 'Filed',
    summary: 'The claim, its policy and the exact commit are pinned and the market is created. From here the terms cannot change.',
    who: 'The filer',
    anchor: 'terms',
  },
  {
    id: 'evidence',
    title: 'Evidence window open',
    summary: 'Anyone may investigate and file exhibits: reproducible counterexamples against the pinned commit.',
    who: 'Investigators, human or AI',
    anchor: 'exhibits',
  },
  {
    id: 'deadline',
    title: 'Evidence deadline',
    summary: 'An absolute UTC time. Exhibits filed after it are not timely. Trading may continue; it is not a trading cutoff.',
    who: 'Nobody: it passes automatically',
    anchor: 'exhibits',
  },
  {
    id: 'answer',
    title: 'Oracle answer',
    summary: 'Once the oracle opens, anyone may answer the question on Reality.eth by posting a bond.',
    who: 'Answerers, anyone with a bond',
    anchor: 'oracle',
  },
  {
    id: 'challenge',
    title: 'Challenge window',
    summary: 'A posted answer stands unless someone challenges it by doubling the bond within 3.5 days. Each new answer restarts the 3.5-day clock.',
    who: 'Anyone who disagrees',
    anchor: 'oracle',
  },
  {
    id: 'arbitration',
    title: 'Arbitration',
    summary: 'Only if requested. Kleros jurors on Ethereum review the exhibits and rule. A first ruling takes about two weeks, plus about 11 days per appeal. The requester pays the fee in ETH.',
    who: 'Kleros jurors',
    anchor: 'oracle',
    optional: true,
  },
  {
    id: 'final',
    title: 'Final answer',
    summary: 'The answer becomes final and the market resolves: counterexample demonstrated, none submitted, or invalid.',
    who: 'Nobody: it finalizes automatically',
    anchor: 'outcome',
  },
  {
    id: 'settlement',
    title: 'Settlement',
    summary: 'Token holders redeem, and liquidity providers withdraw whatever their positions are worth.',
    who: 'Token holders and liquidity providers',
    anchor: 'position',
  },
]

function eventAt(claim: ClaimDetail, kind: string): IsoDate | undefined {
  return claim.timeline.find((e) => e.kind === kind)?.at
}

/** Map a claim onto the eight procedural stages with dates and states. */
export function procedureFor(claim: ClaimDetail): ProcedureStage[] {
  const s = claim.status
  const o = claim.oracle
  const arb = o?.arbitration
  const firstAnswer = o?.history[0]?.at ?? eventAt(claim, 'answer_posted')
  const finalAt = eventAt(claim, 'finalized') ?? (o?.isFinalized ? o.finalizesAt : undefined)
  const arbitrationRequested = !!arb?.requested

  // Index of the current stage in PROCEDURE.
  const currentIndex: Record<string, number> = {
    draft: 0,
    publishing: 0,
    failed: 0,
    open: 1,
    awaiting_answer: 3,
    answer_proposed: 4,
    disputed: 4,
    arbitration: 5,
    resolved: 7,
    settled: 8,
  }
  const cur = currentIndex[s] ?? 0

  return PROCEDURE.map((p, i) => {
    let state: StageState = i < cur ? 'done' : i === cur ? 'current' : 'upcoming'
    if (p.id === 'filed' && s === 'failed') state = 'failed'
    // Deadline is a moment, not a stage someone works in: it is "done" once we are past the window.
    if (p.id === 'deadline' && cur > 2) state = 'done'
    if (p.id === 'arbitration') {
      if (cur > 5 && !arbitrationRequested) state = 'skipped'
    }

    let at: IsoDate | undefined
    let atLabel: string | undefined
    switch (p.id) {
      case 'filed':
        at = claim.market?.createdAt ?? claim.createdAt
        atLabel = s === 'publishing' ? 'Started' : 'Filed'
        break
      case 'evidence':
        at = claim.evidenceDeadline
        atLabel = state === 'done' ? 'Closed' : 'Closes'
        break
      case 'deadline':
        at = claim.evidenceDeadline
        atLabel = state === 'done' ? 'Passed' : 'Due'
        break
      case 'answer':
        at = firstAnswer ?? o?.openingTime ?? claim.manifest?.claim?.oracle?.openingTime
        atLabel = firstAnswer ? 'Answered' : 'Opens'
        break
      case 'challenge':
        at = o?.finalizesAt
        atLabel = state === 'done' ? 'Ended' : at ? 'Ends' : undefined
        break
      case 'arbitration':
        at = arb?.requestedAt
        atLabel = at ? 'Requested' : undefined
        break
      case 'final':
        at = finalAt
        atLabel = finalAt ? 'Final' : undefined
        break
      case 'settlement':
        at = eventAt(claim, 'redeemed')
        atLabel = at ? 'Redeemed' : undefined
        break
    }

    return { ...p, n: i + 1, state, at, atLabel }
  })
}

export const ACTOR_LABEL: Record<string, string> = {
  anyone: 'Anyone',
  investigators: 'Investigators',
  answerers: 'Oracle answerers',
  creator: 'The filer',
  arbitrator: 'Kleros jurors',
  holders: 'Token holders and liquidity providers',
}

export const ACTOR_EXPLAINER: Record<string, string> = {
  anyone: 'Any person or agent can act. No permission is needed.',
  investigators: 'Anyone can investigate the pinned commit and file a reproducible counterexample as an exhibit.',
  answerers: 'Anyone can post the answer on Reality.eth. Posting requires a bond that is lost if the answer is overturned.',
  creator: 'Only the account that filed this claim can take this step.',
  arbitrator: 'Kleros jurors are deciding. Parties may submit arguments, and appeals require funding.',
  holders: 'People holding outcome tokens or liquidity positions in this market.',
}
