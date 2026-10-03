/** api read side: status mapping, answer decoding and policy catalog mapping (pure functions). */
import { describe, expect, it } from 'vitest'
import type { ClaimStatus, Outcome } from '@pine/core'
import {
  answerFromBytes32,
  claimStatusOf,
  outcomeFromPayouts,
  policyFamilyOf,
  policyFromApi,
  policyParametersFromSchema,
  policySectionsFromText,
  policyStatusOf,
  type ApiClaimPhase,
  type ApiWireOracleStatus,
} from '../src'
import { apiPolicyDetailSchema, apiPolicyParametersSchema } from '../src'
import { BOT_TEXT, botParametersSchema, funcParametersSchema, policyDetail } from './api-read-fixtures'

const answered = (outcome: 'yes' | 'no' | 'invalid' | 'answered_too_soon'): ApiWireOracleStatus => ({ state: 'answered', outcome, bond: '10000000000000000000', finalizesAt: 1_800_000_000 })
const finalized = (outcome: 'yes' | 'no' | 'invalid' | 'answered_too_soon'): ApiWireOracleStatus => ({ state: 'finalized', outcome, byArbitrator: false })
const payouts = (...n: string[]) => ({ payoutNumerators: n })

describe('claimStatusOf (backend phase + oracle + resolution → ClaimStatus)', () => {
  const table: [ApiClaimPhase, ApiWireOracleStatus | null, { payoutNumerators: string[] } | null, ClaimStatus, Outcome | undefined][] = [
    ['evidence_open', { state: 'not_open', opensAt: 1_800_000_000 }, null, 'open', undefined],
    // Evidence is closed on chain once the evidence deadline passes: the reveal window is not "open for evidence".
    ['reveal_open', { state: 'not_open', opensAt: 1_800_000_000 }, null, 'awaiting_answer', undefined],
    ['oracle_open', null, null, 'awaiting_answer', undefined],
    ['oracle_open', { state: 'not_open', opensAt: 1_800_000_000 }, null, 'awaiting_answer', undefined],
    ['oracle_open', { state: 'open_unanswered' }, null, 'awaiting_answer', undefined],
    ['oracle_open', answered('yes'), null, 'answer_proposed', undefined],
    ['oracle_open', answered('answered_too_soon'), null, 'answer_proposed', undefined],
    ['oracle_open', { state: 'pending_arbitration', outcome: 'no', requestedBy: null }, null, 'arbitration', undefined],
    ['pending_arbitration', { state: 'pending_arbitration', outcome: null, requestedBy: null }, null, 'arbitration', undefined],
    ['finalized', finalized('yes'), null, 'resolved', 'yes'],
    ['finalized', finalized('no'), null, 'resolved', 'no'],
    ['finalized', finalized('invalid'), null, 'resolved', 'invalid'],
    // Reality settled "answered too soon": the question must be reopened; no outcome yet.
    ['finalized', finalized('answered_too_soon'), null, 'awaiting_answer', undefined],
    ['resolved', finalized('yes'), payouts('1', '0', '0'), 'resolved', 'yes'],
    ['resolved', finalized('no'), payouts('0', '1', '0'), 'resolved', 'no'],
    ['resolved', null, payouts('0', '0', '1'), 'resolved', 'invalid'],
    ['resolved', finalized('no'), null, 'resolved', 'no'],
    // A split payout has no single winning outcome.
    ['resolved', null, payouts('1', '1', '0'), 'resolved', undefined],
    // The payout the market pays wins over the oracle summary.
    ['resolved', finalized('yes'), payouts('0', '1', '0'), 'resolved', 'no'],
  ]

  it.each(table)('%s + %j + %j → %s %s', (phase, oracle, resolution, status, outcome) => {
    const r = claimStatusOf({ phase, oracle, resolution })
    expect(r.status).toBe(status)
    expect(r.outcome).toBe(outcome)
    if (outcome === undefined) expect('outcome' in r).toBe(false)
  })
})

describe('answers and payouts', () => {
  it('decodes Seer categorical Reality answers', () => {
    expect(answerFromBytes32(`0x${'0'.repeat(64)}`)).toBe('yes')
    expect(answerFromBytes32(`0x${'0'.repeat(63)}1`)).toBe('no')
    expect(answerFromBytes32(`0x${'f'.repeat(64)}`)).toBe('invalid')
    expect(answerFromBytes32(`0x${'F'.repeat(63)}E`)).toBe('too_soon')
    expect(answerFromBytes32(`0x${'0'.repeat(63)}7`)).toBe('invalid')
  })

  it('finds the single winning outcome of a payout vector', () => {
    expect(outcomeFromPayouts(['1', '0', '0'])).toBe('yes')
    expect(outcomeFromPayouts(['0', '1', '0'])).toBe('no')
    expect(outcomeFromPayouts(['0', '0', '1'])).toBe('invalid')
    expect(outcomeFromPayouts(['0', '0', '0'])).toBeUndefined()
    expect(outcomeFromPayouts(['1', '1', '1'])).toBeUndefined()
    expect(outcomeFromPayouts(undefined)).toBeUndefined()
  })
})

