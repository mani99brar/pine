import {
  buildStep,
  canonicalJson,
  claimDocumentSchema,
  encodeClaimDocument,
  planFromWire,
  PlanVerificationError,
  rawCidFromSha256,
  renderQuestion,
  tokenNames,
  type Address,
  type ClaimDocument,
  type DeploymentManifest,
  type Hex32,
  type JsonValue,
  type TxPlan,
} from '@pine/core/pine-shared'
import type { ClaimPreviewResponse, DraftInput } from '@pine/data'

// Client-side check of a claim preview before it is shown as reviewable (SEC-CLAIM-01/04/05, SEC-TX-02). The backend
// freezes a claim document and states its digest, CID, question and token names; the browser re-derives every one of
// them from the document with its own copy of @pine/shared, checks the document names this deployment and the connected
// wallet, and that it carries exactly the terms the user composed. Any mismatch blocks publishing.

export type PreviewIssueCode =
  | 'document_invalid'
  | 'digest_mismatch'
  | 'cid_mismatch'
  | 'question_mismatch'
  | 'token_names_mismatch'
  | 'creator_mismatch'
  | 'deployment_mismatch'
  | 'field_mismatch'
  | 'deadline_mismatch'
  | 'stale_preview'
  | 'offer_expired'

export interface PreviewIssue {
  code: PreviewIssueCode
  /** Document field concerned, e.g. `claim.title`. */
  field?: string
  message: string
}

export interface PreviewExpectations {
  /** The draft input sent to the backend for the previewed revision. */
  input: DraftInput
  /** The connected wallet (the document's creator must be this wallet). */
  account: Address | undefined
  /** The deployment manifest pinned in this build. */
  manifest: DeploymentManifest
  chainId: number
  /** Revision the input was saved as. */
  draftRevision?: number
  /** Evidence deadline the user chose, unix seconds. */
  chosenEvidenceDeadline?: number
  /** Accepted difference between the chosen and the previewed deadline (default 15 min: latency, minute rounding, clock skew). */
  deadlineToleranceSeconds?: number
  /** Unix seconds; the publication offer must not have expired. */
  now?: number
}

export interface PreviewTimeline {
  /** Evidence must be committed or published while block.timestamp < evidenceDeadline. */
  evidenceDeadline: number
  /** Sealed evidence must be revealed while block.timestamp < revealDeadline. */
  revealDeadline: number
  /** Reality accepts answers once block.timestamp >= this (the opening time, equal to revealDeadline). */
  answersOpen: number
  /** Opening time plus the answer timeout; every new answer restarts the timeout. */
  earliestFinalization: number
}

/** A preview whose document re-encodes to its digest; all values below are derived from the verified document. */
export interface VerifiedPreview {
  previewId: string
  documentSha256: Hex32
  cid: string
  document: ClaimDocument
  question: string
  tokenNames: readonly [string, string]
  planExpiresAt: number
  draftRevision: number
  timeline: PreviewTimeline
  /** Advisory gas estimate (not part of the terms). */
  costs: ClaimPreviewResponse['costs']
  /** Platform-authored disclosures (plain text). */
  disclosures: ClaimPreviewResponse['disclosures']
}

const lower = (value: string) => value.toLowerCase()
function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue)
  } catch {
    return false
  }
}

const FIELD_LABELS: Record<string, string> = {
  'target.repository': 'repository',
  'target.commit': 'commit',
  'target.baseCommit': 'base commit',
  'target.membership.ref': 'pull request or branch',
  policy: 'policy',
  'claim.title': 'title',
  'claim.requirement': 'requirement',
  'claim.violation': 'violation',
  'claim.scope': 'scope',
  'claim.allowedInputs': 'allowed inputs',
  'claim.assumptions': 'assumptions',
  'claim.faultModel': 'fault model',
  'claim.regressionOnly': 'regression-only setting',
  'claim.exclusions': 'exclusions',
  'claim.policyParameters': 'policy parameters',
  environment: 'environment',
  'market.minBondWei': 'minimum bond',
}

