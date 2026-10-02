import { describe, expect, it } from 'vitest'
import { fixtures } from '../src/mock/fixtures'
import { createDataProvider } from '../src'

describe('smoke', () => {
  it('loads', async () => {
    const p = createDataProvider()
    const page = await p.listClaims({ limit: 50 })
    console.log(page.items.map((c) => `${c.id} ${c.status} ${c.outcome ?? ''} ${c.yesPrice} ${c.liquidity} ${c.evidenceDeadline}`).join('\n'))
    console.log('activity', fixtures.activity.length)
    const pf = await p.getPortfolio(fixtures.demo.wallet)
    console.log(JSON.stringify(pf.totals), pf.positions.map((x) => `${x.claimId} ${x.outcome} ${x.balance} ${x.value} ${x.redeemable}`))
    const c = await p.getClaim('PINE-0005')
    console.log(JSON.stringify(c?.oracle, null, 1).slice(0, 1500))
    console.log(c?.timeline.map((t) => `${t.at} ${t.kind} ${t.title} ${t.scheduled ? '(sched)' : ''}`).join('\n'))
    console.log((await p.getPriceHistory('pine-0009', '7d')).slice(-3), (await p.getDepth('pine-0009', 'yes'))?.levels.slice(0, 3))
    console.log(await p.getStats())
    expect(page.items.length).toBeGreaterThan(14)
  })
})
