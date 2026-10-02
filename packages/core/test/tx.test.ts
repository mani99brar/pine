import { decodeFunctionData, parseUnits, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { arbitratorProxyAbi, erc20Abi, marketFactoryAbi, routerAbi } from '../src/abis'
import { CHAINS } from '../src/chains'
import { buildManifest } from '../src/manifest'
import { buildQuestion } from '../src/question'
import {
  buildEvidenceTx,
  buildOutcomeApprovalTx,
  buildPublishSteps,
  buildRedeemTx,
  escapeJsonString,
  prepareStepWithMarket,
  type PublishStepsInput,
} from '../src/tx'
import type { Hex } from '../src/types'
import { BOT, CREATOR, DEADLINE, funding, keeperSpec, MARKET, REALITY_QID, source } from './fixtures'

const gnosis = CHAINS[100]!
const spec = keeperSpec()
const question = buildQuestion({ spec, source, policy: BOT })
const { hash: manifestHash } = buildManifest({ claimId: 'pine-0042', creator: CREATOR, source, spec, policy: BOT, createdAt: '2026-10-03T12:00:00Z' })

function input(over: Partial<PublishStepsInput> = {}): PublishStepsInput {
  return {
    chainId: 100,
    manifestUri: 'ipfs://bafyexample/manifest.json',
    manifestHash,
    question,
    oracle: spec.oracle,
    funding: { ...funding, liquidity: '12.345678901234567891' },
    creator: CREATOR,
    ...over,
  }
}

describe('buildPublishSteps', () => {
  const steps = buildPublishSteps(input())

  it('orders steps and freezes terms at create_market', () => {
    expect(steps.map((s) => s.id)).toEqual(['upload_manifest', 'create_market', 'approve_collateral', 'split_position', 'add_liquidity_yes', 'add_liquidity_no'])
    expect(steps.filter((s) => s.freezesTerms).map((s) => s.id)).toEqual(['create_market'])
    expect(steps[0]?.kind).toBe('offchain')
    expect(steps.find((s) => s.id === 'add_liquidity_no')?.optional).toBe(true)
    for (const s of steps) {
      expect(s.estimatedCost).toBeDefined()
      expect(s.label).toBeTruthy()
      expect(s.description).toBeTruthy()
    }
  })

  it('split_position carries the liquidity deposit as a collateral cost for the spending limit', () => {
    const split = steps.find((s) => s.id === 'split_position')!
    expect(split.collateralCost).toEqual({ amount: '12.345678901234567891', currency: gnosis.collateral.symbol })
    expect(split.estimatedCost?.currency).toBe(gnosis.nativeSymbol)
  })

  it('approves exactly the liquidity amount to the router (never unlimited)', () => {
    const approve = steps.find((s) => s.id === 'approve_collateral')!
    expect(approve.request?.to).toBe(gnosis.collateral.address)
    expect(approve.request?.chainId).toBe(100)
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approve.request!.data })
    expect(decoded.functionName).toBe('approve')
    expect(decoded.args).toEqual([gnosis.seer.router, parseUnits('12.345678901234567891', 18)])
  })

  it('creates the market through the official factory with the question + manifest reference', () => {
    const create = steps.find((s) => s.id === 'create_market')!
    expect(create.request?.to).toBe(gnosis.seer.marketFactory)
    expect(create.request?.value).toBe('0')
    const decoded = decodeFunctionData({ abi: marketFactoryAbi, data: create.request!.data })
    expect(decoded.functionName).toBe('createCategoricalMarket')
    const p = decoded.args[0]!
    expect(p.marketName.startsWith(question.text)).toBe(true)
    expect(p.marketName).toContain(manifestHash)
    expect(p.marketName).toContain('ipfs://bafyexample/manifest.json')
    expect(p.outcomes).toEqual(['Yes', 'No'])
    expect(p.tokenNames).toEqual(['YES', 'NO'])
    expect(p.minBond).toBe(parseUnits('10', 18))
    expect(p.openingTime).toBe(Math.floor(new Date(DEADLINE).getTime() / 1000))
    expect(p.parentMarket).toBe(zeroAddress)
    expect(p.lang).toBe('en_US')
    expect(p.category).toBe('misc')
  })

  it('needs the market address before split; liquidity steps are DEX deep links', () => {
    const split = steps.find((s) => s.id === 'split_position')!
    expect(split.request).toBeUndefined()
    const prepared = prepareStepWithMarket(split, { ...input(), market: MARKET })
    const decoded = decodeFunctionData({ abi: routerAbi, data: prepared.request!.data })
    expect(decoded.functionName).toBe('splitPosition')
    expect(decoded.args).toEqual([gnosis.collateral.address, MARKET, parseUnits('12.345678901234567891', 18)])
    expect(prepared.request?.to).toBe(gnosis.seer.router)
    for (const id of ['add_liquidity_yes', 'add_liquidity_no'] as const) {
      const s = steps.find((x) => x.id === id)!
      expect(s.request).toBeUndefined()
      expect(s.description).toContain('Completed via Seer liquidity interface')
    }
  })

  it('never builds requests against placeholder addresses unless explicitly allowed', () => {
    const guarded = buildPublishSteps(input({ addresses: { marketFactory: zeroAddress, collateral: zeroAddress } }))
    expect(guarded.find((s) => s.id === 'create_market')?.request).toBeUndefined()
    expect(guarded.find((s) => s.id === 'approve_collateral')?.request).toBeUndefined()
    const demo = buildPublishSteps(input({ addresses: { marketFactory: zeroAddress }, allowPlaceholderAddresses: true }))
    expect(demo.find((s) => s.id === 'create_market')?.request?.to).toBe(zeroAddress)
  })

  it('rejects non-positive liquidity', () => {
    expect(() => buildPublishSteps(input({ funding: { ...funding, liquidity: '0' } }))).toThrow()
  })

  it('JSON-escapes the market name for the Reality template', () => {
    expect(escapeJsonString('a "quoted" \\ name')).toBe('a \\"quoted\\" \\\\ name')
    const sep = String.fromCharCode(0x241f)
    expect(escapeJsonString(`a${sep}b`)).toBe('a b')
  })
})

