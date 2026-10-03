/** The api write client: exact request bodies and headers, strict response validation, error messages, polling. */
import { describe, expect, it, vi } from 'vitest'
import { PlanVerificationError } from '@pine/core/pine-shared'
import {
  describeWriteError,
  draftInputSchema,
  formatWait,
  ladderFiguresFromIssues,
  PineApiClient,
  PineBackendError,
  PineWriteApi,
  pollUntil,
  RetryLaterError,
  type DraftInput,
} from '../src'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: BodyInit | null | undefined
}

function client(respond: (call: Call) => Response) {
  const calls: Call[] = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return { api: new PineWriteApi(new PineApiClient({ baseUrl: '', fetch: fetcher })), calls }
}

const ok = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number, code: string, message: string, extra: { issues?: unknown; retryAfter?: number } = {}) => () =>
  new Response(JSON.stringify({ error: { code, message, requestId: 'r', ...(extra.issues ? { issues: extra.issues } : {}) } }), {
    status,
    headers: { 'content-type': 'application/json', ...(extra.retryAfter ? { 'retry-after': String(extra.retryAfter) } : {}) },
  })

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const SHA = `0x${'ab'.repeat(32)}` as const
const TX = `0x${'cd'.repeat(32)}` as const
const MARKET = '0x4000000000000000000000000000000000000004' as const
const ISO = '2026-10-04T12:00:00.000Z'

const input: DraftInput = {
  repository: { owner: 'kleros', name: 'kleros-v2' },
  commit: 'c84e3dd7c01a2be9db29c372ed0006b55bf59ec0',
  baseCommit: null,
  membership: { kind: 'pull', number: 2101 },
  policy: { id: 'BOT-001', version: '0.1.0' },
  title: 'Reporter deposits never draw on the gas reserve',
  requirement: 'r',
  violation: 'v',
  scope: { components: ['src'], outOfScope: [] },
  allowedInputs: 'a',
  assumptions: [],
  faultModel: 'f',
  regressionOnly: false,
  exclusions: [],
  policyParameters: {},
  environment: { runtime: 'node', dependencies: 'd', configuration: 'none', externalState: 'none', reproduction: { setup: 'none', command: 'c', notes: '' } },
  evidenceWindowSeconds: 604_800,
  minBondWei: null,
}
const draftView = { id: UUID, revision: 2, input, valid: true, issues: [], createdAt: ISO, updatedAt: ISO }
const publication = {
  id: UUID,
  state: 'submitted',
  previewId: UUID,
  draftId: UUID,
  documentSha256: SHA,
  creator: MARKET,
  planId: UUID,
  market: null,
  planExpiresAt: 1_791_000_000,
  planExpiresAtIso: '2026-10-05T12:00:00Z',
  planExpired: false,
  failureReason: null,
  transactions: [{ txHash: TX, status: 'unknown', reason: null }],
  createdAt: ISO,
  updatedAt: ISO,
}
const planState = { id: UUID, kind: 'evidence_commit', route: 'evidence.commit', market: MARKET, account: MARKET, state: 'planned', expiresAt: 1_791_000_000, offerExpired: false, steps: [], createdAt: ISO, updatedAt: ISO }

