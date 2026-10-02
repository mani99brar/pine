import { describe, expect, it } from 'vitest'
import { COPY } from '../src/copy'
import { pinEnvironment } from '../src/question'
import {
  claimSpecSchema,
  evidenceDraftSchema,
  fundingInputSchema,
  oracleParamsSchema,
  sourceRefSchema,
  validateClaimDraft,
} from '../src/validation'
import type { ClaimDraft } from '../src/types'
import { BASE_SHA, funding, keeperDraft, keeperSpec, NOW, source } from './fixtures'

function issuesFor(draft: ClaimDraft, now = NOW) {
  return validateClaimDraft(draft, now).issues
}
function find(draft: ClaimDraft, path: string, now = NOW) {
  return issuesFor(draft, now).filter((i) => i.path === path)
}

const H = 3600_000

describe('validateClaimDraft', () => {
  it('accepts the keeper example', () => {
    const r = validateClaimDraft(keeperDraft(), NOW)
    expect(r.issues).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('never throws on an empty draft and maps issues to stages', () => {
    const r = validateClaimDraft({ id: 'x', owner: 'me', createdAt: '', updatedAt: '', stage: 'source', spec: {} }, NOW)
    expect(r.ok).toBe(false)
    const stages = new Set(r.issues.map((i) => i.stage))
    for (const s of ['source', 'policy', 'claim', 'deadlines', 'funding'] as const) expect(stages.has(s)).toBe(true)
    for (const i of r.issues) {
      expect(i.message.length).toBeGreaterThan(5)
      expect(i.path.length).toBeGreaterThan(0)
    }
  })

  it('rejects a past deadline', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: '2026-10-01T00:00:00Z' }, oracle: { ...keeperSpec().oracle, openingTime: '2026-10-01T00:00:00Z' } }) }), 'spec.evidence.deadline')
    expect(iss).toHaveLength(1)
    expect(iss[0]?.message).toMatch(/past/)
    expect(iss[0]?.stage).toBe('deadlines')
  })

  it('rejects a deadline less than 24h away', () => {
    const soon = new Date(NOW.getTime() + 23 * H).toISOString().replace('.000Z', 'Z')
    const iss = find(keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: soon }, oracle: { ...keeperSpec().oracle, openingTime: soon } }) }), 'spec.evidence.deadline')
    expect(iss[0]?.message).toMatch(/24 hours/)
  })

  it('accepts exactly 24h and rejects more than 180 days', () => {
    const exact = new Date(NOW.getTime() + 24 * H).toISOString().replace('.000Z', 'Z')
    const ok = keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: exact }, oracle: { ...keeperSpec().oracle, openingTime: exact } }) })
    expect(find(ok, 'spec.evidence.deadline')).toEqual([])
    const far = '2027-06-01T00:00:00Z'
    const tooFar = keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: far }, oracle: { ...keeperSpec().oracle, openingTime: far } }) })
    expect(find(tooFar, 'spec.evidence.deadline')[0]?.message).toMatch(/180 days/)
  })

  it.each(['2026-10-10T18:00:00+02:00', '2026-10-10 18:00', '2026-10-10T18:00:00', 'Oct 10 2026', ''])(
    'rejects non-UTC deadline %j',
    (deadline) => {
      const iss = find(keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline } }) }), 'spec.evidence.deadline')
      expect(iss).toHaveLength(1)
      expect(iss[0]?.message).toMatch(deadline ? /UTC timestamp ending in Z/ : /Set an evidence deadline/)
    },
  )

  it('rejects deadlines that are not on a whole minute', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: '2026-10-10T18:00:30Z' } }) }), 'spec.evidence.deadline')
    expect(iss[0]?.message).toMatch(/whole minute/)
  })

  it('rejects an oracle opening before the deadline', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ oracle: { ...keeperSpec().oracle, openingTime: '2026-10-10T17:59:00Z' } }) }), 'spec.oracle.openingTime')
    expect(iss[0]?.message).toMatch(/must not open before the evidence deadline/)
    expect(iss[0]?.stage).toBe('deadlines')
  })

  it('requires the fixed Seer timeout, a minimum 1h timeout and a positive bond', () => {
    const t = find(keeperDraft({ spec: keeperSpec({ oracle: { ...keeperSpec().oracle, timeoutSeconds: 86400 } }) }), 'spec.oracle.timeoutSeconds')
    expect(t[0]?.message).toMatch(/302400/)
    const short = find(keeperDraft({ spec: keeperSpec({ oracle: { ...keeperSpec().oracle, timeoutSeconds: 60 } }) }), 'spec.oracle.timeoutSeconds')
    expect(short[0]?.message).toMatch(/at least 1 hour/)
    const bond = find(keeperDraft({ spec: keeperSpec({ oracle: { ...keeperSpec().oracle, minBond: '0' } }) }), 'spec.oracle.minBond')
    expect(bond[0]?.message).toMatch(/greater than zero/)
  })

  it('requires a base commit for regression-only claims', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ regressionOnly: true }) }), 'source.baseCommit')
    expect(iss[0]?.message).toMatch(/base commit/)
    expect(iss[0]?.stage).toBe('source')
    const ok = keeperDraft({
      spec: keeperSpec({ regressionOnly: true }),
      source: { ...source, baseCommit: { sha: BASE_SHA, htmlUrl: 'https://github.com/x/y/commit/z' } },
    })
    expect(find(ok, 'source.baseCommit')).toEqual([])
  })

  it('requires a full 40-hex commit SHA', () => {
    const iss = find(keeperDraft({ source: { ...source, commit: { ...source.commit, sha: 'abc1234' } } }), 'source.commit.sha')
    expect(iss[0]?.message).toMatch(/40-character/)
  })

  it('blocks the gated SC-001 policy with the canonical gate copy', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ policyId: 'SC-001', policyVersion: '0.1.0' }) }), 'spec.policyId')
    expect(iss[0]?.message).toBe(COPY.scGate)
    expect(iss[0]?.stage).toBe('policy')
  })

  it('rejects unknown policies', () => {
    expect(find(keeperDraft({ spec: keeperSpec({ policyId: 'XYZ-999' }) }), 'spec.policyId')[0]?.message).toMatch(/Unknown policy/)
  })

  it.each(['the reporter funding code is safe', 'a secure bot loses funds', 'the planner is bug-free', 'there are no bugs in planning', 'the contract is certified'])(
    'rejects blanket-safety wording: %s',
    (violation) => {
      const iss = find(keeperDraft({ spec: keeperSpec({ violation }) }), 'spec.violation')
      expect(iss[0]?.message).toMatch(/bounded/)
      expect(iss[0]?.stage).toBe('claim')
    },
  )

  it('does not flag words that merely contain the stems', () => {
    expect(find(keeperDraft({ spec: keeperSpec({ violation: 'an unsafe external call can drain the security deposit' }) }), 'spec.violation')).toEqual([])
  })

  it('bounds title, requirement and violation length', () => {
    expect(find(keeperDraft({ spec: keeperSpec({ title: 'x'.repeat(91) }) }), 'spec.title')[0]?.message).toMatch(/90/)
    expect(find(keeperDraft({ spec: keeperSpec({ requirement: '' }) }), 'spec.requirement')).toHaveLength(1)
    expect(find(keeperDraft({ spec: keeperSpec({ violation: 'v'.repeat(501) }) }), 'spec.violation')[0]?.message).toMatch(/500/)
    expect(find(keeperDraft({ spec: keeperSpec({ violation: 'line one\nline two that is long' }) }), 'spec.violation')[0]?.message).toMatch(/line breaks/)
  })

  it('requires a reproduction command', () => {
    const env = keeperSpec().environment
    const iss = find(keeperDraft({ spec: keeperSpec({ environment: pinEnvironment({ ...env, reproductionCommand: '  ' }) }) }), 'spec.environment.reproductionCommand')
    expect(iss[0]?.message).toMatch(/reproduction command/)
  })

  it('flags stale environment hashes and secret-looking config keys', () => {
    const env = keeperSpec().environment
    const stale = find(keeperDraft({ spec: keeperSpec({ environment: { ...env, runtime: 'node 23' } }) }), 'spec.environment')
    expect(stale[0]?.message).toMatch(/Re-pin/)
    const secret = keeperDraft({ spec: keeperSpec({ environment: pinEnvironment({ ...env, config: { ...env.config, API_KEY: 'x' } }) }) })
    expect(find(secret, 'spec.environment.config.API_KEY')[0]?.message).toMatch(/secret/)
  })

  it('requires the policy parameters', () => {
    const params = { ...keeperSpec().parameters }
    delete params.invariant
    expect(find(keeperDraft({ spec: keeperSpec({ parameters: params }) }), 'spec.parameters.invariant')).toHaveLength(1)
  })

  it('keeps commit-reveal behind its launch gate', () => {
    const iss = find(keeperDraft({ spec: keeperSpec({ evidence: { mechanism: 'commit-reveal', deadline: '2026-10-10T18:00:00Z' } }) }), 'spec.evidence.mechanism')
    expect(iss[0]?.message).toMatch(/launch gate/)
  })

  it('blocks when the estimated max spend exceeds the spending limit', () => {
    const iss = find(keeperDraft({ funding: { ...funding, liquidity: '10', spendingLimit: '10' } }), 'funding.spendingLimit')
    expect(iss[0]?.message).toMatch(/exceeds your spending limit/)
    expect(iss[0]?.stage).toBe('funding')
  })

  it('handles empty, zero, scientific and garbage liquidity without throwing', () => {
    expect(find(keeperDraft({ funding: { ...funding, liquidity: '' } }), 'funding.liquidity')[0]?.message).toMatch(/Enter how much/)
    expect(find(keeperDraft({ funding: { ...funding, liquidity: '0' } }), 'funding.liquidity')[0]?.message).toMatch(/greater than zero/)
    expect(find(keeperDraft({ funding: { ...funding, liquidity: '1e-7' } }), 'funding.liquidity')[0]?.message).toMatch(/scientific notation/)
    expect(find(keeperDraft({ funding: { ...funding, liquidity: 'five' } }), 'funding.liquidity')[0]?.message).toMatch(/plain decimal/)
    expect(find(keeperDraft({ funding: { ...funding, liquidity: '0.0000001' } }), 'funding.liquidity')).toEqual([])
    expect(find(keeperDraft({ funding: { ...funding, liquidity: '0.1' } }), 'funding.liquidity')).toEqual([])
    expect(find(keeperDraft({ funding: undefined }), 'funding')).toHaveLength(1)
  })

  it('checks price range and chain consistency', () => {
    expect(find(keeperDraft({ funding: { ...funding, priceRange: [0.6, 0.2] } }), 'funding.priceRange')).toHaveLength(1)
    expect(find(keeperDraft({ funding: { ...funding, initialYesPrice: 0.9 } }), 'funding.initialYesPrice')).toHaveLength(1)
    expect(find(keeperDraft({ funding: { ...funding, chainId: 1 } }), 'funding.chainId')[0]?.message).toMatch(/same chain/)
  })
})

describe('schemas', () => {
  it('parse valid domain objects', () => {
    expect(claimSpecSchema.safeParse(keeperSpec()).success).toBe(true)
    expect(sourceRefSchema.safeParse(source).success).toBe(true)
    expect(oracleParamsSchema.safeParse(keeperSpec().oracle).success).toBe(true)
    expect(fundingInputSchema.safeParse(funding).success).toBe(true)
  })
  it('evidence drafts need a reproduction for direct counterexamples', () => {
    const base = { claimId: 'pine-0042', kind: 'counterexample' as const, title: 'Deposit drawn from gas reserve', summary: 'Shows principal from reserve', attachments: [], mode: 'direct' as const }
    expect(evidenceDraftSchema.safeParse(base).success).toBe(false)
    expect(
      evidenceDraftSchema.safeParse({ ...base, reproduction: { command: 'pnpm test', environment: 'node 22', expected: 'no draw', actual: 'draw' } }).success,
    ).toBe(true)
    expect(evidenceDraftSchema.safeParse({ ...base, mode: 'commit' }).success).toBe(true)
  })
})
