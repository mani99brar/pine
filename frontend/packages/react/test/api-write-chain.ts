/**
 * Chain fixtures for the api write tests: the pinned deployment, one registered claim market and a fake ClaimRegistry
 * reader. Kept free of wagmi/React imports so `vi.mock('wagmi', …)` factories can import it.
 */
import {
  buildDeploymentManifest,
  buildStep,
  CLAIM_DOCUMENT_SCHEMA_ID,
  encodeClaimDocument,
  EVIDENCE_MANIFEST_SCHEMA_ID,
  newPlan,
  planToWire,
  rawCidFromSha256,
  renderQuestion,
  tokenNames,
  type Address,
  type ClaimDocument,
  type Hex32,
  type WireTxPlan,
} from '@pine/core/pine-shared'
import type { DraftInput } from '@pine/data'
import type { RegistryReader } from '../src/api/plans'

export const PINE = {
  claimRegistry: '0x1000000000000000000000000000000000000001' as Address,
  evidenceRegistry: '0x2000000000000000000000000000000000000002' as Address,
  deploymentBlock: 1,
}
export const manifest = buildDeploymentManifest(PINE)
/** DEMO_WALLET_ADDRESS, lowercase (the demo wallet signs in the hook tests). */
export const ACCOUNT = '0xde30bd7c2a0b6f1e5c4b1a9f2f5d3c8e7a6b0d30' as Address
export const OTHER = '0x3000000000000000000000000000000000000003' as Address
export const MARKET = '0x4000000000000000000000000000000000000004' as Address
// Outcome tokens sorted around the collateral (0xaf20…) so both pool orientations are exercised elsewhere.
export const YES = '0x5000000000000000000000000000000000000005' as Address
export const NO = '0x6000000000000000000000000000000000000006' as Address
export const INVALID = '0x7000000000000000000000000000000000000007' as Address
export const QUESTION = `0x${'99'.repeat(32)}` as Hex32
export const CONDITION = `0x${'88'.repeat(32)}` as Hex32
export const CLAIM_DOC_SHA = `0x${'cd'.repeat(32)}` as Hex32
export const POLICY_SHA = `0x${'ab'.repeat(32)}` as Hex32
export const COMMIT = 'c84e3dd7c01a2be9db29c372ed0006b55bf59ec0'
export const XDAI = 10n ** 18n

/** A fixed clock on a whole minute. */
export const NOW = new Date('2026-10-04T12:00:00.000Z')
export const NOW_S = Math.floor(NOW.getTime() / 1000)
export const EVIDENCE_DEADLINE = NOW_S + 3 * 86_400
export const REVEAL_DEADLINE = EVIDENCE_DEADLINE + 2 * 86_400

/** The ClaimRegistry struct of MARKET (getClaim). */
export function claimStruct(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    creator: OTHER,
    createdAt: BigInt(NOW_S - 86_400),
    evidenceDeadline: BigInt(EVIDENCE_DEADLINE),
    revealDeadline: BigInt(REVEAL_DEADLINE),
    repositoryId: 427_016_914n,
    commit: `0x${COMMIT}`,
    claimDocumentSha256: CLAIM_DOC_SHA,
    policyDocumentSha256: POLICY_SHA,
    questionId: QUESTION,
    conditionId: CONDITION,
    marketNameHash: `0x${'77'.repeat(32)}`,
    minBond: 10n * XDAI,
    yesToken: YES,
    noToken: NO,
    invalidToken: INVALID,
    ...over,
  }
}

/** Claims ClaimRegistry knows, by lowercase market (tests may add more; reset with resetChain()). */
export const chainClaims = new Map<string, Record<string, unknown>>()
export function resetChain(): void {
  chainClaims.clear()
  chainClaims.set(MARKET, claimStruct())
}
resetChain()

/** ClaimRegistry on the user's RPC. Records every read. */
export const reads: string[] = []
export const fakeReader: RegistryReader = {
  async readContract({ address, functionName, args }) {
    reads.push(`${functionName}:${args[0]}`)
    if (address.toLowerCase() !== PINE.claimRegistry) throw new Error('read from the wrong registry')
    const claim = chainClaims.get(String(args[0]).toLowerCase())
    if (functionName === 'isRegistered') return claim !== undefined
    if (!claim) throw new Error('not registered')
    return claim
  },
}

