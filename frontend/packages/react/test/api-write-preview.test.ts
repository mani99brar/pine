import { describe, expect, it } from 'vitest'
import type { ClaimDraft, Hex } from '@pine/core'
import { encodeClaimDocument, PlanVerificationError, type ClaimDocument, type Hex32 } from '@pine/core/pine-shared'
import { claimPreviewResponseSchema, type ClaimPreviewResponse, type DraftInput } from '@pine/data'
import { toDraftInput } from '../src/api/draft-input'
import { checkCreateClaimPlan, createClaimParamsOf, verifyPreview, type PreviewExpectations } from '../src/api/verify-preview'
import { ACCOUNT, COMMIT, createClaimParams, documentFor, manifest, NOW, NOW_S, OTHER, PINE, previewFor, wirePlan } from './api-write-chain'

const HASH = `0x${'ee'.repeat(32)}` as Hex
const draft: ClaimDraft = {
  id: 'dprev0001',
  owner: 'local',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  stage: 'review',
  source: {
    provider: 'github',
    owner: 'kleros',
    repo: 'kleros-v2',
    pullRequest: { number: 2101, title: 'PR', htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101', author: 'dev', state: 'open' },
    commit: { sha: COMMIT, message: 'm', author: 'dev', committedAt: '2026-10-02T09:00:00Z', htmlUrl: 'https://github.com/x' },
  },
  spec: {
    title: 'Reporter deposits never draw on the gas reserve',
    policyId: 'BOT-001',
    policyVersion: '0.1.0',
    requirement: 'Reporter-deposit principal must not be funded from arbitration allocations.',
    violation: 'reporter-deposit principal funded from the gas reserve',
    scope: { inScope: ['src/funding'], outOfScope: [] },
    parameters: { sourceRequirement: 'Spec section 4', startingStates: 'fresh deploy', simulatedAdapters: [] },
    faultModel: 'crash between plan and submit',
    allowedInputs: 'any configuration',
    assumptions: [],
    exclusions: [],
    environment: { runtime: 'node 22.14.0', config: {}, configHash: HASH, externalState: 'none', reproductionCommand: 'pnpm test', setupSteps: [], notes: 'none', envHash: HASH },
    regressionOnly: false,
    evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() },
    oracle: { chainId: 100, openingTime: '2026-10-12T00:00:00Z', timeoutSeconds: 302_400, minBond: '10', bondToken: 'xDAI', arbitrator: '0x68154ea682f95bf582b80dd6453fa401737491dc', arbitratorName: 'Kleros', language: 'en_US', category: 'misc' },
  },
}

function input(): DraftInput {
  const r = toDraftInput(draft, { now: NOW })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.input
}

function preview(doc: ClaimDocument, over: Partial<ClaimPreviewResponse> = {}): ClaimPreviewResponse {
  return claimPreviewResponseSchema.parse({ ...previewFor(doc, { now: NOW_S }), ...over })
}

function expectations(over: Partial<PreviewExpectations> = {}): PreviewExpectations {
  return { input: input(), account: ACCOUNT, manifest, chainId: 100, draftRevision: 1, chosenEvidenceDeadline: NOW_S + 7 * 86_400, now: NOW_S, ...over }
}

const goodDoc = () => documentFor(input(), ACCOUNT, NOW_S)

