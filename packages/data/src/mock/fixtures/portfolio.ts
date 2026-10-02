import type { ActivityItem, ClaimDetail, LiquidityPosition, OutcomePosition, Portfolio, PricePoint } from '@pine/core'
import { DEMO_WALLET_ADDRESS } from '../../demo'
import { fakeHash, fromUnits, hoursFromNow, mulDecimal, round, sameAddress, sumDecimal, toUnits } from '../../internal/util'
import { claimIdOf, FIXTURE_CHAIN_ID, priceAt } from './build'


/**
 * Builds the demo wallet's portfolio from the fixture claims and its scripted trades, so balances
 * match the activity history (tokens = collateral spent / price at trade time).
 */
export function buildDemoPortfolio(
  claims: ClaimDetail[],
  prices: Record<string, PricePoint[]>,
  activity: ActivityItem[],
): { portfolio: Portfolio; extraActivity: ActivityItem[] } {
  const byId = new Map(claims.map((c) => [c.id, c]))
  const positions: OutcomePosition[] = []
  const demoTrades = activity.filter((a) => a.type === 'trade' && sameAddress(a.actor, DEMO_WALLET_ADDRESS))

  for (const t of demoTrades) {
    const claim = byId.get(t.claimId)
    if (!claim || !t.outcome || t.outcome === 'invalid') continue
    const spent = (t.amount ?? '0').replace('-', '')
    const p = priceAt(prices[t.claimId] ?? [], Date.parse(t.at))
    const avg = p ? (t.outcome === 'yes' ? p.yes : p.no) : 0.5
    const balance = fromUnits((toUnits(spent) * 1_000_000n) / BigInt(Math.max(1, Math.round(avg * 1_000_000))), 18, 2)
    const finalOutcome = claim.status === 'resolved' || claim.status === 'settled' ? claim.outcome : undefined
    const quote = claim.market?.outcomes.find((o) => o.label.toLowerCase() === t.outcome)
    const mark = finalOutcome ? (finalOutcome === t.outcome ? 1 : 0) : quote?.price ?? avg
    const redeemable = finalOutcome !== undefined && finalOutcome === t.outcome
    positions.push({
      claimId: claim.id,
      claimNumber: claim.number,
      claimTitle: claim.title,
      status: claim.status,
      outcome: t.outcome,
      balance,
      avgPrice: round(avg, 4),
      markPrice: round(mark, 4),
      value: mulDecimal(balance, mark, 4),
      redeemable,
      redeemableAmount: redeemable ? balance : undefined,
    })
  }

  // Invalid-result tokens left over from splitting collateral for the flagship claim (Seer always mints them).
  const flagship = byId.get(claimIdOf(9))
  if (flagship) {
    const inv = flagship.market?.outcomes.find((o) => o.index === 2)?.price ?? 0.02
    positions.push({
      claimId: flagship.id,
      claimNumber: flagship.number,
      claimTitle: flagship.title,
      status: flagship.status,
      outcome: 'invalid',
      balance: flagship.funding?.liquidity ?? '400',
      avgPrice: undefined,
      markPrice: inv,
      value: mulDecimal(flagship.funding?.liquidity ?? '400', inv, 4),
      redeemable: false,
    })
  }

  const liquidity: LiquidityPosition[] = []
  if (flagship) {
    liquidity.push(
      { claimId: flagship.id, claimNumber: flagship.number, claimTitle: flagship.title, tokenId: '48211', pool: flagship.market?.pools[0]?.address ?? DEMO_WALLET_ADDRESS, outcome: 'yes', deposited: '200', currentValue: '203.18', feesEarned: '0.42', withdrawable: true, inRange: true },
      { claimId: flagship.id, claimNumber: flagship.number, claimTitle: flagship.title, tokenId: '48212', pool: flagship.market?.pools[1]?.address ?? DEMO_WALLET_ADDRESS, outcome: 'no', deposited: '200', currentValue: '196.47', feesEarned: '0.31', withdrawable: true, inRange: true },
    )
  }
  const thin = byId.get(claimIdOf(12))
  const extraActivity: ActivityItem[] = []
  if (thin) {
    liquidity.push({ claimId: thin.id, claimNumber: thin.number, claimTitle: thin.title, tokenId: '48977', pool: thin.market?.pools[0]?.address ?? DEMO_WALLET_ADDRESS, outcome: 'yes', deposited: '2.5', currentValue: '2.31', feesEarned: '0.04', withdrawable: true, inRange: false })
    // The split also minted 2.5 NO and 2.5 Invalid-result tokens, which stay in the wallet.
    for (const [index, outcome] of [[1, 'no'], [2, 'invalid']] as const) {
      const mark = thin.market?.outcomes.find((o) => o.index === index)?.price ?? 0
      positions.push({ claimId: thin.id, claimNumber: thin.number, claimTitle: thin.title, status: thin.status, outcome, balance: '2.5', markPrice: mark, value: mulDecimal('2.5', mark, 4), redeemable: false })
    }
    extraActivity.push(
      { id: 'act-0012-demo-split', type: 'split', claimId: thin.id, claimNumber: thin.number, claimTitle: thin.title, actor: DEMO_WALLET_ADDRESS, at: hoursFromNow(-61), txHash: fakeHash('tx:demo-split:12'), chainId: FIXTURE_CHAIN_ID, amount: '-2.5', token: 'sDAI', summary: 'Split 2.5 sDAI into YES, NO and Invalid outcome tokens', status: 'confirmed' },
      { id: 'act-0012-demo-lp', type: 'liquidity_added', claimId: thin.id, claimNumber: thin.number, claimTitle: thin.title, actor: DEMO_WALLET_ADDRESS, at: hoursFromNow(-60), txHash: fakeHash('tx:demo-lp:12'), chainId: FIXTURE_CHAIN_ID, outcome: 'yes', token: 'sDAI', summary: 'Added a concentrated YES position in the 0.05–0.40 range (now out of range at 0.62)', status: 'confirmed' },
    )
  }

  const mine = [...activity, ...extraActivity].filter((a) => sameAddress(a.actor, DEMO_WALLET_ADDRESS) && a.token === 'sDAI')
  const deposited = mine.filter((a) => a.amount?.startsWith('-')).map((a) => a.amount?.slice(1))
  const withdrawn = mine.filter((a) => a.amount && !a.amount.startsWith('-')).map((a) => a.amount)

  const portfolio: Portfolio = {
    address: DEMO_WALLET_ADDRESS,
    positions,
    liquidity,
    totals: {
      positionsValue: sumDecimal(positions.map((p) => p.value), 4),
      liquidityValue: sumDecimal(liquidity.map((l) => l.currentValue), 4),
      redeemable: sumDecimal(positions.map((p) => p.redeemableAmount), 4),
      depositedAllTime: sumDecimal(deposited, 4),
      withdrawnAllTime: sumDecimal(withdrawn, 4),
      feesPaidAllTime: '0.0614',
    },
  }
  return { portfolio, extraActivity }
}

export function emptyPortfolio(address: Portfolio['address']): Portfolio {
  return {
    address,
    positions: [],
    liquidity: [],
    totals: { positionsValue: '0', liquidityValue: '0', redeemable: '0', depositedAllTime: '0', withdrawnAllTime: '0', feesPaidAllTime: '0' },
  }
}
