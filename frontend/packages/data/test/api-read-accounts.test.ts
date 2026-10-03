/** api read side: activity, portfolio, stats, policies and the api-mode provider factory. */
import { describe, expect, it } from 'vitest'
import { rawCidFromSha256 } from '@pine/core/pine-shared'
import { ApiDataProvider, createDataProvider, HIDDEN_CLAIM_TITLE, MockDataProvider, readPineEnv, RestDataProvider } from '../src'
import {
  activityView,
  apiError,
  BOT_SHA,
  botParametersSchema,
  CREATE_TX,
  CREATED_AT,
  CREATOR,
  claimDetail,
  claimList,
  EVIDENCE_REGISTRY,
  fakeBackend,
  funcParametersSchema,
  FUNC_SHA,
  isoSeconds,
  json,
  listedClaim,
  liquidityView,
  MARKET,
  NOW,
  NOW_MS,
  OTHER_MARKET,
  policyDetail,
  policyList,
  positionsView,
  SC_SHA,
  TITLE,
  YES,
  YES_POOL,
} from './api-read-fixtures'

function provider(routes: Parameters<typeof fakeBackend>[0], now = () => NOW_MS) {
  const backend = fakeBackend(routes)
  return { p: new ApiDataProvider({ baseUrl: '', fetch: backend.fetch, now }), calls: backend.calls }
}

describe('listActivity', () => {
  it('reads one account’s activity, newest first, with placeholder claim titles', async () => {
    const { p, calls } = provider({ [`/api/v1/accounts/${CREATOR}/activity`]: activityView({ nextCursor: 'eyJ2IjoxfQ' }) })
    const page = await p.listActivity({ account: CREATOR.toUpperCase().replace('0X', '0x') as `0x${string}` })
    expect(calls).toEqual([`/api/v1/accounts/${CREATOR}/activity`])
    expect(page.nextCursor).toBe('eyJ2IjoxfQ')
    expect(page.items).toEqual([
      {
        id: `evidence:${EVIDENCE_REGISTRY}:7`,
        type: 'evidence_submitted',
        claimId: OTHER_MARKET,
        claimNumber: 0,
        claimTitle: 'Claim 0x6c4d…716a',
        actor: CREATOR,
        at: isoSeconds(CREATED_AT + 7_200),
        txHash: `0x${'e1'.repeat(32)}`,
        chainId: 100,
        summary: 'Committed sealed evidence',
        status: 'confirmed',
      },
      {
        id: `claim:${MARKET}`,
        type: 'market_created',
        claimId: MARKET,
        claimNumber: 0,
        claimTitle: 'Claim 0x5b3c…6051',
        actor: CREATOR,
        at: isoSeconds(CREATED_AT),
        txHash: CREATE_TX,
        chainId: 100,
        summary: 'Published a claim and created its market',
        status: 'confirmed',
      },
    ])
  })

  it('SEC-EVID-11 never shows activity titles (that route drops only "hide", so a blocked claim’s title could be there)', async () => {
    const { p } = provider({ [`/api/v1/accounts/${CREATOR}/activity`]: activityView() })
    const page = await p.listActivity({ account: CREATOR })
    expect(JSON.stringify(page)).not.toContain(TITLE)
  })

  it('filters by type and claim, passes the cursor through, and needs an account', async () => {
    const { p, calls } = provider({ [`/api/v1/accounts/${CREATOR}/activity`]: activityView() })
    expect((await p.listActivity({ account: CREATOR, types: ['evidence_submitted'] })).items.map((i) => i.type)).toEqual(['evidence_submitted'])
    expect((await p.listActivity({ account: CREATOR, claimId: MARKET.toUpperCase().replace('0X', '0x') })).items.map((i) => i.claimId)).toEqual([MARKET])
    await p.listActivity({ account: CREATOR, cursor: 'eyJ2IjoxLCJjbGFpbXMiOm51bGx9' })
    expect(calls.at(-1)).toBe(`/api/v1/accounts/${CREATOR}/activity?cursor=eyJ2IjoxLCJjbGFpbXMiOm51bGx9`)
    const before = calls.length
    expect(await p.listActivity({})).toEqual({ items: [] })
    expect(await p.listActivity({ claimId: MARKET })).toEqual({ items: [] })
    expect(await p.listActivity({ account: '../admin' as `0x${string}` })).toEqual({ items: [] })
    expect(await p.listActivity({ account: CREATOR, cursor: 'x'.repeat(2_049) })).toEqual({ items: [] })
    expect(calls).toHaveLength(before)
  })
})

