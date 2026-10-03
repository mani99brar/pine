/**
 * Backend payloads for the api read-side tests, shaped exactly as packages/api serializes them (claims/views.ts
 * platformFacts, agents.ts, markets/evidence-browse.ts, markets/oracle.ts, markets/accounts.ts, funding/liquidity.ts,
 * funding/positions.ts, claims/policies.ts, claims/github.ts). The claim document and evidence manifest are the e2e
 * journey's (test/e2e/support/scenario.ts), valid under the frozen schemas and hashed with the frozen encoders.
 */
import { vi } from 'vitest'
import {
  encodeClaimDocument,
  encodeEvidenceManifest,
  rawCidFromSha256,
  renderQuestion,
  type ClaimDocument,
  type EvidenceManifest,
} from '@pine/core/pine-shared'
import type { Address, Hex } from '@pine/core'

export const NOW_MS = Date.UTC(2026, 9, 4, 12, 0, 0)
export const NOW = NOW_MS / 1000
export const CREATED_AT = Date.UTC(2026, 9, 1, 0, 1, 0) / 1000
export const EVIDENCE_DEADLINE = CREATED_AT + 7 * 86_400
export const REVEAL_DEADLINE = EVIDENCE_DEADLINE + 48 * 3_600

export const MARKET = '0x5b3c0a1f2e9d8c7b6a5948372615049382716051' as Address
export const OTHER_MARKET = '0x6c4d1b2a3f0e9d8c7b6a5948372615049382716a' as Address
export const CLAIM_REGISTRY = '0x00000000000000000000000000000000000c1a10' as Address
export const EVIDENCE_REGISTRY = '0x00000000000000000000000000000000000e01de' as Address
export const CREATOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address
export const RESEARCHER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as Address
export const YES = '0x1111111111111111111111111111111111111a01' as Address
export const NO = '0x1111111111111111111111111111111111111a02' as Address
export const INVALID = '0x1111111111111111111111111111111111111a03' as Address
export const SDAI = '0xaf204776c7245bf4147c2612bf6e5972ee483701' as Address
export const YES_POOL = '0x2222222222222222222222222222222222222b01' as Address
export const QUESTION_ID = `0x${'3a'.repeat(32)}` as Hex
export const CONDITION_ID = `0x${'4b'.repeat(32)}` as Hex
export const CREATE_TX = `0x${'5c'.repeat(32)}` as Hex
export const TARGET_COMMIT = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12'
export const USER_CONTENT = 'https://usercontent.pine.test'
export const TITLE = 'Reporter deposits never use arbitration funds or the operator gas reserve'
export const XDAI = 10n ** 18n

export const BOT_SHA = '0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc' as Hex
export const FUNC_SHA = '0x95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7' as Hex
export const SC_SHA = '0xcc5859adc69b002d55db134193dd370bd0dff4c7445462a8772410ac3fea84d9' as Hex

