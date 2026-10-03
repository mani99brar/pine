import { describe, expect, it } from 'vitest'
import { compareDecimals, sumDecimals } from '../src/decimal'
import { estimateFunding, priceImpact } from '../src/funding'
import { buildQuestion } from '../src/question'
import type { CostLine, DepthSnapshot, FundingInput } from '../src/types'
import { BOT, CREATOR, funding, keeperSpec, source } from './fixtures'

const line = (plan: ReturnType<typeof estimateFunding>, key: CostLine['key']) => plan.costs.find((c) => c.key === key) as CostLine

// Gas: 1.7M + 60k + 600k + 2 × 5.3M = 12.96M units × 2 gwei = 0.02592 xDAI (converted 1:1 to sDAI)
const GAS = '0.02592'

describe('estimateFunding', () => {
  it.each([
    ['0.1', '0.12592'],
    ['5', '5.02592'],
    ['12.345678901234567891', '12.371598901234567891'],
  ])('liquidity %s → exact maxSpend %s', (liquidity, maxSpend) => {
    const plan = estimateFunding({ ...funding, liquidity, spendingLimit: '100' })
    expect(plan.totals.maxSpend).toBe(maxSpend)
    expect(plan.totals.exposedToLoss).toBe(liquidity)
    expect(plan.totals.nonRecoverable).toBe(GAS)
    expect(plan.withinLimit).toBe(true)
    expect(compareDecimals(plan.headroom, '0')).toBe(1)
    expect(sumDecimals([plan.headroom, plan.totals.maxSpend])).toBe('100')
  })

  it('handles scientific notation gracefully (1e-7)', () => {
    const plan = estimateFunding({ ...funding, liquidity: '1e-7' })
    expect(line(plan, 'liquidity_deposit').amount).toBe('0.0000001')
    expect(plan.totals.maxSpend).toBe('0.0259201')
    expect(plan.warnings.join(' ')).toMatch(/Thin depth/)
  })

  it('empty or garbage input never throws and is not within limit', () => {
    for (const liquidity of ['', 'abc', '-1', '0']) {
      const plan = estimateFunding({ ...funding, liquidity })
      expect(plan.withinLimit).toBe(false)
      expect(plan.warnings.length).toBeGreaterThan(0)
      expect(line(plan, 'liquidity_deposit').amount).toBe('0')
    }
    const p = estimateFunding({} as FundingInput)
    expect(p.withinLimit).toBe(false)
    expect(p.steps).toEqual([])
  })

  it('withinLimit is false when the limit is too low', () => {
    const plan = estimateFunding({ ...funding, liquidity: '5', spendingLimit: '5' })
    expect(plan.withinLimit).toBe(false)
    expect(plan.headroom).toBe('-0.02592')
    expect(plan.warnings.join(' ')).toMatch(/exceeds your spending limit/)
  })

  it('classifies every cost line', () => {
    const plan = estimateFunding(funding)
    const keys = plan.costs.map((c) => c.key)
    for (const k of ['gas_market_creation', 'gas_approval', 'gas_split', 'gas_liquidity', 'liquidity_deposit', 'swap_fee_tier', 'protocol_fee', 'platform_fee', 'ipfs_pinning', 'oracle_bond', 'arbitration_fee'] as const) {
      expect(keys).toContain(k)
    }
    expect(line(plan, 'gas_market_creation')).toMatchObject({ kind: 'spent', estimate: true, currency: 'xDAI', payer: 'you', countsTowardLimit: true, amount: '0.0034' })
    expect(line(plan, 'liquidity_deposit')).toMatchObject({ kind: 'at_risk', currency: 'sDAI', countsTowardLimit: true })
    expect(line(plan, 'liquidity_deposit').note).toMatch(/exposed to loss/)
    expect(line(plan, 'liquidity_deposit').note).toMatch(/is not a bounty/)
    expect(line(plan, 'oracle_bond')).toMatchObject({ kind: 'reserved', payer: 'answerer', countsTowardLimit: false, currency: 'xDAI', amount: '10' })
    expect(line(plan, 'arbitration_fee')).toMatchObject({ kind: 'reserved', payer: 'challenger', countsTowardLimit: false, currency: 'ETH', amount: '0.1674' })
    expect(line(plan, 'platform_fee')).toMatchObject({ amount: '0', note: 'No platform fee in this release.' })
    expect(line(plan, 'ipfs_pinning')).toMatchObject({ amount: '0', payer: 'platform' })
  })

  it('self-answering and dispute budgeting are opt-in', () => {
    const plan = estimateFunding({ ...funding, spendingLimit: '1000' }, { selfAnswer: true, includeDisputeCosts: true, ethInCollateral: 4000 })
    expect(line(plan, 'oracle_bond')).toMatchObject({ payer: 'you', countsTowardLimit: true })
    expect(line(plan, 'arbitration_fee')).toMatchObject({ payer: 'you', countsTowardLimit: true })
    // 5 + gas 0.02592 + bond 10 + 0.1674 ETH × 4000
    expect(plan.totals.maxSpend).toBe('684.62592')
  })

  it('uses the gas price from context', () => {
    const plan = estimateFunding(funding, { gasPriceGwei: 1 })
    expect(plan.totals.nonRecoverable).toBe('0.01296')
  })

  it('warns about narrow ranges, high initial price and sponsorship', () => {
    const w = estimateFunding({ ...funding, initialYesPrice: 0.7, priceRange: [0.65, 0.75], sponsored: true }).warnings.join(' ')
    expect(w).toMatch(/High initial Yes price/)
    expect(w).toMatch(/Narrow price range/)
    expect(w).toMatch(/accounted separately/)
    expect(estimateFunding({ ...funding, priceRange: [0.5, 0.2] }).warnings.join(' ')).toMatch(/0 < low < high < 1/)
  })

  it('builds publish steps only when publish context is given', () => {
    expect(estimateFunding(funding).steps).toEqual([])
    const spec = keeperSpec()
    const plan = estimateFunding(funding, {
      publish: {
        manifestUri: 'ipfs://m',
        manifestHash: `0x${'a'.repeat(64)}`,
        question: buildQuestion({ spec, source, policy: BOT }),
        oracle: spec.oracle,
        creator: CREATOR,
      },
    })
    expect(plan.steps.map((s) => s.id)).toEqual(['upload_manifest', 'create_market', 'approve_collateral', 'split_position', 'add_liquidity_yes', 'add_liquidity_no'])
  })

  it('sums decimals exactly', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3')
    expect(sumDecimals(['1e-18', '1'])).toBe('1.000000000000000001')
  })
})

