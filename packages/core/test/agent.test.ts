import { describe, expect, it } from 'vitest'
import {
  AGENT_CLAIM_BRIEF_JSON_SCHEMA,
  briefToMarkdown,
  buildAgentOpenApi,
  buildAtomFeed,
  buildClaimJsonLd,
  buildLlmsFullTxt,
  buildLlmsTxt,
  buildWellKnown,
  CLAIM_MANIFEST_JSON_SCHEMA,
  escapeXml,
  jsonLdString,
  toAgentBrief,
} from '../src/agent'
import { POLICIES } from '../src/policies'
import type { ClaimSummary } from '../src/types'
import { keeperClaim, market, oracle, REALITY_QID } from './fixtures'

const SITE = 'https://pine.example/'

describe('agent brief', () => {
  const claim = keeperClaim({ market: market(), oracle: oracle() })
  const brief = toAgentBrief(claim, { siteUrl: SITE })

  it('has every required key', () => {
    for (const key of AGENT_CLAIM_BRIEF_JSON_SCHEMA.required as string[]) {
      expect(brief, key).toHaveProperty(key)
    }
    expect(brief.url).toBe('https://pine.example/claims/pine-0042')
    expect(brief.manifest.jsonUrl).toBe('https://pine.example/api/agent/v1/claims/pine-0042/manifest.json')
    expect(brief.manifest.hash).toBe(claim.manifestHash)
    expect(brief.policy).toMatchObject({ id: 'BOT-001', version: '0.1.0' })
    expect(brief.target.repository).toBe('https://github.com/kleros/gateway-balancer-bot')
    expect(brief.target.pullRequest).toBe('https://github.com/kleros/gateway-balancer-bot/pull/42')
    expect(brief.evidence.deadlineTs).toBe(Date.parse('2026-10-10T18:00:00Z') / 1000)
    expect(brief.evidence.mechanism.chainId).toBe(1)
    expect(brief.evidence.requirements.length).toBeGreaterThan(3)
    expect(brief.exclusions.length).toBeGreaterThan(3)
    expect(brief.reproduction.command).toBe('pnpm vitest run test/reporter-funding.spec.ts')
    expect(brief.market?.outcomes).toHaveLength(3)
    expect(brief.oracle?.realityQuestionId).toBe(REALITY_QID)
    expect(brief.disclaimers.length).toBeGreaterThan(3)
  })

  it('is robust to claims without market, oracle or manifest details', () => {
    const bare = keeperClaim({ status: 'failed' })
    // simulate a partially populated manifest from an indexer
    const partial = { ...bare, manifest: { ...bare.manifest, claim: undefined } } as unknown as typeof bare
    const b = toAgentBrief(partial, { siteUrl: SITE })
    expect(b.market).toBeUndefined()
    expect(b.violation).toBe(bare.violation)
    expect(() => briefToMarkdown(b)).not.toThrow()
  })

  it('renders a self-contained Markdown prompt', () => {
    const md = briefToMarkdown(brief)
    expect(md.startsWith('# PINE-0042')).toBe(true)
    expect(md).toContain(claim.manifest.question.text)
    expect(md).toContain('2026-10-10 18:00 UTC')
    expect(md).toContain(String(brief.evidence.deadlineTs))
    expect(md).toContain('pnpm vitest run test/reporter-funding.spec.ts')
    expect(md).toContain('## Evidence requirements')
    expect(md).toContain('## Admissibility and exclusions')
    expect(md).toContain('## Disclaimers')
    expect(md).toContain(claim.manifestHash)
    expect(md).toContain(`uint256(\`${REALITY_QID}\`)`)
    expect(md).not.toMatch(/\b(safe|secure|certified|audited)\b/i)
  })
})

const summaries: ClaimSummary[] = [
  { ...keeperClaim(), title: 'Fees & <script>alert("x")</script> limits', violation: 'a > b && c < d', tags: ['a&b'] },
  { ...keeperClaim({ id: 'pine-0043', number: 43, createdAt: '2026-10-04T00:00:00Z', status: 'resolved', outcome: 'yes' }) },
]

describe('Atom feed', () => {
  const xml = buildAtomFeed({ siteUrl: SITE, appName: 'Pine & Co', claims: summaries })
  it('is well-formed Atom 1.0', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true)
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">')
    expect(xml.trim().endsWith('</feed>')).toBe(true)
    expect(xml.match(/<entry>/g)).toHaveLength(2)
    expect(xml.match(/<\/entry>/g)).toHaveLength(2)
    expect(xml).toContain('<updated>2026-10-04T00:00:00Z</updated>')
    // newest first
    expect(xml.indexOf('PINE-0043')).toBeLessThan(xml.indexOf('PINE-0042'))
  })
  it('escapes &, <, > and quotes', () => {
    expect(xml).toContain('Fees &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; limits')
    expect(xml).toContain('a &gt; b &amp;&amp; c &lt; d')
    expect(xml).toContain('Pine &amp; Co')
    expect(xml).not.toContain('<script>')
    // every & is an entity
    expect(xml.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&')
  })
  it('strips characters invalid in XML', () => {
    expect(escapeXml(`a${String.fromCharCode(0)}b${String.fromCharCode(0xfffe)}c`)).toBe('abc')
  })
})

