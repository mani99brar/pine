import { z } from 'zod'
import type { Address, Hex } from '@pine/core'

// Wire schemas of the backend's public read routes (packages/api/src/modules/{claims,markets,funding}) and its GitHub
// browsing routes. Response objects strip unknown keys (the backend may add fields); every field the app reads is typed
// exactly as the backend sends it: big integers and wei amounts as base-10 strings, unix seconds as numbers, prices as
// decimal strings. Embedded user documents (claim documents, evidence manifests) are parsed separately with the frozen
// strict schemas of @pine/core/pine-shared, so one malformed document never takes a whole page down.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/

const address = z
  .string()
  .regex(ADDRESS)
  .transform((v) => v.toLowerCase() as Address)
const hex32 = z
  .string()
  .regex(HEX32)
  .transform((v) => v.toLowerCase() as Hex)
const uint = z.string().regex(/^(?:0|[1-9][0-9]{0,77})$/)
const unix = z.number().int().min(0).max(2 ** 40)
const iso = z.string().min(1).max(64)
const commit = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase())
/** Raw-codec CIDv1, base32 lowercase ("bafkrei…"). */
const cid = z.string().regex(/^b[a-z2-7]{10,120}$/)
/** formatWad output: a decimal with up to 18 fractional digits. */
const decimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,40})(?:\.[0-9]{1,18})?$/)
const policyId = z.string().regex(/^[A-Z]{2,8}-\d{3}$/)
const semver = z.string().regex(/^\d+\.\d+\.\d+$/)

export const claimPhaseSchema = z.enum(['evidence_open', 'reveal_open', 'oracle_open', 'pending_arbitration', 'finalized', 'resolved'])
export const oracleOutcomeSchema = z.enum(['yes', 'no', 'invalid', 'answered_too_soon'])

/** Derived Reality status (`deriveOracleStatus`), big integers as strings. */
export const oracleStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_open'), opensAt: unix }),
  z.object({ state: z.literal('open_unanswered') }),
  z.object({ state: z.literal('answered'), outcome: oracleOutcomeSchema, bond: uint, finalizesAt: unix }),
  z.object({ state: z.literal('pending_arbitration'), outcome: oracleOutcomeSchema.nullable(), requestedBy: address.nullable() }),
  z.object({ state: z.literal('finalized'), outcome: oracleOutcomeSchema, byArbitrator: z.boolean() }),
])

/** Moderation state. `action` stays a string: any value, known or not, withholds user text. */
const moderation = z.object({ action: z.string().min(1).max(32), reason: z.string().max(2_000), at: iso }).nullable()

const integrity = z.object({
  status: z.enum(['pending', 'verified', 'mismatch', 'document_unavailable']),
  mismatchFields: z.array(z.string().max(64)).max(64),
  final: z.boolean(),
})

/** `indexer` of claims-module responses (SEC-IDX-07). */
const indexer = z.object({
  indexedBlock: uint,
  indexedBlockTimestamp: unix,
  lagSeconds: z.number().min(0),
  halted: z.boolean(),
  stale: z.boolean(),
})

/** `freshness` of markets-module responses (SEC-IDX-07). */
const freshness = z.object({
  indexedBlock: uint,
  indexedBlockTimestamp: unix,
  finalizedBlock: uint.nullable(),
  headBlock: uint.nullable(),
  lagSeconds: z.number().min(0),
  halted: z.boolean(),
  stale: z.boolean(),
  status: z.enum(['ok', 'lagging', 'stalled']),
})

const deadline = z.object({ unix, iso, operator: z.string().max(200) })

/** PlatformFacts (claims/views.ts `platformFacts`): chain facts and digests, no user text. */
const platformFacts = z.object({
  market: address,
  registry: address,
  creator: address,
  repositoryId: z.number().int().positive(),
  commit,
  claimDocument: z.object({ sha256: hex32, cid, url: z.string().max(2_048).nullable() }),
  policyDocument: z.object({ sha256: hex32, cid }),
  deadlines: z.object({ evidence: deadline, reveal: deadline, answers: deadline }),
  minBondWei: uint,
  questionId: hex32,
  currentQuestionId: hex32,
  conditionId: hex32,
  outcomeTokens: z.object({ yes: address, no: address, invalid: address }),
  created: z.object({ at: unix, iso, block: uint, txHash: hex32, logIndex: z.number().int().min(0) }),
  phase: claimPhaseSchema,
  oracle: oracleStatusSchema.nullable(),
  resolution: z.object({ payoutNumerators: z.array(uint).min(1).max(256), resolvedAt: unix, txHash: hex32 }).nullable(),
})