export function isoSeconds(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export const claimDocument: ClaimDocument = {
  schema: 'urn:pine:claim:v1',
  nonce: `0x${'5a'.repeat(32)}`,
  policy: { id: 'BOT-001', version: '0.1.0', sha256: BOT_SHA },
  target: {
    host: 'github.com',
    repository: { id: 427_016_914, ownerLogin: 'kleros', name: 'kleros-v2' },
    commit: TARGET_COMMIT,
    baseCommit: null,
    membership: { method: 'pull_head', ref: { kind: 'pull', number: 2101 }, verifiedAt: '2026-10-01T00:00:00Z' },
  },
  claim: {
    title: TITLE,
    requirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
    violation: 'A reachable sequence in which a positive reporter deposit draws principal from an arbitration allocation.',
    scope: { components: ['bots/gateway-balancer/src/reporter'], outOfScope: ['LI.FI execution'] },
    allowedInputs: 'Configurations valid under config/example.json.',
    assumptions: ['Operator reserve may pay reporter transaction gas fees.'],
    faultModel: 'Process crash between any two persisted steps; RPC timeouts.',
    regressionOnly: false,
    exclusions: ['Gas fees paid from the operator reserve.'],
    policyParameters: { sourceRequirement: 'spec sections 2.2 and 4.2', startingStates: 'Reachable from an empty journal', simulatedAdapters: ['lifi'] },
  },
  environment: {
    runtime: 'Node 24.21.0 on Linux x64',
    dependencies: 'yarn.lock at the target commit',
    configuration: 'config/example.json at the target commit',
    externalState: 'Simulated chains; no live RPC',
    reproduction: { setup: 'yarn install --immutable\nyarn build', command: 'yarn test', notes: '' },
  },
  evidence: { chainId: 100, registry: EVIDENCE_REGISTRY, evidenceDeadline: EVIDENCE_DEADLINE, revealDeadline: REVEAL_DEADLINE, manifestSchema: 'urn:pine:evidence-manifest:v1' },
  market: {
    chainId: 100,
    claimRegistry: CLAIM_REGISTRY,
    seerMarketFactory: '0x83183da839ce8228e31ae41222ead9edbb5cdcf1',
    collateralToken: SDAI,
    realitio: '0xe78996a233895be74a66f451f1019ca9734205cc',
    arbitrator: '0x29f39de98d750eb77b5fafb31b2837f079fce222',
    questionTimeoutSeconds: 302_400,
    openingTime: REVEAL_DEADLINE,
    minBondWei: '10000000000000000000',
  },
  disclosure: { liveSystemImpact: 'none' },
  creator: CREATOR,
  createdAt: '2026-10-01T00:00:00Z',
}

export const DOC_SHA = encodeClaimDocument(claimDocument).sha256 as Hex
export const DOC_CID = rawCidFromSha256(DOC_SHA)
export const QUESTION_TEXT = renderQuestion({
  evidenceRegistry: EVIDENCE_REGISTRY,
  title: TITLE,
  evidenceDeadline: EVIDENCE_DEADLINE,
  revealDeadline: REVEAL_DEADLINE,
  repositoryId: 427_016_914,
  commit: TARGET_COMMIT,
  claimDocumentSha256: DOC_SHA,
  policyDocumentSha256: BOT_SHA,
})

const ARTIFACT_SHA = `0x${'6d'.repeat(32)}` as Hex

export const evidenceManifest: EvidenceManifest = {
  schema: 'urn:pine:evidence-manifest:v1',
  submitter: RESEARCHER,
  claim: { chainId: 100, market: MARKET, claimDocumentSha256: DOC_SHA, commit: TARGET_COMMIT },
  title: 'Arbitration allocation funds a reporter deposit',
  violatedRequirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
  summary: 'A crash between journal steps makes the reporter reuse the arbitration allocation.',
  expectedBehavior: 'Deposit principal comes from reporter funds.',
  actualBehavior: 'Deposit principal comes from the arbitration allocation.',
  reproduction: { environment: 'Node 24, simulated chains', setup: 'yarn install --immutable', command: 'yarn test reporter', initialState: '', notes: '' },
  artifacts: [{ name: 'steps.txt', sha256: ARTIFACT_SHA, size: 118, mediaType: 'text/plain', locators: ['http://169.254.169.254/latest/meta-data'], description: 'Steps' }],
}

export const MANIFEST_SHA = encodeEvidenceManifest(evidenceManifest).sha256 as Hex
export const MANIFEST_CID = rawCidFromSha256(MANIFEST_SHA)
export const ARTIFACT_CID = rawCidFromSha256(ARTIFACT_SHA)

const deadline = (unix: number, operator: string) => ({ unix, iso: isoSeconds(unix), operator })

/** claims/views.ts platformFacts */
export function platformFacts(over: Record<string, unknown> = {}) {
  return {
    market: MARKET,
    registry: CLAIM_REGISTRY,
    creator: CREATOR,
    repositoryId: 427_016_914,
    commit: TARGET_COMMIT,
    claimDocument: { sha256: DOC_SHA, cid: DOC_CID, url: `${USER_CONTENT}/c/${DOC_SHA}` },
    policyDocument: { sha256: BOT_SHA, cid: rawCidFromSha256(BOT_SHA) },
    deadlines: {
      evidence: deadline(EVIDENCE_DEADLINE, 'commit/publish while block.timestamp < evidenceDeadline'),
      reveal: deadline(REVEAL_DEADLINE, 'reveal while block.timestamp < revealDeadline'),
      answers: deadline(REVEAL_DEADLINE, 'answers accepted once block.timestamp >= revealDeadline'),
    },
    minBondWei: '10000000000000000000',
    questionId: QUESTION_ID,
    currentQuestionId: QUESTION_ID,
    conditionId: CONDITION_ID,
    outcomeTokens: { yes: YES, no: NO, invalid: INVALID },
    created: { at: CREATED_AT, iso: isoSeconds(CREATED_AT), block: '41200000', txHash: CREATE_TX, logIndex: 3 },
    phase: 'evidence_open',
    oracle: { state: 'not_open', opensAt: REVEAL_DEADLINE },
    resolution: null,
    ...over,
  }
}

const verified = { status: 'verified', mismatchFields: [], final: true }

export const indexer = { indexedBlock: '41210000', indexedBlockTimestamp: NOW - 12, lagSeconds: 12, halted: false, stale: false }

export const freshness = {
  indexedBlock: '41210000',
  indexedBlockTimestamp: NOW - 12,
  finalizedBlock: '41209936',
  headBlock: '41210000',
  lagSeconds: 12,
  halted: false,
  stale: false,
  status: 'ok',
}

/** One GET /api/v1/claims item. */
export function listedClaim(over: Record<string, unknown> = {}) {
  return { ...platformFacts(over), title: TITLE, policyId: 'BOT-001', integrity: verified, listable: true }
}

/** GET /api/v1/claims */
export function claimList(items: unknown[] = [listedClaim()], nextCursor: string | null = null) {
  return { items, nextCursor, indexer }
}

/** GET /api/v1/claims/:market */
export function claimDetail(over: Record<string, unknown> = {}) {
  const { claim: claimOver, ...facts } = over as { claim?: Record<string, unknown> }
  return {
    claim: {
      ...platformFacts(facts),
      title: TITLE,
      marketName: QUESTION_TEXT,
      policyId: 'BOT-001',
      integrity: verified,
      listable: true,
      moderation: null,
      contentModeration: null,
      hidden: false,
      listed: true,
      ...claimOver,
    },
    indexer,
  }
}

/** GET /api/v1/agents/claims/:market */
export function agentClaim(over: { platform?: Record<string, unknown>; userSupplied?: unknown } = {}) {
  return {
    item: {
      platform: {
        ...platformFacts(),
        policyId: 'BOT-001',
        integrity: verified,
        listable: true,
        moderation: null,
        contentModeration: null,
        hidden: false,
        evidenceSubmission: {
          chainId: 100,
          registry: EVIDENCE_REGISTRY,
          market: MARKET,
          functions: { commit: 'commitEvidence(market, commitment)', reveal: 'revealEvidence(submissionId, contentSha256, salt)', publish: 'publishEvidence(market, contentSha256)' },
          limits: { manifestMaxBytes: 262_144, artifactMaxBytes: 262_144, maxArtifacts: 16 },
        },
        warningCode: 'sandbox_only',
        warning: 'Reproduce only in an isolated sandbox without secrets, keys or network privileges.',
        ...over.platform,
      },
      contentTrust: 'untrusted',
      userSupplied: over.userSupplied === undefined ? { title: TITLE, marketName: QUESTION_TEXT, document: claimDocument } : over.userSupplied,
    },
    indexer,
  }
}

const operators = { recorded: 'committedAt < evidenceDeadline', disclosed: 'revealedAt < revealDeadline' }

/** One submission of GET /api/v1/markets/:market/evidence (a revealed, stored, attributed manifest by default). */
export function evidenceItem(over: Record<string, unknown> = {}) {
  const committedAt = CREATED_AT + 3_600
  return {
    registry: EVIDENCE_REGISTRY,
    submissionId: '1',
    market: MARKET,
    submitter: RESEARCHER,
    status: 'revealed',
    commitment: `0x${'7e'.repeat(32)}`,
    contentSha256: MANIFEST_SHA,
    contentCid: MANIFEST_CID,
    committedAt,
    committedAtIso: isoSeconds(committedAt),
    revealedAt: committedAt + 3_600,
    revealedAtIso: isoSeconds(committedAt + 3_600),
    committedTxHash: `0x${'8f'.repeat(32)}`,
    committedBlock: '41201000',
    timeliness: { recordedBeforeEvidenceDeadline: true, disclosedBeforeRevealDeadline: true, timely: true, operators },
    availability: { stored: true },
    moderation: null,
    manifest: evidenceManifest,
    manifestError: null,
    attribution: { submitterMatches: true, claimMatches: true },
    contentTrust: 'untrusted',
    ...over,
  }
}

/** A commitment that is not revealed yet. */
export function committedItem(over: Record<string, unknown> = {}) {
  return evidenceItem({
    submissionId: '2',
    status: 'committed',
    contentSha256: null,
    contentCid: null,
    revealedAt: null,
    revealedAtIso: null,
    committedTxHash: `0x${'9a'.repeat(32)}`,
    timeliness: { recordedBeforeEvidenceDeadline: true, disclosedBeforeRevealDeadline: null, timely: false, operators },
    availability: { stored: false },
    manifest: null,
    attribution: null,
    ...over,
  })
}

/** GET /api/v1/markets/:market/evidence */
export function evidenceList(items: unknown[] = [evidenceItem(), committedItem()], nextCursor: string | null = null) {
  return { market: MARKET, evidenceDeadline: EVIDENCE_DEADLINE, revealDeadline: REVEAL_DEADLINE, items, nextCursor, freshness, contentTrust: 'untrusted' }
}

const ANSWER_TS = REVEAL_DEADLINE + 600

/** Reality question record as the oracle route serializes it (bigints as strings). */
export function oracleQuestion(over: Record<string, unknown> = {}) {
  return {
    questionId: QUESTION_ID,
    markets: [MARKET],
    openingTs: REVEAL_DEADLINE,
    minBond: '10000000000000000000',
    timeout: 302_400,
    bestAnswer: `0x${'0'.repeat(64)}`,
    bond: '10000000000000000000',
    finalizeTs: ANSWER_TS + 302_400,
    pendingArbitration: false,
    arbitrationRequestedBy: null,
    answeredByArbitrator: false,
    bounty: '0',
    reopenedBy: null,
    reopens: null,
    answerCount: 1,
    lastEventBlock: '41300000',
    ...over,
  }
}

/** GET /api/v1/markets/:market/oracle: YES answered with a 10 xDAI bond, challenge window running. */
export function oracleView(over: Record<string, unknown> = {}) {
  return {
    market: MARKET,
    questionId: QUESTION_ID,
    currentQuestionId: QUESTION_ID,
    reopened: false,
    question: oracleQuestion(),
    originalQuestion: null,
    answers: [
      {
        answer: `0x${'0'.repeat(64)}`,
        revealedAnswer: `0x${'0'.repeat(64)}`,
        historyHash: `0x${'ab'.repeat(32)}`,
        answerer: RESEARCHER,
        bond: '10000000000000000000',
        ts: ANSWER_TS,
        isCommitment: false,
        txHash: `0x${'cd'.repeat(32)}`,
        blockNumber: '41300000',
      },
    ],
    status: { state: 'answered', outcome: 'yes', bond: '10000000000000000000', finalizesAt: ANSWER_TS + 302_400 },
    arbitration: null,
    resolution: null,
    phase: 'oracle_open',
    dueActions: [
      { action: 'answer', questionId: QUESTION_ID, planRoute: '/api/v1/oracle/plans/submit-answer', details: { minimumBond: '20000000000000000000', maxPrevious: '10000000000000000000', note: 'Bonds are paid in native xDAI by your own wallet; Pine never answers or bonds.' } },
      { action: 'request_arbitration_on_ethereum', questionId: QUESTION_ID, planRoute: null, details: { chainId: 1, maxPrevious: '10000000000000000000' } },
    ],
    chainReads: { historyHash: null, originalHistoryHash: null, balance: null },
    freshness,
    note: 'Pine runs no keeper and never answers or bonds; every action above is permissionless and must be sent by an interested party.',
    computedAt: NOW,
    ...over,
  }
}

/** GET /api/v1/markets/:market/liquidity: a priced YES pool, no NO pool. */
export function liquidityView(over: Record<string, unknown> = {}) {
  return {
    market: MARKET,
    block: '41210000',
    collateralToken: SDAI,
    sdaiToXdai: '1.25',
    priceLabel: 'Last pool price (marginal price). Not a probability that the code is correct.',
    outcomes: [
      {
        outcome: 'yes',
        token: YES,
        pool: YES_POOL,
        reason: null,
        sqrtPriceX96: '39614081257132168796771975168',
        tick: -13863,
        fee: 3000,
        liquidity: '1000000000000000000000',
        priceSdai: '0.25',
        priceXdai: '0.3125',
        depth: [
          { xdaiIn: '1000000000000000000', sdaiIn: '800000000000000000', outcomeOut: '3100000000000000000', averagePriceSdai: '0.258064516129032259', priceImpactBps: 322, fee: 3000, reason: null },
          { xdaiIn: '100000000000000000000', sdaiIn: '80000000000000000000', outcomeOut: '0', averagePriceSdai: null, priceImpactBps: null, fee: 3000, reason: 'no executable liquidity for this size' },
        ],
      },
      { outcome: 'no', token: NO, pool: null, reason: 'no pool exists for this outcome token and sDAI', sqrtPriceX96: null, tick: null, fee: null, liquidity: null, priceSdai: null, priceXdai: null, depth: [] },
    ],
    notes: ['Third-party liquidity in these pools can appear or be withdrawn at any time.'],
    ...over,
  }
}

/** GET /api/v1/funding/positions/:wallet?market= */
export function positionsView(over: Record<string, unknown> = {}) {
  return {
    wallet: CREATOR,
    market: MARKET,
    block: '41210000',
    pools: { yes: YES_POOL, no: null },
    positionCount: '1',
    scanned: { from: 0, to: 1 },
    truncated: false,
    nextCursor: null,
    items: [
      { tokenId: '4242', outcome: 'yes', token0: YES, token1: SDAI, tickLower: -16000, tickUpper: -6000, liquidity: '500000000000000000000', tokensOwed0: '0', tokensOwed1: '0' },
    ],
    balances: { yes: (4n * XDAI).toString(), no: '0', invalid: '0' },
    notes: ['At most the first 200 position NFTs of a wallet are scanned.'],
    ...over,
  }
}

/** GET /api/v1/accounts/:wallet/activity */
export function activityView(over: Record<string, unknown> = {}) {
  return {
    wallet: CREATOR,
    claims: [
      { market: MARKET, title: TITLE, claimDocumentSha256: DOC_SHA, evidenceDeadline: EVIDENCE_DEADLINE, revealDeadline: REVEAL_DEADLINE, createdAt: CREATED_AT, createdTxHash: CREATE_TX, contentTrust: 'untrusted' },
    ],
    evidence: [
      { registry: EVIDENCE_REGISTRY, submissionId: '7', market: OTHER_MARKET, status: 'committed', contentSha256: null, contentCid: null, committedAt: CREATED_AT + 7_200, revealedAt: null, committedTxHash: `0x${'e1'.repeat(32)}` },
    ],
    nextCursor: null,
    oracleAnswers: { available: false, reason: 'Oracle answers by wallet are not indexed by the read model yet.' },
    freshness,
    ...over,
  }
}

/** GET /api/v1/policies */
export const policyList = {
  policies: [
    { id: 'FUNC-001', version: '0.1.0', title: 'Functional Correctness', family: 'functional-correctness', sha256: FUNC_SHA, cid: rawCidFromSha256(FUNC_SHA), status: 'draft', publishable: true },
    { id: 'BOT-001', version: '0.1.0', title: 'Automation and Keeper Reliability', family: 'automation-reliability', sha256: BOT_SHA, cid: rawCidFromSha256(BOT_SHA), status: 'draft', publishable: true },
    { id: 'SC-001', version: '0.1.0', title: 'Smart-Contract Invariant and Security Verification', family: 'smart-contract-security', sha256: SC_SHA, cid: rawCidFromSha256(SC_SHA), status: 'disabled', publishable: false },
  ],
}

export const BOT_TEXT = [
  '# BOT-001 Automation and Keeper Reliability — policy version 0.1.0 (DRAFT)',
  '',
  'Status: draft for development and staging. Not approved market terms.',
  '',
  '## Intended use',
  'Verify one invariant of a keeper, treasury bot, scheduler or other stateful automation system at a pinned commit. Candidate invariant classes: separation of protected fund categories.',
  '',
  '## Evidence',
  'A reproducible sequence with initial state, allowed events and faults, the resulting plans and state transitions, and the violation.',
  '',
  '## Exclusions and boundaries',
  '- No claim requires or authorises live transfers, production keys or attacks on services.',
  '- Simulation evidence cannot establish that a real `bridge` integration works.',
  '',
  '## Common rules (apply to every claim under this policy)',
  '',
  '### C5. Correct answer',
  '- **Yes** (answer index 0): at least one timely, admissible submission demonstrates the named violation.',
  '- **No** (answer index 1): no timely, admissible submission demonstrates it.',
  '- **Invalid** (Reality.eth invalid answer): the question cannot be evaluated under C2.',
  '',
  '<img src=x onerror=alert(1)>',
].join('\n')

/** GET /api/v1/policies/:id/:version */
export function policyDetail(id = 'BOT-001', over: Record<string, unknown> = {}) {
  const summary = policyList.policies.find((p) => p.id === id) ?? policyList.policies[1]
  return { ...summary, bytes: BOT_TEXT.length, gate: id === 'SC-001' ? 'Requires a human-approved live-vulnerability disclosure process.' : null, mediaType: 'text/markdown; charset=utf-8', text: BOT_TEXT, ...over }
}

/** z.toJSONSchema output of the backend's BOT-001@0.1.0 parameter schema (io: input, draft-7). */
export const botParametersSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    sourceRequirement: { type: 'string', minLength: 1, maxLength: 1000 },
    startingStates: { type: 'string', minLength: 1, maxLength: 4000 },
    simulatedAdapters: { maxItems: 20, type: 'array', items: { type: 'string', minLength: 1, maxLength: 100 } },
  },
  required: ['sourceRequirement', 'startingStates', 'simulatedAdapters'],
  additionalProperties: false,
  $comment: 'Structural schema only. Text-safety rules (NFC, no control/bidi/zero-width characters), title rules and cross-field rules are enforced server-side only.',
  title: 'BOT-001@0.1.0 policy parameters',
}

