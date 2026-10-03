/** Oracle, funding and exit actions: plan checks before the wallet, exact values, exact reports. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { PlanVerificationError, type Address, type Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { readCurrentQuestionId, verifyWirePlan } from '../src/api/plans'
import { checkOraclePlan, minimumBondOf, reopenedQuestionIdsOf, useApiOracle } from '../src/api/oracle'
import { checkLadderPlan, ladderQuoteKey, useApiFunding, type LadderPlanCheck, type LadderQuote } from '../src/api/funding'
import { checkExitPlan } from '../src/api/exits'
import { getSqrtRatioAtTick, MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK } from '../src/api/tick-math'
import { ACCOUNT, chainReopened, fakeReader, INVALID, manifest, MARKET, NO, NOW, NOW_S, OTHER, QUESTION, reads, resetChain, REVEAL_DEADLINE, wirePlan, XDAI, YES } from './api-write-chain'
import { apiError, FakePine, iso, json, noSleep, wrapper } from './api-write-support'

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const ANSWER_NO = `0x${'0'.repeat(63)}1` as Hex32
const REOPENED = `0x${'98'.repeat(32)}` as Hex32
/** A Reality question someone else created (own arbitrator and timeout): never a target of the user's bonds. */
const FOREIGN = `0x${'a1'.repeat(32)}` as Hex32
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

  it('derives the bond floor from the oracle status, and takes a replacement question from it only when the chain confirms it', () => {
    const question = { questionId: QUESTION, openingTs: 1, minBond: (10n * XDAI).toString(), timeout: 1, bestAnswer: null, bond: (7n * XDAI).toString(), finalizeTs: 0, pendingArbitration: false, arbitrationRequestedBy: null, answeredByArbitrator: false, bounty: '0', reopenedBy: null, reopens: null, answerCount: 1 }
    const status = { ...statusFixture(), question }
    expect(minimumBondOf(status, null)).toBe(14n * XDAI)
    const reopened = { ...status, currentQuestionId: REOPENED, reopened: true }
    // SEC-TX-01: the status alone never vouches for a question.
    expect(reopenedQuestionIdsOf(reopened, QUESTION)).toEqual([])
    expect(reopenedQuestionIdsOf(reopened, QUESTION, QUESTION)).toEqual([])
    expect(reopenedQuestionIdsOf({ ...status, currentQuestionId: FOREIGN, reopened: true }, QUESTION, REOPENED)).toEqual([])
    expect(reopenedQuestionIdsOf(reopened, QUESTION, REOPENED)).toEqual([REOPENED])
    expect(reopenedQuestionIdsOf(status, QUESTION)).toEqual([])
  })
})

describe('oracle questions come from the chain', () => {
  beforeEach(() => resetChain())

  const bounty = (question: Hex32) => wirePlan('p-b', ACCOUNT, [{ id: 'fund-bounty', allowlistId: 'realitio.fundAnswerBounty', args: [question], value: 500n * XDAI }])
  const limits = { maxTotalValueWei: 500n * XDAI, maxApprovalAmount: 0n }

  it('reads the current question from Reality: the latest replacement once reopened, else the claim question', async () => {
    expect(await readCurrentQuestionId(fakeReader, manifest, QUESTION)).toBe(QUESTION)
    chainReopened.set(QUESTION, REOPENED)
    expect(await readCurrentQuestionId(fakeReader, manifest, QUESTION)).toBe(REOPENED)
  })

  it('SEC-TX-01 refuses a bounty or a bonded answer for a question that only the Pine API vouches for', async () => {
    await expect(verifyWirePlan(bounty(FOREIGN), { manifest, account: ACCOUNT, reader: fakeReader, markets: [MARKET], limits })).rejects.toThrow(/not a registered claim question/)
    const answer = wirePlan('p-a', ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [FOREIGN, ANSWER_NO, 0n], value: 20n * XDAI }])
    await expect(verifyWirePlan(answer, { manifest, account: ACCOUNT, reader: fakeReader, markets: [MARKET], limits })).rejects.toThrow(/not a registered claim question/)
    // The current question handed to the route check is the chain's, so the same plans fail there too.
    const currentQuestionId = await readCurrentQuestionId(fakeReader, manifest, QUESTION)
    expect(() => checkOraclePlan(bounty(FOREIGN), oracleCtx({ route: 'fund-bounty', body: { market: MARKET, amount: (500n * XDAI).toString() }, valueWei: 500n * XDAI, currentQuestionId }))).toThrow(/another question/)
  })

  it('accepts a plan for the replacement question Reality reports on chain', async () => {
    chainReopened.set(QUESTION, REOPENED)
    const { plan } = await verifyWirePlan(bounty(REOPENED), { manifest, account: ACCOUNT, reader: fakeReader, markets: [MARKET], limits })
    expect(plan.steps).toHaveLength(1)
    expect(reads).toContain(`reopened_questions:${QUESTION}`)
  })
})