/** One item of GET /api/v1/claims (listable, verified, unmoderated). `title` is on-chain printable ASCII. */
export const listedClaimSchema = platformFacts.extend({
  title: z.string().max(1_000),
  policyId: policyId.nullable(),
  integrity,
  listable: z.boolean(),
})

/** GET /api/v1/claims */
export const claimListSchema = z.object({
  items: z.array(listedClaimSchema).max(100),
  nextCursor: z.string().min(1).max(200).nullable(),
  indexer,
})

/** GET /api/v1/claims/:market → `claim`. A blocked claim or document has null title, marketName and document url. */
export const claimViewSchema = platformFacts.extend({
  title: z.string().max(1_000).nullable(),
  marketName: z.string().max(8_000).nullable(),
  policyId: policyId.nullable(),
  integrity,
  listable: z.boolean(),
  moderation,
  contentModeration: moderation,
  hidden: z.boolean(),
  listed: z.boolean(),
})

/** GET /api/v1/claims/:market */
export const claimDetailSchema = z.object({ claim: claimViewSchema, indexer })

/**
 * GET /api/v1/agents/claims/:market. Only the fields the app reads: the moderation flags of the platform part and the
 * user-supplied document (untrusted; null unless verified and unblocked). The document is checked separately with the
 * frozen claim document schema and against the on-chain digest.
 */
export const agentClaimSchema = z.object({
  item: z.object({
    platform: z.object({
      market: address,
      claimDocument: z.object({ sha256: hex32 }),
      moderation,
      contentModeration: moderation,
      hidden: z.boolean(),
    }),
    contentTrust: z.literal('untrusted'),
    userSupplied: z
      .object({
        title: z.string().max(1_000),
        marketName: z.string().max(8_000),
        document: z.unknown(),
      })
      .nullable(),
  }),
  indexer,
})

/** One submission of GET /api/v1/markets/:market/evidence (evidence-browse.ts `submissionView`). */
export const evidenceItemSchema = z.object({
  registry: address,
  submissionId: uint,
  market: address,
  submitter: address,
  status: z.enum(['committed', 'revealed', 'published']),
  commitment: hex32.nullable(),
  contentSha256: hex32.nullable(),
  contentCid: cid.nullable(),
  committedAt: unix,
  committedAtIso: iso,
  revealedAt: unix.nullable(),
  revealedAtIso: iso.nullable(),
  committedTxHash: hex32,
  committedBlock: uint,
  timeliness: z.object({
    recordedBeforeEvidenceDeadline: z.boolean(),
    disclosedBeforeRevealDeadline: z.boolean().nullable(),
    timely: z.boolean(),
  }),
  availability: z.object({ stored: z.boolean() }),
  moderation,
  /** Untrusted; parsed with the frozen evidence manifest schema and checked against `contentSha256`. */
  manifest: z.unknown(),
  manifestError: z.string().max(200).nullable(),
  attribution: z.object({ submitterMatches: z.boolean(), claimMatches: z.boolean() }).nullable(),
  contentTrust: z.literal('untrusted'),
})

/** GET /api/v1/markets/:market/evidence */
export const evidenceListSchema = z.object({
  market: address,
  evidenceDeadline: unix,
  revealDeadline: unix,
  items: z.array(evidenceItemSchema).max(500),
  nextCursor: z.string().min(1).max(512).nullable(),
  freshness,
  contentTrust: z.literal('untrusted'),
})

const oracleQuestionSchema = z.object({
  questionId: hex32,
  openingTs: unix,
  minBond: uint,
  timeout: z.number().int().min(0).max(2 ** 32),
  bestAnswer: hex32.nullable(),
  bond: uint,
  finalizeTs: unix,
  pendingArbitration: z.boolean(),
  arbitrationRequestedBy: address.nullable(),
  answeredByArbitrator: z.boolean(),
  bounty: uint,
  reopenedBy: hex32.nullable(),
  reopens: hex32.nullable(),
  answerCount: z.number().int().min(0),
})

export const klerosStageSchema = z.enum([
  'RequestNotified',
  'RequestRejected',
  'RequestAcknowledged',
  'RequestCanceled',
  'ArbitrationFailed',
  'ArbitratorAnswered',
  'ArbitrationFinished',
])

