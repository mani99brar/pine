import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildDeploymentManifest,
  buildStep,
  canonicalJson,
  computeEvidenceCommitment,
  deploymentHash,
  identify,
  newPlan,
  planFromWire,
  planToWire,
  PlanVerificationError,
  rawCidFromSha256,
  renderQuestion,
  sha256FromRawCid,
  sha256Hex,
  verifyPlan,
  type Address,
  type Hex32,
  type JsonValue,
} from '../src/pine-shared'
// @ts-expect-error -- plain ESM script without type declarations
import { transform, VENDORED } from '../../../scripts/sync-shared.mjs'

const sharedSrc = resolve(__dirname, '../../../../packages/shared/src')
const vendored = resolve(__dirname, '../src/pine-shared')
const haveShared = existsSync(join(sharedSrc, 'tx-plan.ts'))
// The original canonical.ts needs the backend workspace's dependencies (canonicalize, multiformats).
const haveSharedDeps = haveShared && existsSync(resolve(sharedSrc, '../node_modules/canonicalize'))

interface OriginalCanonical {
  canonicalJson(value: JsonValue): string
  sha256Hex(bytes: Uint8Array): Hex32
  rawCidFromBytes(bytes: Uint8Array): string
  rawCidFromSha256(sha: Hex32): string
  sha256FromRawCid(cid: string): Hex32 | null
}

async function original<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(sharedSrc, file)).href)) as T
}

const PINE = {
  claimRegistry: '0x1000000000000000000000000000000000000001' as Address,
  evidenceRegistry: '0x2000000000000000000000000000000000000002' as Address,
  deploymentBlock: 42,
}
const ACCOUNT = '0x3000000000000000000000000000000000000003' as Address

describe.skipIf(!haveShared)('pine-shared stays a faithful copy of packages/shared/src', () => {
  it('every vendored file equals the sync script output for its source', () => {
    for (const file of VENDORED as string[]) {
      const expected = (transform as (text: string) => string)(readFileSync(join(sharedSrc, file), 'utf8'))
      expect(readFileSync(join(vendored, file), 'utf8'), file).toBe(expected)
    }
  })
})

describe.skipIf(!haveSharedDeps)('the browser canonical twin matches the original', () => {
  const docs: JsonValue[] = [
    { b: 1, a: [3, 2, 1], c: { z: null, y: true, x: 'é "\\' } },
    { version: 1, nested: { deep: [{ k: 'v' }, 0.5, -0, 1e21, 123456789] } },
    'plain',
    [],
  ]

  it('canonicalJson, sha256Hex, rawCid and digest extraction agree', async () => {
    const orig = await original<OriginalCanonical>('canonical.ts')
    for (const doc of docs) {
      expect(canonicalJson(doc)).toBe(orig.canonicalJson(doc))
      const bytes = new TextEncoder().encode(canonicalJson(doc))
      expect(sha256Hex(bytes)).toBe(orig.sha256Hex(bytes))
      expect(identify(bytes).cid).toBe(orig.rawCidFromBytes(bytes))
      const digest = sha256Hex(bytes)
      expect(rawCidFromSha256(digest)).toBe(orig.rawCidFromSha256(digest))
      expect(sha256FromRawCid(orig.rawCidFromSha256(digest))).toBe(digest)
    }
    expect(sha256FromRawCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBeNull()
    expect(orig.sha256FromRawCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBeNull()
  })

  it('reproduces the frozen cross-language vectors', async () => {
    const vectors = await original<{
      RAW_CID_VECTORS: readonly (readonly [string, string])[]
      QUESTION_VECTORS: readonly { input: Parameters<typeof renderQuestion>[0]; question: string }[]
      EVIDENCE_COMMITMENT_VECTOR: { input: Parameters<typeof computeEvidenceCommitment>[0]; commitment: string }
    }>('testing/vectors.ts')
    for (const [digest, cid] of vectors.RAW_CID_VECTORS) expect(rawCidFromSha256(digest as Hex32)).toBe(cid)
    for (const vector of vectors.QUESTION_VECTORS) expect(renderQuestion(vector.input)).toBe(vector.question)
    expect(computeEvidenceCommitment(vectors.EVIDENCE_COMMITMENT_VECTOR.input)).toBe(vectors.EVIDENCE_COMMITMENT_VECTOR.commitment)
  })

  it('computes the same deployment hash as the original manifest code', async () => {
    const orig = await original<{ buildDeploymentManifest: typeof buildDeploymentManifest; deploymentHash: typeof deploymentHash }>('deployment.ts')
    expect(deploymentHash(buildDeploymentManifest(PINE))).toBe(orig.deploymentHash(orig.buildDeploymentManifest(PINE)))
  })
})

describe('plan verification in the browser copy', () => {
  const manifest = buildDeploymentManifest(PINE)
  const market = '0x4000000000000000000000000000000000000004' as Address
  const context = { markets: new Map<Address, readonly Address[]>(), questionIds: new Set<Hex32>() }
  const limits = { maxTotalValueWei: 10n ** 18n, maxApprovalAmount: 10n ** 24n }

  it('accepts a plan built with buildStep and survives the wire round trip', () => {
    const plan = newPlan(manifest, 'plan-1', ACCOUNT, [
      buildStep(manifest, { id: 'evidence', allowlistId: 'evidenceRegistry.commitEvidence', args: [market, `0x${'ab'.repeat(32)}`] }),
    ])
    const decoded = planFromWire(JSON.parse(JSON.stringify(planToWire(plan))))
    expect(verifyPlan(decoded, manifest, context, limits)).toBe(0n)
  })

  it('SEC-TX-01 rejects a plan whose calldata targets a contract outside the deployment manifest', () => {
    const plan = newPlan(manifest, 'plan-2', ACCOUNT, [
      buildStep(manifest, { id: 'evidence', allowlistId: 'evidenceRegistry.commitEvidence', args: [market, `0x${'ab'.repeat(32)}`] }),
    ])
    const wire = planToWire(plan)
    wire.steps[0]!.to = '0x5000000000000000000000000000000000000005'
    expect(() => verifyPlan(planFromWire(wire), manifest, context, limits)).toThrow(PlanVerificationError)
  })

  it('SEC-TX-12 rejects a plan built for another deployment manifest', () => {
    const other = buildDeploymentManifest({ ...PINE, deploymentBlock: 43 })
    const plan = newPlan(other, 'plan-3', ACCOUNT, [
      buildStep(other, { id: 'evidence', allowlistId: 'evidenceRegistry.commitEvidence', args: [market, `0x${'ab'.repeat(32)}`] }),
    ])
    expect(() => verifyPlan(planFromWire(planToWire(plan)), manifest, context, limits)).toThrow(/different deployment manifest/)
  })

  it('rejects calls that are not on the allowlist when decoding from the wire', () => {
    const wire = planToWire(
      newPlan(manifest, 'plan-4', ACCOUNT, [
        buildStep(manifest, { id: 'evidence', allowlistId: 'evidenceRegistry.commitEvidence', args: [market, `0x${'ab'.repeat(32)}`] }),
      ]),
    )
    wire.steps[0]!.allowlistId = 'erc20.transfer'
    expect(() => planFromWire(wire)).toThrow(PlanVerificationError)
  })
})
