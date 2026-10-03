import { describe, expect, it } from 'vitest'
import { canonicalJson, hashJson, hashText } from '../src/hash'
import {
  buildManifest,
  buildMarketDescription,
  buildMarketName,
  CLAIM_MANIFEST_SCHEMA_URL,
  MANIFEST_DISCLAIMERS,
  verifyManifestHash,
} from '../src/manifest'
import { buildQuestion, computeConfigHash, computeEnvHash, normalizeViolation, pinEnvironment } from '../src/question'
import { formatClaimNumber } from '../src/format'
import type { ClaimSpec } from '../src/types'
import { BOT, CREATOR, keeperSpec, SHA, source } from './fixtures'

const KEEPER_QUESTION =
  'Was a reproducible counterexample demonstrating reporter-deposit principal can consume arbitration funds or the operator transaction-gas reserve ' +
  'against commit 3f2a9c1d7e5b4a6f8c0d2e1f3a5b7c9d0e2f4a6b, ' +
  'under configuration/environment 0xec16daf99e66bd8941ffca912aeadba5727a9559c4c4782545fd3aede542c1a7 ' +
  'and policy BOT-001@0.1.0 (0x2eb8fafc8f0becd5c10c14b4a2cf5f64f59ca3ae20f2222b65e49e74b9aa69a0), ' +
  "submitted through ERC-1497 evidence on Ethereum (chain 1) contract 0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68 (evidence group = this question's Reality.eth id) " +
  'before 2026-10-10 18:00 UTC?'

describe('buildQuestion', () => {
  it('matches the SPEC §5 template for the keeper example (snapshot)', () => {
    const q = buildQuestion({ spec: keeperSpec(), source, policy: BOT })
    expect(q.text).toBe(KEEPER_QUESTION)
    expect(q.outcomes).toEqual(['Yes', 'No'])
    expect(q.hash).toBe(hashText(KEEPER_QUESTION))
  })

  it('follows the exact template shape', () => {
    const spec = keeperSpec()
    const q = buildQuestion({ spec, source, policy: BOT })
    const re =
      /^Was a reproducible counterexample demonstrating (.+) against commit ([0-9a-f]{40}), under configuration\/environment (0x[0-9a-f]{64}) and policy ([A-Z]+-\d{3})@(\d+\.\d+\.\d+) \((0x[0-9a-f]{64})\), submitted through (.+) before (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)\?$/
    const m = re.exec(q.text)
    expect(m).not.toBeNull()
    expect(m?.[2]).toBe(SHA)
    expect(m?.[3]).toBe(spec.environment.envHash)
    expect(m?.[6]).toBe(BOT.contentHash)
  })

  it('never produces double punctuation when the violation ends with a period', () => {
    const q = buildQuestion({ spec: keeperSpec({ violation: '  a user can read another user’s file.  ' }), source, policy: BOT })
    expect(q.text).toContain('demonstrating a user can read another user’s file against commit')
    expect(q.text).not.toMatch(/\.\s*against/)
    expect(normalizeViolation('x can happen?!.')).toBe('x can happen')
  })

  it('lowercases the SHA and formats the deadline to the minute in UTC', () => {
    const q = buildQuestion({
      spec: keeperSpec(),
      source: { ...source, commit: { ...source.commit, sha: SHA.toUpperCase() } },
      policy: BOT,
    })
    expect(q.text).toContain(`against commit ${SHA},`)
    expect(q.text).toContain('before 2026-10-10 18:00 UTC?')
  })
})

describe('environment hashing', () => {
  it('computeConfigHash is key-order independent', () => {
    expect(computeConfigHash({ B: '2', A: '1' })).toBe(computeConfigHash({ A: '1', B: '2' }))
  })
  it('pinEnvironment computes configHash and envHash; envHash ignores itself', () => {
    const env = keeperSpec().environment
    expect(env.configHash).toBe(computeConfigHash(env.config))
    expect(env.envHash).toBe(computeEnvHash(env))
    const { envHash: _e, ...rest } = env
    expect(env.envHash).toBe(hashJson(rest))
    const changed = pinEnvironment({ ...rest, runtime: 'node 22.15.0' })
    expect(changed.envHash).not.toBe(env.envHash)
  })
})

describe('buildManifest', () => {
  const input = { claimId: 'pine-0042', creator: CREATOR, source, spec: keeperSpec(), policy: BOT, createdAt: '2026-10-03T12:00:00Z' }

  it('is deterministic and independent of key insertion order', () => {
    const a = buildManifest(input)
    const reversedSpec = Object.fromEntries(Object.entries(keeperSpec()).reverse()) as unknown as ClaimSpec
    const reversedSource = Object.fromEntries(Object.entries(source).reverse()) as unknown as typeof source
    const b = buildManifest({ ...input, spec: reversedSpec, source: reversedSource })
    expect(b.hash).toBe(a.hash)
    expect(canonicalJson(b.manifest)).toBe(canonicalJson(a.manifest))
    expect(a.hash).toBe(hashJson(a.manifest))
    expect(verifyManifestHash(a.manifest, a.hash)).toBe(true)
  })

  it('carries schema, policy reference, question and disclaimers', () => {
    const { manifest } = buildManifest(input)
    expect(manifest.$schema).toBe(CLAIM_MANIFEST_SCHEMA_URL)
    expect(manifest.$schema).toBe('https://pine.dev/schemas/claim-manifest/v1.json')
    expect(manifest.manifestVersion).toBe('1')
    expect(manifest.policy).toEqual({ id: 'BOT-001', version: '0.1.0', hash: BOT.contentHash, uri: BOT.uri })
    expect(manifest.question.text).toBe(KEEPER_QUESTION)
    expect(manifest.disclaimers).toEqual(MANIFEST_DISCLAIMERS)
  })

  it('drops undefined optional fields so hashes survive JSON round-trips', () => {
    const { manifest, hash } = buildManifest({ ...input, spec: { ...keeperSpec(), faultModel: undefined } })
    expect('faultModel' in manifest.claim).toBe(false)
    expect(verifyManifestHash(JSON.parse(JSON.stringify(manifest)), hash)).toBe(true)
  })

  it('changes hash when any term changes', () => {
    const a = buildManifest(input)
    const b = buildManifest({ ...input, spec: keeperSpec({ requirement: 'different' }) })
    expect(b.hash).not.toBe(a.hash)
  })

  it('market description references policy, manifest, target and outcome semantics', () => {
    const { manifest, hash } = buildManifest(input)
    const d = buildMarketDescription(manifest, 'ipfs://bafy/manifest.json', hash)
    expect(d).toContain('BOT-001@0.1.0')
    expect(d).toContain(BOT.contentHash)
    expect(d).toContain('ipfs://bafy/manifest.json')
    expect(d).toContain(hash)
    expect(d).toContain(`github.com/kleros/gateway-balancer-bot at commit ${SHA}`)
    expect(d).toMatch(/YES:/)
    expect(d).toMatch(/NO: .*not a statement that the code is correct/)
    expect(d).toMatch(/Invalid: .*Not a refund/)
    expect(d.length).toBeLessThan(1200)
  })

  it('market name appends the manifest reference to the question', () => {
    const name = buildMarketName(KEEPER_QUESTION, 'ipfs://x', `0x${'1'.repeat(64)}`)
    expect(name.startsWith(KEEPER_QUESTION)).toBe(true)
    expect(name).toContain('ipfs://x')
  })

  it('formatClaimNumber', () => {
    expect(formatClaimNumber(42)).toBe('PINE-0042')
  })
})