/** Same for FUNC-001@0.1.0 (no required key). */
export const funcParametersSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: { formatDefinition: { type: 'string', minLength: 1, maxLength: 4000 } },
  additionalProperties: false,
  $comment: 'Structural schema only.',
  title: 'FUNC-001@0.1.0 policy parameters',
}

/** GET /api/v1/auth/session */
export function session(over: Record<string, unknown> = {}) {
  return {
    wallet: CREATOR,
    githubUserId: 9001,
    githubLogin: 'maintainer',
    isAdmin: false,
    termsDigest: `0x${'7e'.repeat(32)}`,
    termsAccepted: true,
    authenticatedAt: '2026-10-04T11:00:00.000Z',
    idleExpiresAt: '2026-10-05T11:00:00.000Z',
    absoluteExpiresAt: '2026-10-11T11:00:00.000Z',
    ...over,
  }
}

/** GitHubRepo (contracts/app.ts) as served by /api/v1/github/repos. */
export function githubRepo(over: Record<string, unknown> = {}) {
  return {
    id: 427_016_914,
    owner: 'kleros',
    ownerId: 1_001_001,
    name: 'kleros-v2',
    fullName: 'kleros/kleros-v2',
    private: false,
    fork: false,
    defaultBranch: 'main',
    htmlUrl: 'https://github.com/kleros/kleros-v2',
    pushedAt: '2026-10-03T08:00:00Z',
    ...over,
  }
}