describe('tick math', () => {
  it('matches Algebra/Uniswap TickMath at the canonical values', () => {
    expect(getSqrtRatioAtTick(0)).toBe(1n << 96n)
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO)
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO)
    expect(getSqrtRatioAtTick(1)).toBe(79_232_123_823_359_799_118_286_999_568n)
    expect(getSqrtRatioAtTick(-1)).toBe(79_224_201_403_219_477_170_569_942_574n)
    expect(getSqrtRatioAtTick(-29_940)).toBe(17_732_633_948_828_052_598_660_473_723n)
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError)
    expect(() => getSqrtRatioAtTick(0.5)).toThrow(RangeError)
  })
})

// The backend's ladder for 100 xDAI over YES 0.05–0.5 sDAI with S = 79 sets (packages/api funding math, tick spacing 60):
// YES (0x50…) sorts before sDAI (0xaf20…), so YES = token0 and the pool price is sDAI per YES.
const SETS = 79n * XDAI
const LOSS = 66_514_848_024_341_992_635n
const TICKS: [number, number] = [-29_940, -6_960]
const INIT_SQRT = 17_732_633_948_828_052_598_660_473_722n
const minus50bps = (amount: bigint) => amount - (amount * 50n) / 10_000n

interface LadderOver {
  approveTo?: Address
  recipient?: Address
  split?: bigint
  ticks?: [number, number]
  init?: bigint
  yes?: bigint
  approve?: bigint
  yesMin?: bigint
  sdai?: bigint
  deadline?: bigint
}

const ladderSteps = (over: LadderOver = {}) => {
  const yes = over.yes ?? SETS
  const [tickLower, tickUpper] = over.ticks ?? TICKS
  return [
    { id: 'split', allowlistId: 'gnosisRouter.splitFromBase', args: [MARKET], value: over.split ?? 100n * XDAI },
    { id: 'approve-yes', allowlistId: 'outcomeToken.approve', to: over.approveTo ?? YES, args: [PM, over.approve ?? yes], dependsOn: ['split'] },
    { id: 'create-pool', allowlistId: 'positionManager.createAndInitializePoolIfNecessary', args: [YES, COLLATERAL, over.init ?? INIT_SQRT] },
    {
      id: 'mint-yes',
      allowlistId: 'positionManager.mint',
      args: [
        {
          token0: YES,
          token1: COLLATERAL,
          tickLower,
          tickUpper,
          amount0Desired: yes,
          amount1Desired: over.sdai ?? 0n,
          amount0Min: over.yesMin ?? minus50bps(yes),
          amount1Min: 0n,
          recipient: over.recipient ?? ACCOUNT,
          deadline: over.deadline ?? BigInt(NOW_S + 1200),
        },
      ],
      dependsOn: ['approve-yes', 'create-pool'],
    },
  ]
}
const ladderCtx: LadderPlanCheck = { market: MARKET, account: ACCOUNT, budgetWei: 100n * XDAI, yesToken: YES, manifest, lowerPrice: '0.05', upperPrice: '0.5', maxYesAmount: SETS, maxLossIfYesShares: LOSS, now: NOW_S }
const ladder = (over: LadderOver = {}) => wirePlan('p-l', ACCOUNT, ladderSteps(over))

