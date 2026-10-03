import { describe, expect, it } from 'vitest'
import { keccak256, stringToBytes } from 'viem'
import { createDataProvider, readPineEnv } from '@pine/data'
import { createAgentHandler, llmsFullTxtHandler, llmsTxtHandler, wellKnownHandler } from '../src/agent'
import { ctx, req } from './helpers'

const data = createDataProvider(readPineEnv({ dataSource: 'mock' }))
const agent = createAgentHandler({ appName: 'Pine Test', data, siteUrl: 'https://pine.example' })

async function get(path: string, extra = '') {
  const segs = path.split('/').filter(Boolean)
  return agent.GET(req(`/api/agent/${path}${extra}`), ctx(segs))
}

function expectPublicGet(res: Response) {
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=300')
}

describe('agent API v1', () => {
  it('index lists endpoints', async () => {
    const res = await get('v1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { endpoints: string[]; llmsTxt: string }
    expect(body.endpoints.length).toBeGreaterThan(5)
    expect(body.llmsTxt).toBe('https://pine.example/llms.txt')
  })

  it('GET v1/claims?status=open returns agent briefs', async () => {
    const res = await get('v1/claims', '?status=open&limit=5')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expectPublicGet(res)
    const body = (await res.json()) as { items: Record<string, unknown>[]; total?: number }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items.length).toBeLessThanOrEqual(5)
    for (const b of body.items) {
      expect(b.status).toBe('open')
      expect(b).toHaveProperty('question')
      expect(b).toHaveProperty('questionHash')
      expect(b).toHaveProperty('manifest.hash')
      expect(b).toHaveProperty('target.commit')
      expect(b).toHaveProperty('evidence.deadline')
      expect(b).toHaveProperty('reproduction.command')
      expect(String(b.url)).toMatch(/^https:\/\/pine\.example\//)
    }
  })

  it('filters by policy and validates query params', async () => {
    const res = await get('v1/claims', '?policy=BOT-001')
    const body = (await res.json()) as { items: { policy: { id: string } }[] }
    expect(body.items.every((b) => b.policy.id === 'BOT-001')).toBe(true)
    const bad = await get('v1/claims', '?status=bogus')
    expect(bad.status).toBe(400)
    const err = (await bad.json()) as { error: { code: string; message: string } }
    expect(err.error.code).toBe('bad_request')
    expect(err.error.message).toMatch(/Allowed/)
  })

  it('list as markdown', async () => {
    const res = await get('v1/claims', '?status=open&limit=2&format=md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(await res.text()).toMatch(/counterexample/i)
  })

  it('GET v1/claims/{id} returns the brief; numeric ids resolve; ?format=md returns Markdown', async () => {
    const res = await get('v1/claims/pine-0009')
    expect(res.status).toBe(200)
    expectPublicGet(res)
    const brief = (await res.json()) as { id: string; question: string; manifest: { hash: string; jsonUrl: string } }
    expect(brief.id).toBe('pine-0009')
    expect(brief.question).toMatch(/^Was a reproducible counterexample/)
    expect(res.headers.get('x-pine-manifest-hash')).toBe(brief.manifest.hash)

    const numeric = await get('v1/claims/9')
    expect(numeric.status).toBe(200)

    const md = await get('v1/claims/pine-0009', '?format=md')
    expect(md.status).toBe(200)
    expect(md.headers.get('content-type')).toMatch(/^text\/markdown/)
    const text = await md.text()
    expect(text).toContain(brief.question)
  })

  it('manifest.json is canonical and hash-verifiable', async () => {
    const res = await get('v1/claims/pine-0009/manifest.json')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    const header = res.headers.get('x-pine-manifest-hash')
    expect(header).toMatch(/^0x[0-9a-f]{64}$/)
    const body = await res.text()
    expect(keccak256(stringToBytes(body))).toBe(header)
    expect(JSON.parse(body)).toHaveProperty('claimId', 'pine-0009')
  })

  it('evidence route marks content as untrusted', async () => {
    const res = await get('v1/claims/pine-0010/evidence')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { notice: string; items: unknown[] }
    expect(body.notice).toMatch(/untrusted/i)
    expect(body.items.length).toBeGreaterThan(0)
  })

  it('unknown claim → 404 JSON with hints', async () => {
    const res = await get('v1/claims/pine-9999')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await res.json()) as { error: { code: string; hint: string; endpoints: string[] } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.hint).toMatch(/claims\?status=open/)
    expect(body.error.endpoints.length).toBeGreaterThan(0)
  })

  it('policies list + detail (+ markdown)', async () => {
    const list = await get('v1/policies')
    expect(list.status).toBe(200)
    const body = (await list.json()) as { items: { id: string; contentHash: string; status: string }[] }
    expect(body.items.map((p) => p.id)).toEqual(expect.arrayContaining(['FUNC-001', 'BOT-001', 'SC-001']))
    expect(body.items.find((p) => p.id === 'SC-001')?.status).toBe('gated')

    const detail = await get('v1/policies/BOT-001')
    expect(detail.status).toBe(200)
    const policy = (await detail.json()) as { id: string; text: string; contentHash: string }
    expect(policy.text.length).toBeGreaterThan(100)
    expect(detail.headers.get('x-pine-policy-hash')).toBe(policy.contentHash)

    const md = await get('v1/policies/BOT-001', '?format=md')
    expect(md.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(keccak256(stringToBytes(await md.text()))).toBe(policy.contentHash)

    expect((await get('v1/policies/NOPE-001')).status).toBe(404)
  })

  it('schema, openapi, feed and stats', async () => {
    const schema = await get('v1/schema/claim-manifest.json')
    expect(schema.status).toBe(200)
    expect(schema.headers.get('content-type')).toMatch(/^application\/schema\+json/)
    expect(((await schema.json()) as { $schema: string }).$schema).toMatch(/2020-12/)

    const openapi = await get('v1/openapi.json')
    expect(openapi.status).toBe(200)
    expect(((await openapi.json()) as { openapi: string }).openapi).toMatch(/^3\.1/)

    const feed = await get('v1/feed.xml')
    expect(feed.status).toBe(200)
    expect(feed.headers.get('content-type')).toMatch(/^application\/atom\+xml/)
    expect(await feed.text()).toContain('<feed')

    const stats = await get('v1/stats')
    expect(stats.status).toBe(200)
    expect(await stats.json()).toHaveProperty('openClaims')
  })

  it('unknown routes 404 and OPTIONS answers CORS preflight', async () => {
    expect((await get('v2/claims')).status).toBe(404)
    expect((await get('v1/nope')).status).toBe(404)
    const pre = agent.OPTIONS()
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('works without Next params (URL fallback)', async () => {
    const res = await agent.GET(req('/api/agent/v1/claims/pine-0009'))
    expect(res.status).toBe(200)
  })
})

describe('root files', () => {
  it('llms.txt', async () => {
    const { GET } = llmsTxtHandler({ appName: 'Pine Test', data, siteUrl: 'https://pine.example' })
    const res = await GET(req('/llms.txt'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const text = await res.text()
    expect(text).toMatch(/^# /)
    expect(text).toContain('Pine Test')
    expect(text).toContain('https://pine.example/api/agent/v1')
  })

  it('llms-full.txt includes policy text', async () => {
    const { GET } = llmsFullTxtHandler({ appName: 'Pine Test', data, siteUrl: 'https://pine.example' })
    const res = await GET(req('/llms-full.txt'))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('BOT-001')
    expect(text.length).toBeGreaterThan(2000)
  })

  it('.well-known/pine.json uses the request origin when no site URL is configured', async () => {
    const { GET } = wellKnownHandler({ appName: 'Pine Test' })
    const res = await GET(req('/.well-known/pine.json', { headers: { host: 'pine.local:3002' } }))
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).toMatch(/pine\.local:3002|localhost:3001/)
  })
})
