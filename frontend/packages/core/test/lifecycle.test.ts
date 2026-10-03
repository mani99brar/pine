import { describe, expect, it } from 'vitest'
import { deriveStatus, nextStep, OUTCOME_META, STATUS_META, timeRemaining } from '../src/lifecycle'
import type { ClaimStatus, PublicationStep } from '../src/types'
import { answer, DEADLINE, keeperClaim, market, oracle } from './fixtures'

const BEFORE = new Date('2026-10-05T00:00:00Z')
const AFTER = new Date('2026-10-11T00:00:00Z')
const ALL: ClaimStatus[] = ['draft', 'publishing', 'open', 'awaiting_answer', 'answer_proposed', 'disputed', 'arbitration', 'resolved', 'settled', 'failed']

const confirmed = (ids: PublicationStep['id'][]): PublicationStep[] => ids.map((id) => ({ id, status: 'confirmed' as const }))

describe('meta', () => {
  it('covers every status and outcome', () => {
    for (const s of ALL) {
      expect(STATUS_META[s].label).toBeTruthy()
      expect(STATUS_META[s].description).toBeTruthy()
    }
    expect(OUTCOME_META.yes).toMatchObject({ label: 'Counterexample demonstrated', tone: 'counterexample' })
    expect(OUTCOME_META.no).toMatchObject({ label: 'No qualifying counterexample submitted', tone: 'held' })
    expect(OUTCOME_META.invalid).toMatchObject({ label: 'Resolved invalid', tone: 'invalid' })
    expect(OUTCOME_META.invalid.long).toMatch(/not a refund/)
  })
})

describe('deriveStatus', () => {
  const m = market()
  it('draft', () => {
    expect(deriveStatus({ evidenceDeadline: DEADLINE, draft: true }).status).toBe('draft')
    expect(deriveStatus({ evidenceDeadline: DEADLINE }).status).toBe('draft')
  })
  it('publishing: manifest pinned, market not yet created', () => {
    const publication = { steps: [...confirmed(['upload_manifest']), { id: 'create_market' as const, status: 'pending' as const }], resumable: true }
    expect(deriveStatus({ publication, evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('publishing')
  })
  it('publishing: market created, liquidity step failed (recoverable)', () => {
    const publication = {
      steps: [...confirmed(['upload_manifest', 'create_market', 'approve_collateral', 'split_position']), { id: 'add_liquidity_yes' as const, status: 'failed' as const }],
      resumable: true,
    }
    expect(deriveStatus({ publication, market: m, evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('publishing')
  })
  it('failed: not resumable', () => {
    const publication = { steps: [...confirmed(['upload_manifest']), { id: 'create_market' as const, status: 'failed' as const }], resumable: false }
    expect(deriveStatus({ publication, evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('failed')
  })
  it('open once required steps confirmed (optional No liquidity may be skipped)', () => {
    const publication = {
      steps: [...confirmed(['upload_manifest', 'create_market', 'approve_collateral', 'split_position', 'add_liquidity_yes']), { id: 'add_liquidity_no' as const, status: 'skipped' as const }],
    }
    expect(deriveStatus({ publication, market: m, evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('open')
    expect(deriveStatus({ market: m, oracle: oracle(), evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('open')
  })
  it('awaiting_answer after the deadline with no answer', () => {
    expect(deriveStatus({ market: m, oracle: oracle(), evidenceDeadline: DEADLINE, now: AFTER }).status).toBe('awaiting_answer')
  })
  it('answer_proposed with one answer inside its timeout', () => {
    const o = oracle({ currentAnswer: 'no', currentBond: '10', finalizesAt: '2026-10-14T12:00:00Z', history: [answer('no', '10', '2026-10-10T20:00:00Z')] })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: AFTER }).status).toBe('answer_proposed')
  })
  it('disputed with escalating answers', () => {
    const o = oracle({
      currentAnswer: 'yes',
      currentBond: '20',
      finalizesAt: '2026-10-15T12:00:00Z',
      history: [answer('no', '10', '2026-10-10T20:00:00Z'), answer('yes', '20', '2026-10-11T00:00:00Z')],
    })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: AFTER }).status).toBe('disputed')
  })
  it('arbitration when requested', () => {
    const o = oracle({
      currentAnswer: 'yes',
      finalizesAt: '2026-10-11T12:00:00Z',
      history: [answer('no', '10', '2026-10-10T20:00:00Z'), answer('yes', '20', '2026-10-11T00:00:00Z')],
      arbitration: { requested: true, status: 'pending', cost: '0.1674', requestedAt: '2026-10-11T06:00:00Z' },
    })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: new Date('2026-10-20T00:00:00Z') }).status).toBe('arbitration')
  })
  it.each(['yes', 'no', 'invalid'] as const)('resolved %s when finalized', (a) => {
    const o = oracle({ isFinalized: true, finalAnswer: a, currentAnswer: a, history: [answer(a, '10', '2026-10-10T20:00:00Z')] })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: AFTER })).toEqual({ status: 'resolved', outcome: a })
  })
  it('resolved when the timeout passes unchallenged (Reality emits no event)', () => {
    const o = oracle({ currentAnswer: 'no', finalizesAt: '2026-10-14T12:00:00Z', history: [answer('no', '10', '2026-10-10T20:00:00Z')] })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: new Date('2026-10-15T00:00:00Z') })).toEqual({ status: 'resolved', outcome: 'no' })
  })
  it('settled when the viewer has nothing left', () => {
    const o = oracle({ isFinalized: true, finalAnswer: 'yes', history: [answer('yes', '10', '2026-10-10T20:00:00Z')] })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: AFTER, settled: true })).toEqual({ status: 'settled', outcome: 'yes' })
  })
  it('answered too soon stays awaiting an answer (must be reopened)', () => {
    const o = oracle({ isFinalized: true, finalAnswer: 'too_soon', history: [answer('too_soon', '10', '2026-10-10T20:00:00Z')] })
    expect(deriveStatus({ market: m, oracle: o, evidenceDeadline: DEADLINE, now: AFTER }).status).toBe('awaiting_answer')
  })
})