describe('portfolio', () => {
  const resolvedClaim = claimDetail({ phase: 'resolved', oracle: { state: 'finalized', outcome: 'yes', byArbitrator: false }, resolution: { payoutNumerators: ['1', '0', '0'], resolvedAt: NOW - 600, txHash: CREATE_TX } })

  it('values outcome tokens at the marginal pool price and lists LP positions of the account’s markets', async () => {
    const { p, calls } = provider({
      [`/api/v1/accounts/${CREATOR}/activity`]: activityView(),
      [`/api/v1/funding/positions/${CREATOR}`]: (url: URL) => (url.searchParams.get('market') === MARKET ? json(positionsView()) : apiError(404, 'NOT_FOUND')),
      [`/api/v1/claims/${MARKET}`]: claimDetail({ phase: 'oracle_open', oracle: { state: 'open_unanswered' } }),
      [`/api/v1/markets/${MARKET}/liquidity`]: liquidityView(),
    })
    const portfolio = await p.getPortfolio(CREATOR)
    expect(calls).toEqual(
      expect.arrayContaining([
        `/api/v1/accounts/${CREATOR}/activity`,
        `/api/v1/funding/positions/${CREATOR}?market=${MARKET}`,
        `/api/v1/funding/positions/${CREATOR}?market=${OTHER_MARKET}`,
        `/api/v1/claims/${MARKET}`,
        `/api/v1/markets/${MARKET}/liquidity`,
      ]),
    )
    expect(portfolio.positions).toEqual([
      { claimId: MARKET, claimNumber: 0, claimTitle: TITLE, status: 'awaiting_answer', outcome: 'yes', balance: '4', markPrice: 0.25, value: '1', redeemable: false },
    ])
    expect(portfolio.liquidity).toEqual([
      {
        claimId: MARKET,
        claimNumber: 0,
        claimTitle: TITLE,
        tokenId: '4242',
        pool: YES_POOL,
        outcome: 'yes',
        deposited: '0',
        currentValue: '0',
        feesEarned: '0',
        withdrawable: true,
        inRange: true,
        api: { market: MARKET, liquidity: '500000000000000000000', tickLower: -16000, tickUpper: -6000, tokensOwed0: '0', tokensOwed1: '0', token0: YES, token1: '0xaf204776c7245bf4147c2612bf6e5972ee483701' },
      },
    ])
    expect(portfolio.totals).toEqual({ positionsValue: '1', liquidityValue: '0', redeemable: '0', depositedAllTime: '0', withdrawnAllTime: '0', feesPaidAllTime: '0' })
  })

  it('marks winning tokens of a resolved market redeemable at their payout', async () => {
    const { p } = provider({
      [`/api/v1/funding/positions/${CREATOR}`]: positionsView({ items: [], balances: { yes: '4000000000000000000', no: '2500000000000000000', invalid: '0' } }),
      [`/api/v1/claims/${MARKET}`]: resolvedClaim,
    })
    const portfolio = await p.getMarketPortfolio(CREATOR, MARKET)
    expect(portfolio.positions.map((x) => [x.outcome, x.balance, x.markPrice, x.value, x.redeemable, x.redeemableAmount, x.status])).toEqual([
      ['yes', '4', 1, '4', true, '4', 'resolved'],
      ['no', '2.5', 0, '0', false, undefined, 'resolved'],
    ])
    expect(portfolio.totals.redeemable).toBe('4')
    expect(portfolio.totals.positionsValue).toBe('4')
  })

  it('reads every position page (bounded) and hides a moderated claim’s title', async () => {
    const pages = [
      positionsView({ nextCursor: '20', items: [] }),
      positionsView({ nextCursor: null, items: [{ tokenId: '7', outcome: 'invalid', token0: YES, token1: YES, tickLower: 0, tickUpper: 60, liquidity: '1', tokensOwed0: '0', tokensOwed1: '0' }] }),
    ]
    const { p, calls } = provider({
      [`/api/v1/funding/positions/${CREATOR}`]: (url: URL) => json(url.searchParams.get('cursor') === '20' ? pages[1] : pages[0]),
      [`/api/v1/claims/${MARKET}`]: claimDetail({ claim: { title: null, marketName: null, hidden: true, moderation: { action: 'block', reason: 'abuse', at: '2026-10-03T10:00:00.000Z' } } }),
      [`/api/v1/markets/${MARKET}/liquidity`]: apiError(429, 'RATE_LIMITED'),
    })
    const portfolio = await p.getMarketPortfolio(CREATOR, MARKET)
    expect(calls.filter((u) => u.includes('/positions/'))).toEqual([`/api/v1/funding/positions/${CREATOR}?market=${MARKET}`, `/api/v1/funding/positions/${CREATOR}?market=${MARKET}&cursor=20`])
    expect(portfolio.positions.map((x) => x.claimTitle)).toEqual([HIDDEN_CLAIM_TITLE])
    // Without a price the value is unknown (0), never guessed.
    expect(portfolio.positions[0]).toMatchObject({ markPrice: 0, value: '0' })
    // An Invalid-token LP position is not a YES/NO liquidity position.
    expect(portfolio.liquidity).toEqual([])
  })

  it('needs valid addresses and makes no request otherwise', async () => {
    const { p, calls } = provider({})
    expect((await p.getPortfolio('../x' as `0x${string}`)).positions).toEqual([])
    expect((await p.getMarketPortfolio(CREATOR, '..' as `0x${string}`)).positions).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('getStats', () => {
  it('derives lower-bound counts from the newest open and closed listing pages', async () => {
    const closed = [
      listedClaim({ phase: 'resolved', oracle: { state: 'finalized', outcome: 'yes', byArbitrator: false }, resolution: { payoutNumerators: ['1', '0', '0'], resolvedAt: NOW, txHash: CREATE_TX } }),
      listedClaim({ phase: 'finalized', oracle: { state: 'finalized', outcome: 'no', byArbitrator: false } }),
      listedClaim({ phase: 'oracle_open', oracle: { state: 'open_unanswered' } }),
    ]
    const { p, calls } = provider({
      '/api/v1/claims?phase=evidence_open&limit=25': claimList([listedClaim(), listedClaim()]),
      '/api/v1/claims?phase=closed&limit=25': claimList(closed),
    })
    expect(await p.getStats()).toEqual({ openClaims: 2, resolvedClaims: 2, totalLiquidity: '0', volume30d: '0', evidenceSubmissions: 0, counterexamplesAccepted: 1, collateralSymbol: 'sDAI' })
    expect(calls.sort()).toEqual(['/api/v1/claims?phase=closed&limit=25', '/api/v1/claims?phase=evidence_open&limit=25'])
  })
})

describe('policies', () => {
  const routes = {
    '/api/v1/policies': policyList,
    '/api/v1/policies/FUNC-001/0.1.0': policyDetail('FUNC-001'),
    '/api/v1/policies/BOT-001/0.1.0': policyDetail('BOT-001'),
    '/api/v1/policies/SC-001/0.1.0': policyDetail('SC-001'),
    '/api/v1/policies/FUNC-001/0.1.0/parameters.schema.json': funcParametersSchema,
    '/api/v1/policies/BOT-001/0.1.0/parameters.schema.json': botParametersSchema,
  }

  it('maps the catalog with status, digest, text and composer parameters', async () => {
    const { p } = provider(routes)
    const list = await p.listPolicies()
    expect(list.map((x) => [x.id, x.family, x.status, x.contentHash])).toEqual([
      ['FUNC-001', 'FUNC', 'draft', FUNC_SHA],
      ['BOT-001', 'BOT', 'draft', BOT_SHA],
      ['SC-001', 'SC', 'gated', SC_SHA],
    ])
    const bot = list[1]
    expect(bot).toMatchObject({ version: '0.1.0', title: 'Automation and Keeper Reliability', uri: `ipfs://${rawCidFromSha256(BOT_SHA)}`, publishedAt: '' })
    expect(bot?.parameters.map((x) => [x.key, x.kind, x.required])).toEqual([
      ['sourceRequirement', 'longtext', true],
      ['startingStates', 'longtext', true],
      ['simulatedAdapters', 'list', true],
    ])
    expect(bot?.summary).toMatch(/^Verify one invariant/)
    expect(list[2]).toMatchObject({ gateReason: 'Requires a human-approved live-vulnerability disclosure process.', parameters: [] })
  })

  it('caches the catalog briefly and immutable texts and schemas for good', async () => {
    let now = NOW_MS
    const { p, calls } = provider(routes, () => now)
    await p.listPolicies()
    const first = calls.length
    await p.listPolicies()
    expect(calls).toHaveLength(first)
    now += 61_000
    await p.listPolicies()
    expect(calls.slice(first)).toEqual(['/api/v1/policies'])
  })

  it('getPolicy resolves the latest version and refuses malformed ids or versions without a request', async () => {
    const { p, calls } = provider(routes)
    expect((await p.getPolicy('bot-001'))?.id).toBe('BOT-001')
    expect((await p.getPolicy('BOT-001', '0.1.0'))?.version).toBe('0.1.0')
    expect(await p.getPolicy('BOT-001', '9.9.9')).toBeNull()
    const before = calls.length
    for (const [id, version] of [['../etc', undefined], ['BOT-001/../../admin', undefined], ['BOT-001', '1.0'], ['BOT-001', '../0.1.0'], ['', undefined]] as const) {
      expect(await p.getPolicy(id, version)).toBeNull()
    }
    expect(calls).toHaveLength(before)
  })

  it('omits unknown policy families and rejects a malformed catalog', async () => {
    const odd = { policies: [...policyList.policies, { ...policyList.policies[0], id: 'XYZ-001' }] }
    const { p } = provider({ ...routes, '/api/v1/policies': odd, '/api/v1/policies/XYZ-001/0.1.0': policyDetail('FUNC-001', { id: 'XYZ-001' }) })
    expect((await p.listPolicies()).map((x) => x.id)).toEqual(['FUNC-001', 'BOT-001', 'SC-001'])
    const bad = provider({ '/api/v1/policies': { policies: [{ ...policyList.policies[0], sha256: 'not-a-digest' }] } })
    await expect(bad.p.listPolicies()).rejects.toMatchObject({ name: 'PineBackendError', apiCode: 'BAD_RESPONSE' })
  })
})

describe('createDataProvider in api mode', () => {
  it('reads the same-origin backend in the browser', async () => {
    const backend = fakeBackend({ '/api/v1/claims': claimList([]), '/api/v1/policies': policyList })
    const p = createDataProvider(readPineEnv({ dataSource: 'api' }), { runtime: 'browser', fetch: backend.fetch })
    expect(p).toBeInstanceOf(ApiDataProvider)
    expect(p.kind).toBe('api')
    await p.listClaims()
    expect(backend.calls).toContain('/api/v1/claims?limit=20')
  })

  it('reads PINE_API_INTERNAL_URL on the server, without cookies', async () => {
    const seen: RequestInit[] = []
    const backend = fakeBackend({ '/api/v1/claims': claimList([]), '/api/v1/policies': policyList })
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return backend.fetch(input, init)
    }) as typeof fetch
    const p = createDataProvider(readPineEnv({ dataSource: 'api', apiInternalUrl: 'http://pine-api.internal:3000/' }), { runtime: 'server', fetch: fetcher })
    await p.listClaims()
    expect(backend.calls).toContain('http://pine-api.internal:3000/api/v1/claims?limit=20')
    for (const init of seen) {
      expect(init.method).toBe('GET')
      expect(Object.keys((init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase())).toEqual(['accept'])
    }
  })

  it('resolves every read empty on a server without (or with an unusable) internal URL, without any request', async () => {
    for (const apiInternalUrl of [undefined, 'javascript:alert(1)', 'http://user:secret@pine-api:3000', 'ftp://pine-api']) {
      const backend = fakeBackend({})
      const p = createDataProvider(readPineEnv({ dataSource: 'api', apiInternalUrl }), { runtime: 'server', fetch: backend.fetch })
      expect(await p.listClaims()).toEqual({ items: [] })
      expect(await p.getClaim(MARKET)).toBeNull()
      expect(await p.listEvidence(MARKET)).toEqual([])
      expect(await p.listActivity({ account: CREATOR })).toEqual({ items: [] })
      expect((await p.getPortfolio(CREATOR)).positions).toEqual([])
      expect(await p.listPolicies()).toEqual([])
      expect(await p.getPolicy('BOT-001')).toBeNull()
      expect(await p.getDepth(MARKET, 'yes')).toBeNull()
      expect((await p.getStats()).openClaims).toBe(0)
      expect(backend.calls).toEqual([])
    }
  })

  it('leaves the other modes unchanged', () => {
    expect(createDataProvider(readPineEnv({ dataSource: 'mock' }))).toBeInstanceOf(MockDataProvider)
    expect(createDataProvider(readPineEnv({ dataSource: 'rest', apiUrl: 'https://api.pine.example/v1' }))).toBeInstanceOf(RestDataProvider)
  })
})