describe('checkLadderPlan', () => {
  it('accepts split → approve YES → create pool → mint YES to the wallet, inside the acknowledged range and figures', () => {
    expect(checkLadderPlan(ladder(), ladderCtx).steps).toHaveLength(4)
    // A plan whose S shrank a little since the quote (sDAI appreciated) is still the acknowledged ladder.
    expect(checkLadderPlan(ladder({ yes: SETS - 10n ** 15n }), ladderCtx).steps).toHaveLength(4)
  })

  it('SEC-TX-03 refuses an approval of another market token, and a split of another amount', () => {
    expect(() => checkLadderPlan(ladder({ approveTo: NO }), ladderCtx)).toThrow(/YES token/)
    expect(() => checkLadderPlan(ladder({ split: 101n * XDAI }), ladderCtx)).toThrow(/differs from your budget/)
  })

  it('refuses a position minted to another address and any extra call', () => {
    expect(() => checkLadderPlan(ladder({ recipient: OTHER }), ladderCtx)).toThrow(/minted to another address/)
    const extra = [...ladderSteps(), { id: 'withdraw', allowlistId: 'realitio.withdraw', args: [] }]
    expect(() => checkLadderPlan(wirePlan('p-l', ACCOUNT, extra), ladderCtx)).toThrow(/may not call realitio.withdraw/)
  })

  it('SEC-LEGAL-03 refuses a tick range that sells YES below or above the requested prices', () => {
    // YES at about 0.0001 sDAI: anyone could buy the wallet's YES for almost nothing.
    expect(() => checkLadderPlan(ladder({ ticks: [-92_160, -92_100], init: getSqrtRatioAtTick(-92_160) - 1n }), ladderCtx)).toThrow(/outside the price range/)
    // One tick spacing below the requested lower price, or above the upper one.
    expect(() => checkLadderPlan(ladder({ ticks: [-30_000, -6_960], init: getSqrtRatioAtTick(-30_000) - 1n }), ladderCtx)).toThrow(/outside the price range/)
    expect(() => checkLadderPlan(ladder({ ticks: [-29_940, -6_900] }), ladderCtx)).toThrow(/outside the price range/)
    // A range at 0.9–0.95 when 0.05–0.5 was requested.
    expect(() => checkLadderPlan(ladder({ ticks: [-1_020, -480], init: getSqrtRatioAtTick(-1_020) - 1n }), ladderCtx)).toThrow(/outside the price range/)
  })

  it('SEC-LEGAL-03 refuses a narrower range whose loss if YES resolves is above the acknowledged figure', () => {
    // Inside the request but only at its bottom (0.050–0.051): almost the whole deposit is lost if YES resolves.
    expect(() => checkLadderPlan(ladder({ ticks: [-29_940, -29_760] }), ladderCtx)).toThrow(/maximum loss/)
  })

  it('SEC-LEGAL-03 refuses a new pool initialised inside or above the range', () => {
    expect(() => checkLadderPlan(ladder({ init: 1n << 96n }), ladderCtx)).toThrow(/new pool would start/)
    expect(() => checkLadderPlan(ladder({ init: getSqrtRatioAtTick(TICKS[0]) }), ladderCtx)).toThrow(/new pool would start/)
    expect(() => checkLadderPlan(ladder({ init: getSqrtRatioAtTick(-20_000) }), ladderCtx)).toThrow(/new pool would start/)
  })

  it('SEC-TX-03 refuses an approval or deposit above the acknowledged sets, and any sDAI-side deposit', () => {
    expect(() => checkLadderPlan(ladder({ yes: 200n * XDAI }), ladderCtx)).toThrow(/exceeds the YES amount you acknowledged/)
    expect(() => checkLadderPlan(ladder({ approve: SETS + 1n }), ladderCtx)).toThrow(/exceeds the YES amount you acknowledged/)
    expect(() => checkLadderPlan(ladder({ approve: SETS - 1n }), ladderCtx)).toThrow(/approval differs from the YES the position deposits/)
    expect(() => checkLadderPlan(ladder({ sdai: 5n * XDAI }), ladderCtx)).toThrow(/would deposit sDAI/)
  })

  it('refuses a minimum outside the slippage bound and a deadline that passed or lies far ahead', () => {
    expect(() => checkLadderPlan(ladder({ yesMin: 0n }), ladderCtx)).toThrow(/slippage bound/)
    expect(() => checkLadderPlan(ladder({ yesMin: SETS + 1n }), ladderCtx)).toThrow(/slippage bound/)
    expect(() => checkLadderPlan(ladder({ deadline: BigInt(NOW_S) }), ladderCtx)).toThrow(/deadline/)
    expect(() => checkLadderPlan(ladder({ deadline: BigInt(NOW_S + 86_400) }), ladderCtx)).toThrow(/deadline/)
  })

  it('refuses when the acknowledged range or figures are missing', () => {
    expect(() => checkLadderPlan(ladder(), { ...ladderCtx, lowerPrice: 'undefined' })).toThrow(/acknowledged/)
    expect(() => checkLadderPlan(ladder(), { ...ladderCtx, maxLossIfYesShares: -1n })).toThrow(/acknowledged/)
    expect(() => checkLadderPlan(ladder(), { ...ladderCtx, maxYesAmount: 0n })).toThrow(/acknowledged/)
  })

  describe('with YES sorted after sDAI (YES = token1, pool price in YES per sDAI)', () => {
    const YES1 = '0xc000000000000000000000000000000000000c0c' as Address
    const ctx1: LadderPlanCheck = { ...ladderCtx, yesToken: YES1 }
    const steps1 = (over: { ticks?: [number, number]; init?: bigint; tokens?: [Address, Address] } = {}) => {
      const [tickLower, tickUpper] = over.ticks ?? [6_960, 29_940]
      const [token0, token1] = over.tokens ?? [COLLATERAL, YES1]
      return wirePlan('p-l1', ACCOUNT, [
        { id: 'split', allowlistId: 'gnosisRouter.splitFromBase', args: [MARKET], value: 100n * XDAI },
        { id: 'approve-yes', allowlistId: 'outcomeToken.approve', to: YES1, args: [PM, SETS], dependsOn: ['split'] },
        { id: 'create-pool', allowlistId: 'positionManager.createAndInitializePoolIfNecessary', args: [token0, token1, over.init ?? 353_985_863_211_343_940_043_224_823_342n] },
        {
          id: 'mint-yes',
          allowlistId: 'positionManager.mint',
          args: [{ token0, token1, tickLower, tickUpper, amount0Desired: 0n, amount1Desired: SETS, amount0Min: 0n, amount1Min: minus50bps(SETS), recipient: ACCOUNT, deadline: BigInt(NOW_S + 1200) }],
          dependsOn: ['approve-yes', 'create-pool'],
        },
      ])
    }

    it('accepts the backend ladder', () => {
      expect(checkLadderPlan(steps1(), ctx1).steps).toHaveLength(4)
    })

    it('SEC-LEGAL-03 refuses a shifted range, a pool started below the range and swapped token order', () => {
      expect(() => checkLadderPlan(steps1({ ticks: [6_960, 30_000], init: getSqrtRatioAtTick(30_000) + 1n }), ctx1)).toThrow(/outside the price range/)
      expect(() => checkLadderPlan(steps1({ init: getSqrtRatioAtTick(6_960) - 1n }), ctx1)).toThrow(/new pool would start/)
      expect(() => checkLadderPlan(steps1({ tokens: [YES1, COLLATERAL] }), ctx1)).toThrow(/YES\/sDAI pool/)
    })
  })
})