describe('nextStep', () => {
  const now = BEFORE
  it('returns a plain-language step for every status', () => {
    for (const status of ALL) {
      const s = nextStep(keeperClaim({ status, outcome: status === 'resolved' || status === 'settled' ? 'no' : undefined }), now)
      expect(s.title.length).toBeGreaterThan(3)
      expect(s.detail.length).toBeGreaterThan(10)
      expect(['anyone', 'investigators', 'answerers', 'creator', 'arbitrator', 'holders']).toContain(s.actor)
      expect(`${s.title} ${s.detail}`).not.toMatch(/\b(safe|secure|certified|audited)\b/i)
    }
  })
  it('open: investigators until the deadline', () => {
    const s = nextStep(keeperClaim({ status: 'open' }), now)
    expect(s.detail).toContain('Investigators can submit evidence until 2026-10-10 18:00 UTC')
    expect(s.actor).toBe('investigators')
    expect(s.at).toBe(DEADLINE)
  })
  it('answer_proposed: challenge by doubling the bond', () => {
    const o = oracle({ currentAnswer: 'no', currentBond: '10', finalizesAt: '2026-10-14T12:00:00Z', history: [answer('no', '10', '2026-10-10T20:00:00Z')] })
    const s = nextStep(keeperClaim({ status: 'answer_proposed', market: market(), oracle: o }), AFTER)
    expect(s.detail).toContain('Answer stands unless challenged by 2026-10-14 12:00 UTC; anyone can challenge by doubling the bond (at least 20 xDAI)')
    expect(s.actor).toBe('anyone')
  })
  it('arbitration: Kleros jurors reviewing', () => {
    const o = oracle({ arbitration: { requested: true, status: 'pending', cost: '0.1674' } })
    const s = nextStep(keeperClaim({ status: 'arbitration', oracle: o }), AFTER)
    expect(s.detail).toMatch(/^Kleros jurors are reviewing; ruling expected/)
    expect(s.actor).toBe('arbitrator')
  })
  it('disputed: arbitration fee is paid in ETH on Ethereum', () => {
    const o = oracle({ currentAnswer: 'yes', currentBond: '20', finalizesAt: '2026-10-15T00:00:00Z', history: [] })
    expect(nextStep(keeperClaim({ status: 'disputed', oracle: o }), AFTER).detail).toMatch(/ETH on Ethereum/)
  })
  it('resolved yes / no / invalid', () => {
    expect(nextStep(keeperClaim({ status: 'resolved', outcome: 'yes' }), AFTER).detail).toContain('Holders of Yes tokens can redeem')
    expect(nextStep(keeperClaim({ status: 'resolved', outcome: 'no' }), AFTER).detail).toContain('Holders of No tokens can redeem')
    expect(nextStep(keeperClaim({ status: 'resolved', outcome: 'invalid' }), AFTER).detail).toMatch(/not a refund/)
  })
  it('publishing: resume from the first incomplete step', () => {
    const s = nextStep(
      keeperClaim({
        status: 'publishing',
        publication: { steps: [...confirmed(['upload_manifest', 'create_market']), { id: 'approve_collateral', status: 'failed' }], resumable: true },
      }),
      now,
    )
    expect(s.detail).toContain('2 of 3 steps complete')
    expect(s.detail).toContain('approve collateral')
    expect(s.detail).toContain('terms are frozen')
    expect(s.actor).toBe('creator')
  })
  it('awaiting_answer before the oracle opens', () => {
    const o = oracle({ openingTime: '2026-10-12T00:00:00Z' })
    const s = nextStep(keeperClaim({ status: 'awaiting_answer', oracle: o }), AFTER)
    expect(s.actor).toBe('answerers')
    expect(s.at).toBe('2026-10-12T00:00:00Z')
    expect(s.detail).toMatch(/at least 10 xDAI/)
  })
})

describe('timeRemaining', () => {
  it('formats durations and flags the past', () => {
    expect(timeRemaining('2026-10-07T04:00:00Z', new Date('2026-10-05T00:00:00Z'))).toEqual({ ms: (2 * 24 + 4) * 3600_000, label: '2d 4h', past: false })
    const past = timeRemaining('2026-10-04T21:00:00Z', new Date('2026-10-05T00:00:00Z'))
    expect(past.past).toBe(true)
    expect(past.label).toBe('3h')
    expect(past.ms).toBeLessThan(0)
    expect(timeRemaining('garbage').past).toBe(true)
  })
})

describe('deriveStatus edge cases', () => {
  it('a created market is never "failed", even if a later step failed irrecoverably', () => {
    const publication = {
      steps: [
        { id: 'upload_manifest' as const, status: 'confirmed' as const },
        { id: 'create_market' as const, status: 'confirmed' as const },
        { id: 'approve_collateral' as const, status: 'failed' as const },
      ],
      resumable: false,
    }
    expect(deriveStatus({ publication, market: market(), evidenceDeadline: DEADLINE, now: BEFORE }).status).toBe('publishing')
  })
})