describe('priceImpact', () => {
  const depth: DepthSnapshot = {
    outcome: 'yes',
    mid: 0.18,
    at: '2026-10-03T12:00:00Z',
    levels: [
      { side: 'ask', price: 0.3, size: 20 },
      { side: 'ask', price: 0.2, size: 10 },
      { side: 'ask', price: 0.5, size: 30 },
      { side: 'bid', price: 0.16, size: 10 },
      { side: 'bid', price: 0.1, size: 30 },
    ],
  }

  it('walks cumulative ask levels for a buy', () => {
    const r = priceImpact(depth, 'buy', 5)
    // 10 tokens @0.2 (2) + 10 tokens @0.3 (3) = 20 tokens for 5
    expect(r.filled).toBeCloseTo(5)
    expect(r.tokens).toBeCloseTo(20)
    expect(r.avgPrice).toBeCloseTo(0.25)
    expect(r.impact).toBeCloseTo((0.25 - 0.18) / 0.18)
    expect(r.worstPrice).toBe(0.3)
    expect(r.executable).toBe(true)
  })

  it('reports partial fills when the book is too thin', () => {
    const r = priceImpact(depth, 'buy', 100)
    expect(r.executable).toBe(false)
    expect(r.filled).toBeCloseTo(2 + 3 + 5)
    expect(r.tokens).toBeCloseTo(30)
  })

  it('walks bids for a sell', () => {
    const r = priceImpact(depth, 'sell', 3.6)
    // 10 tokens @0.16 = 1.6, then 20 tokens @0.1 = 2.0 → 30 tokens for 3.6
    expect(r.tokens).toBeCloseTo(30)
    expect(r.avgPrice).toBeCloseTo(0.12)
    expect(r.impact).toBeCloseTo((0.18 - 0.12) / 0.18)
    expect(r.executable).toBe(true)
  })

  it('handles empty books and zero amounts', () => {
    expect(priceImpact({ ...depth, levels: [] }, 'buy', 1)).toMatchObject({ filled: 0, executable: false })
    expect(priceImpact(depth, 'buy', 0)).toMatchObject({ filled: 0, impact: 0, executable: true })
    expect(priceImpact(depth, 'buy', Number.NaN).executable).toBe(false)
  })
})
