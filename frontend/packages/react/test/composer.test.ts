import { describe, expect, it } from 'vitest'
import { getPolicy, hashJson, hashManifest } from '@pine/core'
import type { ClaimDraft, SourceRef } from '@pine/core'
import {
  addHours,
  claimIdForDraft,
  createDefaultDraft,
  defaultDeadline,
  deriveComposer,
  isDraftFrozen,
  mergeDraft,
  normalizeDraft,
  roundUpToHourUtc,
  SEER_QUESTION_TIMEOUT_SECONDS,
  VIOLATION_PLACEHOLDER,
} from '../src/composer/defaults'

const NOW = new Date('2026-10-03T10:17:42Z')

const SOURCE: SourceRef = {
  provider: 'github',
  owner: 'kleros',
  repo: 'gateway-balancer-bot',
  pullRequest: { number: 42, title: 'Separate reporter deposits', htmlUrl: 'https://github.com/kleros/gateway-balancer-bot/pull/42', author: 'dev', state: 'open' },
  commit: {
    sha: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
    message: 'Separate reporter deposit funding',
    author: 'dev',
    committedAt: '2026-10-02T09:00:00Z',
    htmlUrl: 'https://github.com/kleros/gateway-balancer-bot/commit/3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345',
  },
}

function baseDraft(): ClaimDraft {
  const d = createDefaultDraft({ id: 'dk3j2h1g9f0abc', owner: 'mara-okafor', chainId: 100, now: NOW })
  return normalizeDraft(
    mergeDraft(d, {
      source: SOURCE,
      spec: {
        policyId: 'BOT-001',
        title: 'Reporter deposits never draw on the gas reserve',
        requirement: 'Reporter-deposit principal must not be funded from arbitration allocations or the operator gas reserve.',
        violation: 'reporter-deposit principal funded from the operator gas reserve',
      },
    }),
    d,
  )
}

