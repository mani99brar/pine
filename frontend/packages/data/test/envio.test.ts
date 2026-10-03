import { hashJson } from '@pine/core'
import { describe, expect, it } from 'vitest'
import { EnvioDataProvider, MockManifestStorage, PineDataError } from '../src'
import { depthFromPool, deriveEnvioStatus, statusWhere, type EnvioClaimDetail, type EnvioClaimSummary } from '../src/envio/mappers'
import { fixtures } from '../src/mock/fixtures'

const NOW = 1_790_000_000 // fixed clock (unix seconds)
const H = 3600
const flagship = fixtures.claims.find((c) => c.number === 9)!

// ---------------------------------------------------------------------------
// Sample Envio (Hasura) responses shaped like docs/indexer/envio/schema.graphql
// ---------------------------------------------------------------------------

const summary = (over: Partial<EnvioClaimSummary> = {}): EnvioClaimSummary => ({
  id: `100:${flagship.marketAddress!.toLowerCase()}`,
  chainId: 100,
  claimId: 'pine-0009',
  number: 9,
  title: flagship.title,
  violation: flagship.violation,
  policyId: 'BOT-001',
  policyVersion: '0.1.0',
  policyFamily: 'BOT',
  policyTitle: 'Automation and Keeper Reliability',
  repoOwner: 'kleros',
  repoName: 'gateway-balancer-bot',
  commitSha: flagship.source.commitSha,
  prNumber: 47,
  prTitle: flagship.source.prTitle ?? null,
  evidenceDeadlineTs: String(NOW + 120 * H),
  creator: flagship.creator.toLowerCase(),
  sponsored: false,
  phase: 'open',
  currentAnswer: null,
  finalizeTs: '0',
  outcome: null,
  yesPrice: 0.12,
  noPrice: 0.86,
  invalidPrice: 0.02,
  yesPrice24hAgo: 0.1,
  liquidity: '400',
  volume: '312.6',
  volume24h: '58.4',
  openInterest: '118.79',
  traders: 12,
  evidenceCount: 2,
  createdAt: String(NOW - 48 * H),
  lastActivityAt: String(NOW - 2 * H),
  createdTx: `0x${'1'.repeat(64)}`,
  manifestUri: flagship.manifestUri,
  manifestHash: flagship.manifestHash,
  market: { address: flagship.marketAddress!.toLowerCase(), collateralSymbol: 'sDAI' },
  ...over,
})

