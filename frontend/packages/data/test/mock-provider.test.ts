import type { ActivityItem, ClaimDetail, Evidence } from '@pine/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDataProvider, DEMO_WALLET_ADDRESS, getMockDataProvider, MOCK_STORAGE_KEYS, MockDataProvider, readPineEnv } from '../src'
import { fixtures } from '../src/mock/fixtures'

/** Minimal in-memory localStorage + window for browser-path tests. */
function installFakeWindow() {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  const listeners: ((e: unknown) => void)[] = []
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    addEventListener: (_: string, fn: (e: unknown) => void) => listeners.push(fn),
    removeEventListener: () => {},
  }
  return { store }
}

function removeFakeWindow() {
  delete (globalThis as Record<string, unknown>).window
}

const p = () => new MockDataProvider({ latency: false, persist: false })

describe('MockDataProvider queries', () => {
  it('lists newest first with offset cursors and totals', async () => {
    const prov = p()
    const first = await prov.listClaims({ limit: 5 })
    expect(first.items).toHaveLength(5)
    expect(first.total).toBe(fixtures.claims.length)
    expect(first.nextCursor).toBe('5')
    const created = first.items.map((c) => Date.parse(c.createdAt))
    expect([...created].sort((a, b) => b - a)).toEqual(created)
    const second = await prov.listClaims({ limit: 5, cursor: first.nextCursor })
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    const all: string[] = []
    let cursor: string | undefined
    do {
      const page = await prov.listClaims({ limit: 4, cursor })
      all.push(...page.items.map((c) => c.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(new Set(all).size).toBe(fixtures.claims.length)
  })

  it('returns summaries without heavy detail fields', async () => {
    const page = await p().listClaims({ limit: 1 })
    const c = page.items[0] as unknown as Record<string, unknown>
    expect(c.manifest).toBeUndefined()
    expect(c.timeline).toBeUndefined()
    expect(c.id).toMatch(/^pine-\d{4}$/)
  })

  it('filters by status (single and multiple), outcome, policy, family, repo, creator, chain', async () => {
    const prov = p()
    const open = await prov.listClaims({ status: 'open', limit: 100 })
    expect(open.items.length).toBeGreaterThanOrEqual(5)
    expect(open.items.every((c) => c.status === 'open')).toBe(true)
    const multi = await prov.listClaims({ status: ['disputed', 'arbitration'], limit: 100 })
    expect(new Set(multi.items.map((c) => c.status))).toEqual(new Set(['disputed', 'arbitration']))
    expect((await prov.listClaims({ outcome: 'yes' })).items.every((c) => c.outcome === 'yes')).toBe(true)
    expect((await prov.listClaims({ policyId: 'bot-001', limit: 100 })).items.every((c) => c.policy.id === 'BOT-001')).toBe(true)
    expect((await prov.listClaims({ family: 'FUNC', limit: 100 })).items.every((c) => c.policy.family === 'FUNC')).toBe(true)
    const repo = await prov.listClaims({ repo: 'Kleros/Gateway-Balancer-Bot' })
    expect(repo.items.map((c) => c.number).sort((a, b) => a - b)).toEqual([9, 15])
    const mine = await prov.listClaims({ creator: DEMO_WALLET_ADDRESS.toLowerCase() as `0x${string}`, limit: 100 })
    expect(mine.items.length).toBeGreaterThanOrEqual(4)
    expect((await prov.listClaims({ chainId: 1 })).items).toHaveLength(0)
    expect((await prov.listClaims({ status: [] })).total).toBe(fixtures.claims.length)
  })

  it('searches title, repo, policy, violation, claim number and PR', async () => {
    const prov = p()
    expect((await prov.listClaims({ search: 'reporter deposit' })).items.map((c) => c.number)).toContain(9)
    expect((await prov.listClaims({ search: 'fastparse' })).items.map((c) => c.number).sort((a, b) => a - b)).toEqual([2, 10])
    expect((await prov.listClaims({ search: 'PINE-0005' })).items.map((c) => c.number)).toEqual([5])
    expect((await prov.listClaims({ search: 'arbitration allocation' })).items.map((c) => c.number)).toContain(9)
    expect((await prov.listClaims({ search: 'BOT-001 nonce' })).items.map((c) => c.number)).toEqual([6])
    expect((await prov.listClaims({ search: '#1408' })).items.map((c) => c.number)).toEqual([8])
    expect((await prov.listClaims({ search: 'zzz-no-match' })).items).toHaveLength(0)
  })

  it('sorts by deadline (upcoming first), liquidity, volume, yes price and activity', async () => {
    const prov = p()
    const byDeadline = (await prov.listClaims({ status: 'open', sort: 'deadline', limit: 100 })).items
    const d = byDeadline.map((c) => Date.parse(c.evidenceDeadline))
    expect([...d].sort((a, b) => a - b)).toEqual(d)
    const all = (await prov.listClaims({ sort: 'deadline', limit: 100 })).items
    const firstPast = all.findIndex((c) => Date.parse(c.evidenceDeadline) < Date.now())
    expect(all.slice(firstPast).every((c) => Date.parse(c.evidenceDeadline) < Date.now())).toBe(true)
    const liq = (await prov.listClaims({ sort: 'liquidity', limit: 100 })).items.map((c) => Number(c.liquidity))
    expect([...liq].sort((a, b) => b - a)).toEqual(liq)
    expect(liq[0]).toBe(2400)
    const vol = (await prov.listClaims({ sort: 'volume', limit: 100 })).items.map((c) => Number(c.volume))
    expect([...vol].sort((a, b) => b - a)).toEqual(vol)
    const yes = (await prov.listClaims({ sort: 'yes_price', status: 'open', limit: 100 })).items.map((c) => c.yesPrice ?? 0)
    expect([...yes].sort((a, b) => b - a)).toEqual(yes)
    expect((await prov.listClaims({ sort: 'activity', limit: 3 })).items).toHaveLength(3)
  })

  it('gets claims by id variants and by market', async () => {
    const prov = p()
    const c = await prov.getClaim('PINE-0009')
    expect(c?.id).toBe('pine-0009')
    expect((await prov.getClaim('9'))?.id).toBe('pine-0009')
    expect(await prov.getClaim('pine-9999')).toBeNull()
    const byMarket = await prov.getClaimByMarket(100, c!.marketAddress!.toLowerCase() as `0x${string}`)
    expect(byMarket?.id).toBe('pine-0009')
    expect(await prov.getClaimByMarket(1, c!.marketAddress!)).toBeNull()
  })

  it('serves price ranges, depth and evidence', async () => {
    const prov = p()
    const day = await prov.getPriceHistory('pine-0009', '24h')
    const week = await prov.getPriceHistory('pine-0009', '7d')
    const all = await prov.getPriceHistory('pine-0001', 'all')
    expect(day.length).toBeGreaterThanOrEqual(23)
    expect(day.length).toBeLessThanOrEqual(25)
    expect(week.length).toBeGreaterThan(day.length)
    expect(all.length).toBeGreaterThan(30 * 24)
    expect(await prov.getPriceHistory('pine-0016', 'all')).toEqual([])
    const depth = await prov.getDepth('pine-0011', 'yes')
    expect(depth?.levels.some((l) => l.side === 'bid')).toBe(true)
    const asks = depth!.levels.filter((l) => l.side === 'ask')
    for (let i = 1; i < asks.length; i++) {
      expect(asks[i]!.price).toBeGreaterThan(asks[i - 1]!.price)
      expect(asks[i]!.size).toBeGreaterThan(asks[i - 1]!.size)
    }
    const thin = await prov.getDepth('pine-0012', 'yes')
    expect(thin!.levels.at(-1)!.size).toBeLessThan(depth!.levels.at(-1)!.size)
    expect(await prov.getDepth('pine-0015', 'yes')).toBeNull()
    const ev = await prov.listEvidence('pine-0005')
    expect(ev.length).toBe(3)
    const t = ev.map((e) => Date.parse(e.submittedAt))
    expect([...t].sort((a, b) => a - b)).toEqual(t)
  })

  it('filters and paginates activity', async () => {
    const prov = p()
    const page = await prov.listActivity({ limit: 10 })
    expect(page.items).toHaveLength(10)
    expect(page.nextCursor).toBe('10')
    const at = page.items.map((a) => Date.parse(a.at))
    expect([...at].sort((a, b) => b - a)).toEqual(at)
    expect((await prov.listActivity({ claimId: 'PINE-0005', limit: 100 })).items.every((a) => a.claimId === 'pine-0005')).toBe(true)
    const trades = await prov.listActivity({ types: ['trade'], limit: 200 })
    expect(trades.items.every((a) => a.type === 'trade')).toBe(true)
    const demo = await prov.listActivity({ account: DEMO_WALLET_ADDRESS.toLowerCase() as `0x${string}`, limit: 200 })
    expect(demo.items.length).toBeGreaterThan(5)
  })

  it('returns the demo portfolio and empty portfolios for unknown addresses', async () => {
    const prov = p()
    const pf = await prov.getPortfolio(DEMO_WALLET_ADDRESS)
    expect(pf.positions.some((x) => x.redeemable)).toBe(true)
    const empty = await prov.getPortfolio('0x0000000000000000000000000000000000000001')
    expect(empty.positions).toEqual([])
    expect(empty.totals.positionsValue).toBe('0')
  })

  it('serves policies and stats', async () => {
    const prov = p()
    const policies = await prov.listPolicies()
    expect(policies.map((x) => x.id)).toEqual(['FUNC-001', 'BOT-001', 'SC-001'])
    expect((await prov.getPolicy('sc-001'))?.status).toBe('gated')
    expect(await prov.getPolicy('BOT-001', '9.9.9')).toBeNull()
    const stats = await prov.getStats()
    expect(stats.openClaims).toBe(fixtures.claims.filter((c) => c.status === 'open').length)
    expect(stats.counterexamplesAccepted).toBe(1)
    expect(Number(stats.totalLiquidity)).toBeGreaterThan(0)
  })

  it('returns deep copies (callers cannot mutate fixtures)', async () => {
    const prov = p()
    const c = await prov.getClaim('pine-0009')
    c!.title = 'mutated'
    c!.evidence[0]!.title = 'mutated'
    expect((await prov.getClaim('pine-0009'))?.title).not.toBe('mutated')
    const list = await prov.listClaims({ limit: 100 })
    for (const x of list.items) {
      x.tags.push('HACKED')
      x.source.owner = 'HACKED'
      x.policy.id = 'HACKED'
    }
    const act = await prov.listActivity({ limit: 5 })
    for (const a of act.items) a.summary = 'HACKED'
    const ev = await prov.listEvidence('pine-0009')
    ev[0]!.summary = 'HACKED'
    const pf = await prov.getPortfolio(DEMO_WALLET_ADDRESS)
    pf.positions[0]!.balance = '999999'
    const json = JSON.stringify(fixtures)
    expect(json).not.toContain('HACKED')
    expect(json).not.toContain('999999')
    expect((await prov.listClaims({ limit: 100 })).items.some((x) => x.tags.includes('HACKED'))).toBe(false)
  })

  it('ignores corrupt persisted demo state', async () => {
    const store = new Map<string, string>([
      [MOCK_STORAGE_KEYS.claims, '{"not":"an array"}'],
      [MOCK_STORAGE_KEYS.activity, '[null, 3, {"id": 1}]'],
      [MOCK_STORAGE_KEYS.evidence, '"nope"'],
      [MOCK_STORAGE_KEYS.patches, '[1,2]'],
    ])
    ;(globalThis as Record<string, unknown>).window = {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
      addEventListener: () => {},
    }
    try {
      const prov = new MockDataProvider({ latency: false })
      expect((await prov.listClaims({ limit: 100 })).total).toBe(fixtures.claims.length)
      expect((await prov.listActivity({ limit: 1 })).items).toHaveLength(1)
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })

  it('simulates latency when enabled', async () => {
    const slow = new MockDataProvider({ latency: [30, 40], persist: false })
    const t = Date.now()
    await slow.getStats()
    expect(Date.now() - t).toBeGreaterThanOrEqual(25)
  })
})

describe('MockDataProvider demo writes', () => {
  afterEach(() => removeFakeWindow())

  function newClaim(base: ClaimDetail, n: number): ClaimDetail {
    return { ...structuredClone(base), id: `pine-${String(n).padStart(4, '0')}`, number: n, title: 'Demo-published claim', status: 'open', createdAt: new Date().toISOString() }
  }

  it('addClaim / updateClaim / addEvidence / recordActivity show up everywhere; reset restores fixtures', async () => {
    const prov = p()
    const n = prov.nextClaimNumber()
    expect(n).toBe(19)
    let notified = 0
    const off = prov.subscribe(() => notified++)
    const base = (await prov.getClaim('pine-0009'))!
    prov.addClaim(newClaim(base, n))
    expect((await prov.listClaims({ limit: 1 })).items[0]?.id).toBe('pine-0019')
    expect((await prov.listClaims({ search: 'Demo-published' })).items).toHaveLength(1)

    prov.updateClaim('pine-0015', { status: 'open', yesPrice: 0.15, liquidity: '250' })
    const updated = await prov.getClaim('pine-0015')
    expect(updated?.status).toBe('open')
    expect(updated?.liquidity).toBe('250')

    const ev: Evidence = { ...structuredClone(base.evidence[0]!), id: 'ev-demo-1', title: 'Demo counterexample', kind: 'counterexample', submittedAt: new Date().toISOString() }
    prov.addEvidence('PINE-0009', ev)
    const withEv = await prov.getClaim('pine-0009')
    expect(withEv?.evidence.at(-1)?.id).toBe('ev-demo-1')
    expect(withEv?.evidenceCount).toBe(base.evidence.length + 1)
    expect(withEv?.timeline.some((t) => t.detail === 'Demo counterexample')).toBe(true)

    const act: ActivityItem = { id: 'act-demo-1', type: 'trade', claimId: 'pine-0011', claimNumber: 11, claimTitle: 'x', actor: DEMO_WALLET_ADDRESS, at: new Date().toISOString(), txHash: `0x${'ab'.repeat(32)}`, chainId: 100, amount: '-4', token: 'sDAI', outcome: 'yes', side: 'buy', summary: 'Bought YES', status: 'confirmed' }
    prov.recordActivity(act)
    expect((await prov.listActivity({ limit: 1 })).items[0]?.id).toBe('act-demo-1')
    const pf = await prov.getPortfolio(DEMO_WALLET_ADDRESS)
    expect(pf.positions.some((x) => x.claimId === 'pine-0011' && x.outcome === 'yes')).toBe(true)

    expect(notified).toBe(4)
    off()
    prov.reset()
    expect(notified).toBe(4)
    expect(await prov.getClaim('pine-0019')).toBeNull()
    expect((await prov.getClaim('pine-0015'))?.status).toBe('publishing')
    expect((await prov.getClaim('pine-0009'))?.evidence.length).toBe(base.evidence.length)
  })

  it('persists demo writes to localStorage pine:mock:* in the browser and reloads them', async () => {
    const { store } = installFakeWindow()
    const a = new MockDataProvider({ latency: false })
    const base = (await a.getClaim('pine-0009'))!
    a.addClaim(newClaim(base, 42))
    a.updateClaim('pine-0012', { title: 'Patched title' })
    expect(store.has(MOCK_STORAGE_KEYS.claims)).toBe(true)
    expect([...store.keys()].every((k) => k.startsWith('pine:mock:'))).toBe(true)
    const b = new MockDataProvider({ latency: false })
    expect((await b.getClaim('pine-0042'))?.title).toBe('Demo-published claim')
    expect((await b.getClaim('pine-0012'))?.title).toBe('Patched title')
    b.reset()
    expect([...store.keys()].filter((k) => k.startsWith('pine:mock:'))).toHaveLength(0)
  })
})

describe('createDataProvider / readPineEnv', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('NEXT_PUBLIC_') || k.startsWith('PINE_') || k === 'AUTH_GITHUB_ID') delete process.env[k]
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('defaults to mock with sensible defaults and a shared singleton', () => {
    const env = readPineEnv()
    expect(env).toMatchObject({ dataSource: 'mock', ipfsGateway: 'https://cdn.kleros.link', defaultChainId: 100, demoWallet: true, githubOAuthConfigured: false })
    expect(createDataProvider(env)).toBe(getMockDataProvider())
    expect(createDataProvider().kind).toBe('mock')
  })

  it('reads rest/envio configuration and falls back to mock when URLs are missing', () => {
    process.env.NEXT_PUBLIC_PINE_DATA_SOURCE = 'rest'
    expect(readPineEnv().dataSource).toBe('mock')
    process.env.NEXT_PUBLIC_PINE_API_URL = 'https://api.example/v1/'
    const rest = readPineEnv()
    expect(rest).toMatchObject({ dataSource: 'rest', apiUrl: 'https://api.example/v1', demoWallet: false })
    expect(createDataProvider(rest).kind).toBe('rest')
    process.env.NEXT_PUBLIC_PINE_DATA_SOURCE = 'envio'
    process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL = 'https://indexer.example/v1/graphql'
    process.env.NEXT_PUBLIC_PINE_DEMO_WALLET = '1'
    process.env.AUTH_GITHUB_ID = 'abc'
    process.env.NEXT_PUBLIC_CHAIN_ID = '11155111'
    const envio = readPineEnv()
    expect(envio).toMatchObject({ dataSource: 'envio', demoWallet: true, githubOAuthConfigured: true, defaultChainId: 11155111 })
    expect(createDataProvider(envio).kind).toBe('envio')
  })
})