describe('composer defaults', () => {
  it('deadline is now+72h rounded up to the hour (UTC); oracle opens 1h later with the fixed Seer timeout', () => {
    expect(roundUpToHourUtc(new Date('2026-10-03T10:00:00Z')).toISOString()).toBe('2026-10-03T10:00:00.000Z')
    expect(defaultDeadline(NOW)).toBe('2026-10-06T11:00:00Z')
    const d = createDefaultDraft({ owner: 'x', chainId: 100, now: NOW })
    expect(d.spec.evidence?.deadline).toBe('2026-10-06T11:00:00Z')
    expect(d.spec.oracle?.openingTime).toBe('2026-10-06T12:00:00Z')
    expect(d.spec.oracle?.timeoutSeconds).toBe(302_400)
    expect(SEER_QUESTION_TIMEOUT_SECONDS).toBe(302_400)
    expect(d.spec.evidence?.mechanism).toBe('erc1497-arbitrator-proxy')
    expect(d.funding).toMatchObject({ liquidity: '25', initialYesPrice: 0.15, priceRange: [0.02, 0.8], spendingLimit: '50' })
    expect(d.spec.oracle?.minBond).toBe('10')
    expect(d.spec.environment?.envHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('uses the account spending limit when given', () => {
    const d = createDefaultDraft({ owner: 'x', chainId: 100, spendingLimit: '120', now: NOW })
    expect(d.funding?.spendingLimit).toBe('120')
  })

  it('claim id is stable per draft', () => {
    expect(claimIdForDraft('dK3j-2h1g9f0abcdef')).toBe('pine-dk3j2h1g9f0a')
  })
})

describe('deriveComposer', () => {
  it('builds question + manifest once source and policy are set', () => {
    const d0 = createDefaultDraft({ id: 'dempty', owner: 'x', chainId: 100, now: NOW })
    const empty = deriveComposer(d0, { now: NOW })
    expect(empty.question).toBeUndefined()
    expect(empty.manifest).toBeUndefined()
    expect(empty.validation.ok).toBe(false)

    const r = deriveComposer(baseDraft(), { now: NOW })
    expect(r.policy?.id).toBe('BOT-001')
    expect(r.question?.text).toContain('reporter-deposit principal funded from the operator gas reserve')
    expect(r.question?.text).toContain(SOURCE.commit.sha)
    expect(r.question?.text).toContain('BOT-001@')
    expect(r.question?.text).toContain('2026-10-06 11:00 UTC')
    expect(r.manifest?.claimId).toBe('pine-dk3j2h1g9f0a')
    expect(r.manifest?.createdAt).toBe(baseDraft().createdAt)
    expect(r.manifestHash).toBe(hashManifest(r.manifest!))
    expect(r.manifestHash).toBe(hashJson(r.manifest))
    expect(r.funding?.costs.length).toBeGreaterThan(0)
  })

  it('question and manifest hash update when the draft changes', () => {
    const d = baseDraft()
    const a = deriveComposer(d, { now: NOW })
    const changed = normalizeDraft(mergeDraft(d, { spec: { violation: 'duplicate reporter deposits after a crash' } }), d)
    const b = deriveComposer(changed, { now: NOW })
    expect(b.question?.text).toContain('duplicate reporter deposits after a crash')
    expect(b.question?.hash).not.toBe(a.question?.hash)
    expect(b.manifestHash).not.toBe(a.manifestHash)
    // Same input → same hashes (deterministic)
    expect(deriveComposer(changed, { now: NOW }).manifestHash).toBe(b.manifestHash)
    // Deadline change moves the question text and the oracle opening time.
    const later = normalizeDraft(
      mergeDraft(changed, { spec: { evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: '2026-10-08T18:00:00Z' } } }),
      changed,
    )
    const c = deriveComposer(later, { now: NOW })
    expect(c.question?.text).toContain('2026-10-08 18:00 UTC')
    expect(later.spec.oracle?.openingTime).toBe(addHours('2026-10-08T18:00:00Z', 1))
    // Creator is part of the manifest.
    const withCreator = deriveComposer(later, { now: NOW, creator: '0xDE30BD7C2A0B6f1e5C4b1a9F2f5d3C8E7a6b0D30' })
    expect(withCreator.manifestHash).not.toBe(c.manifestHash)
    expect(withCreator.question?.hash).toBe(c.question?.hash)
  })

  it('environment edits recompute configHash/envHash and change the question', () => {
    const d = baseDraft()
    const a = deriveComposer(d, { now: NOW })
    const edited = normalizeDraft(
      {
        ...d,
        spec: {
          ...d.spec,
          environment: { ...d.spec.environment!, runtime: 'node 22.14.0', config: { NETWORK: 'gnosis' }, reproductionCommand: 'pnpm vitest run' },
        },
      },
      d,
    )
    expect(edited.spec.environment?.configHash).toBe(hashJson({ NETWORK: 'gnosis' }))
    expect(edited.spec.environment?.envHash).not.toBe(d.spec.environment?.envHash)
    const b = deriveComposer(edited, { now: NOW })
    expect(b.question?.text).toContain(edited.spec.environment!.envHash)
    expect(b.question?.hash).not.toBe(a.question?.hash)
  })

  it('uses a visible placeholder while the violation is empty', () => {
    const d = baseDraft()
    const r = deriveComposer(normalizeDraft(mergeDraft(d, { spec: { violation: '' } }), d), { now: NOW })
    expect(r.question?.text).toContain(VIOLATION_PLACEHOLDER)
    expect(r.validation.ok).toBe(false)
  })

  it('the oracle timeout cannot be edited away from Seer’s fixed value', () => {
    const d = baseDraft()
    const edited = normalizeDraft({ ...d, spec: { ...d.spec, oracle: { ...d.spec.oracle!, timeoutSeconds: 86_400 } } }, d)
    expect(edited.spec.oracle?.timeoutSeconds).toBe(302_400)
  })

  it('switching chains moves oracle defaults to the new chain', () => {
    const d = baseDraft()
    const eth = normalizeDraft(mergeDraft(d, { funding: { chainId: 1 } }), d)
    expect(eth.spec.oracle?.chainId).toBe(1)
    expect(eth.spec.oracle?.bondToken).toBe('ETH')
    expect(eth.spec.oracle?.timeoutSeconds).toBe(302_400)
  })

  it('frozen once create_market confirmed', () => {
    const d = baseDraft()
    expect(isDraftFrozen(d)).toBe(false)
    const published = { ...d, publication: { steps: [{ id: 'create_market' as const, status: 'confirmed' as const }] } }
    expect(isDraftFrozen(published)).toBe(true)
    expect(deriveComposer(published, { now: NOW }).frozen).toBe(true)
  })

  it('frozen once the market is recorded, also without a confirmed step (adopted from ClaimRegistry after a reload)', () => {
    const d = baseDraft()
    const market = '0x565c000000000000000000000000000000b211' as const
    const adopted = { ...d, publication: { steps: [], marketAddress: market, claimId: market } }
    expect(isDraftFrozen(adopted)).toBe(true)
    expect(deriveComposer(adopted, { now: NOW }).frozen).toBe(true)
    expect(isDraftFrozen({ ...d, publication: { steps: [] } })).toBe(false)
  })

  it('validation passes for a complete, valid draft', () => {
    const d = baseDraft()
    const parameters: Record<string, string | string[] | boolean> = {}
    for (const p of getPolicy('BOT-001')?.parameters ?? []) {
      if (!p.required) continue
      const first = p.options?.[0]?.value ?? 'value'
      parameters[p.key] =
        p.kind === 'list' ? ['example'] : p.kind === 'multiselect' ? [first] : p.kind === 'boolean' ? true : p.kind === 'select' ? first : 'Example value for this parameter.'
    }
    const complete = normalizeDraft(
      {
        ...d,
        spec: {
          ...d.spec,
          scope: { inScope: ['src/funding/*.ts'], outOfScope: ['UI'] },
          parameters,
          faultModel: 'process crash between plan and submit',
          assumptions: ['Gas price below 50 gwei'],
          exclusions: ['Live transfers'],
          environment: {
            ...d.spec.environment!,
            runtime: 'node 22.14.0',
            reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts',
            setupSteps: ['pnpm install --frozen-lockfile'],
          },
        },
      },
      d,
    )
    const r = deriveComposer(complete, { now: NOW, creator: '0xDE30BD7C2A0B6f1e5C4b1a9F2f5d3C8E7a6b0D30' })
    // Report issues to make failures readable.
    expect(r.validation.issues).toEqual([])
    expect(r.validation.ok).toBe(true)
  })
})