const detail = (over: Partial<EnvioClaimDetail> = {}): EnvioClaimDetail => ({
  ...summary(),
  manifestValid: true,
  manifest: null,
  market: {
    address: flagship.marketAddress!.toLowerCase(),
    collateralSymbol: 'sDAI',
    id: `100:${flagship.marketAddress!.toLowerCase()}`,
    chainId: 100,
    collateralToken: '0xaf204776c7245bf4147c2612bf6e5972ee483701',
    conditionId: `0x${'c'.repeat(64)}`,
    questionId: `0x${'d'.repeat(64)}`,
    realityQuestionId: `0x${'e'.repeat(64)}`,
    templateId: 2,
    openingTs: String(NOW + 120 * H),
    payoutReported: false,
    payoutNumerators: [],
    blockTimestamp: String(NOW - 48 * H),
    txHash: `0x${'1'.repeat(64)}`,
    outcomes: [
      { index: 0, label: 'Yes', token: '0x' + '0a'.repeat(20), price: 0.12, change24h: 0.02 },
      { index: 1, label: 'No', token: '0x' + '0b'.repeat(20), price: 0.86, change24h: -0.02 },
      { index: 2, label: 'Invalid result', token: '0x' + '0c'.repeat(20), price: 0.02, change24h: null },
    ],
    pools: [
      { address: '0x' + '1a'.repeat(20), dex: 'Swapr v3 (Algebra)', outcomeIndex: 0, feeBps: 1, tvlCollateral: '200' },
      { address: '0x' + '1b'.repeat(20), dex: 'Swapr v3 (Algebra)', outcomeIndex: 1, feeBps: 1, tvlCollateral: '200' },
      { address: '0x' + '1c'.repeat(20), dex: 'Swapr v3 (Algebra)', outcomeIndex: 2, feeBps: 1, tvlCollateral: '0.5' },
    ],
  },
  question: {
    questionId: `0x${'e'.repeat(64)}`,
    templateId: 2,
    openingTs: String(NOW + 120 * H),
    timeout: '302400',
    minBond: '10',
    finalizeTs: '0',
    isPendingArbitration: false,
    bestAnswer: null,
    bond: '0',
    finalizedByArbitrator: false,
    answers: [],
    arbitration: null,
  },
  evidence: [
    {
      id: `1:0x${'2'.repeat(64)}:7`,
      questionId: `0x${'e'.repeat(64)}`,
      chainId: 1,
      party: '0x' + '3f'.repeat(20),
      uri: 'ipfs://bafkreievidence/evidence.json',
      blockNumber: '23900000',
      timestamp: String(NOW - 14 * H),
      txHash: `0x${'2'.repeat(64)}`,
      timely: true,
      hydrated: true,
      kind: 'commitment',
      title: 'Commitment 0x2b7a…c40e',
      summary: 'Hash committed before the deadline.',
      contentHash: `0x${'4'.repeat(64)}`,
      reproduction: null,
      attachments: [],
      commitment: { hash: `0x${'4'.repeat(64)}`, revealed: false },
    },
    {
      id: `1:0x${'5'.repeat(64)}:3`,
      questionId: `0x${'e'.repeat(64)}`,
      chainId: 1,
      party: '0x' + '6f'.repeat(20),
      uri: 'ipfs://bafkreinothydrated',
      blockNumber: '23900100',
      timestamp: String(NOW - 2 * H),
      txHash: `0x${'5'.repeat(64)}`,
      timely: null,
      hydrated: false,
      kind: 'unknown',
      title: null,
      summary: null,
      contentHash: null,
      reproduction: { command: 'pnpm vitest run x', environment: 'node 22', expected: 'a', actual: 'b', steps: ['one', 2] },
      attachments: [{ name: 'log.txt', uri: 'ipfs://bafkreilog', mime: 'text/plain', size: 10 }],
      commitment: null,
    },
  ],
  activity: [
    { id: 'a1', type: 'liquidity_added', actor: flagship.creator.toLowerCase(), timestamp: String(NOW - 48 * H + 600), txHash: `0x${'7'.repeat(64)}`, summary: 'Added liquidity to the YES pool' },
  ],
  ...over,
})

/** fetch stub routing by GraphQL operation name. */
function envioServer(handlers: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const calls: { op: string; vars: Record<string, unknown> }[] = []
  const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> }
    const op = /query (\w+)/.exec(body.query)?.[1] ?? 'anonymous'
    calls.push({ op, vars: body.variables })
    const h = handlers[op]
    if (!h) return new Response(JSON.stringify({ errors: [{ message: `no handler for ${op}` }] }))
    return new Response(JSON.stringify({ data: h(body.variables) }))
  }) as typeof fetch
  return { fetcher, calls }
}

const provider = (fetcher: typeof fetch) =>
  new EnvioDataProvider({ url: 'https://indexer.test/v1/graphql', fetch: fetcher, storage: new MockManifestStorage({ ipfsGateway: 'https://gw' }), now: () => NOW * 1000 })