describe('ladderQuoteKey', () => {
  const quote: LadderQuote = {
    market: MARKET,
    budgetWei: (100n * XDAI).toString(),
    sets: '99000000000000000000',
    finalLowerPrice: '0.05',
    finalUpperPrice: '0.5',
    maxLossIfYesShares: '60000000000000000000',
    maxLossIfYesXdaiWei: '61000000000000000000',
    requestedLowerPrice: '0.05',
    requestedUpperPrice: '0.5',
  }

  it('SEC-LEGAL-03 gives other figures another key, so an acknowledgement never carries over to them', () => {
    const key = ladderQuoteKey(quote)
    expect(ladderQuoteKey({ ...quote })).toBe(key)
    // The figures Pine returns when the pool moved between the quote and the plan (409 with a larger loss).
    for (const changed of [
      { maxLossIfYesShares: '70000000000000000000' },
      { maxLossIfYesXdaiWei: '71000000000000000000' },
      { budgetWei: (200n * XDAI).toString() },
      { sets: '98000000000000000000' },
      { finalLowerPrice: '0.04' },
      { finalUpperPrice: '0.6' },
      { market: OTHER },
    ]) {
      expect(ladderQuoteKey({ ...quote, ...changed })).not.toBe(key)
    }
    // What the user typed is not a figure: the same figures for another request keep the key.
    expect(ladderQuoteKey({ ...quote, requestedLowerPrice: '0.051' })).toBe(key)
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

function statusFixture(currentQuestionId: Hex32 = QUESTION) {
  return {
    market: MARKET,
    questionId: QUESTION,
    currentQuestionId,
    reopened: currentQuestionId !== QUESTION,
    question: {
      questionId: currentQuestionId,
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
      reopens: currentQuestionId !== QUESTION ? QUESTION : null,
      answerCount: 0,
    },
    originalQuestion: null,
    status: { state: 'open_unanswered' as const },
    phase: 'oracle_open' as const,
    dueActions: [{ action: 'answer' as const, questionId: currentQuestionId, planRoute: '/api/v1/oracle/plans/submit-answer', details: { minimumBond: (10n * XDAI).toString(), maxPrevious: '0' } }],
    chainReads: { historyHash: null, originalHistoryHash: null, balance: '0' },
    computedAt: NOW_S,
  }
}

const ORACLE_PLAN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LADDER_PLAN = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let fake: FakePine
let answerValue: (bond: bigint) => bigint
let statusQuestion: Hex32
let bountyQuestion: Hex32
let ladderOver: LadderOver
let fundingExpiresAt: number
let clock: Date

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
  const wire = wirePlan(LADDER_PLAN, ACCOUNT, ladderSteps(ladderOver))
  return {
    planId: LADDER_PLAN,
    kind: 'ladder',
    market: MARKET,
    account: ACCOUNT,
    state,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(fundingExpiresAt).toISOString(),
    plan: wire,
    details: { maxLossIfYes: { sdai: LOSS.toString() } },
    steps: wire.steps.map((s) => ({ id: s.id, state: 'pending', txHashes: [], confirmedTxHash: null, revertReason: null })),
    recovery: null,
  }
}

const FIGURES = [
  ['maxLossIfYesShares', LOSS.toString()],
  ['maxLossIfYesXdaiWei', '83143560030427490794'],
  ['budgetWei', (100n * XDAI).toString()],
  ['sets', SETS.toString()],
  ['finalLowerPrice', '0.050094186778981481'],
  ['finalUpperPrice', '0.498592972568148699'],
].map(([name, message]) => ({ path: ['riskAcknowledgement', 'computed', name as string], message: message as string }))

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  resetChain()
  reads.length = 0
  answerValue = (bond) => bond
  statusQuestion = QUESTION
  bountyQuestion = QUESTION
  ladderOver = {}
  fundingExpiresAt = NOW.getTime() + 20 * 60_000
  clock = NOW
  fake = new FakePine()
    .on('GET', /^\/api\/v1\/markets\/[^/]+\/oracle$/, () => json(200, statusFixture(statusQuestion)))
    .on('POST', /^\/api\/v1\/oracle\/plans\/submit-answer$/, (req) => {
      const body = req.json as { outcome: string; bond: string }
      const wire = wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: answerValue(BigInt(body.bond)) }])
      return json(201, marketsView(wire))
    })
    .on('POST', /^\/api\/v1\/oracle\/plans\/fund-bounty$/, (req) => {
      const body = req.json as { amount: string }
      return json(201, marketsView(wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'fund-bounty', allowlistId: 'realitio.fundAnswerBounty', args: [bountyQuestion], value: BigInt(body.amount) }])))
    })
    .on('POST', /^\/api\/v1\/markets\/plans\/[^/]+\/submitted$/, () => json(200, marketsView(wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: 10n * XDAI }]), 'submitted')))
    .on('GET', /^\/api\/v1\/markets\/plans\/[^/]+$/, () => json(200, marketsView(wirePlan(ORACLE_PLAN, ACCOUNT, [{ id: 'answer', allowlistId: 'realitio.submitAnswer', args: [QUESTION, ANSWER_NO, 0n], value: 10n * XDAI }]), 'confirmed')))
    .on('POST', /^\/api\/v1\/funding\/plans\/ladder$/, (req) => {
      const ack = (req.json as { riskAcknowledgement: { maxLossIfYesShares: string } }).riskAcknowledgement.maxLossIfYesShares
      if (BigInt(ack) < LOSS) return apiError(409, 'CONFLICT', 'The maximum loss if YES resolves is now 66 … Review the figures and acknowledge again.', { issues: FIGURES })
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
    return renderHook(() => ({ oracle: useApiOracle(MARKET, { sleep: noSleep, pollIntervalMs: 1, now: () => clock }), wallet: useWallet() }), { wrapper })
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
    expect(step?.request?.from).toBe(ACCOUNT)
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

  it('SEC-TX-01 refuses to plan while the oracle status names a current question the chain does not', async () => {
    // A compromised API claims the question was reopened as FOREIGN; Reality on the user's RPC says it was not.
    statusQuestion = FOREIGN
    bountyQuestion = FOREIGN
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status?.currentQuestionId).toBe(FOREIGN))
    await waitFor(() => expect(result.current.oracle.claim).not.toBeNull())
    await act(async () => {
      void result.current.oracle.fundBounty(500n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.error?.action).toBe('retry_later'))
    expect(result.current.oracle.error?.message).toMatch(/does not match the question on chain/)
    expect(reads).toContain(`reopened_questions:${QUESTION}`)
    expect(fake.of(/\/oracle\/plans\//)).toEqual([])
    expect(result.current.oracle.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
  })

  it('SEC-TX-01 blocks a bounty for a question other than the one Reality reports, before any wallet prompt', async () => {
    chainReopened.set(QUESTION, REOPENED)
    statusQuestion = REOPENED
    bountyQuestion = FOREIGN
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status?.currentQuestionId).toBe(REOPENED))
    await waitFor(() => expect(result.current.oracle.claim).not.toBeNull())
    await act(async () => {
      void result.current.oracle.fundBounty(500n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.oracle.error?.message).toMatch(/another question/)
    expect(result.current.oracle.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
  })

  it('funds the bounty of the replacement question Reality reports on chain', async () => {
    chainReopened.set(QUESTION, REOPENED)
    statusQuestion = REOPENED
    bountyQuestion = REOPENED
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status?.currentQuestionId).toBe(REOPENED))
    await waitFor(() => expect(result.current.oracle.claim).not.toBeNull())
    await act(async () => {
      void result.current.oracle.fundBounty(500n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.runner.runner.state).toBe('done'))
    expect(result.current.oracle.runner.plan?.steps[0]?.args).toEqual([REOPENED])
    expect(fake.of(/\/markets\/plans\/[^/]+\/submitted$/)).toHaveLength(1)
  })

  it('SEC-TX-08 never sends a stored plan after its offer expired, through run() or the runner itself', async () => {
    const { result } = render()
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.oracle.status).not.toBeNull())
    demoWalletStore.failNext() // the user rejects the first wallet prompt
    await act(async () => {
      void result.current.oracle.submitAnswer('no', 10n * XDAI)
    })
    await waitFor(() => expect(result.current.oracle.runner.runner.state).toBe('failed'))
    expect(result.current.oracle.runner.expiresAt).toBe((NOW_S + 3_600) * 1000)

    clock = new Date((NOW_S + 3_600) * 1000) // the offer ends
    await act(async () => {
      await result.current.oracle.runner.run()
    })
    expect(result.current.oracle.runner.error).toMatch(/offer has expired/)
    await act(async () => {
      await result.current.oracle.runner.runner.retry()
    })
    const step = result.current.oracle.runner.runner.steps[0]
    expect(step?.status).toBe('failed')
    expect(step?.error).toMatch(/offer has expired/)
    expect(step?.txHash).toBeUndefined()
    expect(fake.of(/\/oracle\/plans\//)).toHaveLength(1)
    expect(fake.of(/\/submitted$/)).toEqual([])

    // Before the end of the offer, the same stored plan is sent (no new plan is requested).
    clock = new Date((NOW_S + 3_599) * 1000)
    await act(async () => {
      await result.current.oracle.runner.run()
    })
    await waitFor(() => expect(result.current.oracle.runner.runner.state).toBe('done'))
    expect(fake.of(/\/oracle\/plans\//)).toHaveLength(1)
    expect(fake.of(/\/submitted$/)).toHaveLength(1)
  })
})

describe('useApiFunding', () => {
  function render() {
    return renderHook(() => ({ funding: useApiFunding(MARKET, { sleep: noSleep, pollIntervalMs: 1, now: () => clock }), wallet: useWallet() }), { wrapper })
  }

  async function quoted(result: ReturnType<typeof render>['result']) {
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.funding.claim).not.toBeNull())
    await act(async () => {
      await result.current.funding.quoteLadder({ budgetWei: 100n * XDAI, lowerPrice: '0.05', upperPrice: '0.5' })
    })
    const quote = result.current.funding.quote
    expect(quote).toMatchObject({ maxLossIfYesShares: LOSS.toString(), sets: SETS.toString(), finalLowerPrice: '0.050094186778981481', requestedLowerPrice: '0.05' })
    return quote!
  }

  async function fundRejected(result: ReturnType<typeof render>['result']) {
    const quote = await quoted(result)
    await act(async () => {
      void result.current.funding.fund({ quote, spendingLimitWei: 200n * XDAI })
    })
    await waitFor(() => expect(result.current.funding.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.funding.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
    return result.current.funding.error?.message ?? ''
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
    expect(planReq?.json).toEqual({ market: MARKET, budgetWei: (100n * XDAI).toString(), lowerPrice: '0.05', upperPrice: '0.5', riskAcknowledgement: { budgetWei: (100n * XDAI).toString(), maxLossIfYesShares: LOSS.toString() } })
    expect(planReq?.headers['idempotency-key']).not.toBe(quoteReq?.headers['idempotency-key'])
    const steps = result.current.funding.runner.runner.steps
    expect(fake.of(/\/funding\/plans\/[^/]+\/submitted$/).map((r) => r.text)).toEqual(
      ['split', 'approve-yes', 'create-pool', 'mint-yes'].map((id, i) => JSON.stringify({ stepId: id, txHash: steps[i]?.txHash?.toLowerCase() })),
    )
    // The offer ends at the mint deadline (now + 20 min), the earlier of the two.
    expect(result.current.funding.runner.expiresAt).toBe((NOW_S + 1200) * 1000)
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
    ladderOver = { approveTo: NO }
    await fundRejected(render().result)
  })

  it('SEC-LEGAL-03 blocks a ladder with a tampered tick range before any wallet prompt', async () => {
    ladderOver = { ticks: [-92_160, -92_100], init: getSqrtRatioAtTick(-92_160) - 1n }
    expect(await fundRejected(render().result)).toMatch(/outside the price range/)
  })

  it('SEC-LEGAL-03 blocks a ladder whose new pool starts inside the range before any wallet prompt', async () => {
    ladderOver = { init: getSqrtRatioAtTick(-20_000) }
    expect(await fundRejected(render().result)).toMatch(/new pool would start/)
  })

  it('SEC-TX-03 blocks a ladder approving more than the acknowledged sets (up to the spending limit) before any wallet prompt', async () => {
    ladderOver = { yes: 200n * XDAI }
    expect(await fundRejected(render().result)).toMatch(/exceeds the YES amount you acknowledged/)
  })

  it('SEC-LEGAL-03 blocks a ladder that deposits sDAI before any wallet prompt', async () => {
    ladderOver = { sdai: 5n * XDAI }
    expect(await fundRejected(render().result)).toMatch(/would deposit sDAI/)
  })

  it('SEC-TX-08 sends nothing more of a ladder once its mint deadline passed, although the offer still runs', async () => {
    fundingExpiresAt = NOW.getTime() + 60 * 60_000
    const { result } = render()
    const quote = await quoted(result)
    demoWalletStore.failNext() // the user rejects the split
    await act(async () => {
      void result.current.funding.fund({ quote, spendingLimitWei: 200n * XDAI })
    })
    await waitFor(() => expect(result.current.funding.runner.runner.state).toBe('failed'))
    expect(result.current.funding.runner.expiresAt).toBe((NOW_S + 1200) * 1000)

    clock = new Date((NOW_S + 1200) * 1000)
    await act(async () => {
      await result.current.funding.runner.run()
    })
    expect(result.current.funding.runner.error).toMatch(/offer has expired/)
    expect(result.current.funding.runner.runner.steps.every((s) => !s.txHash)).toBe(true)
    expect(fake.of(/\/funding\/plans\/ladder$/)).toHaveLength(2)
    expect(fake.of(/\/submitted$/)).toEqual([])
  })
})