/** GET /api/v1/markets/:market/oracle (oracle.ts `oracleStatus`). The untrusted Kleros rejection reason is not read. */
export const oracleViewSchema = z.object({
  market: address,
  questionId: hex32,
  currentQuestionId: hex32,
  reopened: z.boolean(),
  question: oracleQuestionSchema.nullable(),
  originalQuestion: oracleQuestionSchema.nullable(),
  answers: z
    .array(
      z.object({
        answer: hex32,
        revealedAnswer: hex32.nullable(),
        historyHash: hex32,
        answerer: address,
        bond: uint,
        ts: unix,
        isCommitment: z.boolean(),
        txHash: hex32,
        blockNumber: uint,
      }),
    )
    .max(1_000),
  status: oracleStatusSchema.nullable(),
  arbitration: z
    .object({
      questionId: hex32,
      stage: klerosStageSchema,
      requester: address.nullable(),
      arbitratorAnswer: hex32.nullable(),
      updatedAt: unix,
      history: z.array(z.object({ stage: klerosStageSchema, at: unix, txHash: hex32 })).max(100),
    })
    .nullable(),
  resolution: z
    .object({ conditionId: hex32, payoutNumerators: z.array(uint).min(1).max(256), resolvedAt: unix, txHash: hex32 })
    .nullable(),
  phase: claimPhaseSchema,
  dueActions: z
    .array(
      z.object({
        action: z.string().min(1).max(64),
        questionId: hex32.nullable(),
        planRoute: z.string().max(200).nullable(),
        details: z.record(z.string(), z.unknown()),
      }),
    )
    .max(50),
  freshness,
  computedAt: unix,
})

const depthQuoteSchema = z.object({
  xdaiIn: uint,
  sdaiIn: uint,
  outcomeOut: uint.nullable(),
  averagePriceSdai: decimal.nullable(),
  priceImpactBps: z.number().int().nullable(),
  fee: z.number().int().min(0).nullable(),
  reason: z.string().max(500).nullable(),
})

/** GET /api/v1/markets/:market/liquidity (funding/liquidity.ts). Prices are marginal pool prices, not probabilities. */
export const liquidityViewSchema = z.object({
  market: address,
  block: uint,
  collateralToken: address,
  sdaiToXdai: decimal,
  priceLabel: z.string().max(500),
  outcomes: z
    .array(
      z.object({
        outcome: z.enum(['yes', 'no']),
        token: address,
        pool: address.nullable(),
        reason: z.string().max(500).nullable(),
        sqrtPriceX96: uint.nullable(),
        tick: z.number().int().nullable(),
        fee: z.number().int().min(0).nullable(),
        liquidity: uint.nullable(),
        priceSdai: decimal.nullable(),
        priceXdai: decimal.nullable(),
        depth: z.array(depthQuoteSchema).max(10),
      }),
    )
    .max(3),
  notes: z.array(z.string().max(1_000)).max(20),
})

/** GET /api/v1/funding/positions/:wallet?market= (funding/positions.ts). */
export const positionsViewSchema = z.object({
  wallet: address,
  market: address,
  block: uint,
  pools: z.object({ yes: address.nullable(), no: address.nullable() }),
  positionCount: uint,
  scanned: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }),
  truncated: z.boolean(),
  nextCursor: z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,2})$/)
    .nullable(),
  items: z
    .array(
      z.object({
        tokenId: uint,
        outcome: z.enum(['yes', 'no', 'invalid']),
        token0: address,
        token1: address,
        tickLower: z.number().int(),
        tickUpper: z.number().int(),
        liquidity: uint,
        tokensOwed0: uint,
        tokensOwed1: uint,
      }),
    )
    .max(200),
  balances: z.object({ yes: uint, no: uint, invalid: uint }),
  notes: z.array(z.string().max(1_000)).max(20),
})

/**
 * GET /api/v1/accounts/:wallet/activity (markets/accounts.ts). The claim titles in this route are not read: it drops
 * only "hide" moderation, so a blocked claim's title could appear there.
 */
export const activityViewSchema = z.object({
  wallet: address,
  claims: z
    .array(
      z.object({
        market: address,
        claimDocumentSha256: hex32,
        evidenceDeadline: unix,
        revealDeadline: unix,
        createdAt: unix,
        createdTxHash: hex32,
      }),
    )
    .max(100),
  evidence: z
    .array(
      z.object({
        registry: address,
        submissionId: uint,
        market: address,
        status: z.enum(['committed', 'revealed', 'published']),
        contentSha256: hex32.nullable(),
        committedAt: unix,
        revealedAt: unix.nullable(),
        committedTxHash: hex32,
      }),
    )
    .max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  freshness,
})

const policySummarySchema = z.object({
  id: policyId,
  version: semver,
  title: z.string().min(1).max(200),
  family: z.string().max(100),
  sha256: hex32,
  cid,
  status: z.enum(['draft', 'approved', 'disabled', 'retired']),
  publishable: z.boolean(),
})

/** GET /api/v1/policies */
export const policyListSchema = z.object({ policies: z.array(policySummarySchema).max(500) })