describe('Envio status derivation', () => {
  it('maps indexed facts to lifecycle status at a given time', () => {
    const base = { evidenceDeadlineTs: String(NOW + 10), finalizeTs: '0', currentAnswer: null, outcome: null }
    expect(deriveEnvioStatus({ ...base, phase: 'open' }, NOW).status).toBe('open')
    expect(deriveEnvioStatus({ ...base, phase: 'open', evidenceDeadlineTs: String(NOW - 10) }, NOW).status).toBe('awaiting_answer')
    expect(deriveEnvioStatus({ ...base, phase: 'answered', finalizeTs: String(NOW + 100), currentAnswer: 'no' }, NOW).status).toBe('answer_proposed')
    expect(deriveEnvioStatus({ ...base, phase: 'disputed', finalizeTs: String(NOW + 100), currentAnswer: 'yes' }, NOW).status).toBe('disputed')
    expect(deriveEnvioStatus({ ...base, phase: 'disputed', finalizeTs: String(NOW - 1), currentAnswer: 'yes' }, NOW)).toEqual({ status: 'resolved', outcome: 'yes' })
    expect(deriveEnvioStatus({ ...base, phase: 'answered', finalizeTs: String(NOW - 1), currentAnswer: 'too_soon' }, NOW).status).toBe('awaiting_answer')
    expect(deriveEnvioStatus({ ...base, phase: 'arbitration', currentAnswer: 'yes' }, NOW).status).toBe('arbitration')
    expect(deriveEnvioStatus({ ...base, phase: 'finalized', outcome: 'invalid' }, NOW)).toEqual({ status: 'resolved', outcome: 'invalid' })
  })

  it('builds Hasura where clauses per status; off-chain statuses match nothing', () => {
    expect(statusWhere('open', NOW)).toEqual({ phase: { _eq: 'open' }, evidenceDeadlineTs: { _gt: String(NOW) } })
    expect(statusWhere('disputed', NOW)).toEqual({ phase: { _eq: 'disputed' }, finalizeTs: { _gt: String(NOW) } })
    const resolved = JSON.stringify(statusWhere('resolved', NOW))
    expect(resolved).toContain('"outcome":{"_is_null":false}')
    expect(JSON.stringify(statusWhere('awaiting_answer', NOW))).toContain('"phase":{"_eq":"finalized"},"outcome":{"_is_null":true}')
    expect(statusWhere('publishing', NOW)).toBeNull()
    expect(statusWhere('draft', NOW)).toBeNull()
    expect(statusWhere('settled', NOW)).toBeNull()
  })
})