describe('PineWriteApi requests', () => {
  it('creates and updates drafts with the exact strict bodies and the CSRF header', async () => {
    const { api, calls } = client(ok({ draft: draftView }, 201))
    await api.createDraft(input)
    await api.updateDraft(UUID, input, 1)
    await api.updateDraft(UUID, input)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/v1/drafts'],
      ['PUT', `/api/v1/drafts/${UUID}`],
      ['PUT', `/api/v1/drafts/${UUID}`],
    ])
    expect(calls[0]?.body).toBe(JSON.stringify(input))
    expect(calls[1]?.body).toBe(JSON.stringify({ input, expectedRevision: 1 }))
    expect(calls[2]?.body).toBe(JSON.stringify({ input }))
    for (const c of calls) expect(c.headers).toMatchObject({ 'x-pine-csrf': '1', 'content-type': 'application/json' })
  })

  it('sends the live-system attestation only as `true` and refuses to preview without it', async () => {
    const { api, calls } = client(ok({}))
    await expect(api.preview(UUID, { liveSystemImpactNone: false as unknown as true })).rejects.toThrow(/attestation/)
    expect(calls).toEqual([])
    await expect(api.preview(UUID, { liveSystemImpactNone: true })).rejects.toThrow(PineBackendError) // {} is not a preview
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/drafts/${UUID}/preview`, body: '{"attestLiveSystemImpactNone":true}' })
  })

  it('publishes by preview id and lowercase digest, and reports a publication transaction by hash only', async () => {
    const { api, calls } = client(ok({ publication, planExpired: false, plan: null }))
    await api.publish(UUID, `0x${'AB'.repeat(32)}`)
    expect(calls[0]?.body).toBe(JSON.stringify({ previewId: UUID, documentSha256: SHA }))
    await api.reportPublicationTx(UUID, `0x${'CD'.repeat(32)}`)
    expect(calls[1]).toMatchObject({ url: `/api/v1/publications/${UUID}/submitted`, body: JSON.stringify({ txHash: TX }) })
    await expect(api.reportPublicationTx(UUID, '0x1234')).rejects.toThrow(/transaction hash/)
    expect(calls).toHaveLength(2)
  })

  it('SEC-TX-08 sends the Idempotency-Key with plan requests and reports plan steps as {stepId, txHash}', async () => {
    const { api, calls } = client(ok({ plan: {}, planState, details: {} }, 201))
    await api.commitPlan({ market: MARKET, commitment: SHA }, 'key_1-A')
    expect(calls[0]).toMatchObject({ url: '/api/v1/evidence/plans/commit', body: JSON.stringify({ market: MARKET, commitment: SHA }) })
    expect(calls[0]?.headers['idempotency-key']).toBe('key_1-A')
    await expect(api.commitPlan({ market: MARKET, commitment: SHA }, 'bad key!')).rejects.toThrow(/idempotency/)
    await api.reportMarketsPlanTx(UUID, 'commit', TX)
    expect(calls[1]).toMatchObject({ url: `/api/v1/markets/plans/${UUID}/submitted`, body: JSON.stringify({ stepId: 'commit', txHash: TX }) })
    expect(calls[1]?.headers['idempotency-key']).toBeUndefined()
    await expect(api.reportMarketsPlanTx(UUID, '../x', TX)).rejects.toThrow(/step id/)
  })

  it('sends the required empty object to the withdraw route and the exact oracle bodies', async () => {
    const { api, calls } = client(ok({ plan: {}, planState: { ...planState, kind: 'oracle_withdraw', market: null }, details: {} }, 201))
    await api.oraclePlan('withdraw', {}, 'k1')
    await api.oraclePlan('submit-answer', { market: MARKET, outcome: 'yes', bond: '1000' }, 'k2')
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ['/api/v1/oracle/plans/withdraw', '{}'],
      ['/api/v1/oracle/plans/submit-answer', JSON.stringify({ market: MARKET, outcome: 'yes', bond: '1000' })],
    ])
  })

  it('SEC-EVID-01 uploads one artifact as multipart with its digest and a neutral file name, never above 256 KiB', async () => {
    const { api, calls } = client(ok({ sha256: SHA, cid: 'bafkrei', size: 3 }, 201))
    await api.uploadArtifact(new TextEncoder().encode('abc'), { mediaType: 'text/plain', expectedSha256: SHA })
    const form = calls[0]?.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(calls[0]?.headers['content-type']).toBeUndefined()
    expect(calls[0]?.headers['x-pine-csrf']).toBe('1')
    expect([...form.keys()]).toEqual(['expectedSha256', 'file'])
    expect(form.get('expectedSha256')).toBe(SHA)
    const file = form.get('file') as File
    expect([file.name, file.type, await file.text()]).toEqual(['artifact', 'text/plain', 'abc'])
    await expect(api.uploadArtifact(new Uint8Array(262_145), { mediaType: 'text/plain', expectedSha256: SHA })).rejects.toThrow(/256 KiB/)
    expect(calls).toHaveLength(1)
  })

  it('never puts a salt into the reveal-template request and acknowledges unavailable content only when asked', async () => {
    const template = { template: { chainId: 100, registry: MARKET, function: 'f', submissionId: '1', contentSha256: SHA, commitment: SHA, market: MARKET, account: MARKET, revealDeadline: 1, expiresAt: 1 }, warnings: [], instructions: [] }
    const { api, calls } = client(ok(template))
    await api.revealTemplate({ submissionId: '1', contentSha256: SHA })
    await api.revealTemplate({ submissionId: '1', contentSha256: SHA, unavailableContentAcknowledged: true })
    expect(calls.map((c) => c.body)).toEqual([JSON.stringify({ submissionId: '1', contentSha256: SHA }), JSON.stringify({ submissionId: '1', contentSha256: SHA, unavailableContentAcknowledged: true })])
  })

  it('reads oracle status and evidence listings with only the query parameters the strict routes accept', async () => {
    const { api, calls } = client(() => new Response('{}', { status: 200 }))
    await expect(api.oracleStatus(MARKET, '0xABCDEF0000000000000000000000000000000001')).rejects.toThrow(PineBackendError)
    await expect(api.evidence(MARKET, { status: 'committed' })).rejects.toThrow(PineBackendError)
    await expect(api.evidence(MARKET)).rejects.toThrow(PineBackendError)
    expect(calls.map((c) => c.url)).toEqual([
      `/api/v1/markets/${MARKET}/oracle?account=0xabcdef0000000000000000000000000000000001`,
      `/api/v1/markets/${MARKET}/evidence?status=committed`,
      `/api/v1/markets/${MARKET}/evidence`,
    ])
  })
})

describe('PineWriteApi responses', () => {
  it('rejects answers that do not match the wire schema', async () => {
    const { api } = client(ok({ draft: { ...draftView, id: 'not-a-uuid' } }))
    await expect(api.getDraft(UUID)).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
    const pub = client(ok({ publication: { ...publication, state: 'teleported' } }))
    await expect(pub.api.getPublication(UUID)).rejects.toMatchObject({ apiCode: 'BAD_RESPONSE' })
  })

  it('keeps plans and claim documents opaque (they are verified by the caller)', async () => {
    const { api } = client(ok({ publication, planExpired: false, plan: { anything: true } }))
    expect((await api.publish(UUID, SHA)).plan).toEqual({ anything: true })
  })

  it('carries the error envelope, issues and Retry-After into PineBackendError', async () => {
    const { api } = client(failure(503, 'NOT_READY', 'Chain data is behind; try again shortly', { retryAfter: 30 }))
    await expect(api.commitPlan({ market: MARKET, commitment: SHA }, 'k')).rejects.toMatchObject({ apiCode: 'NOT_READY', status: 503, retryAfter: 30 })
  })
})

describe('draftInputSchema', () => {
  it('is strict like the backend schema', () => {
    expect(draftInputSchema.safeParse(input).success).toBe(true)
    expect(draftInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false)
    expect(draftInputSchema.safeParse({ ...input, title: 'a "quoted" title' }).success).toBe(false)
    expect(draftInputSchema.safeParse({ ...input, regressionOnly: true }).success).toBe(false)
    expect(draftInputSchema.safeParse({ ...input, evidenceWindowSeconds: 2 * 86_400 }).success).toBe(false)
    expect(draftInputSchema.safeParse({ ...input, minBondWei: '100000000000000000001' }).success).toBe(false)
  })
})

describe('ladderFiguresFromIssues', () => {
  const issues = [
    ['maxLossIfYesShares', '55'],
    ['maxLossIfYesXdaiWei', '68'],
    ['budgetWei', '100'],
    ['sets', '79'],
    ['finalLowerPrice', '0.0501'],
    ['finalUpperPrice', '0.4998'],
  ].map(([name, message]) => ({ path: ['riskAcknowledgement', 'computed', name as string], message: message as string }))

  it('reads the computed figures of a 409 acknowledgement refusal', () => {
    expect(ladderFiguresFromIssues(issues)).toEqual({ maxLossIfYesShares: '55', maxLossIfYesXdaiWei: '68', budgetWei: '100', sets: '79', finalLowerPrice: '0.0501', finalUpperPrice: '0.4998' })
  })

  it('refuses incomplete or malformed figures (the body is untrusted)', () => {
    expect(ladderFiguresFromIssues(issues.slice(1))).toBeNull()
    expect(ladderFiguresFromIssues(issues.map((i) => (i.path[2] === 'sets' ? { ...i, message: '1e18' } : i)))).toBeNull()
    expect(ladderFiguresFromIssues(undefined)).toBeNull()
  })
})

describe('describeWriteError', () => {
  const err = (status: number, code: PineBackendError['apiCode'], message: string, retryAfter?: number) =>
    new PineBackendError(message, status, code, 'r', undefined, retryAfter)

  it.each([
    [err(403, 'TERMS_REQUIRED', 'Accept the current terms'), 'sign_in', /Sign in again to accept the current terms/],
    [err(401, 'UNAUTHENTICATED', 'Sign in required'), 'sign_in', /Sign in with your wallet again/],
    [err(451, 'UNAVAILABLE_FOR_LEGAL_REASONS', 'blocked'), 'none', /not available for your wallet or region/],
    [err(429, 'QUOTA_EXCEEDED', 'quota', 7_500), 'retry_later', /daily limit for this action\. Try again in 2 h 5 min/],
    [err(503, 'NOT_READY', 'Chain data is behind; try again shortly', 30), 'retry_later', /catching up.*Try again in 30 s/],
    [err(503, 'NOT_READY', 'the claim is being created on chain; retry when it is final', 30), 'retry_later', /being created on chain/],
    [err(409, 'CONFLICT', 'plan offer expired; create a new preview'), 'repreview', /offer to publish this preview expired/],
    [err(409, 'CONFLICT', 'The draft was modified after this preview; preview again'), 'repreview', /changed after this preview/],
    [err(409, 'CONFLICT', 'Connect your GitHub account again before publishing'), 'link_github', /Connect your GitHub account/],
    [err(403, 'FORBIDDEN', 'Connect your GitHub account first'), 'link_github', /Connect your GitHub account first/],
    [err(422, 'UNPROCESSABLE', 'The commit is not part of the selected pull request or branch'), 'fix_input', /not part of the selected pull request/],
    [err(0, 'NETWORK', 'Could not reach'), 'retry_later', /Could not reach Pine/],
  ])('%s → %s', (e, action, message) => {
    const info = describeWriteError(e)
    expect(info.action).toBe(action)
    expect(info.message).toMatch(message)
    expect(info.code).toBe(e.apiCode)
  })

  it('says nothing reached the wallet when a plan fails verification', () => {
    const info = describeWriteError(new PlanVerificationError('create', 'createClaim minBond differs from the previewed claim document'))
    expect(info).toMatchObject({ code: 'PLAN_REJECTED', action: 'none' })
    expect(info.message).toMatch(/nothing was sent to your wallet/)
  })

  it('offers a later retry for the app’s own transient refusals', () => {
    const info = describeWriteError(new RetryLaterError('Pine’s oracle status does not match the chain yet. Nothing was sent.', 30))
    expect(info).toEqual({ code: 'UNKNOWN', action: 'retry_later', message: 'Pine’s oracle status does not match the chain yet. Nothing was sent.', retryAfter: 30 })
  })

  it('formats waits', () => {
    expect([formatWait(2), formatWait(90), formatWait(7_500), formatWait(7_200)]).toEqual(['2 s', '2 min', '2 h 5 min', '2 h'])
  })
})

describe('pollUntil', () => {
  it('stops at a final value, honours Retry-After on 503 and backs off on network failures', async () => {
    const answers: (() => Promise<string>)[] = [
      async () => 'planned',
      async () => {
        throw new PineBackendError('behind', 503, 'NOT_READY', 'r', undefined, 30)
      },
      async () => {
        throw new PineBackendError('offline', 0, 'NETWORK')
      },
      async () => 'confirmed',
    ]
    const waits: number[] = []
    const seen: string[] = []
    const final = await pollUntil({
      load: () => (answers.shift() ?? (async () => 'never'))(),
      done: (v) => v === 'confirmed',
      onValue: (v) => seen.push(v),
      intervalMs: 1_000,
      signal: new AbortController().signal,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(final).toBe('confirmed')
    expect(seen).toEqual(['planned', 'confirmed'])
    // Consecutive transient failures back off exponentially (the second one waits 2² × the interval).
    expect(waits).toEqual([1_000, 30_000, 4_000])
  })

  it('rethrows non-transient failures and resolves null once aborted', async () => {
    await expect(
      pollUntil({ load: async () => Promise.reject(new PineBackendError('nope', 404, 'NOT_FOUND')), done: () => false, intervalMs: 1, signal: new AbortController().signal, sleep: async () => undefined }),
    ).rejects.toMatchObject({ apiCode: 'NOT_FOUND' })
    const controller = new AbortController()
    const result = pollUntil({ load: async () => 'x', done: () => false, intervalMs: 1, signal: controller.signal, sleep: async () => controller.abort() })
    expect(await result).toBeNull()
  })
})