describe('llms.txt', () => {
  it('follows llmstxt.org structure and links the agent API', () => {
    const txt = buildLlmsTxt({ siteUrl: SITE, appName: 'Pine', claims: summaries })
    const lines = txt.split('\n')
    expect(lines[0]).toBe('# Pine')
    expect(lines[2]?.startsWith('> ')).toBe(true)
    expect(txt).toContain('## Agent API')
    expect(txt).toContain('https://pine.example/api/agent/v1/claims?status=open')
    expect(txt).toContain('https://pine.example/.well-known/pine.json')
    expect(txt).toContain('https://pine.example/api/agent/v1/schema/claim-manifest.json')
    expect(txt).toContain('https://pine.example/api/agent/v1/openapi.json')
    expect(txt).toContain('https://pine.example/api/agent/v1/feed.xml')
    expect(txt).toContain('## Policies')
    expect(txt).toContain('## How to submit evidence')
    expect(txt).toContain('## Rules')
    expect(txt).toContain('## Optional')
    expect(txt).toMatch(/\[PINE-0042: /)
    expect(txt).not.toMatch(/\b(safe|secure|certified|audited)\b/i)
  })
  it('full variant embeds policy texts and disclosures', () => {
    const txt = buildLlmsFullTxt({ siteUrl: SITE, appName: 'Pine', claims: summaries, policies: POLICIES })
    for (const p of POLICIES) {
      expect(txt).toContain(p.contentHash)
      expect(txt).toContain(p.text.trim().slice(0, 200))
    }
    expect(txt).toContain('## Risk disclosures')
    expect(txt).toContain('## Launch gates')
  })
})

describe('well-known, JSON-LD, schema, OpenAPI', () => {
  it('well-known descriptor', () => {
    const wk = buildWellKnown({ siteUrl: SITE, appName: 'Pine' }) as { api: Record<string, string>; chains: { chainId: number }[]; policies: unknown[] }
    expect(wk.api.base).toBe('https://pine.example/api/agent/v1')
    expect(wk.chains.map((c) => c.chainId)).toContain(100)
    expect(wk.policies).toHaveLength(3)
  })

  it('claim JSON-LD is a schema.org Question about SoftwareSourceCode with a Dataset', () => {
    const ld = buildClaimJsonLd(keeperClaim({ status: 'resolved', outcome: 'no' }), { siteUrl: SITE }) as Record<string, any>
    expect(ld['@context']).toBe('https://schema.org')
    expect(ld['@type']).toBe('Question')
    expect(ld.about['@type']).toBe('SoftwareSourceCode')
    expect(ld.about.codeRepository).toBe('https://github.com/kleros/gateway-balancer-bot')
    expect(ld.subjectOf['@type']).toBe('Dataset')
    expect(ld.subjectOf.distribution[0].contentUrl).toBe('https://pine.example/api/agent/v1/claims/pine-0042/manifest.json')
    expect(ld.acceptedAnswer.text).toBe('No qualifying counterexample submitted')
    const s = jsonLdString({ x: '</script><script>alert(1)</script>' })
    expect(s).not.toContain('<')
    expect(JSON.parse(s)).toEqual({ x: '</script><script>alert(1)</script>' })
  })

  it('manifest JSON Schema matches the manifest shape', () => {
    const claim = keeperClaim()
    const schema = CLAIM_MANIFEST_JSON_SCHEMA as { $schema: string; required: string[]; properties: Record<string, unknown>; $defs: Record<string, { required: string[]; properties: Record<string, unknown> }> }
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(Object.keys(claim.manifest).sort()).toEqual([...schema.required].sort())
    const specDef = schema.$defs.ClaimSpec!
    for (const k of Object.keys(claim.manifest.claim)) expect(specDef.properties, k).toHaveProperty(k)
    for (const k of specDef.required) expect(claim.manifest.claim, k).toHaveProperty(k)
    const envDef = schema.$defs.EnvironmentPin!
    for (const k of Object.keys(claim.manifest.claim.environment)) expect(envDef.properties, k).toHaveProperty(k)
    const srcDef = schema.$defs.SourceRef!
    for (const k of Object.keys(claim.manifest.source)) expect(srcDef.properties, k).toHaveProperty(k)
  })

  it('OpenAPI 3.1 covers every agent route', () => {
    const doc = buildAgentOpenApi({ siteUrl: SITE }) as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.servers[0]?.url).toBe('https://pine.example')
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/api/agent/v1/claims',
        '/api/agent/v1/claims/{id}',
        '/api/agent/v1/claims/{id}/manifest.json',
        '/api/agent/v1/policies',
        '/api/agent/v1/policies/{id}',
        '/api/agent/v1/schema/claim-manifest.json',
        '/api/agent/v1/openapi.json',
        '/api/agent/v1/feed.xml',
      ].sort(),
    )
    const list = (doc.paths['/api/agent/v1/claims'] as { get: { parameters: { name: string }[] } }).get
    expect(list.parameters.map((p) => p.name)).toEqual(['status', 'policy', 'repo', 'limit', 'cursor'])
    expect(() => JSON.stringify(doc)).not.toThrow()
  })
})