function fieldIssue(field: string): PreviewIssue {
  return { code: 'field_mismatch', field, message: `The preview’s ${FIELD_LABELS[field] ?? field} differs from what you composed. Do not publish it; request a new preview.` }
}

/** The terms of the document that come straight from the draft input. */
function compareComposed(doc: ClaimDocument, input: DraftInput): PreviewIssue[] {
  const issues: PreviewIssue[] = []
  const repo = doc.target.repository
  // GitHub names are case-insensitive; the document carries GitHub's own spelling.
  if (lower(repo.ownerLogin) !== lower(input.repository.owner) || lower(repo.name) !== lower(input.repository.name)) issues.push(fieldIssue('target.repository'))
  if (doc.target.commit !== input.commit) issues.push(fieldIssue('target.commit'))
  if (doc.target.baseCommit !== input.baseCommit) issues.push(fieldIssue('target.baseCommit'))
  if (!same(doc.target.membership.ref, input.membership)) issues.push(fieldIssue('target.membership.ref'))
  if (doc.policy.id !== input.policy.id || doc.policy.version !== input.policy.version) issues.push(fieldIssue('policy'))
  const claim = doc.claim
  if (claim.title !== input.title) issues.push(fieldIssue('claim.title'))
  if (claim.requirement !== input.requirement) issues.push(fieldIssue('claim.requirement'))
  if (claim.violation !== input.violation) issues.push(fieldIssue('claim.violation'))
  if (!same(claim.scope, input.scope)) issues.push(fieldIssue('claim.scope'))
  if (claim.allowedInputs !== input.allowedInputs) issues.push(fieldIssue('claim.allowedInputs'))
  if (!same(claim.assumptions, input.assumptions)) issues.push(fieldIssue('claim.assumptions'))
  if (claim.faultModel !== input.faultModel) issues.push(fieldIssue('claim.faultModel'))
  if (claim.regressionOnly !== input.regressionOnly) issues.push(fieldIssue('claim.regressionOnly'))
  if (!same(claim.exclusions, input.exclusions)) issues.push(fieldIssue('claim.exclusions'))
  if (!same(claim.policyParameters, input.policyParameters)) issues.push(fieldIssue('claim.policyParameters'))
  if (!same(doc.environment, input.environment)) issues.push(fieldIssue('environment'))
  if (input.minBondWei !== null && doc.market.minBondWei !== input.minBondWei) issues.push(fieldIssue('market.minBondWei'))
  return issues
}

/** The document must name this build's deployment (registries, Seer, Reality, Kleros) and chain. */
function compareDeployment(doc: ClaimDocument, manifest: DeploymentManifest, chainId: number): PreviewIssue[] {
  const pairs: [string, string | number, string | number][] = [
    ['evidence.chainId', doc.evidence.chainId, chainId],
    ['evidence.registry', doc.evidence.registry, manifest.pine.evidenceRegistry],
    ['market.chainId', doc.market.chainId, chainId],
    ['market.claimRegistry', doc.market.claimRegistry, manifest.pine.claimRegistry],
    ['market.seerMarketFactory', doc.market.seerMarketFactory, manifest.seer.marketFactory],
    ['market.collateralToken', doc.market.collateralToken, manifest.seer.collateralToken],
    ['market.realitio', doc.market.realitio, manifest.seer.realitio],
    ['market.arbitrator', doc.market.arbitrator, manifest.seer.arbitrator],
    ['market.questionTimeoutSeconds', doc.market.questionTimeoutSeconds, manifest.seer.questionTimeoutSeconds],
  ]
  return pairs
    .filter(([, actual, pinned]) => lower(String(actual)) !== lower(String(pinned)))
    .map(([field]) => ({ code: 'deployment_mismatch' as const, field, message: `The preview names a different ${field} than this app’s pinned Pine deployment. Do not publish it.` }))
}

function utc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Verifies a preview response. `preview` is null only when the document itself is unusable; otherwise it is returned
 * for display together with any issues (an issue always blocks publishing).
 */