/** GET /api/v1/policies/:id/:version (the text is Markdown: plain text or the sanitized renderer only). */
export const policyDetailSchema = policySummarySchema.extend({
  bytes: z.number().int().positive().max(262_144),
  gate: z.string().max(1_000).nullable(),
  mediaType: z.string().max(100),
  text: z.string().max(262_144),
})

const jsonSchemaScalar = z.object({
  type: z.string().max(20).optional(),
  enum: z.array(z.string().max(200)).max(100).optional(),
  maxLength: z.number().int().min(0).optional(),
  minLength: z.number().int().min(0).optional(),
  description: z.string().max(2_000).optional(),
  title: z.string().max(200).optional(),
})

/** GET /api/v1/policies/:id/:version/parameters.schema.json (JSON Schema draft-7, input side). */
export const policyParametersSchema = z.object({
  type: z.literal('object'),
  properties: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
      jsonSchemaScalar.extend({ items: jsonSchemaScalar.optional(), maxItems: z.number().int().min(0).optional() }),
    )
    .optional(),
  required: z.array(z.string().max(64)).max(64).optional(),
  title: z.string().max(200).optional(),
})

const githubLogin = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)
const githubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((v) => v !== '.' && v !== '..')
const githubRef = z.string().min(1).max(255)
const sha40 = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase())

/** GitHubRepo (contracts/app.ts). Private repositories never pass (SEC-GH-13). */
export const githubRepoSchema = z.object({
  id: z.number().int().positive(),
  owner: githubLogin,
  ownerId: z.number().int().positive(),
  name: githubRepoName,
  fullName: z.string().max(201),
  private: z.literal(false),
  fork: z.boolean(),
  defaultBranch: githubRef,
  htmlUrl: z.string().max(2_048),
  pushedAt: z.string().max(40).nullable(),
})

/** GET /api/v1/github/repos */
export const githubRepoPageSchema = z.object({ items: z.array(githubRepoSchema).max(100), hasMore: z.boolean() })

/** GitHubPull (contracts/app.ts). */
export const githubPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1_024),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  headSha: sha40,
  headRef: githubRef,
  headRepoId: z.number().int().positive().nullable(),
  baseSha: sha40,
  baseRef: githubRef,
  htmlUrl: z.string().max(2_048),
  authorLogin: githubLogin.nullable(),
  updatedAt: z.string().max(40),
})

/** GET /api/v1/github/repos/:owner/:name/pulls */
export const githubPullPageSchema = z.object({ items: z.array(githubPullSchema).max(100), hasMore: z.boolean() })

/** GitHubCommit (contracts/app.ts). */
export const githubCommitSchema = z.object({
  sha: sha40,
  parents: z.array(sha40).max(100),
  message: z.string().max(65_536),
  authorLogin: githubLogin.nullable(),
  committedAt: z.string().max(40).nullable(),
  htmlUrl: z.string().max(2_048),
})

/** GET /api/v1/github/repos/:owner/:name/pulls/:number/commits */
export const githubCommitListSchema = z.object({ items: z.array(githubCommitSchema).max(250) })

/** GET /api/v1/github/repos/:owner/:name/commits/:sha (existence only, never membership: SEC-GH-11). */
export const githubCommitDetailSchema = z.object({ commit: githubCommitSchema, membershipVerified: z.boolean() })

export type WireListedClaim = z.output<typeof listedClaimSchema>
export type WireClaimView = z.output<typeof claimViewSchema>
export type WireClaimList = z.output<typeof claimListSchema>
export type WireClaimDetail = z.output<typeof claimDetailSchema>
export type WireAgentClaim = z.output<typeof agentClaimSchema>
export type WireEvidenceItem = z.output<typeof evidenceItemSchema>
export type WireEvidenceList = z.output<typeof evidenceListSchema>
export type WireOracleView = z.output<typeof oracleViewSchema>
export type WireOracleStatus = z.output<typeof oracleStatusSchema>
export type WireLiquidityView = z.output<typeof liquidityViewSchema>
export type WirePositionsView = z.output<typeof positionsViewSchema>
export type WireActivityView = z.output<typeof activityViewSchema>
export type WirePolicySummary = z.output<typeof policySummarySchema>
export type WirePolicyDetail = z.output<typeof policyDetailSchema>
export type WirePolicyParameters = z.output<typeof policyParametersSchema>
export type WireGitHubRepo = z.output<typeof githubRepoSchema>
export type WireGitHubPull = z.output<typeof githubPullSchema>
export type WireGitHubCommit = z.output<typeof githubCommitSchema>
export type ApiClaimPhase = z.output<typeof claimPhaseSchema>
export type ApiOracleOutcome = z.output<typeof oracleOutcomeSchema>
export type ApiKlerosStage = z.output<typeof klerosStageSchema>