describe('verifyPreview', () => {
  it('accepts the backend’s preview and derives every displayed value from the verified document', () => {
    const doc = goodDoc()
    const { preview: p, issues } = verifyPreview(preview(doc), expectations())
    expect(issues).toEqual([])
    expect(p?.documentSha256).toBe(encodeClaimDocument(doc).sha256)
    expect(p?.timeline).toEqual({
      evidenceDeadline: NOW_S + 7 * 86_400,
      revealDeadline: NOW_S + 9 * 86_400,
      answersOpen: NOW_S + 9 * 86_400,
      earliestFinalization: NOW_S + 9 * 86_400 + 302_400,
    })
    expect(p?.question).toContain(`commit ${COMMIT}`)
    expect(p?.tokenNames).toEqual([`PY_${p?.documentSha256.slice(2, 10)}`, `PN_${p?.documentSha256.slice(2, 10)}`])
  })

  it('SEC-CLAIM-04 blocks a document that does not hash to the stated digest', () => {
    const doc = goodDoc()
    const stated = preview(doc)
    const tampered = { ...stated, document: { ...doc, claim: { ...doc.claim, requirement: 'Anything goes.' } } }
    const { issues } = verifyPreview(tampered, expectations())
    expect(issues.map((i) => i.code)).toContain('digest_mismatch')
  })

  it('SEC-CLAIM-04 blocks a CID that names other bytes', () => {
    const doc = goodDoc()
    const other = previewFor(documentFor(input(), ACCOUNT, NOW_S, { nonce: `0x${'22'.repeat(32)}` as Hex32 }), { now: NOW_S })
    expect(verifyPreview(preview(doc, { cid: other.cid }), expectations()).issues.map((i) => i.code)).toEqual(['cid_mismatch'])
  })

  it('SEC-CLAIM-05 blocks a market question that differs from the one ClaimRegistry will ask', () => {
    const stated = preview(goodDoc())
    const question = stated.question.replace('Yes = at least one', 'Yes = no')
    expect(verifyPreview({ ...stated, question }, expectations()).issues.map((i) => i.code)).toEqual(['question_mismatch'])
  })

  it('SEC-CLAIM-05 never shows Pine’s stated question when the browser cannot compose one from the document', () => {
    const stated = preview(goodDoc())
    // Schema-valid, but no question can be rendered from an all-zero policy digest.
    const doc = { ...goodDoc(), policy: { ...goodDoc().policy, sha256: `0x${'00'.repeat(32)}` as Hex32 } }
    const { preview: p, issues } = verifyPreview({ ...stated, document: doc }, expectations())
    expect(p).not.toBeNull()
    expect(issues.map((i) => i.code)).toContain('question_mismatch')
    expect(p?.question).toBeNull()
  })

  it('blocks outcome token names that do not derive from the digest', () => {
    const stated = preview(goodDoc())
    expect(verifyPreview({ ...stated, tokenNames: ['PY_00000000', 'PN_00000000'] }, expectations()).issues.map((i) => i.code)).toEqual(['token_names_mismatch'])
  })

  it('blocks a document whose creator is not the connected wallet', () => {
    const doc = documentFor(input(), OTHER, NOW_S)
    expect(verifyPreview(preview(doc), expectations()).issues.map((i) => i.code)).toEqual(['creator_mismatch'])
    expect(verifyPreview(preview(goodDoc()), expectations({ account: undefined })).issues.map((i) => i.code)).toEqual(['creator_mismatch'])
  })

  it('blocks a self-consistent document whose terms differ from what the user composed', () => {
    // A compromised backend can recompute digest, CID, question and token names for terms of its choosing.
    const doc = goodDoc()
    const swapped = { ...doc, claim: { ...doc.claim, title: 'Reporter deposits may draw on the gas reserve', exclusions: ['Everything'] } }
    const { issues } = verifyPreview(preview(swapped), expectations())
    expect(issues.map((i) => [i.code, i.field])).toEqual([
      ['field_mismatch', 'claim.title'],
      ['field_mismatch', 'claim.exclusions'],
    ])
  })

  it.each([
    ['commit', (d: ClaimDocument) => ({ ...d, target: { ...d.target, commit: 'a'.repeat(40) } }), 'target.commit'],
    ['repository', (d: ClaimDocument) => ({ ...d, target: { ...d.target, repository: { ...d.target.repository, name: 'other' } } }), 'target.repository'],
    ['policy', (d: ClaimDocument) => ({ ...d, policy: { ...d.policy, id: 'FUNC-001' } }), 'policy'],
    ['minimum bond', (d: ClaimDocument) => ({ ...d, market: { ...d.market, minBondWei: '1000000000000000000' } }), 'market.minBondWei'],
    ['environment', (d: ClaimDocument) => ({ ...d, environment: { ...d.environment, externalState: 'mainnet fork' } }), 'environment'],
    ['membership', (d: ClaimDocument) => ({ ...d, target: { ...d.target, membership: { ...d.target.membership, ref: { kind: 'pull' as const, number: 1 } } } }), 'target.membership.ref'],
  ])('blocks a document whose %s differs from the composed claim', (_name, mutate, field) => {
    const { issues } = verifyPreview(preview(mutate(goodDoc())), expectations())
    expect(issues).toEqual([expect.objectContaining({ code: 'field_mismatch', field })])
  })

  it('accepts GitHub’s own spelling of the repository owner and name (case-insensitive)', () => {
    const doc = documentFor(input(), ACCOUNT, NOW_S, { ownerLogin: 'Kleros' })
    expect(verifyPreview(preview(doc), expectations()).issues).toEqual([])
  })

  it('SEC-TX-12 blocks a document naming another evidence registry, claim registry or Seer factory than the pinned deployment', () => {
    const doc = goodDoc()
    const other = '0x9000000000000000000000000000000000000009'
    const variants: [ClaimDocument, string][] = [
      [{ ...doc, evidence: { ...doc.evidence, registry: other } }, 'evidence.registry'],
      [{ ...doc, market: { ...doc.market, claimRegistry: other } }, 'market.claimRegistry'],
      [{ ...doc, market: { ...doc.market, seerMarketFactory: other } }, 'market.seerMarketFactory'],
      [{ ...doc, market: { ...doc.market, arbitrator: other } }, 'market.arbitrator'],
    ]
    for (const [variant, field] of variants) {
      const issues = verifyPreview(preview(variant), expectations()).issues
      expect(issues.filter((i) => i.code === 'deployment_mismatch').map((i) => i.field)).toEqual([field])
    }
  })

  it('SEC-CLAIM-01 refuses a document with unknown fields or a schema violation', () => {
    const stated = preview(goodDoc())
    const r = verifyPreview({ ...stated, document: { ...(stated.document as object), extra: true } }, expectations())
    expect(r.preview).toBeNull()
    expect(r.issues.map((i) => i.code)).toEqual(['document_invalid'])
  })

  it('SEC-CLAIM-07 flags a deadline far from the one chosen (or a timeline that disagrees with the document)', () => {
    const stated = preview(goodDoc())
    expect(verifyPreview(stated, expectations({ chosenEvidenceDeadline: NOW_S + 6 * 86_400 })).issues.map((i) => i.code)).toEqual(['deadline_mismatch'])
    expect(verifyPreview(stated, expectations({ chosenEvidenceDeadline: NOW_S + 7 * 86_400 - 600 })).issues).toEqual([])
    const timeline = { ...stated.timeline, evidenceDeadline: { unix: 1, iso: 'x' } }
    expect(verifyPreview({ ...stated, timeline }, expectations()).issues.map((i) => i.field)).toEqual(['timeline.evidenceDeadline'])
  })

  it('flags a preview of another draft revision and an expired publication offer', () => {
    const stated = preview(goodDoc())
    expect(verifyPreview(stated, expectations({ draftRevision: 2 })).issues.map((i) => i.code)).toEqual(['stale_preview'])
    expect(verifyPreview(stated, expectations({ now: stated.planExpiresAt })).issues.map((i) => i.code)).toEqual(['offer_expired'])
  })
})