describe('policy catalog mapping', () => {
  it('derives the family from the id prefix only', () => {
    expect(policyFamilyOf('FUNC-001')).toBe('FUNC')
    expect(policyFamilyOf('BOT-001')).toBe('BOT')
    expect(policyFamilyOf('SC-001')).toBe('SC')
    expect(policyFamilyOf('XYZ-001')).toBeNull()
  })

  it('maps the backend status and publishability of THIS deployment', () => {
    expect(policyStatusOf({ status: 'approved', publishable: true })).toEqual({ status: 'enabled' })
    expect(policyStatusOf({ status: 'draft', publishable: true })).toEqual({ status: 'draft' })
    expect(policyStatusOf({ status: 'retired', publishable: false })).toEqual({ status: 'retired' })
    expect(policyStatusOf({ status: 'approved', publishable: false })).toEqual({ status: 'gated', gateReason: 'This policy is not enabled on this deployment.' })
    expect(policyStatusOf({ status: 'draft', publishable: false }).status).toBe('gated')
    expect(policyStatusOf({ status: 'disabled', publishable: false }, 'Requires a disclosure process.')).toEqual({ status: 'gated', gateReason: 'Requires a disclosure process.' })
  })

  it('turns the parameter JSON Schema into composer fields', () => {
    const bot = policyParametersFromSchema(apiPolicyParametersSchema.parse(botParametersSchema))
    expect(bot).toEqual([
      { key: 'sourceRequirement', label: 'Source requirement', help: '', required: true, kind: 'longtext', maxLength: 1000 },
      { key: 'startingStates', label: 'Starting states', help: '', required: true, kind: 'longtext', maxLength: 4000 },
      { key: 'simulatedAdapters', label: 'Simulated adapters', help: '', required: true, kind: 'list', maxLength: 100 },
    ])
    const func = policyParametersFromSchema(apiPolicyParametersSchema.parse(funcParametersSchema))
    expect(func).toEqual([{ key: 'formatDefinition', label: 'Format definition', help: '', required: false, kind: 'longtext', maxLength: 4000 }])
    const other = policyParametersFromSchema(
      apiPolicyParametersSchema.parse({
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['strict', 'lenient'] },
          label: { type: 'string', maxLength: 120, description: 'Shown in lists' },
          flags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
          enabled: { type: 'boolean' },
          count: { type: 'integer' },
        },
        required: ['mode'],
      }),
    )
    expect(other.map((p) => [p.key, p.kind, p.required])).toEqual([
      ['mode', 'select', true],
      ['label', 'text', false],
      ['flags', 'multiselect', false],
      ['enabled', 'boolean', false],
    ])
    expect(other[1]?.help).toBe('Shown in lists')
  })

  it('extracts plain-text sections from the policy Markdown and keeps the text itself verbatim', () => {
    const s = policySectionsFromText(BOT_TEXT)
    expect(s.summary).toBe('Verify one invariant of a keeper, treasury bot, scheduler or other stateful automation system at a pinned commit.')
    expect(s.intendedUse).toHaveLength(1)
    expect(s.evidenceRequirements).toEqual([
      'A reproducible sequence with initial state, allowed events and faults, the resulting plans and state transitions, and the violation.',
    ])
    expect(s.exclusions).toEqual([
      'No claim requires or authorises live transfers, production keys or attacks on services.',
      'Simulation evidence cannot establish that a real bridge integration works.',
    ])
    expect(s.outcomeRules.yes).toBe('Yes (answer index 0): at least one timely, admissible submission demonstrates the named violation.')
    expect(s.outcomeRules.no).toBe('No (answer index 1): no timely, admissible submission demonstrates it.')
    expect(s.outcomeRules.invalid).toMatch(/^Invalid \(Reality\.eth invalid answer\)/)

    const detail = apiPolicyDetailSchema.parse(policyDetail('BOT-001'))
    const p = policyFromApi(detail, detail, null)
    // Markdown is passed through as data for the sanitized renderer; nothing is rendered here (SEC-EVID-10).
    expect(p?.text).toBe(BOT_TEXT)
    expect(p?.text).toContain('<img src=x onerror=alert(1)>')
    expect(p).toMatchObject({ id: 'BOT-001', family: 'BOT', status: 'draft', examples: [], claimClasses: [], publishedAt: '' })
  })

  it('omits policies of an unknown family instead of mislabelling them', () => {
    const summary = { ...policyDetail('BOT-001'), id: 'XYZ-001' }
    expect(policyFromApi(apiPolicyDetailSchema.parse(summary), null, null)).toBeNull()
  })
})
