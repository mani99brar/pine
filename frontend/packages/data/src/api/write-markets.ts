import { z } from 'zod'

// Markets lane answers used by the write side (packages/api/src/modules/markets/*): the markets plan view shared by
// evidence and oracle plans, evidence content uploads, the salt-free reveal template, the committed-evidence listing
// (to find a submission id) and the oracle status with its due actions. Big integers arrive as decimal strings.

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const uintString = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/)
const unix = z.number().int().nonnegative().max(2 ** 40)
const iso = z.string().max(40)
const platformText = z.string().max(2_000)

export const MARKETS_PLAN_STATES = ['planned', 'submitted', 'confirmed', 'failed', 'expired'] as const
export type MarketsPlanState = (typeof MARKETS_PLAN_STATES)[number]
/** Plan states (markets and funding) after which nothing changes. */
export const FINAL_PLAN_STATES: readonly string[] = ['confirmed', 'failed', 'expired']

const txHintSchema = z.object({ txHash: hex32, status: z.string().max(32), reason: z.string().max(500).nullable() })

export const marketsPlanStateSchema = z.object({
  id: z.uuid(),
  kind: z.string().max(64),
  route: z.string().max(64),
  market: address.nullable(),
  account: address,
  state: z.enum(MARKETS_PLAN_STATES),
  /** Offer expiry, unix seconds (unlike funding plans). */
  expiresAt: unix,
  expiresAtIso: iso.optional(),
  offerExpired: z.boolean(),
  steps: z
    .array(z.object({ id: z.string().max(64), allowlistId: z.string().max(128), state: z.enum(['pending', 'confirmed']), transactions: z.array(txHintSchema).max(20) }))
    .max(16),
  createdAt: iso,
  updatedAt: iso,
})
export type MarketsPlanStateView = z.infer<typeof marketsPlanStateSchema>

/** Evidence and oracle plan routes (201 new, 200 replay), GET /api/v1/markets/plans/:planId and its /submitted. */
export const marketsPlanResponseSchema = z.object({
  /** WireTxPlan: decoded and verified by the client, never trusted. */
  plan: z.unknown(),
  planState: marketsPlanStateSchema,
  /** Route-specific public values (decimal strings for big integers). Display only. */
  details: z.record(z.string(), z.unknown()),
})
export type MarketsPlanResponse = z.infer<typeof marketsPlanResponseSchema>

/** POST /api/v1/evidence/artifacts and /api/v1/evidence/manifests (201). */
export const contentIdentitySchema = z.object({ sha256: hex32, cid: z.string().min(1).max(200), size: z.number().int().nonnegative().max(262_144) })
export type ContentIdentity = z.infer<typeof contentIdentitySchema>

/** POST /api/v1/evidence/reveal-template: no plan, no salt; the client completes and verifies the reveal itself. */
export const revealTemplateResponseSchema = z.object({
  template: z.object({
    chainId: z.number().int().positive(),
    registry: address,
    function: z.string().max(200),
    submissionId: z.string().regex(/^[1-9][0-9]{0,76}$/),
    contentSha256: hex32,
    commitment: hex32,
    market: address,
    account: address,
    revealDeadline: unix,
    revealDeadlineIso: iso.optional(),
    operator: platformText.optional(),
    expiresAt: unix,
    expiresAtIso: iso.optional(),
  }),
  warnings: z.array(z.object({ code: z.string().max(64), text: platformText })).max(10),
  instructions: z.array(platformText).max(20).default([]),
  contentTrust: z.string().max(32).optional(),
})
export type RevealTemplateResponse = z.infer<typeof revealTemplateResponseSchema>

/** One entry of GET /api/v1/markets/:market/evidence (only the fields the write side needs). */
export const revealCandidateSchema = z.object({
  registry: address,
  submissionId: z.string().regex(/^(?:0|[1-9][0-9]{0,76})$/),
  market: address,
  submitter: address,
  status: z.enum(['committed', 'revealed', 'published']),
  commitment: hex32.nullable(),
  contentSha256: hex32.nullable(),
  committedAt: unix,
  committedTxHash: hex32,
})
export type RevealCandidate = z.infer<typeof revealCandidateSchema>

export const revealCandidatePageSchema = z.object({
  market: address,
  evidenceDeadline: unix,
  revealDeadline: unix,
  items: z.array(revealCandidateSchema).max(100),
  nextCursor: z.string().max(512).nullable(),
})
export type RevealCandidatePage = z.infer<typeof revealCandidatePageSchema>

const oracleOutcome = z.enum(['yes', 'no', 'invalid', 'answered_too_soon'])

const oracleQuestionSchema = z.object({
  questionId: hex32,
  openingTs: unix,
  minBond: uintString,
  timeout: z.number().int().nonnegative(),
  bestAnswer: hex32.nullable(),
  bond: uintString,
  finalizeTs: unix,
  pendingArbitration: z.boolean(),
  arbitrationRequestedBy: address.nullable(),
  answeredByArbitrator: z.boolean(),
  bounty: uintString,
  reopenedBy: hex32.nullable(),
  reopens: hex32.nullable(),
  answerCount: z.number().int().nonnegative(),
})
export type OracleActionQuestion = z.infer<typeof oracleQuestionSchema>

const oracleStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_open'), opensAt: unix }),
  z.object({ state: z.literal('open_unanswered') }),
  z.object({ state: z.literal('answered'), outcome: oracleOutcome, bond: uintString, finalizesAt: unix }),
  z.object({ state: z.literal('pending_arbitration'), outcome: oracleOutcome.nullable(), requestedBy: address.nullable() }),
  z.object({ state: z.literal('finalized'), outcome: oracleOutcome, byArbitrator: z.boolean() }),
])

export const ORACLE_DUE_ACTIONS = [
  'answer',
  'fund_bounty',
  'request_arbitration_on_ethereum',
  'handle_notified_request',
  'handle_rejected_request',
  'report_arbitration_answer',
  'reopen_question',
  'resolve_market',
  'claim_winnings',
  'withdraw',
] as const
export type OracleDueActionName = (typeof ORACLE_DUE_ACTIONS)[number]

/** GET /api/v1/markets/:market/oracle?account=… (public). Facts come from the read model plus eth_call reads. */
export const oracleActionStatusSchema = z.object({
  market: address,
  questionId: hex32,
  currentQuestionId: hex32,
  reopened: z.boolean(),
  question: oracleQuestionSchema.nullable(),
  originalQuestion: oracleQuestionSchema.nullable(),
  status: oracleStatusSchema.nullable(),
  phase: z.enum(['evidence_open', 'reveal_open', 'oracle_open', 'pending_arbitration', 'finalized', 'resolved']),
  dueActions: z
    .array(
      z.object({
        action: z.enum(ORACLE_DUE_ACTIONS),
        questionId: hex32.nullable(),
        planRoute: z.string().max(100).nullable(),
        details: z.record(z.string(), z.unknown()),
      }),
    )
    .max(20),
  chainReads: z.object({ historyHash: hex32.nullable(), originalHistoryHash: hex32.nullable(), balance: uintString.nullable() }),
  computedAt: unix,
})
export type OracleActionStatus = z.infer<typeof oracleActionStatusSchema>
