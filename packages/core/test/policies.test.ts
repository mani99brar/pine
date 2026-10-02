import { describe, expect, it } from 'vitest'
import { hashText } from '../src/hash'
import { getPolicy, getPolicyByPath, POLICIES, POLICY_FAMILIES, policyPath } from '../src/policies'

describe('policies', () => {
  it('has the three policies at 0.1.0', () => {
    expect(POLICIES.map(policyPath)).toEqual(['FUNC-001@0.1.0', 'BOT-001@0.1.0', 'SC-001@0.1.0'])
    expect(POLICY_FAMILIES.map((f) => f.id)).toEqual(['FUNC', 'BOT', 'SC'])
  })
  it('contentHash === hashText(text) for every policy', () => {
    for (const p of POLICIES) {
      expect(p.contentHash).toBe(hashText(p.text))
      expect(p.contentHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(p.uri).toBe(`ipfs://pending/${p.id}@${p.version}`)
      expect(p.text).toContain('## Common publication requirements')
      expect(p.outcomeRules.invalid).toMatch(/not a guaranteed refund/)
      expect(p.parameters.length).toBeGreaterThan(3)
    }
  })
  it('SC-001 is gated with a reason; others enabled', () => {
    const sc = getPolicy('SC-001')
    expect(sc?.status).toBe('gated')
    expect(sc?.gateReason).toMatch(/disclosure/)
    expect(getPolicy('FUNC-001')?.status).toBe('enabled')
    expect(getPolicy('bot-001', '0.1.0')?.status).toBe('enabled')
  })
  it('BOT-001 has the five candidate claim classes; FUNC and SC three each', () => {
    expect(getPolicy('BOT-001')?.claimClasses).toHaveLength(5)
    expect(getPolicy('FUNC-001')?.claimClasses).toHaveLength(3)
    expect(getPolicy('SC-001')?.claimClasses).toHaveLength(3)
  })
  it('policy text contains the verbatim README sections', () => {
    expect(getPolicy('BOT-001')?.text).toContain('## BOT-001 — Automation and Keeper Reliability')
    expect(getPolicy('SC-001')?.text).toContain('### Publication gate')
    expect(getPolicy('FUNC-001')?.text).toContain('NO means none was submitted; it is not a general correctness certification.')
  })
  it('lookup helpers', () => {
    expect(getPolicyByPath('BOT-001@0.1.0')?.id).toBe('BOT-001')
    expect(getPolicy('NOPE-001')).toBeUndefined()
    expect(getPolicy('BOT-001', '9.9.9')).toBeUndefined()
  })
})
