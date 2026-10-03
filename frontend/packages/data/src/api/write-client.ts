import type { Address, Hex } from '@pine/core'
import type { EvidenceManifest } from '@pine/core/pine-shared'
import { PineBackendError, seg, type PineApiClient } from './http'
import { draftEnvelopeSchema, type DraftInput, type DraftView } from './write-draft'
import {
  claimPreviewResponseSchema,
  publicationEnvelopeSchema,
  publicationResponseSchema,
  type ClaimPreviewResponse,
  type PublicationResponse,
  type PublicationView,
} from './write-claims'
import {
  contentIdentitySchema,
  revealCandidatePageSchema,
  marketsPlanResponseSchema,
  oracleActionStatusSchema,
  revealTemplateResponseSchema,
  type ContentIdentity,
  type RevealCandidatePage,
  type MarketsPlanResponse,
  type OracleActionStatus,
  type RevealTemplateResponse,
} from './write-markets'
import { fundingPlanViewSchema, type FundingPlanView } from './write-funding'

// Typed calls of every backend write route the app uses, over the same-origin PineApiClient (CSRF header, JSON bodies,
// zod-validated answers). Bodies are built here field by field: the backend schemas are strict, so nothing extra is
// ever sent, and no request carries an evidence salt (Pine never receives it).

/** Largest artifact or manifest Pine stores (one raw IPFS block). */
export const EVIDENCE_UPLOAD_MAX_BYTES = 262_144
/** Default PINE_ALLOWED_ARTIFACT_MEDIA_TYPES of the backend. */
export const DEFAULT_ARTIFACT_MEDIA_TYPES: readonly string[] = [
  'application/json',
  'text/plain',
  'application/gzip',
  'application/zip',
  'application/x-tar',
  'image/png',
  'image/jpeg',
]

export const ORACLE_PLAN_ROUTES = [
  'submit-answer',
  'fund-bounty',
  'resolve',
  'reopen',
  'handle-notified-request',
  'handle-rejected-request',
  'report-arbitration-answer',
  'claim-winnings',
  'withdraw',
] as const
export type OraclePlanRoute = (typeof ORACLE_PLAN_ROUTES)[number]

/** Body of each oracle plan route (strict on the backend). */
export type OraclePlanBody<R extends OraclePlanRoute> = R extends 'submit-answer'
  ? { market: Address; outcome: 'yes' | 'no' | 'invalid'; bond: string }
  : R extends 'fund-bounty'
    ? { market: Address; amount: string }
    : R extends 'withdraw'
      ? Record<string, never>
      : { market: Address }

export interface LadderPlanBody {
  market: Address
  budgetWei: string
  lowerPrice: string
  upperPrice: string
  riskAcknowledgement: { budgetWei: string; maxLossIfYesShares: string }
}

export type ExitPlanKind = 'withdraw' | 'merge' | 'redeem'
export type ExitPlanBody<K extends ExitPlanKind> = K extends 'withdraw'
  ? { market: Address; tokenId: string }
  : K extends 'merge'
    ? { market: Address; amount: string }
    : { market: Address }

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const PLAN_STEP_ID = /^[A-Za-z0-9._-]{1,64}$/

function txHash(value: Hex): Hex {
  if (!TX_HASH.test(value)) throw new PineBackendError('Invalid transaction hash', 0, 'BAD_REQUEST')
  return value.toLowerCase() as Hex
}

function stepId(value: string): string {
  if (!PLAN_STEP_ID.test(value)) throw new PineBackendError('Invalid plan step id', 0, 'BAD_REQUEST')
  return value
}

const required = <T>(value: T | null, what: string): T => {
  if (value === null) throw new PineBackendError(`Empty response (${what})`, 204, 'BAD_RESPONSE')
  return value
}

export class PineWriteApi {
  constructor(readonly api: PineApiClient) {}

  // ---- drafts, preview, publication (packages/api/src/modules/claims) ----