const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The claim document the backend freezes for `input` (preview.ts), for `creator`, at `now` (unix s). */
export function documentFor(input: DraftInput, creator: Address, now: number, over: { nonce?: Hex32; repositoryId?: number; ownerLogin?: string } = {}): ClaimDocument {
  const window = input.evidenceWindowSeconds ?? 7 * 86_400
  const evidenceDeadline = Math.ceil((now + window) / 60) * 60
  const revealDeadline = evidenceDeadline + 48 * 3_600
  return {
    schema: CLAIM_DOCUMENT_SCHEMA_ID,
    nonce: over.nonce ?? (`0x${'11'.repeat(32)}` as Hex32),
    policy: { id: input.policy.id, version: input.policy.version, sha256: POLICY_SHA },
    target: {
      host: 'github.com',
      repository: { id: over.repositoryId ?? 427_016_914, ownerLogin: over.ownerLogin ?? input.repository.owner, name: input.repository.name },
      commit: input.commit,
      baseCommit: input.baseCommit,
      membership: { method: input.membership.kind === 'pull' ? 'pull_head' : 'branch_ancestor', ref: input.membership, verifiedAt: iso(now) },
    },
    claim: {
      title: input.title,
      requirement: input.requirement,
      violation: input.violation,
      scope: input.scope,
      allowedInputs: input.allowedInputs,
      assumptions: input.assumptions,
      faultModel: input.faultModel,
      regressionOnly: input.regressionOnly,
      exclusions: input.exclusions,
      policyParameters: input.policyParameters as ClaimDocument['claim']['policyParameters'],
    },
    environment: input.environment,
    evidence: { chainId: 100, registry: PINE.evidenceRegistry, evidenceDeadline, revealDeadline, manifestSchema: EVIDENCE_MANIFEST_SCHEMA_ID },
    market: {
      chainId: 100,
      claimRegistry: PINE.claimRegistry,
      seerMarketFactory: manifest.seer.marketFactory,
      collateralToken: manifest.seer.collateralToken,
      realitio: manifest.seer.realitio,
      arbitrator: manifest.seer.arbitrator,
      questionTimeoutSeconds: manifest.seer.questionTimeoutSeconds,
      openingTime: revealDeadline,
      minBondWei: input.minBondWei ?? (10n * XDAI).toString(),
    },
    disclosure: { liveSystemImpact: 'none' },
    creator: creator.toLowerCase() as Address,
    createdAt: iso(now),
  }
}

/** A preview response exactly as preview.ts builds it for `document`. */
export function previewFor(document: ClaimDocument, opts: { previewId?: string; draftRevision?: number; now: number }) {
  const { sha256 } = encodeClaimDocument(document)
  const question = renderQuestion({
    evidenceRegistry: PINE.evidenceRegistry,
    title: document.claim.title,
    evidenceDeadline: document.evidence.evidenceDeadline,
    revealDeadline: document.evidence.revealDeadline,
    repositoryId: document.target.repository.id,
    commit: document.target.commit,
    claimDocumentSha256: sha256,
    policyDocumentSha256: document.policy.sha256,
  })
  const planExpiresAt = Math.min(document.evidence.evidenceDeadline - 86_400 - 900, opts.now + 86_400)
  const t = (unix: number) => ({ unix, iso: iso(unix), operator: 'op' })
  return {
    previewId: opts.previewId ?? '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    documentSha256: sha256,
    cid: rawCidFromSha256(sha256),
    document,
    question,
    tokenNames: [...tokenNames(sha256)],
    planExpiresAt,
    planExpiresAtIso: iso(planExpiresAt),
    draftRevision: opts.draftRevision ?? 1,
    timeline: {
      evidenceDeadline: t(document.evidence.evidenceDeadline),
      revealDeadline: t(document.evidence.revealDeadline),
      answersOpen: t(document.market.openingTime),
      earliestFinalization: { unix: document.market.openingTime + 302_400, iso: iso(document.market.openingTime + 302_400), note: 'n' },
      arbitration: 'Kleros',
    },
    costs: { estimatedGas: '1800000', gasPriceWei: null, estimatedCostWei: null, note: 'estimate' },
    disclosures: [{ code: 'no_is_not_certification', text: 'No is not a certification.' }],
  }
}

/** createClaim parameters from a document (publications.ts createClaimParams). */
export function createClaimParams(document: ClaimDocument, sha256: Hex32) {
  return {
    claimDocumentSha256: sha256,
    policyDocumentSha256: document.policy.sha256,
    repositoryId: BigInt(document.target.repository.id),
    commit: `0x${document.target.commit}` as `0x${string}`,
    evidenceDeadline: BigInt(document.evidence.evidenceDeadline),
    revealDeadline: BigInt(document.evidence.revealDeadline),
    minBond: BigInt(document.market.minBondWei),
    title: document.claim.title,
  }
}

/** A one-step wire plan for `account`. */
export function wirePlan(planId: string, account: Address, steps: Parameters<typeof buildStep>[1][]): WireTxPlan {
  return planToWire(newPlan(manifest, planId, account, steps.map((s) => buildStep(manifest, s))))
}
