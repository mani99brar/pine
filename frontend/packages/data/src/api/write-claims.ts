import { z } from 'zod'

// Preview and publication answers (packages/api/src/modules/claims/preview.ts, publications.ts). The claim document and
// the plan are kept as `unknown` here: the client parses the document with the vendored claimDocumentSchema and the plan
// with planFromWire, and verifies both before anything is shown as reviewable or sent to a wallet.

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const uintString = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/)
const unix = z.number().int().nonnegative().max(2 ** 40)
const iso = z.string().max(40)
/** Platform-authored text (operators, notes, disclosures): shown as plain text only. */
const platformText = z.string().max(2_000)

const timedFact = z.object({ unix, iso, operator: platformText.optional(), note: platformText.optional() })

/** POST /api/v1/drafts/:id/preview (201). */
export const claimPreviewResponseSchema = z.object({
  previewId: z.uuid(),
  documentSha256: hex32,
  cid: z.string().min(1).max(200),
  /** urn:pine:claim:v1, untrusted until it re-encodes to `documentSha256` on the client. */
  document: z.unknown(),
  question: z.string().min(1).max(4_000),
  tokenNames: z.array(z.string().max(32)).length(2),
  planExpiresAt: unix,
  planExpiresAtIso: iso.optional(),
  draftRevision: z.number().int().positive(),
  timeline: z
    .object({
      evidenceDeadline: timedFact.optional(),
      revealDeadline: timedFact.optional(),
      answersOpen: timedFact.optional(),
      earliestFinalization: timedFact.optional(),
      arbitration: platformText.optional(),
    })
    .optional(),
  costs: z
    .object({
      estimatedGas: uintString.optional(),
      gasPriceWei: uintString.nullable().optional(),
      estimatedCostWei: uintString.nullable().optional(),
      note: platformText.optional(),
    })
    .optional(),
  disclosures: z.array(z.object({ code: z.string().max(64), text: platformText })).max(20).default([]),
})
export type ClaimPreviewResponse = z.infer<typeof claimPreviewResponseSchema>

export const PUBLICATION_STATES = ['planned', 'submitted', 'mined', 'confirmed', 'failed', 'expired'] as const
export type PublicationState = (typeof PUBLICATION_STATES)[number]
/** States after which a publication never changes. */
export const FINAL_PUBLICATION_STATES: readonly PublicationState[] = ['confirmed', 'failed', 'expired']

export const publicationViewSchema = z.object({
  id: z.uuid(),
  state: z.enum(PUBLICATION_STATES),
  previewId: z.uuid(),
  draftId: z.uuid(),
  documentSha256: hex32,
  creator: address,
  planId: z.uuid(),
  market: address.nullable(),
  planExpiresAt: unix,
  planExpiresAtIso: iso.optional(),
  planExpired: z.boolean(),
  failureReason: z.string().max(500).nullable(),
  transactions: z
    .array(z.object({ txHash: hex32, status: z.string().max(32), reason: z.string().max(500).nullable() }))
    .max(50),
  createdAt: iso,
  updatedAt: iso,
})
export type PublicationView = z.infer<typeof publicationViewSchema>

/** POST /api/v1/publications (always 200): the publication and its createClaim plan, or `plan: null`. */
export const publicationResponseSchema = z.object({
  publication: publicationViewSchema,
  planExpired: z.boolean(),
  plan: z.unknown().nullable(),
})
export type PublicationResponse = z.infer<typeof publicationResponseSchema>

/** GET /api/v1/publications/:id and POST /api/v1/publications/:id/submitted. */
export const publicationEnvelopeSchema = z.object({ publication: publicationViewSchema })