export function verifyPreview(response: ClaimPreviewResponse, expected: PreviewExpectations): { preview: VerifiedPreview | null; issues: PreviewIssue[] } {
  const parsed = claimDocumentSchema.safeParse(response.document)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      preview: null,
      issues: [{ code: 'document_invalid', message: `The claim document is not a valid urn:pine:claim:v1 document${first ? ` (${first.path.join('.')}: ${first.message})` : ''}.` }],
    }
  }
  const doc = parsed.data
  let digest: Hex32
  try {
    digest = encodeClaimDocument(doc).sha256
  } catch (e) {
    return { preview: null, issues: [{ code: 'document_invalid', message: e instanceof Error ? e.message : 'The claim document cannot be encoded.' }] }
  }

  const issues: PreviewIssue[] = []
  if (digest !== lower(response.documentSha256)) {
    issues.push({ code: 'digest_mismatch', message: 'The claim document does not hash to the digest Pine stated, so the terms shown may not be the terms published. Do not publish it.' })
  }
  if (rawCidFromSha256(digest) !== response.cid) {
    issues.push({ code: 'cid_mismatch', message: 'The IPFS CID Pine stated does not match the claim document.' })
  }
  let question: string | null = null
  try {
    question = renderQuestion({
      evidenceRegistry: expected.manifest.pine.evidenceRegistry,
      title: doc.claim.title,
      evidenceDeadline: doc.evidence.evidenceDeadline,
      revealDeadline: doc.evidence.revealDeadline,
      repositoryId: doc.target.repository.id,
      commit: doc.target.commit,
      claimDocumentSha256: digest,
      policyDocumentSha256: doc.policy.sha256,
    })
  } catch (e) {
    issues.push({ code: 'question_mismatch', message: `The market question cannot be composed from this document (${e instanceof Error ? e.message : 'invalid input'}).` })
  }
  if (question !== null && question !== response.question) {
    issues.push({ code: 'question_mismatch', message: 'The market question Pine stated differs from the one the claim registry will ask for this document. Do not publish it.' })
  }
  const names = tokenNames(digest)
  if (response.tokenNames[0] !== names[0] || response.tokenNames[1] !== names[1]) {
    issues.push({ code: 'token_names_mismatch', message: 'The outcome token names Pine stated do not match this document.' })
  }
  if (!expected.account) {
    issues.push({ code: 'creator_mismatch', message: 'Connect the wallet you signed in with: the claim document names its creator.' })
  } else if (doc.creator !== lower(expected.account)) {
    issues.push({ code: 'creator_mismatch', field: 'creator', message: `The claim document names creator ${doc.creator}, not your connected wallet. Connect that wallet or sign in with this one, then preview again.` })
  }
  issues.push(...compareDeployment(doc, expected.manifest, expected.chainId))
  issues.push(...compareComposed(doc, expected.input))

  const tolerance = expected.deadlineToleranceSeconds ?? 15 * 60
  if (expected.chosenEvidenceDeadline !== undefined && Math.abs(doc.evidence.evidenceDeadline - expected.chosenEvidenceDeadline) > tolerance) {
    issues.push({
      code: 'deadline_mismatch',
      field: 'evidence.evidenceDeadline',
      message: `The preview’s evidence deadline (${utc(doc.evidence.evidenceDeadline)}) differs from the one you chose (${utc(expected.chosenEvidenceDeadline)}). Check your device clock, then preview again.`,
    })
  }
  const stated = response.timeline
  const statedTimes: [string, number | undefined, number][] = [
    ['evidenceDeadline', stated?.evidenceDeadline?.unix, doc.evidence.evidenceDeadline],
    ['revealDeadline', stated?.revealDeadline?.unix, doc.evidence.revealDeadline],
    ['answersOpen', stated?.answersOpen?.unix, doc.market.openingTime],
  ]
  for (const [name, said, actual] of statedTimes) {
    if (said !== undefined && said !== actual) {
      issues.push({ code: 'deadline_mismatch', field: `timeline.${name}`, message: `Pine’s timeline states a different ${name} than the claim document.` })
    }
  }
  if (expected.draftRevision !== undefined && response.draftRevision !== expected.draftRevision) {
    issues.push({ code: 'stale_preview', message: 'This preview was made for another revision of the draft. Request a new preview.' })
  }
  if (expected.now !== undefined && response.planExpiresAt <= expected.now) {
    issues.push({ code: 'offer_expired', message: 'The offer to publish this preview has expired. Request a new preview.' })
  }

  const preview: VerifiedPreview = {
    previewId: response.previewId,
    documentSha256: digest,
    cid: rawCidFromSha256(digest),
    document: doc,
    question: question ?? response.question,
    tokenNames: names,
    planExpiresAt: response.planExpiresAt,
    draftRevision: response.draftRevision,
    timeline: {
      evidenceDeadline: doc.evidence.evidenceDeadline,
      revealDeadline: doc.evidence.revealDeadline,
      answersOpen: doc.market.openingTime,
      earliestFinalization: doc.market.openingTime + doc.market.questionTimeoutSeconds,
    },
    costs: response.costs,
    disclosures: response.disclosures,
  }
  return { preview, issues }
}