  async createDraft(input: DraftInput): Promise<DraftView> {
    return (await this.api.post('/api/v1/drafts', draftEnvelopeSchema, input)).draft
  }

  async updateDraft(id: string, input: DraftInput, expectedRevision?: number): Promise<DraftView> {
    const body = expectedRevision === undefined ? { input } : { input, expectedRevision }
    return required(await this.api.request('PUT', `/api/v1/drafts/${seg(id)}`, draftEnvelopeSchema, { body }), 'PUT draft').draft
  }

  async getDraft(id: string): Promise<DraftView> {
    return (await this.api.get(`/api/v1/drafts/${seg(id)}`, draftEnvelopeSchema)).draft
  }

  /**
   * Freezes the claim document. The attestation is the user's explicit statement that no counterexample would demonstrate
   * an exploitable flaw in a deployed system holding third-party funds or data; it is only ever sent as `true`.
   */
  async preview(draftId: string, attestation: { liveSystemImpactNone: true }): Promise<ClaimPreviewResponse> {
    if (attestation.liveSystemImpactNone !== true) throw new PineBackendError('The live-system attestation is required', 0, 'BAD_REQUEST')
    return this.api.post(`/api/v1/drafts/${seg(draftId)}/preview`, claimPreviewResponseSchema, { attestLiveSystemImpactNone: true })
  }

  /** Idempotent per (user, documentSha256): a retry returns the same publication and plan. */
  async publish(previewId: string, documentSha256: Hex): Promise<PublicationResponse> {
    return this.api.post('/api/v1/publications', publicationResponseSchema, { previewId, documentSha256: documentSha256.toLowerCase() })
  }

  async getPublication(id: string): Promise<PublicationView> {
    return (await this.api.get(`/api/v1/publications/${seg(id)}`, publicationEnvelopeSchema)).publication
  }

  /** The publication route takes `{txHash}` only (no step id). */
  async reportPublicationTx(id: string, hash: Hex): Promise<PublicationView> {
    return (await this.api.post(`/api/v1/publications/${seg(id)}/submitted`, publicationEnvelopeSchema, { txHash: txHash(hash) })).publication
  }

  // ---- evidence (packages/api/src/modules/markets/evidence-*.ts) ----

  /**
   * Uploads one artifact as multipart/form-data: one file part (with a neutral file name; the backend never reads it)
   * and the locally computed `expectedSha256`, which the backend compares with the bytes it received.
   */
  async uploadArtifact(bytes: Uint8Array, opts: { mediaType: string; expectedSha256: Hex }): Promise<ContentIdentity> {
    if (bytes.byteLength > EVIDENCE_UPLOAD_MAX_BYTES) throw new PineBackendError('Artifacts are limited to 256 KiB', 413, 'PAYLOAD_TOO_LARGE')
    const form = new FormData()
    form.append('expectedSha256', opts.expectedSha256.toLowerCase())
    form.append('file', new Blob([bytes.slice().buffer], { type: opts.mediaType }), 'artifact')
    return required(await this.api.request('POST', '/api/v1/evidence/artifacts', contentIdentitySchema, { form }), 'POST artifact')
  }

  /** Stores a manifest that is already in normal form (lowercase addresses, digests and commit). */
  async storeManifest(manifest: EvidenceManifest): Promise<ContentIdentity> {
    return this.api.post('/api/v1/evidence/manifests', contentIdentitySchema, manifest)
  }

  async commitPlan(body: { market: Address; commitment: Hex }, idempotencyKey: string): Promise<MarketsPlanResponse> {
    return this.api.post('/api/v1/evidence/plans/commit', marketsPlanResponseSchema, { market: body.market, commitment: body.commitment }, { idempotencyKey })
  }

  async publishEvidencePlan(body: { market: Address; contentSha256: Hex }, idempotencyKey: string): Promise<MarketsPlanResponse> {
    return this.api.post('/api/v1/evidence/plans/publish', marketsPlanResponseSchema, { market: body.market, contentSha256: body.contentSha256 }, { idempotencyKey })
  }