describe('EnvioDataProvider', () => {
  it('lists claims with server-side filters, ordering and offset pagination (limit + 1 probe)', async () => {
    const { fetcher, calls } = envioServer({ ListClaims: () => ({ Claim: [summary(), summary({ claimId: 'pine-0012', number: 12, id: '100:0x' + '9'.repeat(40) }), summary({ claimId: 'pine-0013', number: 13 })] }) })
    const p = provider(fetcher)
    const page = await p.listClaims({ status: ['open', 'disputed'], policyId: 'bot-001', repo: 'Kleros/Gateway-Balancer-Bot', search: 'reporter 50%', sort: 'liquidity', limit: 2, cursor: '4' })
    expect(page.items.map((c) => c.id)).toEqual(['pine-0009', 'pine-0012'])
    expect(page.nextCursor).toBe('6')
    const v = calls[0]!.vars
    expect(v).toMatchObject({ limit: 3, offset: 4, orderBy: [{ liquidity: 'desc' }, { id: 'asc' }] })
    const where = JSON.stringify(v.where)
    expect(where).toContain('"policyId":{"_eq":"BOT-001"}')
    expect(where).toContain('"repo":{"_eq":"kleros/gateway-balancer-bot"}')
    expect(where).toContain('"searchText":{"_ilike":"%reporter%"}')
    expect(where).toContain('"_ilike":"%50\\\\%%"') // LIKE wildcards escaped
    expect(where).toContain('"phase":{"_eq":"disputed"}')
    const c = page.items[0]!
    expect(c).toMatchObject({ status: 'open', policy: { id: 'BOT-001', family: 'BOT' }, source: { owner: 'kleros', prNumber: 47 }, liquidity: '400', collateralSymbol: 'sDAI', yesPrice: 0.12 })
    expect(c.evidenceDeadline).toBe(new Date((NOW + 120 * H) * 1000).toISOString().replace('.000Z', 'Z'))
  })

  it('returns an empty page without querying when only off-chain statuses are requested', async () => {
    const { fetcher, calls } = envioServer({})
    const page = await provider(fetcher).listClaims({ status: ['draft', 'publishing'] })
    expect(page.items).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('hydrates claim detail: manifest from IPFS, market, oracle, evidence, timeline', async () => {
    const { fetcher, calls } = envioServer({ ClaimDetail: () => ({ Claim: [detail()] }), EvidenceByQuestion: () => ({ Evidence: detail().evidence }) })
    const c = await provider(fetcher).getClaim('PINE-0009')
    expect(calls[0]!.vars.where).toEqual({ claimId: { _eq: 'pine-0009' } })
    expect(c).not.toBeNull()
    expect(hashJson(c!.manifest)).toBe(c!.manifestHash)
    expect(c!.status).toBe('open')
    expect(c!.market?.outcomes.map((o) => o.label)).toEqual(['Yes', 'No', 'Invalid result'])
    expect(c!.market?.pools.map((p) => p.outcome)).toEqual(['yes', 'no']) // invalid pool not exposed
    expect(c!.market?.seerUrl).toBe(`https://app.seer.pm/markets/100/${flagship.marketAddress!.toLowerCase()}`)
    expect(c!.oracle).toMatchObject({ timeoutSeconds: 302400, bondToken: 'xDAI', isFinalized: false, history: [], arbitration: { requested: false } })
    expect(c!.evidence).toHaveLength(2)
    const [commit, raw] = c!.evidence
    expect(commit).toMatchObject({ kind: 'commitment', chainId: 1, timely: true, commitment: { revealed: false } })
    // an unread package is never shown as a counterexample, and no hash is fabricated for it
    expect(raw).toMatchObject({ kind: 'clarification', timely: true, title: 'Evidence package not yet read by the indexer', contentHash: `0x${'0'.repeat(64)}`, attachments: [] })
    expect(raw!.reproduction).toBeUndefined()
    expect(calls.map((x) => x.op)).toEqual(['ClaimDetail', 'EvidenceByQuestion'])
    expect(calls[1]!.vars).toEqual({ questionId: `0x${'e'.repeat(64)}` })
    expect(c!.timeline.find((t) => t.detail === 'Evidence package not yet read by the indexer')?.title).toBe('Evidence submitted')
    const kinds = c!.timeline.map((t) => t.kind)
    expect(kinds).toEqual(expect.arrayContaining(['market_created', 'liquidity_added', 'evidence_submitted', 'evidence_deadline', 'oracle_opened']))
    expect(c!.timeline.find((t) => t.kind === 'evidence_deadline')?.scheduled).toBe(true)
  })

  it('uses the indexer-stored manifest when it verifies and rejects unverifiable terms', async () => {
    const ev = { EvidenceByQuestion: () => ({ Evidence: [] }) }
    const { fetcher } = envioServer({ ClaimDetail: () => ({ Claim: [detail({ manifest: flagship.manifest, manifestUri: 'ipfs://bafkreinotstored' })] }), ...ev })
    expect((await provider(fetcher).getClaim('pine-0009'))?.manifest.claimId).toBe('pine-0009')
    const { fetcher: f2 } = envioServer({ ClaimDetail: () => ({ Claim: [detail({ manifestUri: 'ipfs://bafkreinotstored' })] }), ...ev })
    await expect(provider(f2).getClaim('pine-0009')).rejects.toBeInstanceOf(PineDataError)
    // stored manifest that does not hash to manifestHash, and IPFS content for another claim → rejected
    const other = fixtures.claims.find((c) => c.number === 10)!
    const { fetcher: f3 } = envioServer({ ClaimDetail: () => ({ Claim: [detail({ manifest: other.manifest, manifestUri: other.manifestUri })] }), ...ev })
    await expect(provider(f3).getClaim('pine-0009')).rejects.toMatchObject({ code: 'bad_response' })
    const { fetcher: f4 } = envioServer({ ClaimDetail: () => ({ Claim: [detail({ manifestValid: false, manifest: flagship.manifest })] }), ...ev })
    await expect(provider(f4).getClaim('pine-0009')).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('maps disputed, arbitration (appeal period) and resolved states', async () => {
    const answers = [
      { answer: 'no', bond: '10', user: '0x' + 'aa'.repeat(20), timestamp: String(NOW - 50 * H), txHash: `0x${'a'.repeat(64)}` },
      { answer: 'yes', bond: '20', user: '0x' + 'bb'.repeat(20), timestamp: String(NOW - 10 * H), txHash: `0x${'b'.repeat(64)}` },
    ]
    const q = detail().question!
    const disputed = detail({ phase: 'disputed', currentAnswer: 'yes', finalizeTs: String(NOW + 74 * H), evidenceDeadlineTs: String(NOW - 60 * H), question: { ...q, answers, bond: '20', bestAnswer: '0x' + '0'.repeat(64), finalizeTs: String(NOW + 74 * H) } })
    const arbitration = detail({
      phase: 'arbitration',
      currentAnswer: 'yes',
      evidenceDeadlineTs: String(NOW - 400 * H),
      question: { ...q, answers, bond: '20', isPendingArbitration: true, arbitration: { requester: '0x' + 'cc'.repeat(20), requestedAt: String(NOW - 300 * H), disputeId: '1642', court: 'General Court (31 jurors)', cost: '0.1674', status: 'ruled', ruling: 'yes', rulingAt: String(NOW - 60 * H), appealPeriodEnd: String(NOW + 48 * H) } },
    })
    const resolved = detail({ phase: 'finalized', outcome: 'yes', currentAnswer: 'yes', evidenceDeadlineTs: String(NOW - 600 * H), question: { ...q, answers, bond: '20', finalizeTs: String(NOW - 400 * H) } })
    let next = disputed
    const { fetcher } = envioServer({ ClaimDetail: () => ({ Claim: [next] }), EvidenceByQuestion: () => ({ Evidence: [] }) })
    const p = provider(fetcher)
    const d = await p.getClaim('pine-0009')
    expect(d?.status).toBe('disputed')
    expect(d?.oracle?.history.map((h) => h.bond)).toEqual(['10', '20'])
    expect(d?.oracle?.finalizesAt).toBeDefined()
    expect(d?.timeline.filter((t) => t.kind === 'answer_challenged')).toHaveLength(1)
    next = arbitration
    const a = await p.getClaim('pine-0009')
    expect(a?.status).toBe('arbitration')
    expect(a?.oracle?.arbitration).toMatchObject({ requested: true, status: 'appeal_period', disputeId: '1642', cost: '0.1674', ruling: 'yes', klerosUrl: 'https://resolve.kleros.io/cases/1642?requiredChainId=1' })
    expect(a?.oracle?.finalizesAt).toBeUndefined()
    next = resolved
    const r = await p.getClaim('pine-0009')
    expect(r).toMatchObject({ status: 'resolved', outcome: 'yes' })
    expect(r?.oracle).toMatchObject({ isFinalized: true, finalAnswer: 'yes' })
  })

  it('reads by market, prices, depth, evidence, activity, portfolio and stats', async () => {
    const ref = { Claim: [{ id: `100:${flagship.marketAddress!.toLowerCase()}`, claimId: 'pine-0009', evidenceDeadlineTs: String(NOW + 120 * H), market: { realityQuestionId: `0x${'E'.repeat(64)}` } }] }
    const { fetcher, calls } = envioServer({
      ClaimDetail: () => ({ Claim: [detail()] }),
      ClaimRef: () => ref,
      PriceCandles: () => ({ PriceCandle: [{ periodStart: String(NOW - H), yesClose: 0.12, noClose: 0.86, volume: null }, { periodStart: String(NOW - 2 * H), yesClose: 0.11, noClose: 0.87, volume: '3.5' }] }),
      PoolForDepth: () => ({ Pool: [{ address: '0x' + '1a'.repeat(20), sqrtPriceX96: '0', liquidity: String(5n * 10n ** 20n), outcomeIsToken0: true, price: 0.12, tvlCollateral: '200' }] }),
      EvidenceByQuestion: () => ({ Evidence: detail().evidence }),
      ListActivity: () => ({ ActivityEvent: [{ id: 'x', type: 'trade', claimNumber: 9, claimTitle: 't', actor: '0x' + 'ab'.repeat(20), timestamp: String(NOW - 60), txHash: `0x${'9'.repeat(64)}`, chainId: 100, amount: '-5.5', token: 'sDAI', outcome: 'yes', side: 'buy', summary: 'Bought YES', claim: { claimId: 'pine-0009' } }] }),
      Portfolio: () => ({
        Account_by_pk: {
          id: 'x',
          depositedAllTime: '410',
          withdrawnAllTime: '0',
          feesPaidAllTime: '0.03',
          positions: [
            { outcomeIndex: 0, balance: '84', avgPrice: 0.11, claim: { claimId: 'pine-0002', number: 2, title: 'r', phase: 'finalized', finalizeTs: '1', currentAnswer: 'yes', outcome: 'yes', evidenceDeadlineTs: '1', yesPrice: 0.99, noPrice: 0.005, invalidPrice: 0.005 } },
            { outcomeIndex: 1, balance: '10', avgPrice: null, claim: { claimId: 'pine-0009', number: 9, title: 'f', phase: 'open', finalizeTs: '0', currentAnswer: null, outcome: null, evidenceDeadlineTs: String(NOW + 10), yesPrice: 0.12, noPrice: 0.86, invalidPrice: 0.02 } },
          ],
          liquidityPositions: [
            { tokenId: '48211', outcomeIndex: 0, depositedCollateral: '200', currentValue: '203.18', feesEarned: '0.42', inRange: false, pool: { address: '0x' + '1A'.repeat(20) }, claim: { claimId: 'pine-0009', number: 9, title: 'f' } },
            { tokenId: '48213', outcomeIndex: 2, depositedCollateral: '1', currentValue: '1', feesEarned: '0', inRange: true, pool: { address: '0x' + '1C'.repeat(20) }, claim: { claimId: 'pine-0009', number: 9, title: 'f' } },
          ],
        },
      }),
      Stats: () => ({ PlatformStats_by_pk: { claimCount: 18, resolvedClaims: 4, counterexamplesAccepted: 1, evidenceSubmissions: 27, totalLiquidity: '6967.2', volumeTotal: '16000', collateralSymbol: 'sDAI' }, DailyStats: [{ dayStart: '1', volume: '100.5' }, { dayStart: '2', volume: '0.25' }], open: [{ id: 'a' }, { id: 'b' }] }),
    })
    const p = provider(fetcher)
    expect((await p.getClaimByMarket(100, flagship.marketAddress!))?.id).toBe('pine-0009')
    expect(calls.find((x) => x.op === 'ClaimDetail')!.vars.where).toEqual({ id: { _eq: `100:${flagship.marketAddress!.toLowerCase()}` } })

    const prices = await p.getPriceHistory('pine-0009', '24h')
    expect(prices).toEqual([{ t: (NOW - 2 * H) * 1000, yes: 0.11, no: 0.87, volume: 3.5 }, { t: (NOW - H) * 1000, yes: 0.12, no: 0.86 }])
    expect(calls.at(-1)!.vars).toEqual({ claim: `100:${flagship.marketAddress!.toLowerCase()}`, from: String(NOW - 24 * H) })

    const depth = await p.getDepth('pine-0009', 'yes')
    expect(depth?.mid).toBe(0.12)
    const asks = depth!.levels.filter((l) => l.side === 'ask')
    expect(asks.length).toBe(10)
    for (let i = 1; i < asks.length; i++) expect(asks[i]!.size).toBeGreaterThan(asks[i - 1]!.size)

    const ev = await p.listEvidence('pine-0009')
    expect(calls.at(-1)!.vars).toEqual({ questionId: `0x${'e'.repeat(64)}` })
    expect(ev).toHaveLength(2)

    const act = await p.listActivity({ claimId: 'pine-0009', account: '0x' + 'AB'.repeat(20) as `0x${string}`, types: ['trade'] })
    expect(act.items[0]).toMatchObject({ type: 'trade', claimId: 'pine-0009', amount: '-5.5', side: 'buy', status: 'confirmed' })
    expect(calls.at(-1)!.vars.where).toEqual({ _and: [{ claim: { claimId: { _eq: 'pine-0009' } } }, { actor: { _eq: '0x' + 'ab'.repeat(20) } }, { type: { _in: ['trade'] } }] })

    const pf = await p.getPortfolio('0xDE30BD7C2A0B6f1e5C4b1a9F2f5d3C8E7a6b0D30')
    expect(calls.at(-1)!.vars).toEqual({ id: '0xde30bd7c2a0b6f1e5c4b1a9f2f5d3c8e7a6b0d30' })
    expect(pf.positions[0]).toMatchObject({ status: 'resolved', outcome: 'yes', markPrice: 1, redeemable: true, redeemableAmount: '84', value: '84' })
    expect(pf.positions[1]).toMatchObject({ status: 'open', outcome: 'no', markPrice: 0.86, value: '8.6', redeemable: false })
    expect(pf.liquidity).toHaveLength(1) // Invalid-result pool position not shown as YES/NO liquidity
    expect(pf.liquidity[0]).toMatchObject({ inRange: false, pool: '0x' + '1a'.repeat(20) })
    expect(pf.totals).toMatchObject({ redeemable: '84', positionsValue: '92.6', liquidityValue: '203.18', depositedAllTime: '410' })

    const stats = await p.getStats()
    expect(stats).toEqual({ openClaims: 2, resolvedClaims: 4, totalLiquidity: '6967.2', volume30d: '100.75', evidenceSubmissions: 27, counterexamplesAccepted: 1, collateralSymbol: 'sDAI' })
    expect((await p.listPolicies()).map((x) => x.id)).toEqual(['FUNC-001', 'BOT-001', 'SC-001'])
  })

  it('maps transport and GraphQL errors to PineDataError', async () => {
    const gqlErr = (async () => new Response(JSON.stringify({ errors: [{ message: 'field "Claim" not found' }] }))) as typeof fetch
    await expect(provider(gqlErr).listClaims()).rejects.toMatchObject({ code: 'bad_response' })
    const limited = (async () => new Response('{}', { status: 429 })) as typeof fetch
    await expect(provider(limited).listClaims()).rejects.toMatchObject({ code: 'rate_limited' })
    const down = (async () => { throw new TypeError('ECONNREFUSED') }) as typeof fetch
    await expect(provider(down).listClaims()).rejects.toMatchObject({ code: 'network' })
    const { fetcher } = envioServer({ ClaimDetail: () => ({ Claim: [] }), ClaimRef: () => ({ Claim: [] }), Stats: () => ({ PlatformStats_by_pk: null, DailyStats: [], open: [] }) })
    expect(await provider(fetcher).getClaim('pine-9999')).toBeNull()
    expect(await provider(fetcher).getDepth('pine-9999', 'yes')).toBeNull()
    expect(await provider(fetcher).listEvidence('pine-9999')).toEqual([])
    // a fresh indexer without the PlatformStats singleton reports zeros
    expect(await provider(fetcher).getStats()).toEqual({ openClaims: 0, resolvedClaims: 0, totalLiquidity: '0', volume30d: '0', evidenceSubmissions: 0, counterexamplesAccepted: 0, collateralSymbol: 'sDAI' })
  })

  it('orders every claim list with a unique tie-breaker', async () => {
    const { fetcher, calls } = envioServer({ ListClaims: () => ({ Claim: [] }) })
    const p = provider(fetcher)
    for (const sort of ['newest', 'deadline', 'liquidity', 'volume', 'yes_price', 'activity'] as const) {
      await p.listClaims({ sort })
      expect((calls.at(-1)!.vars.orderBy as Record<string, string>[]).at(-1)).toEqual({ id: 'asc' })
    }
  })
})

describe('depthFromPool', () => {
  it('derives cumulative sizes from active liquidity for either token order', () => {
    const L = String(10n ** 21n) // L = 1000 (18-decimals)
    const a = depthFromPool({ address: '0x', sqrtPriceX96: '0', liquidity: L, outcomeIsToken0: true, price: 0.25, tvlCollateral: '1' }, 'yes', NOW)!
    // outcome tokens between 0.25 and the first ask: L * (1/√0.25 − 1/√p)
    const firstAsk = a.levels.find((l) => l.side === 'ask')!
    expect(firstAsk.size).toBeCloseTo(1000 * (1 / Math.sqrt(0.25) - 1 / Math.sqrt(firstAsk.price)), 0)
    // sqrtPriceX96 path: outcome as token1, pool price = collateral per outcome inverted
    const sqrt = BigInt(Math.round(Math.sqrt(1 / 0.25) * 2 ** 48)) * 2n ** 48n
    const b = depthFromPool({ address: '0x', sqrtPriceX96: sqrt.toString(), liquidity: L, outcomeIsToken0: false, price: null, tvlCollateral: '1' }, 'yes', NOW)!
    expect(b.mid).toBeCloseTo(0.25, 3)
    expect(depthFromPool({ address: '0x', sqrtPriceX96: '0', liquidity: '0', outcomeIsToken0: true, price: 0.3, tvlCollateral: '0' }, 'yes', NOW)).toBeNull()
  })
})