export function githubPull(over: Record<string, unknown> = {}) {
  return {
    number: 2101,
    title: 'Reporter journal: persist deposit source',
    state: 'closed',
    merged: true,
    headSha: TARGET_COMMIT,
    headRef: 'feat/reporter-journal',
    headRepoId: 427_016_914,
    baseSha: '0123456789abcdef0123456789abcdef01234567',
    baseRef: 'main',
    htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101',
    authorLogin: 'tomas-reyes',
    updatedAt: '2026-10-02T09:30:00Z',
    ...over,
  }
}

export function githubCommit(over: Record<string, unknown> = {}) {
  return {
    sha: TARGET_COMMIT,
    parents: ['0123456789abcdef0123456789abcdef01234567'],
    message: 'reporter: persist the deposit source before sending',
    authorLogin: 'tomas-reyes',
    committedAt: '2026-10-02T09:00:00Z',
    htmlUrl: `https://github.com/kleros/kleros-v2/commit/${TARGET_COMMIT}`,
    ...over,
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

export function apiError(status: number, code: string, message = 'error'): Response {
  return json({ error: { code, message, requestId: '3f0c2b1a-0000-4000-8000-000000000000' } }, status)
}

export type Route = unknown | ((url: URL) => Response | Promise<Response>)

/**
 * A fake same-origin backend: routes keyed by `pathname?search` (exact) or `pathname`; anything else is the backend's
 * 404 envelope. Records every requested URL verbatim.
 */
export function fakeBackend(routes: Record<string, Route>) {
  const calls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(raw)
    const url = new URL(raw, 'https://app.pine.test')
    const route = routes[`${url.pathname}${url.search}`] ?? routes[url.pathname]
    if (route === undefined) return apiError(404, 'NOT_FOUND', 'Not found')
    if (typeof route === 'function') return (route as (u: URL) => Response | Promise<Response>)(url)
    if (route instanceof Response) return route.clone()
    return json(route)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

/** Routes for one fully populated claim at MARKET. */
export function claimRoutes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/api/v1/policies': policyList,
    [`/api/v1/claims/${MARKET}`]: claimDetail(),
    [`/api/v1/agents/claims/${MARKET}`]: agentClaim(),
    [`/api/v1/markets/${MARKET}/evidence`]: evidenceList(),
    [`/api/v1/markets/${MARKET}/oracle`]: oracleView(),
    [`/api/v1/markets/${MARKET}/liquidity`]: liquidityView(),
    ...over,
  }
}