  /** Salt-free: the request names only the submission and the content digest. */
  async revealTemplate(body: { submissionId: string; contentSha256: Hex; unavailableContentAcknowledged?: boolean }): Promise<RevealTemplateResponse> {
    const payload =
      body.unavailableContentAcknowledged === true
        ? { submissionId: body.submissionId, contentSha256: body.contentSha256, unavailableContentAcknowledged: true }
        : { submissionId: body.submissionId, contentSha256: body.contentSha256 }
    return this.api.post('/api/v1/evidence/reveal-template', revealTemplateResponseSchema, payload)
  }

  async evidence(market: Address, query: { status?: 'committed' | 'revealed' | 'published'; cursor?: string } = {}): Promise<RevealCandidatePage> {
    return this.api.get(`/api/v1/markets/${seg(market.toLowerCase())}/evidence`, revealCandidatePageSchema, { status: query.status, cursor: query.cursor })
  }

  // ---- markets plans (evidence and oracle) ----

  async getMarketsPlan(planId: string): Promise<MarketsPlanResponse> {
    return this.api.get(`/api/v1/markets/plans/${seg(planId)}`, marketsPlanResponseSchema)
  }

  async reportMarketsPlanTx(planId: string, step: string, hash: Hex): Promise<MarketsPlanResponse> {
    return this.api.post(`/api/v1/markets/plans/${seg(planId)}/submitted`, marketsPlanResponseSchema, { stepId: stepId(step), txHash: txHash(hash) })
  }

  // ---- oracle (packages/api/src/modules/markets/oracle*.ts) ----

  async oracleStatus(market: Address, account?: Address): Promise<OracleActionStatus> {
    return this.api.get(`/api/v1/markets/${seg(market.toLowerCase())}/oracle`, oracleActionStatusSchema, { account: account?.toLowerCase() })
  }

  async oraclePlan<R extends OraclePlanRoute>(route: R, body: OraclePlanBody<R>, idempotencyKey: string): Promise<MarketsPlanResponse> {
    return this.api.post(`/api/v1/oracle/plans/${route}`, marketsPlanResponseSchema, body, { idempotencyKey })
  }

  // ---- funding (packages/api/src/modules/funding) ----

  async ladderPlan(body: LadderPlanBody, idempotencyKey: string): Promise<FundingPlanView> {
    const payload: LadderPlanBody = {
      market: body.market,
      budgetWei: body.budgetWei,
      lowerPrice: body.lowerPrice,
      upperPrice: body.upperPrice,
      riskAcknowledgement: { budgetWei: body.riskAcknowledgement.budgetWei, maxLossIfYesShares: body.riskAcknowledgement.maxLossIfYesShares },
    }
    return this.api.post('/api/v1/funding/plans/ladder', fundingPlanViewSchema, payload, { idempotencyKey })
  }

  async exitPlan<K extends ExitPlanKind>(kind: K, body: ExitPlanBody<K>, idempotencyKey: string): Promise<FundingPlanView> {
    return this.api.post(`/api/v1/funding/plans/${kind}`, fundingPlanViewSchema, body, { idempotencyKey })
  }

  async getFundingPlan(planId: string): Promise<FundingPlanView> {
    return this.api.get(`/api/v1/funding/plans/${seg(planId)}`, fundingPlanViewSchema)
  }

  async reportFundingPlanTx(planId: string, step: string, hash: Hex): Promise<FundingPlanView> {
    return this.api.post(`/api/v1/funding/plans/${seg(planId)}/submitted`, fundingPlanViewSchema, { stepId: stepId(step), txHash: txHash(hash) })
  }
}

/** A decimal wei string for a request body (non-negative bigint). */
export function weiString(value: bigint): string {
  if (value < 0n) throw new PineBackendError('Negative amount', 0, 'BAD_REQUEST')
  return value.toString(10)
}