describe('evidence, redeem and approvals', () => {
  it('submits ERC-1497 evidence on the Ethereum arbitration contract for Gnosis markets', () => {
    const step = buildEvidenceTx({ chainId: 100, questionId: REALITY_QID, evidenceUri: 'ipfs://bafyevidence/evidence.json' })
    expect(step.id).toBe('submit_evidence')
    expect(step.request?.chainId).toBe(1)
    expect(step.request?.to).toBe(gnosis.arbitration.requestContract)
    const decoded = decodeFunctionData({ abi: arbitratorProxyAbi, data: step.request!.data })
    expect(decoded.functionName).toBe('submitEvidence')
    expect(decoded.args).toEqual([BigInt(REALITY_QID), 'ipfs://bafyevidence/evidence.json'])
    expect(step.estimatedCost?.currency).toBe('ETH')
  })

  it('redeems through the router with the market collateral', () => {
    const step = buildRedeemTx({ chainId: 100, market: MARKET, outcomeIndexes: [0, 2], amounts: [5n, 7n] })
    const decoded = decodeFunctionData({ abi: routerAbi, data: step.request!.data })
    expect(decoded.functionName).toBe('redeemPositions')
    expect(decoded.args).toEqual([gnosis.collateral.address, MARKET, [0n, 2n], [5n, 7n]])
    expect(() => buildRedeemTx({ chainId: 100, market: MARKET, outcomeIndexes: [0], amounts: [] })).toThrow()
  })

  it('approves outcome tokens for exactly the amount', () => {
    const token = '0x3333333333333333333333333333333333333333' as Hex
    const step = buildOutcomeApprovalTx({ chainId: 100, token, amount: 42n })
    const decoded = decodeFunctionData({ abi: erc20Abi, data: step.request!.data })
    expect(decoded.args).toEqual([gnosis.seer.router, 42n])
    expect(step.request?.to).toBe(token)
  })
})