/** ClaimRegistry.createClaim parameters derived from the frozen document only (publications.ts `createClaimParams`). */
export function createClaimParamsOf(document: ClaimDocument, documentSha256: Hex32) {
  return {
    claimDocumentSha256: documentSha256,
    policyDocumentSha256: document.policy.sha256,
    repositoryId: BigInt(document.target.repository.id),
    commit: `0x${document.target.commit}` as `0x${string}`,
    evidenceDeadline: BigInt(document.evidence.evidenceDeadline),
    revealDeadline: BigInt(document.evidence.revealDeadline),
    minBond: BigInt(document.market.minBondWei),
    title: document.claim.title,
  }
}

type CreateClaimParams = ReturnType<typeof createClaimParamsOf>

function sameParam(name: keyof CreateClaimParams, actual: unknown, expected: CreateClaimParams[keyof CreateClaimParams]): boolean {
  if (typeof expected === 'bigint') return actual === expected
  if (name === 'title') return actual === expected
  return typeof actual === 'string' && lower(actual) === lower(String(expected))
}

/**
 * SEC-TX-02: the publication plan must be exactly one createClaim call, from `account`, with no value, whose decoded
 * parameters equal the previewed document and whose calldata equals the client's own encoding of them, byte for byte.
 * Throws PlanVerificationError before any wallet prompt otherwise. (verifyPlan then checks the chain, target and
 * deployment hash again.)
 */
export function checkCreateClaimPlan(
  wire: unknown,
  ctx: { document: ClaimDocument; documentSha256: Hex32; account: Address; manifest: DeploymentManifest },
): TxPlan {
  const plan = planFromWire(wire)
  if (plan.account !== lower(ctx.account)) throw new PlanVerificationError(null, 'the plan was built for another wallet')
  if (plan.steps.length !== 1) throw new PlanVerificationError(null, 'a publication plan has exactly one createClaim step')
  const step = plan.steps[0]
  if (!step || step.allowlistId !== 'claimRegistry.createClaim') throw new PlanVerificationError(step?.id ?? null, 'the publication step is not ClaimRegistry.createClaim')
  if (step.value !== 0n) throw new PlanVerificationError(step.id, 'createClaim must not carry value')
  const expected = createClaimParamsOf(ctx.document, ctx.documentSha256)
  const decoded = (step.args[0] ?? {}) as Record<string, unknown>
  for (const name of Object.keys(expected) as (keyof CreateClaimParams)[]) {
    if (!sameParam(name, decoded[name], expected[name])) throw new PlanVerificationError(step.id, `createClaim ${name} differs from the previewed claim document`)
  }
  const rebuilt = buildStep(ctx.manifest, { id: step.id, allowlistId: 'claimRegistry.createClaim', args: [expected] })
  if (lower(rebuilt.data) !== lower(step.data) || rebuilt.to !== lower(step.to)) throw new PlanVerificationError(step.id, 'createClaim calldata differs from the previewed claim document')
  return plan
}
