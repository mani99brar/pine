/** Oracle, funding and exit actions: plan checks before the wallet, exact values, exact reports. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { PlanVerificationError, type Address, type Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { checkOraclePlan, minimumBondOf, reopenedQuestionIdsOf, useApiOracle } from '../src/api/oracle'
import { checkLadderPlan, useApiFunding } from '../src/api/funding'
import { checkExitPlan } from '../src/api/exits'
import { ACCOUNT, INVALID, manifest, MARKET, NO, NOW, NOW_S, OTHER, QUESTION, REVEAL_DEADLINE, wirePlan, XDAI, YES } from './api-write-chain'
import { apiError, FakePine, iso, json, noSleep, wrapper } from './api-write-support'

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const ANSWER_NO = `0x${'0'.repeat(63)}1` as Hex32
const REOPENED = `0x${'98'.repeat(32)}` as Hex32
const COLLATERAL = manifest.seer.collateralToken
const PM = manifest.amm.positionManager
const ROUTER = manifest.seer.gnosisRouter

// ---------------------------------------------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------------------------------------------

const answerPlan = (value: bigint, answer: Hex32 = ANSWER_NO, question: Hex32 = QUESTION) =>
  wirePlan('p-answer', ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [question, answer, 0n], value }])

const oracleCtx = (over: Partial<Parameters<typeof checkOraclePlan>[1]> = {}): Parameters<typeof checkOraclePlan>[1] => ({
  route: 'submit-answer',
  body: { market: MARKET, outcome: 'no', bond: (10n * XDAI).toString() },
  account: ACCOUNT,
  market: MARKET,
  claimQuestionId: QUESTION,
  currentQuestionId: QUESTION,
  valueWei: 10n * XDAI,
  ...over,
})

describe('checkOraclePlan', () => {
  it('accepts an answer plan carrying exactly the chosen bond and outcome', () => {
    expect(checkOraclePlan(answerPlan(10n * XDAI), oracleCtx()).steps).toHaveLength(1)
  })

  it('SEC-TX-11 refuses a plan whose native value differs from the bond the user entered', () => {
    expect(() => checkOraclePlan(answerPlan(11n * XDAI), oracleCtx())).toThrow(/instead of the 10000000000000000000 wei you entered/)
  })

  it('refuses another answer, another question, or another call in the route', () => {
    expect(() => checkOraclePlan(answerPlan(10n * XDAI, `0x${'0'.repeat(64)}` as Hex32), oracleCtx())).toThrow(/differs from the outcome you chose/)
    expect(() => checkOraclePlan(answerPlan(10n * XDAI, ANSWER_NO, REOPENED), oracleCtx())).toThrow(/another question/)
    const withdraw = wirePlan('p-w', ACCOUNT, [{ id: 'withdraw', allowlistId: 'realitio.withdraw', args: [] }])
    expect(() => checkOraclePlan(withdraw, oracleCtx())).toThrow(/may only call realitio.submitAnswer/)
    expect(() => checkOraclePlan(answerPlan(10n * XDAI), oracleCtx({ account: OTHER }))).toThrow(/another wallet/)
  })

  it('binds resolve to the market, reopen to the claim question and non-payable routes to zero value', () => {
    const resolve = wirePlan('p-r', ACCOUNT, [{ id: 'resolve', allowlistId: 'realityProxy.resolve', args: [MARKET] }])
    expect(checkOraclePlan(resolve, oracleCtx({ route: 'resolve', body: { market: MARKET }, valueWei: 0n })).steps).toHaveLength(1)
    const otherMarket = wirePlan('p-r2', ACCOUNT, [{ id: 'resolve', allowlistId: 'realityProxy.resolve', args: [OTHER] }])
    expect(() => checkOraclePlan(otherMarket, oracleCtx({ route: 'resolve', body: { market: MARKET }, valueWei: 0n }))).toThrow(/another market/)
    const bounty = wirePlan('p-b', ACCOUNT, [{ id: 'fund-bounty', allowlistId: 'realitio.fundAnswerBounty', args: [QUESTION], value: 5n }])
    expect(() => checkOraclePlan(bounty, oracleCtx({ route: 'fund-bounty', body: { market: MARKET, amount: '4' }, valueWei: 4n }))).toThrow(PlanVerificationError)
  })

  it('derives the bond floor and the reopened question ids from the oracle status', () => {
    const question = { questionId: QUESTION, openingTs: 1, minBond: (10n * XDAI).toString(), timeout: 1, bestAnswer: null, bond: (7n * XDAI).toString(), finalizeTs: 0, pendingArbitration: false, arbitrationRequestedBy: null, answeredByArbitrator: false, bounty: '0', reopenedBy: null, reopens: null, answerCount: 1 }
    const status = { ...statusFixture(), question }
    expect(minimumBondOf(status, null)).toBe(14n * XDAI)
    expect(reopenedQuestionIdsOf({ ...status, currentQuestionId: REOPENED, reopened: true }, QUESTION)).toEqual([REOPENED])
    expect(reopenedQuestionIdsOf(status, QUESTION)).toEqual([])
  })
})

const SETS = 79n * XDAI
const ladderSteps = (over: { approveTo?: Address; recipient?: Address; split?: bigint } = {}) => [
  { id: 'split', allowlistId: 'gnosisRouter.splitFromBase', args: [MARKET], value: over.split ?? 100n * XDAI },
  { id: 'approve-yes', allowlistId: 'outcomeToken.approve', to: over.approveTo ?? YES, args: [PM, SETS], dependsOn: ['split'] },
  { id: 'create-pool', allowlistId: 'positionManager.createAndInitializePoolIfNecessary', args: [YES, COLLATERAL, 2n ** 96n] },
  {
    id: 'mint-yes',
    allowlistId: 'positionManager.mint',
    args: [{ token0: YES, token1: COLLATERAL, tickLower: -60, tickUpper: 60, amount0Desired: SETS, amount1Desired: 0n, amount0Min: SETS - 1n, amount1Min: 0n, recipient: over.recipient ?? ACCOUNT, deadline: BigInt(NOW_S + 1200) }],
    dependsOn: ['approve-yes', 'create-pool'],
  },
]
const ladderCtx = { market: MARKET, account: ACCOUNT, budgetWei: 100n * XDAI, yesToken: YES, manifest }

describe('checkLadderPlan', () => {
  it('accepts split → approve YES → create pool → mint YES to the wallet, valued at exactly the budget', () => {
    expect(checkLadderPlan(wirePlan('p-l', ACCOUNT, ladderSteps()), ladderCtx).steps).toHaveLength(4)
  })

  it('SEC-TX-03 refuses an approval of another market token, and a split of another amount', () => {
    expect(() => checkLadderPlan(wirePlan('p-l', ACCOUNT, ladderSteps({ approveTo: NO })), ladderCtx)).toThrow(/YES token/)
    expect(() => checkLadderPlan(wirePlan('p-l', ACCOUNT, ladderSteps({ split: 101n * XDAI })), ladderCtx)).toThrow(/differs from your budget/)
  })

  it('refuses a position minted to another address and any extra call', () => {
    expect(() => checkLadderPlan(wirePlan('p-l', ACCOUNT, ladderSteps({ recipient: OTHER })), ladderCtx)).toThrow(/minted to another address/)
    const extra = [...ladderSteps(), { id: 'withdraw', allowlistId: 'realitio.withdraw', args: [] }]
    expect(() => checkLadderPlan(wirePlan('p-l', ACCOUNT, extra), ladderCtx)).toThrow(/may not call realitio.withdraw/)
  })
})

describe('checkExitPlan', () => {
  const claim = { yesToken: YES, noToken: NO, invalidToken: INVALID }
  const base = { market: MARKET, account: ACCOUNT, claim, manifest }

  it('binds a withdrawal to the chosen position and the wallet', () => {
    const steps = (recipient: Address, tokenId = 42n) => [
      { id: 'decrease', allowlistId: 'positionManager.decreaseLiquidity', args: [{ tokenId, liquidity: 10n, amount0Min: 0n, amount1Min: 0n, deadline: 1n }] },
      { id: 'collect', allowlistId: 'positionManager.collect', args: [{ tokenId, recipient, amount0Max: 1n, amount1Max: 1n }], dependsOn: ['decrease'] },
      { id: 'burn', allowlistId: 'positionManager.burn', args: [tokenId], dependsOn: ['collect'] },
    ]
    expect(checkExitPlan(wirePlan('p-x', ACCOUNT, steps(ACCOUNT)), { ...base, kind: 'withdraw', tokenId: '42' }).steps).toHaveLength(3)
    expect(() => checkExitPlan(wirePlan('p-x', ACCOUNT, steps(OTHER)), { ...base, kind: 'withdraw', tokenId: '42' })).toThrow(/another address/)
    expect(() => checkExitPlan(wirePlan('p-x', ACCOUNT, steps(ACCOUNT, 43n)), { ...base, kind: 'withdraw', tokenId: '42' })).toThrow(/another position/)
  })

  it('binds a merge to the market and amount, with approvals to the Seer router only', () => {
    const steps = (amount: bigint, spender: Address = ROUTER) => [
      ...[YES, NO, INVALID].map((to, i) => ({ id: `approve-${i}`, allowlistId: 'outcomeToken.approve', to, args: [spender, amount] })),
      { id: 'merge', allowlistId: 'gnosisRouter.mergeToBase', args: [MARKET, amount], dependsOn: ['approve-0', 'approve-1', 'approve-2'] },
    ]
    expect(checkExitPlan(wirePlan('p-m', ACCOUNT, steps(5n)), { ...base, kind: 'merge', amount: 5n }).steps).toHaveLength(4)
    expect(() => checkExitPlan(wirePlan('p-m', ACCOUNT, steps(6n)), { ...base, kind: 'merge', amount: 5n })).toThrow(PlanVerificationError)
    expect(() => checkExitPlan(wirePlan('p-m', ACCOUNT, steps(5n, PM)), { ...base, kind: 'merge', amount: 5n })).toThrow(/Seer router/)
  })

  it('binds a redemption to the market', () => {
    const steps = (market: Address) => [
      { id: 'approve-yes', allowlistId: 'outcomeToken.approve', to: YES, args: [ROUTER, 3n] },
      { id: 'redeem', allowlistId: 'gnosisRouter.redeemToBase', args: [market, [0n], [3n]], dependsOn: ['approve-yes'] },
    ]
    expect(checkExitPlan(wirePlan('p-rd', ACCOUNT, steps(MARKET)), { ...base, kind: 'redeem' }).steps).toHaveLength(2)
    expect(() => checkExitPlan(wirePlan('p-rd', ACCOUNT, steps(OTHER)), { ...base, kind: 'redeem' })).toThrow(/another market/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------------------------

function statusFixture() {
  return {
    market: MARKET,
    questionId: QUESTION,
    currentQuestionId: QUESTION,
    reopened: false,
    question: {
      questionId: QUESTION,
      openingTs: REVEAL_DEADLINE,
      minBond: (10n * XDAI).toString(),
      timeout: 302_400,
      bestAnswer: null,
      bond: '0',
      finalizeTs: 0,
      pendingArbitration: false,
      arbitrationRequestedBy: null,
      answeredByArbitrator: false,
      bounty: '0',
      reopenedBy: null,
      reopens: null,
      answerCount: 0,
    },
    originalQuestion: null,
    status: { state: 'open_unanswered' as const },
    phase: 'oracle_open' as const,
    dueActions: [{ action: 'answer' as const, questionId: QUESTION, planRoute: '/api/v1/oracle/plans/submit-answer', details: { minimumBond: (10n * XDAI).toString(), maxPrevious: '0' } }],
    chainReads: { historyHash: null, originalHistoryHash: null, balance: '0' },
    computedAt: NOW_S,
  }
}

const ORACLE_PLAN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LADDER_PLAN = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let fake: FakePine
let answerValue: (bond: bigint) => bigint
let ladderApproveTo: Address

function marketsView(wire: ReturnType<typeof wirePlan>, state = 'planned') {
  return {
    plan: wire,
    planState: {
      id: ORACLE_PLAN,
      kind: 'oracle_submit_answer',
      route: 'oracle.submit_answer',
      market: MARKET,
      account: ACCOUNT,
      state,
      expiresAt: NOW_S + 3_600,
      offerExpired: false,
      steps: wire.steps.map((s) => ({ id: s.id, allowlistId: s.allowlistId, state: 'pending', transactions: [] })),
      createdAt: iso(NOW_S),
      updatedAt: iso(NOW_S),
    },
    details: {},
  }
}

function fundingView(state = 'planned') {
  const wire = wirePlan(LADDER_PLAN, ACCOUNT, ladderSteps({ approveTo: ladderApproveTo }))
  return {
    planId: LADDER_PLAN,
    kind: 'ladder',
    market: MARKET,
    account: ACCOUNT,
    state,
    createdAt: new Date(NOW.getTime()).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    plan: wire,
    details: { maxLossIfYes: { sdai: '55000000000000000000' } },
    steps: wire.steps.map((s) => ({ id: s.id, state: 'pending', txHashes: [], confirmedTxHash: null, revertReason: null })),
    recovery: null,
  }
}

const FIGURES = [
  ['maxLossIfYesShares', '55000000000000000000'],
  ['maxLossIfYesXdaiWei', '68750000000000000000'],
  ['budgetWei', (100n * XDAI).toString()],
  ['sets', SETS.toString()],
  ['finalLowerPrice', '0.0501'],
  ['finalUpperPrice', '0.4998'],
].map(([name, message]) => ({ path: ['riskAcknowledgement', 'computed', name as string], message: message as string }))

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  answerValue = (bond) => bond
  ladderApproveTo = YES
  fake = new FakePine()
    .on('GET', /^\/api\/v1\/markets\/[^/]+\/oracle$/, () => json(200, statusFixture()))
    .on('POST', /^\/api\/v1\/oracle\/plans\/submit-answer$/, (req) => {
      const body = req.json as { outcome: string; bond: string }
      const wire = wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: answerValue(BigInt(body.bond)) }])
      return json(201, marketsView(wire))
    })
    .on('POST', /^\/api\/v1\/markets\/plans\/[^/]+\/submitted$/, () => json(200, marketsView(wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: 10n * XDAI }]), 'submitted')))
    .on('GET', /^\/api\/v1\/markets\/plans\/[^/]+$/, () => json(200, marketsView(wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: 10n * XDAI }]), 'confirmed')))
    .on('POST', /^\/api\/v1\/funding\/plans\/ladder$/, (req) => {
      const ack = (req.json as { riskAcknowledgement: { maxLossIfYesShares: string } }).riskAcknowledgement.maxLossIfYesShares
      if (BigInt(ack) < 55n * XDAI) return apiError(409, 'CONFLICT', 'The maximum loss if YES resolves is now 55 … Review the figures and acknowledge again.', { issues: FIGURES })
      return json(200, fundingView())
    })
    .on('POST', /^\/api\/v1\/funding\/plans\/[^/]+\/submitted$/, () => json(200, fundingView('submitted')))
    .on('GET', /^\/api\/v1\/funding\/plans\/[^/]+$/, () => json(200, fundingView('confirmed')))
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useApiOracle', () => {
  function render() {
    return renderHook(() => ({ oracle: useApiOracle(MARKET, { sleep: noSleep, pollIntervalMs: 1 }), wallet: useWallet() }), { wrapper })
  }

  it('answers with exactly the bond the user chose and reports the mined step', async () => {
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status?.dueActions[0]?.action).toBe('answer'))
    // Once the wallet is connected the status is read for it (due actions such as withdraw depend on the account).
    await waitFor(() => expect(fake.of(/\/oracle$/).at(-1)?.query.get('account')).toBe(ACCOUNT))
    expect([...(fake.of(/\/oracle$/).at(-1)?.query.keys() ?? [])]).toEqual(['account'])
    expect(result.current.oracle.minimumBondWei).toBe(10n * XDAI)
    await act(async () => {
      void result.current.oracle.submitAnswer('no', 10n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.runner.runner.state).toBe('done'))
    const [req] = fake.of(/\/oracle\/plans\/submit-answer$/)
    expect(req?.text).toBe(JSON.stringify({ market: MARKET, outcome: 'no', bond: (10n * XDAI).toString() }))
    expect(req?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    const step = result.current.oracle.runner.runner.steps[0]
    expect(step?.request?.value).toBe((10n * XDAI).toString())
    expect(fake.of(/\/markets\/plans\/[^/]+\/submitted$/).map((r) => r.text)).toEqual([JSON.stringify({ stepId: 'answer', txHash: step?.txHash?.toLowerCase() })])
    await waitFor(() => expect(result.current.oracle.planState?.state).toBe('confirmed'))
  })

  it('SEC-TX-11 blocks an answer plan carrying more than the chosen bond before any wallet prompt', async () => {
    answerValue = (bond) => bond + 1n
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status).not.toBeNull())
    await act(async () => {
      void result.current.oracle.submitAnswer('no', 10n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.oracle.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
  })

  it('refuses a bond below max(minBond, 2 × current bond) without asking Pine', async () => {
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status).not.toBeNull())
    await act(async () => {
      await result.current.oracle.submitAnswer('yes', 9n * XDAI)
    })
    expect(result.current.oracle.error?.message).toMatch(/at least twice the current bond/)
    expect(fake.of(/\/oracle\/plans\//)).toEqual([])
  })
})

describe('useApiFunding', () => {
  function render() {
    return renderHook(() => ({ funding: useApiFunding(MARKET, { sleep: noSleep, pollIntervalMs: 1 }), wallet: useWallet() }), { wrapper })
  }

  async function quoted(result: ReturnType<typeof render>['result']) {
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.funding.claim).not.toBeNull())
    await act(async () => {
      await result.current.funding.quoteLadder({ budgetWei: 100n * XDAI, lowerPrice: '0.05', upperPrice: '0.5' })
    })
    const quote = result.current.funding.quote
    expect(quote).toMatchObject({ maxLossIfYesShares: '55000000000000000000', finalLowerPrice: '0.0501', requestedLowerPrice: '0.05' })
    return quote!
  }

  it('SEC-LEGAL-03 shows the computed figures first, then funds exactly what the user acknowledged', async () => {
    const { result } = render()
    const quote = await quoted(result)
    const [quoteReq] = fake.of(/\/funding\/plans\/ladder$/)
    expect(quoteReq?.json).toEqual({ market: MARKET, budgetWei: (100n * XDAI).toString(), lowerPrice: '0.05', upperPrice: '0.5', riskAcknowledgement: { budgetWei: (100n * XDAI).toString(), maxLossIfYesShares: '0' } })

    await act(async () => {
      void result.current.funding.fund({ quote, spendingLimitWei: 200n * XDAI })
    })
    await waitFor(() => expect(result.current.funding.runner.runner.state).toBe('done'))
    const [, planReq] = fake.of(/\/funding\/plans\/ladder$/)
    expect(planReq?.json).toEqual({ market: MARKET, budgetWei: (100n * XDAI).toString(), lowerPrice: '0.05', upperPrice: '0.5', riskAcknowledgement: { budgetWei: (100n * XDAI).toString(), maxLossIfYesShares: '55000000000000000000' } })
    expect(planReq?.headers['idempotency-key']).not.toBe(quoteReq?.headers['idempotency-key'])
    const steps = result.current.funding.runner.runner.steps
    expect(fake.of(/\/funding\/plans\/[^/]+\/submitted$/).map((r) => r.text)).toEqual(
      ['split', 'approve-yes', 'create-pool', 'mint-yes'].map((id, i) => JSON.stringify({ stepId: id, txHash: steps[i]?.txHash?.toLowerCase() })),
    )
    await waitFor(() => expect(result.current.funding.plan?.state).toBe('confirmed'))
  })

  it('refuses a budget above the spending limit without asking Pine', async () => {
    const { result } = render()
    const quote = await quoted(result)
    await act(async () => {
      await result.current.funding.fund({ quote, spendingLimitWei: 50n * XDAI })
    })
    expect(result.current.funding.error?.message).toMatch(/above your spending limit/)
    expect(fake.of(/\/funding\/plans\/ladder$/)).toHaveLength(1)
  })

  it('SEC-TX-03 blocks a ladder that approves another token before any wallet prompt', async () => {
    ladderApproveTo = NO
    const { result } = render()
    const quote = await quoted(result)
    await act(async () => {
      void result.current.funding.fund({ quote, spendingLimitWei: 200n * XDAI })
    })
    await waitFor(() => expect(result.current.funding.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.funding.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
  })
})