describe('checkCreateClaimPlan (SEC-TX-02)', () => {
  const doc = goodDoc()
  const sha = encodeClaimDocument(doc).sha256
  const ctx = { document: doc, documentSha256: sha, account: ACCOUNT, manifest }
  const plan = (params: ReturnType<typeof createClaimParams>, account = ACCOUNT) =>
    wirePlan('8d3b4d6e-0000-4000-8000-000000000001', account, [{ id: 'create', allowlistId: 'claimRegistry.createClaim', args: [params] }])

  it('accepts the single createClaim step that encodes exactly the previewed document', () => {
    const verified = checkCreateClaimPlan(plan(createClaimParams(doc, sha)), ctx)
    expect(verified.steps[0]?.to).toBe(PINE.claimRegistry)
    expect(createClaimParamsOf(doc, sha)).toEqual(createClaimParams(doc, sha))
  })

  it.each([
    ['claimDocumentSha256', { claimDocumentSha256: `0x${'01'.repeat(32)}` }],
    ['policyDocumentSha256', { policyDocumentSha256: `0x${'02'.repeat(32)}` }],
    ['repositoryId', { repositoryId: 1n }],
    ['commit', { commit: `0x${'a'.repeat(40)}` }],
    ['evidenceDeadline', { evidenceDeadline: BigInt(doc.evidence.evidenceDeadline + 60) }],
    ['revealDeadline', { revealDeadline: BigInt(doc.evidence.revealDeadline - 60) }],
    ['minBond', { minBond: 1n }],
    ['title', { title: 'Something else' }],
  ])('refuses a createClaim whose %s differs from the preview, before any wallet prompt', (name, override) => {
    const params = { ...createClaimParams(doc, sha), ...override } as ReturnType<typeof createClaimParams>
    expect(() => checkCreateClaimPlan(plan(params), ctx)).toThrow(new RegExp(`createClaim ${name} differs`))
  })

  it('refuses extra steps, value, another account and other calls', () => {
    const good = createClaimParams(doc, sha)
    const two = wirePlan('p2', ACCOUNT, [
      { id: 'create', allowlistId: 'claimRegistry.createClaim', args: [good] },
      { id: 'withdraw', allowlistId: 'realitio.withdraw', args: [] },
    ])
    expect(() => checkCreateClaimPlan(two, ctx)).toThrow(PlanVerificationError)
    const valued = plan(good)
    valued.steps[0]!.value = '1'
    expect(() => checkCreateClaimPlan(valued, ctx)).toThrow(/value/)
    expect(() => checkCreateClaimPlan(plan(good, OTHER), ctx)).toThrow(/another wallet/)
    const other = wirePlan('p3', ACCOUNT, [{ id: 'withdraw', allowlistId: 'realitio.withdraw', args: [] }])
    expect(() => checkCreateClaimPlan(other, ctx)).toThrow(/not ClaimRegistry.createClaim/)
  })

  it('SEC-TX-02 refuses calldata tampered by one byte (it no longer decodes to the declared call or differs)', () => {
    const wire = plan(createClaimParams(doc, sha))
    const data = wire.steps[0]!.data
    wire.steps[0]!.data = `${data.slice(0, -2)}${data.endsWith('00') ? '01' : '00'}` as Hex
    expect(() => checkCreateClaimPlan(wire, ctx)).toThrow(PlanVerificationError)
  })
})
