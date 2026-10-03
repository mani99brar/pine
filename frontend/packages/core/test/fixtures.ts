import { getPolicy } from '../src/policies'
import { pinEnvironment } from '../src/question'
import { defaultOracleParams } from '../src/oracle'
import type { ClaimDraft, ClaimSpec, FundingInput, PolicyVersion, SourceRef } from '../src/types'

export const NOW = new Date('2026-10-03T12:00:00Z')
export const DEADLINE = '2026-10-10T18:00:00Z'
export const SHA = '3f2a9c1d7e5b4a6f8c0d2e1f3a5b7c9d0e2f4a6b'
export const BASE_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
export const CREATOR = '0x1111111111111111111111111111111111111111' as const

export const BOT: PolicyVersion = getPolicy('BOT-001') as PolicyVersion

export const source: SourceRef = {
  provider: 'github',
  owner: 'kleros',
  repo: 'gateway-balancer-bot',
  pullRequest: { number: 42, title: 'Reporter funding from bridging fees', htmlUrl: 'https://github.com/kleros/gateway-balancer-bot/pull/42', author: 'dev', state: 'open' },
  commit: { sha: SHA, message: 'feat: reporter funding', author: 'dev', committedAt: '2026-10-02T10:00:00Z', htmlUrl: `https://github.com/kleros/gateway-balancer-bot/commit/${SHA}` },
  license: 'MIT',
}

export function keeperSpec(overrides: Partial<ClaimSpec> = {}): ClaimSpec {
  const environment = pinEnvironment({
    runtime: 'node 22.14.0',
    packageManager: 'pnpm 10.9.2',
    config: { NETWORK: 'gnosis', REPORTER_THRESHOLD: '0.5' },
    externalState: 'none',
    reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts',
    setupSteps: ['pnpm install --frozen-lockfile'],
  })
  return {
    title: 'Reporter deposits never draw on arbitration or gas reserves',
    policyId: 'BOT-001',
    policyVersion: '0.1.0',
    claimClass: 'fund-separation',
    requirement:
      "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds; it must not consume a pair's arbitration allocation or the operator's transaction-gas reserve.",
    violation: 'reporter-deposit principal can consume arbitration funds or the operator transaction-gas reserve',
    scope: { inScope: ['src/planner/reporter-funding.ts', 'src/accounting/'], outOfScope: ['LI.FI execution'] },
    parameters: Object.fromEntries(BOT.parameters.filter((p) => p.example !== undefined).map((p) => [p.key, p.example as string | string[] | boolean])),
    faultModel: 'process crash, timeout, replacement transaction',
    assumptions: ['Funds may share one EOA'],
    exclusions: ['Legitimate gas fee of the reporter transaction paid from the operator reserve'],
    environment,
    regressionOnly: false,
    evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: DEADLINE },
    oracle: defaultOracleParams(100, DEADLINE),
    ...overrides,
  }
}

export const funding: FundingInput = {
  chainId: 100,
  liquidity: '5',
  spendingLimit: '10',
  initialYesPrice: 0.15,
  priceRange: [0.05, 0.6],
}

export function keeperDraft(overrides: Partial<ClaimDraft> = {}): ClaimDraft {
  return {
    id: 'draft-1',
    owner: 'dev',
    createdAt: '2026-10-03T11:00:00Z',
    updatedAt: '2026-10-03T11:00:00Z',
    stage: 'review',
    source,
    spec: keeperSpec(),
    funding,
    ...overrides,
  }
}

import { buildManifest } from '../src/manifest'
import type { ClaimDetail, ClaimStatus, OracleState, MarketState, Outcome } from '../src/types'

export const MARKET = '0x2222222222222222222222222222222222222222' as const
export const REALITY_QID = `0x${'ab'.repeat(32)}` as const

export function keeperClaim(overrides: Partial<ClaimDetail> = {}): ClaimDetail {
  const spec = keeperSpec()
  const { manifest, hash } = buildManifest({ claimId: 'pine-0042', creator: CREATOR, source, spec, policy: BOT, createdAt: '2026-10-03T10:00:00Z' })
  return {
    id: 'pine-0042',
    number: 42,
    title: spec.title,
    violation: spec.violation,
    policy: { id: 'BOT-001', version: '0.1.0', family: 'BOT', title: BOT.title },
    source: { owner: source.owner, repo: source.repo, commitSha: SHA, prNumber: 42, prTitle: 'Reporter funding from bridging fees' },
    status: 'open' as ClaimStatus,
    createdAt: '2026-10-03T10:00:00Z',
    evidenceDeadline: DEADLINE,
    chainId: 100,
    marketAddress: MARKET,
    creator: CREATOR,
    creatorGithub: 'dev',
    yesPrice: 0.153,
    liquidity: '5',
    volume: '12.5',
    collateralSymbol: 'sDAI',
    evidenceCount: 0,
    traders: 3,
    sponsored: false,
    tags: ['keeper'],
    manifest,
    manifestUri: 'ipfs://bafyexample/manifest.json',
    manifestHash: hash,
    evidence: [],
    timeline: [],
    ...overrides,
  }
}

export function market(): MarketState {
  return {
    chainId: 100,
    address: MARKET,
    seerUrl: `https://app.seer.pm/markets/100/${MARKET}`,
    conditionId: `0x${'cd'.repeat(32)}`,
    questionId: `0x${'ef'.repeat(32)}`,
    collateral: { address: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', symbol: 'sDAI', decimals: 18 },
    outcomes: [
      { index: 0, label: 'Yes', token: '0x3333333333333333333333333333333333333333', price: 0.153 },
      { index: 1, label: 'No', token: '0x4444444444444444444444444444444444444444', price: 0.84 },
      { index: 2, label: 'Invalid result', token: '0x5555555555555555555555555555555555555555', price: 0.007 },
    ],
    pools: [],
    liquidity: '5',
    volume24h: '1',
    volumeTotal: '12.5',
    traders: 3,
    openInterest: '4',
    createdAt: '2026-10-03T10:00:00Z',
    createdTx: `0x${'12'.repeat(32)}`,
  }
}

export function oracle(patch: Partial<OracleState> = {}): OracleState {
  return {
    chainId: 100,
    realityQuestionId: REALITY_QID,
    realityUrl: 'https://reality.eth.limo/app/#!/network/100/question/x',
    templateId: 2,
    openingTime: DEADLINE,
    timeoutSeconds: 302400,
    minBond: '10',
    bondToken: 'xDAI',
    isFinalized: false,
    history: [],
    arbitration: { requested: false, cost: '0.1674', status: 'not_requested' },
    ...patch,
  }
}

export function answer(a: 'yes' | 'no' | 'invalid' | 'too_soon', bond: string, at: string) {
  return { answer: a, bond, answerer: CREATOR, at, txHash: `0x${'99'.repeat(32)}` as const }
}

export type { Outcome }
