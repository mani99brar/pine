import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COPY } from '../src/copy'

const BANNED = /\b(safe|secure|certified|audited)\b|verified correct/i

function strings(value: unknown, path: string, out: [string, string][]) {
  if (typeof value === 'string') out.push([path, value])
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out)
}

describe('COPY', () => {
  it('uses the canonical outcome and price language', () => {
    expect(COPY.outcome).toEqual({ yes: 'Counterexample demonstrated', no: 'No qualifying counterexample submitted', invalid: 'Resolved invalid' })
    expect(COPY.priceLabel).toBe('Market-implied chance a qualifying counterexample is accepted')
    expect(COPY.priceCaveat).toMatch(/not the probability/)
    expect(COPY.volumeCaveat).toMatch(/do not by themselves prove review depth/)
    expect(COPY.liquidityIsNotBounty).toMatch(/not a bounty/)
    expect(COPY.invalidIsNotRefund).toMatch(/not a refund/)
    expect(COPY.deadlineIsNotTradingCutoff).toMatch(/not a trading cutoff/)
    expect(COPY.noIsNotSafety).toMatch(/not proof that the code is correct/)
    expect(COPY.spendingLimit).toMatch(/exact amount/)
    expect(COPY.scGate.startsWith('Requires approved disclosure process')).toBe(true)
  })

  it('never uses banned certainty words (launch-gate bodies quote SPEC verbatim and are exempt)', () => {
    const all: [string, string][] = []
    strings({ ...COPY, launchGates: COPY.launchGates.map(({ body: _b, ...rest }) => rest) }, 'COPY', all)
    for (const [path, s] of all) expect(s, path).not.toMatch(BANNED)
  })

  it('mentions bounty/reward/refund only to negate them (SPEC-verbatim launch-gate bodies exempt)', () => {
    const all: [string, string][] = []
    strings({ ...COPY, launchGates: COPY.launchGates.map(({ body: _b, ...rest }) => rest) }, 'COPY', all)
    for (const [path, s] of all) {
      for (const sentence of s.split(/(?<=[.;:])\s+/)) {
        if (/\b(bounty|refund|reward)\b/i.test(sentence)) expect(sentence, path).toMatch(/\b(not|no|never|nobody)\b/i)
      }
    }
  })

  it('disclosures cover SPEC §5 and §7', () => {
    const ids = COPY.disclosures.map((d) => d.id)
    for (const id of [
      'capital-at-risk',
      'not-a-bounty',
      'fees-and-costs',
      'price-impact-depth',
      'withdrawability',
      'oracle-bonds',
      'arbitration-costs',
      'spending-limit',
      'outcome-semantics',
      'no-is-not-correctness',
      'invalid-not-refund',
      'price-meaning',
      'deadline-vs-trading',
      'adjudication-timing',
      'frozen-terms',
      'no-merge-authority',
      'untrusted-content',
    ]) {
      expect(ids).toContain(id)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('launch gates are the 12 items of SPEC §10, verbatim', () => {
    const spec = readFileSync(fileURLToPath(new URL('../../../../SPEC.md', import.meta.url)), 'utf8')
    const section = spec.split('## 10. Open decisions and launch gates')[1]!.split('\n## ')[0]!
    const items = [...section.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ id: Number(m[1]), body: m[2] }))
    expect(items).toHaveLength(12)
    expect(COPY.launchGates.map((g) => ({ id: g.id, body: g.body }))).toEqual(items)
    for (const g of COPY.launchGates) expect(['open', 'partially_addressed']).toContain(g.status)
  })
})
