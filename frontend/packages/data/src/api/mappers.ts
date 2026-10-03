import { formatUnits, keccak256, parseUnits, stringToBytes } from 'viem'
import {
  getChainOrDefault,
  hashJson,
  realityQuestionUrl,
  seerMarketUrl,
  SEER_QUESTION_TIMEOUT_SECONDS,
  type ActivityItem,
  type Address,
  type ArbitrationState,
  type ClaimDetail,
  type ClaimManifest,
  type ClaimStatus,
  type ClaimSummary,
  type DepthSnapshot,
  type EnvironmentPin,
  type Evidence,
  type Hex,
  type LiquidityPosition,
  type MarketState,
  type OracleAnswerEntry,
  type OracleState,
  type Outcome,
  type OutcomePosition,
  type PolicyFamilyId,
  type Portfolio,
  type RealityAnswer,
  type TimelineEvent,
} from '@pine/core'
import {
  claimDocumentSchema,
  encodeClaimDocument,
  encodeEvidenceManifest,
  evidenceManifestSchema,
  rawCidFromSha256,
  validateTitle,
  type ClaimDocument,
  type EvidenceManifest,
} from '@pine/core/pine-shared'
import { policyFamilyOf } from './policies'
import type {
  ApiClaimPhase,
  ApiKlerosStage,
  WireActivityView,
  WireClaimList,
  WireClaimView,
  WireEvidenceItem,
  WireListedClaim,
  WireLiquidityView,
  WireOracleStatus,
  WireOracleView,
  WirePolicySummary,
  WirePositionsView,
} from './read-schemas'

// Backend views (packages/api) → the frontend domain types (@pine/core types.ts). Only backend facts are used; what the
// backend cannot provide stays at a neutral value and is listed in `API_READ_GAPS`. Claims are identified by their Seer
// market address (lowercase): `id` is the market and `number` is 0 (the backend has no claim numbers).

/** The only chain the backend serves. */
export const API_CHAIN_ID = 100

/** Title shown instead of user text when moderation hides or blocks a claim (SEC-EVID-11, SEC-AGENT-03). */
export const HIDDEN_CLAIM_TITLE = 'Hidden claim'
export const UNTITLED_CLAIM_TITLE = 'Untitled claim'

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex
const REALITY_TOO_SOON = `0x${'f'.repeat(63)}e`
const CHAIN = getChainOrDefault(API_CHAIN_ID)
const COLLATERAL_SYMBOL = CHAIN.collateral.symbol
const WAD = 10n ** 18n

/** Domain fields the backend cannot provide in api mode, and the neutral value each one gets. */
export const API_READ_GAPS = {
  number: 'always 0: the backend has no claim numbers; display the short market address instead',
  prices: 'yesPrice only on claim details (marginal pool price from /liquidity); undefined in lists; no price history (getPriceHistory → [])',
  volumes: 'liquidity, volume, volume24h, volumeTotal, openInterest are "0" and traders 0 (not indexed)',
  pools: 'MarketState.pools is empty (no TVL); pool addresses, prices and depth quotes are in `api.liquidity`',
  evidenceCount: 'list items report 0 (exact on claim details)',
  source:
    'repoId is the on-chain repository id; owner/repo/prNumber come from the verified claim document ("" when it is unavailable or the claim is moderated). No backend route resolves repository ids (SEC-GH-12), so owner/repo are only as stated by the document (unverifiedName: true) and the GitHub links built from them are best effort',
  repositoryFilter:
    'ClaimQuery.repositoryId, or the id GitHub gives for ClaimQuery.repo through the backend GitHub route (browser only: signed in with a linked GitHub account); never names stated in claim documents',
  policy:
    'labelled only from the catalog entry of the on-chain policy digest, or the indexed id of an integrity-verified claim; otherwise { id: "UNKNOWN", title: "Unknown policy", unknown: true, family "FUNC" as a placeholder }: show policy.hash / policy.uri, never /policies/<id>',
  arbitrationCost: 'ArbitrationState.cost is "" (the backend does not report the Kleros fee)',
  activity: 'only per account; claim titles are placeholders (that route does not apply "block" moderation); no oracle answers',
  portfolio: 'markets the wallet created claims on or submitted evidence to (use getMarketPortfolio for any other market); LP value, deposits and fees are "0"',
  stats: 'counts from the newest evidence_open and closed listing pages (lower bounds); liquidity and volume "0"',
} as const

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function isoFromUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Exact decimal string of a wei amount (18 decimals). */
export function weiToDecimal(wei: string | bigint): string {
  return formatUnits(typeof wei === 'bigint' ? wei : BigInt(wei), 18)
}

/** A market price for display: finite and within [0, 1], else undefined. */
export function priceNumber(decimal: string | null | undefined): number | undefined {
  if (!decimal || decimal.startsWith('-')) return undefined
  const n = Number(decimal)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

/** "Claim 0x1234…abcd": a placeholder that carries no user text. */
export function claimPlaceholderTitle(market: string): string {
  return `Claim ${market.slice(0, 6)}…${market.slice(-4)}`
}

/** On-chain titles are printable ASCII validated by the registry; anything else is not shown. */
function safeTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined) return null
  try {
    validateTitle(title)
    return title
  } catch {
    return null
  }
}

function answerFromOutcome(outcome: string | null | undefined): RealityAnswer | undefined {
  if (outcome === 'yes' || outcome === 'no' || outcome === 'invalid') return outcome
  if (outcome === 'answered_too_soon') return 'too_soon'
  return undefined
}

/** Reality bytes32 answer of a Seer categorical (Yes/No) question: 0 = Yes, 1 = No, "too soon", anything else Invalid. */
export function answerFromBytes32(answer: string): RealityAnswer {
  const lower = answer.toLowerCase()
  if (lower === REALITY_TOO_SOON) return 'too_soon'
  const value = BigInt(lower)
  if (value === 0n) return 'yes'
  if (value === 1n) return 'no'
  return 'invalid'
}

/** The single winning outcome of a resolved condition ([1,0,0] → yes); undefined for split or empty payouts. */
export function outcomeFromPayouts(payoutNumerators: readonly string[] | undefined): Outcome | undefined {
  if (!payoutNumerators) return undefined
  const nonzero = payoutNumerators.map((n, i) => ({ i, v: BigInt(n) })).filter((x) => x.v > 0n)
  if (nonzero.length !== 1) return undefined
  const index = nonzero[0]?.i
  return index === 0 ? 'yes' : index === 1 ? 'no' : index === 2 ? 'invalid' : undefined
}

function finalOutcome(oracle: WireOracleStatus | null | undefined): Outcome | undefined {
  if (oracle?.state !== 'finalized' || oracle.outcome === 'answered_too_soon') return undefined
  return oracle.outcome
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Frontend lifecycle status of a claim from the backend's `phase`, derived oracle status and condition resolution:
 *
 * | phase | oracle | status |
 * |---|---|---|
 * | evidence_open | any | open |
 * | reveal_open | any | awaiting_answer (evidence closed on chain; reveals run until Reality opens at the reveal deadline) |
 * | oracle_open | null, not_open, open_unanswered | awaiting_answer |
 * | oracle_open | answered | answer_proposed |
 * | oracle_open, pending_arbitration | pending_arbitration | arbitration |
 * | finalized | finalized yes/no/invalid | resolved + outcome |
 * | finalized | finalized answered_too_soon | awaiting_answer (the question must be reopened; no outcome yet) |
 * | resolved | any | resolved + outcome of the payouts (else of the oracle); no outcome for a split payout |
 */
export function claimStatusOf(input: {
  phase: ApiClaimPhase
  oracle: WireOracleStatus | null
  resolution: { payoutNumerators: readonly string[] } | null
}): { status: ClaimStatus; outcome?: Outcome } {
  const { phase, oracle, resolution } = input
  switch (phase) {
    case 'evidence_open':
      return { status: 'open' }
    case 'reveal_open':
      return { status: 'awaiting_answer' }
    case 'pending_arbitration':
      return { status: 'arbitration' }
    case 'resolved': {
      const outcome = outcomeFromPayouts(resolution?.payoutNumerators) ?? finalOutcome(oracle)
      return outcome ? { status: 'resolved', outcome } : { status: 'resolved' }
    }
    case 'finalized': {
      const outcome = finalOutcome(oracle)
      return outcome ? { status: 'resolved', outcome } : { status: 'awaiting_answer' }
    }
    case 'oracle_open':
    default:
      switch (oracle?.state) {
        case 'answered':
          return { status: 'answer_proposed' }
        case 'pending_arbitration':
          return { status: 'arbitration' }
        case 'finalized': {
          const outcome = finalOutcome(oracle)
          return outcome ? { status: 'resolved', outcome } : { status: 'awaiting_answer' }
        }
        default:
          return { status: 'awaiting_answer' }
      }
  }
}

// ---------------------------------------------------------------------------
// Claim documents
// ---------------------------------------------------------------------------

/**
 * The claim document when it parses with the frozen urn:pine:claim:v1 schema AND its canonical bytes hash to the
 * on-chain digest; null otherwise (SEC-CLAIM-02, SEC-EVID-14: never show terms that are not the published ones).
 */
export function verifiedClaimDocument(raw: unknown, expectedSha256: string): ClaimDocument | null {
  if (raw === null || raw === undefined) return null
  const parsed = claimDocumentSchema.safeParse(raw)
  if (!parsed.success) return null
  try {
    return encodeClaimDocument(parsed.data).sha256 === expectedSha256.toLowerCase() ? parsed.data : null
  } catch {
    return null
  }
}

/** The evidence manifest when it parses with the frozen schema and hashes to the on-chain content digest. */
export function verifiedEvidenceManifest(raw: unknown, expectedSha256: string): EvidenceManifest | null {
  if (raw === null || raw === undefined) return null
  const parsed = evidenceManifestSchema.safeParse(raw)
  if (!parsed.success) return null
  try {
    return encodeEvidenceManifest(parsed.data).sha256 === expectedSha256.toLowerCase() ? parsed.data : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Label of a policy that cannot be named (see policyRefOf); never a catalog id, so /policies/UNKNOWN finds nothing. */
export const UNKNOWN_POLICY_ID = 'UNKNOWN'
export const UNKNOWN_POLICY_TITLE = 'Unknown policy'

export interface ApiPolicyRef {
  id: string
  version: string
  family: PolicyFamilyId
  title: string
  /** The policy cannot be named: id UNKNOWN_POLICY_ID, `family` a placeholder ('FUNC'). Show `hash`/`uri` instead. */
  unknown?: boolean
  /** SHA-256 of the policy document the claim pins on chain. */
  hash: Hex
  /** Content address of that document (ipfs://<raw CID>). */
  uri: string
}

/**
 * The claim's policy label. A claim pins its policy on chain by digest only, so it is labelled only with an id known to
 * belong to that digest (SEC-AGENT-03: an integrity-failed claim never borrows a catalog label):
 * - a catalog entry with that digest (the catalog is authoritative for id, version and title);
 * - else, for an integrity-verified claim (the backend checked that the digest is a catalog file whose entry carries the
 *   document's id and version) whose catalog entry could not be read: the indexed id and the verified document's version;
 * - else the explicit unknown policy, never the id an unverified document states (or the backend copied from it).
 */
export function policyRefOf(
  policyDocument: { sha256: string; cid: string },
  policyId: string | null,
  catalog: readonly WirePolicySummary[],
  claim: { verified: boolean; document: ClaimDocument | null },
): ApiPolicyRef {
  const pinned = { hash: policyDocument.sha256.toLowerCase() as Hex, uri: `ipfs://${policyDocument.cid}` }
  const named = catalog.filter((p) => p.sha256 === pinned.hash && policyFamilyOf(p.id) !== null)
  const entry = named.find((p) => p.id === policyId) ?? named[0]
  const entryFamily = entry ? policyFamilyOf(entry.id) : null
  if (entry && entryFamily) return { id: entry.id, version: entry.version, family: entryFamily, title: entry.title, ...pinned }
  const indexedFamily = claim.verified && policyId !== null ? policyFamilyOf(policyId) : null
  if (policyId !== null && indexedFamily) {
    const version = claim.document?.policy.id === policyId ? claim.document.policy.version : ''
    return { id: policyId, version, family: indexedFamily, title: '', ...pinned }
  }
  return { id: UNKNOWN_POLICY_ID, version: '', family: 'FUNC', title: UNKNOWN_POLICY_TITLE, unknown: true, ...pinned }
}

export interface ApiIndexerFacts {
  indexedBlock: string
  lagSeconds: number
  halted: boolean
  stale: boolean
}

/** Backend facts carried next to the domain fields in api mode, as `claim.api`. */
export interface ApiClaimFacts {
  phase: ApiClaimPhase
  registry: Address
  creator: Address
  questionId: Hex
  /** The live Reality question (follows reopened replacements). */
  currentQuestionId: Hex
  conditionId: Hex
  /** Outcome tokens in outcome-index order, for plan verification contexts. */
  outcomeTokens: { yes: Address; no: Address; invalid: Address }
  repositoryId: number
  commit: string
  /** `url` is the user-content download link exactly as the backend gives it (null when blocked). */
  claimDocument: { sha256: Hex; cid: string; url: string | null }
  policyDocument: { sha256: Hex; cid: string }
  /** Unix seconds: commit/publish while block.timestamp < evidenceDeadline; reveal while < revealDeadline. */
  evidenceDeadline: number
  revealDeadline: number
  minBondWei: string
  integrity: { status: 'pending' | 'verified' | 'mismatch' | 'document_unavailable'; mismatchFields: string[]; final: boolean }
  /** Moderated (hidden or blocked): every user-supplied text is withheld. */
  hidden: boolean
  /** In public lists (listable and not hidden). */
  listed: boolean
  /** The claim document passed the frozen schema and matched its on-chain digest (and is shown). */
  documentVerified: boolean
  indexer: ApiIndexerFacts
}

export interface ApiClaimSummary extends ClaimSummary {
  api: ApiClaimFacts
}

type PlatformView = WireListedClaim | WireClaimView

export interface ApiClaimInput {
  view: PlatformView
  /** A verified document (see verifiedClaimDocument); ignored when `hidden`. */
  document: ClaimDocument | null
  hidden: boolean
  listed: boolean
  policy: ApiPolicyRef
  indexer: WireClaimList['indexer']
}

/** The user-content link only when it is an http(s) URL to /c/<this digest>; anything else is dropped. */
function documentUrl(url: string | null, sha256: string): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null
    return u.pathname === `/c/${sha256}` && u.search === '' && u.hash === '' ? url : null
  } catch {
    return null
  }
}

function claimFacts(input: ApiClaimInput, documentVerified: boolean): ApiClaimFacts {
  const v = input.view
  return {
    phase: v.phase,
    registry: v.registry,
    creator: v.creator,
    questionId: v.questionId,
    currentQuestionId: v.currentQuestionId,
    conditionId: v.conditionId,
    outcomeTokens: { ...v.outcomeTokens },
    repositoryId: v.repositoryId,
    commit: v.commit,
    claimDocument: {
      sha256: v.claimDocument.sha256,
      cid: v.claimDocument.cid,
      url: input.hidden ? null : documentUrl(v.claimDocument.url, v.claimDocument.sha256),
    },
    policyDocument: { ...v.policyDocument },
    evidenceDeadline: v.deadlines.evidence.unix,
    revealDeadline: v.deadlines.reveal.unix,
    minBondWei: v.minBondWei,
    integrity: { status: v.integrity.status, mismatchFields: [...v.integrity.mismatchFields], final: v.integrity.final },
    hidden: input.hidden,
    listed: input.listed,
    documentVerified,
    indexer: { indexedBlock: input.indexer.indexedBlock, lagSeconds: input.indexer.lagSeconds, halted: input.indexer.halted, stale: input.indexer.stale },
  }
}

/** A listed or detailed claim as a ClaimSummary (plus `api` facts). Moderated claims carry no user text. */
export function claimSummaryFromApi(input: ApiClaimInput): ApiClaimSummary {
  const v = input.view
  const doc = input.hidden ? null : input.document
  const { status, outcome } = claimStatusOf(v)
  const ref = doc?.target.membership.ref
  const title = input.hidden ? HIDDEN_CLAIM_TITLE : (safeTitle(v.title) ?? safeTitle(doc?.claim.title) ?? UNTITLED_CLAIM_TITLE)
  const stated = doc?.target.repository
  return {
    id: v.market,
    number: 0,
    title,
    violation: doc?.claim.violation ?? '',
    policy: { ...input.policy },
    source: {
      owner: stated?.ownerLogin ?? '',
      repo: stated?.name ?? '',
      commitSha: v.commit,
      repoId: v.repositoryId,
      // Display snapshots of the document: the backend ties only the numeric id to the chain (SEC-GH-12, SEC-EVID-15).
      ...(stated ? { unverifiedName: true } : {}),
      ...(ref?.kind === 'pull' ? { prNumber: ref.number } : {}),
    },
    status,
    ...(outcome ? { outcome } : {}),
    createdAt: v.created.iso,
    evidenceDeadline: v.deadlines.evidence.iso,
    chainId: API_CHAIN_ID,
    marketAddress: v.market,
    creator: v.creator,
    liquidity: '0',
    volume: '0',
    collateralSymbol: COLLATERAL_SYMBOL,
    evidenceCount: 0,
    traders: 0,
    sponsored: false,
    tags: input.policy.unknown ? [] : [input.policy.family.toLowerCase()],
    api: claimFacts(input, doc !== null),
  }
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * What the app may show of a submission's manifest:
 * shown (verified against the on-chain digest) | sealed (committed, not revealed yet) | withheld (moderation) |
 * unavailable (Pine does not store it) | unreadable (not a canonical manifest for that digest).
 */
export type ApiManifestState = 'shown' | 'sealed' | 'withheld' | 'unavailable' | 'unreadable'

export interface ApiEvidenceFacts {
  registry: Address
  submissionId: string
  status: 'committed' | 'revealed' | 'published'
  manifest: ApiManifestState
  /** Backend timeliness under the frozen operators (committedAt < evidenceDeadline; revealedAt < revealDeadline). */
  timeliness: { recordedBeforeEvidenceDeadline: boolean; disclosedBeforeRevealDeadline: boolean | null; timely: boolean }
  /** Whether the manifest names this submitter and claim (null when no manifest was read). */
  attribution: { submitterMatches: boolean; claimMatches: boolean } | null
  moderated: boolean
  stored: boolean
  revealedAt: string | null
}

export interface ApiEvidence extends Evidence {
  api: ApiEvidenceFacts
}

const EVIDENCE_COPY: Record<Exclude<ApiManifestState, 'shown'>, { title: string; summary: string }> = {
  sealed: {
    title: 'Sealed evidence commitment',
    summary: 'Only the commitment hash is on chain. The content stays sealed until the submitter reveals it before the reveal deadline.',
  },
  withheld: {
    title: 'Evidence withheld by moderation',
    summary: 'Pine withholds the content of this submission after a moderation decision. Its hash and transaction stay on chain.',
  },
  unavailable: {
    title: 'Evidence manifest not stored by Pine',
    summary: 'Pine does not hold a manifest with this digest. Locate it by its content hash and treat it as untrusted.',
  },
  unreadable: {
    title: 'Unreadable evidence manifest',
    summary: 'The stored content is not a canonical evidence manifest for the digest recorded on chain.',
  },
}

/**
 * One submission as Evidence. Text comes only from a manifest that matches its on-chain digest, and never when the
 * submission or its claim is moderated (the hash, submitter and transaction stay visible as a tombstone, SEC-EVID-11).
 * Links are content addresses (ipfs://<raw CID>) derived from digests; manifest `locators` are never used (SEC-EVID-09).
 */
export function evidenceFromApi(item: WireEvidenceItem, opts: { claimHidden: boolean }): ApiEvidence {
  const moderated = opts.claimHidden || item.moderation !== null || item.manifestError === 'blocked by moderation'
  let manifest: EvidenceManifest | null = null
  let state: ApiManifestState
  if (item.contentSha256 === null) state = 'sealed'
  else if (moderated) state = 'withheld'
  else {
    manifest = verifiedEvidenceManifest(item.manifest, item.contentSha256)
    state = manifest ? 'shown' : item.manifestError === 'not stored by Pine' ? 'unavailable' : 'unreadable'
  }
  const copy = state === 'shown' ? null : EVIDENCE_COPY[state]
  const setup = manifest?.reproduction.setup
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100)
  return {
    id: `${item.registry}:${item.submissionId}`,
    claimId: item.market,
    kind: item.status === 'committed' ? 'commitment' : manifest ? 'counterexample' : 'clarification',
    title: manifest?.title ?? copy?.title ?? '',
    summary: manifest?.summary ?? copy?.summary ?? '',
    submitter: item.submitter,
    submittedAt: item.committedAtIso,
    blockNumber: Number(item.committedBlock),
    txHash: item.committedTxHash,
    chainId: API_CHAIN_ID,
    uri: item.contentCid ? `ipfs://${item.contentCid}` : '',
    contentHash: item.contentSha256 ?? ZERO_HASH,
    timely: item.timeliness.timely,
    ...(manifest
      ? {
          reproduction: {
            command: manifest.reproduction.command,
            environment: manifest.reproduction.environment,
            expected: manifest.expectedBehavior,
            actual: manifest.actualBehavior,
            ...(setup && setup.length > 0 ? { steps: setup } : {}),
          },
        }
      : {}),
    attachments: manifest
      ? manifest.artifacts.map((a) => ({ name: a.name, uri: `ipfs://${rawCidFromSha256(a.sha256)}`, mime: a.mediaType, size: a.size, hash: a.sha256 }))
      : [],
    ...(item.commitment
      ? { commitment: { hash: item.commitment, revealed: item.status === 'revealed', ...(item.revealedAtIso ? { revealedAt: item.revealedAtIso } : {}) } }
      : {}),
    api: {
      registry: item.registry,
      submissionId: item.submissionId,
      status: item.status,
      manifest: state,
      timeliness: { ...item.timeliness },
      attribution: item.attribution ? { ...item.attribution } : null,
      moderated,
      stored: item.availability.stored,
      revealedAt: item.revealedAtIso,
    },
  }
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface ApiDueAction {
  action: string
  questionId: Hex | null
  /** Pine plan route for the action, or null when only instructions exist (Ethereum mainnet steps). */
  planRoute: string | null
  details: Record<string, unknown>
}

export interface ApiOracleFacts {
  reopened: boolean
  status: WireOracleStatus | null
  arbitrationStage: ApiKlerosStage | null
  dueActions: ApiDueAction[]
  freshness: { stale: boolean; halted: boolean; lagSeconds: number; status: 'ok' | 'lagging' | 'stalled' } | null
}

function arbitrationFromApi(view: WireOracleView | null, status: WireOracleStatus | null): ArbitrationState {
  const a = view?.arbitration ?? null
  const requestedAt = a?.history.find((h) => h.stage === 'RequestNotified')?.at
  const requester = a?.requester ?? (status?.state === 'pending_arbitration' ? status.requestedBy : null)
  const common = {
    ...(requestedAt !== undefined ? { requestedAt: isoFromUnix(requestedAt) } : {}),
    ...(requester ? { requester } : {}),
    // The Kleros fee is paid on Ethereum mainnet and is not reported by the backend.
    cost: '',
  }
  if (a && (a.stage === 'ArbitratorAnswered' || a.stage === 'ArbitrationFinished')) {
    return { requested: true, status: 'ruled', ...common, ...(a.arbitratorAnswer ? { ruling: answerFromBytes32(a.arbitratorAnswer) } : {}) }
  }
  if (status?.state === 'pending_arbitration' || a?.stage === 'RequestNotified' || a?.stage === 'RequestAcknowledged') {
    return { requested: true, status: 'pending', ...common }
  }
  return { requested: false, status: 'not_requested', cost: '' }
}

/**
 * OracleState from the oracle route when it answered, else from the claim's own oracle summary (the claim page keeps
 * working when the oracle route is rate limited or not ready). Bonds are converted from wei to decimal xDAI.
 */
export function oracleFromApi(
  view: PlatformView,
  oracleView: WireOracleView | null,
  timeoutFromDocument?: number,
): { oracle: OracleState; facts: ApiOracleFacts } {
  const question = oracleView?.question ?? null
  const status = oracleView ? oracleView.status : view.oracle
  const questionId = oracleView?.currentQuestionId ?? view.currentQuestionId
  const current = status && status.state !== 'not_open' && status.state !== 'open_unanswered' ? answerFromOutcome(status.outcome) : undefined
  const bondWei = status?.state === 'answered' ? status.bond : question && question.answerCount > 0 ? question.bond : null
  const history: OracleAnswerEntry[] = []
  for (const a of oracleView?.answers ?? []) {
    // An unrevealed answer commitment has no answer yet.
    if (a.isCommitment && a.revealedAnswer === null) continue
    history.push({ answer: answerFromBytes32(a.revealedAnswer ?? a.answer), bond: weiToDecimal(a.bond), answerer: a.answerer, at: isoFromUnix(a.ts), txHash: a.txHash })
  }
  const finalized = status?.state === 'finalized'
  const oracle: OracleState = {
    chainId: API_CHAIN_ID,
    realityQuestionId: questionId,
    realityUrl: realityQuestionUrl(API_CHAIN_ID, questionId),
    templateId: CHAIN.realityTemplateId,
    openingTime: isoFromUnix(question?.openingTs ?? view.deadlines.answers.unix),
    timeoutSeconds: question?.timeout ?? timeoutFromDocument ?? SEER_QUESTION_TIMEOUT_SECONDS,
    minBond: weiToDecimal(question?.minBond ?? view.minBondWei),
    bondToken: CHAIN.nativeSymbol,
    ...(current ? { currentAnswer: current } : {}),
    ...(bondWei !== null ? { currentBond: weiToDecimal(bondWei) } : {}),
    ...(status?.state === 'answered' ? { finalizesAt: isoFromUnix(status.finalizesAt) } : {}),
    isFinalized: finalized,
    ...(finalized && current ? { finalAnswer: current } : {}),
    history,
    arbitration: arbitrationFromApi(oracleView, status),
  }
  const f = oracleView?.freshness
  return {
    oracle,
    facts: {
      reopened: oracleView?.reopened ?? questionId !== view.questionId,
      status,
      arbitrationStage: oracleView?.arbitration?.stage ?? null,
      dueActions: (oracleView?.dueActions ?? []).map((d) => ({ action: d.action, questionId: d.questionId, planRoute: d.planRoute, details: { ...d.details } })),
      freshness: f ? { stale: f.stale, halted: f.halted, lagSeconds: f.lagSeconds, status: f.status } : null,
    },
  }
}

// ---------------------------------------------------------------------------
// Market, prices, depth
// ---------------------------------------------------------------------------

function outcomePrice(liquidity: WireLiquidityView | null, outcome: 'yes' | 'no'): number | undefined {
  return priceNumber(liquidity?.outcomes.find((o) => o.outcome === outcome)?.priceSdai)
}

/** MarketState from the claim's market facts; prices are the marginal pool prices in sDAI (0 when no pool). */
export function marketFromApi(view: PlatformView, liquidity: WireLiquidityView | null): MarketState {
  return {
    chainId: API_CHAIN_ID,
    address: view.market,
    seerUrl: seerMarketUrl(API_CHAIN_ID, view.market),
    conditionId: view.conditionId,
    questionId: view.questionId,
    collateral: {
      address: liquidity?.collateralToken ?? (CHAIN.collateral.address.toLowerCase() as Address),
      symbol: CHAIN.collateral.symbol,
      decimals: CHAIN.collateral.decimals,
      ...(CHAIN.collateral.name ? { name: CHAIN.collateral.name } : {}),
    },
    outcomes: [
      { index: 0, label: 'Yes', token: view.outcomeTokens.yes, price: outcomePrice(liquidity, 'yes') ?? 0 },
      { index: 1, label: 'No', token: view.outcomeTokens.no, price: outcomePrice(liquidity, 'no') ?? 0 },
      { index: 2, label: 'Invalid result', token: view.outcomeTokens.invalid, price: 0 },
    ],
    pools: [],
    liquidity: '0',
    volume24h: '0',
    volumeTotal: '0',
    traders: 0,
    openInterest: '0',
    createdAt: view.created.iso,
    createdTx: view.created.txHash,
  }
}

/** Executable depth from the backend's quoter probes (1, 10, 100 xDAI buys): ask levels only. */
export function depthFromApi(liquidity: WireLiquidityView, outcome: 'yes' | 'no', nowSec: number): DepthSnapshot | null {
  const o = liquidity.outcomes.find((x) => x.outcome === outcome)
  const mid = priceNumber(o?.priceSdai)
  if (!o || mid === undefined) return null
  const levels = o.depth.flatMap((q) => {
    const price = priceNumber(q.averagePriceSdai)
    if (price === undefined || q.outcomeOut === null || q.outcomeOut === '0') return []
    return [{ price, size: Number(formatUnits(BigInt(q.outcomeOut), 18)), side: 'ask' as const }]
  })
  return { outcome, mid, levels, at: isoFromUnix(nowSec) }
}

// ---------------------------------------------------------------------------
// Claim detail
// ---------------------------------------------------------------------------

export interface ApiClaimDetailFacts extends ApiClaimFacts {
  oracle: ApiOracleFacts
  /** The liquidity route's view (pools, marginal prices, depth quotes), null when it could not be read. */
  liquidity: WireLiquidityView | null
  /** How the target commit's membership was proven at publication (from the verified document). */
  membership: ClaimDocument['target']['membership'] | null
}

export interface ApiClaimDetail extends ClaimDetail {
  api: ApiClaimDetailFacts
}

export interface ApiClaimDetailInput extends ApiClaimInput {
  view: WireClaimView
  evidence: ApiEvidence[]
  oracle: WireOracleView | null
  liquidity: WireLiquidityView | null
  nowSec: number
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100)
}

function parametersOf(doc: ClaimDocument | null): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {}
  for (const [key, value] of Object.entries(doc?.claim.policyParameters ?? {})) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'number') out[key] = String(value)
    else if (Array.isArray(value) && value.every((x): x is string => typeof x === 'string')) out[key] = [...value]
  }
  return out
}

/** EnvironmentPin from the document's free-text environment (best effort; hashes are derived locally). */
function environmentOf(doc: ClaimDocument | null): EnvironmentPin {
  const e = doc?.environment
  const config: Record<string, string> = e ? { dependencies: e.dependencies, configuration: e.configuration } : {}
  const pin = {
    runtime: e?.runtime ?? '',
    config,
    configHash: hashJson(config),
    ...(e ? { externalState: e.externalState } : {}),
    reproductionCommand: e?.reproduction.command ?? '',
    setupSteps: e ? lines(e.reproduction.setup) : [],
    ...(e?.reproduction.notes ? { notes: e.reproduction.notes } : {}),
  }
  return { ...pin, envHash: hashJson(pin) }
}

function manifestOf(input: ApiClaimDetailInput, title: string, policy: ApiPolicyRef, doc: ClaimDocument | null): ClaimManifest {
  const v = input.view
  const owner = doc?.target.repository.ownerLogin ?? ''
  const repo = doc?.target.repository.name ?? ''
  const repoUrl = owner && repo ? `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` : ''
  const commitUrl = repoUrl ? `${repoUrl}/commit/${v.commit}` : ''
  const question = input.hidden ? '' : (v.marketName ?? '')
  const market = doc?.market
  return {
    $schema: 'urn:pine:claim:v1',
    manifestVersion: '1',
    claimId: v.market,
    createdAt: doc?.createdAt ?? v.created.iso,
    creator: v.creator,
    source: {
      provider: 'github',
      owner,
      repo,
      repoId: v.repositoryId,
      commit: { sha: v.commit, message: '', author: '', committedAt: '', htmlUrl: commitUrl },
      ...(doc?.target.baseCommit ? { baseCommit: { sha: doc.target.baseCommit, htmlUrl: repoUrl ? `${repoUrl}/commit/${doc.target.baseCommit}` : '' } } : {}),
    },
    policy: { id: policy.id, version: policy.version, hash: v.policyDocument.sha256, uri: `ipfs://${v.policyDocument.cid}` },
    claim: {
      title,
      policyId: policy.id,
      policyVersion: policy.version,
      requirement: doc?.claim.requirement ?? '',
      violation: doc?.claim.violation ?? '',
      scope: { inScope: [...(doc?.claim.scope.components ?? [])], outOfScope: [...(doc?.claim.scope.outOfScope ?? [])] },
      parameters: parametersOf(doc),
      ...(doc ? { faultModel: doc.claim.faultModel, allowedInputs: doc.claim.allowedInputs } : {}),
      assumptions: [...(doc?.claim.assumptions ?? [])],
      exclusions: [...(doc?.claim.exclusions ?? [])],
      environment: environmentOf(doc),
      regressionOnly: doc?.claim.regressionOnly ?? false,
      evidence: { mechanism: 'commit-reveal', deadline: v.deadlines.evidence.iso },
      oracle: {
        chainId: API_CHAIN_ID,
        openingTime: v.deadlines.answers.iso,
        timeoutSeconds: market?.questionTimeoutSeconds ?? SEER_QUESTION_TIMEOUT_SECONDS,
        minBond: weiToDecimal(v.minBondWei),
        bondToken: CHAIN.nativeSymbol,
        arbitrator: market?.arbitrator ?? (CHAIN.arbitrator.toLowerCase() as Address),
        arbitratorName: CHAIN.arbitratorName,
        language: 'en_US',
        category: 'misc',
      },
    },
    question: { text: question, outcomes: ['Yes', 'No'], hash: keccak256(stringToBytes(question)) },
    disclaimers: [],
  }
}

function answerLabel(a: RealityAnswer): string {
  return a === 'yes' ? 'Yes' : a === 'no' ? 'No' : a === 'invalid' ? 'Invalid' : 'Answered too soon'
}

function timelineOf(input: ApiClaimDetailInput, oracle: OracleState, evidence: readonly Evidence[]): TimelineEvent[] {
  const v = input.view
  const now = input.nowSec
  const t: Omit<TimelineEvent, 'id'>[] = [
    { kind: 'market_created', at: v.created.iso, title: 'Claim published and its Seer market created', actor: v.creator, txHash: v.created.txHash },
  ]
  for (const e of evidence) {
    t.push({ kind: 'evidence_submitted', at: e.submittedAt, title: e.kind === 'commitment' ? 'Evidence commitment recorded' : 'Evidence recorded', detail: e.title, actor: e.submitter, txHash: e.txHash })
  }
  t.push({
    kind: 'evidence_deadline',
    at: v.deadlines.evidence.iso,
    title: 'Evidence deadline',
    detail: 'Commit or publish evidence while block.timestamp < evidence deadline. Not a trading cutoff.',
    scheduled: v.deadlines.evidence.unix > now,
  })
  t.push({
    kind: 'oracle_opened',
    at: v.deadlines.answers.iso,
    title: 'Reveals close; Reality.eth accepts answers',
    detail: 'Reveal while block.timestamp < reveal deadline; answers are accepted once block.timestamp >= reveal deadline.',
    scheduled: v.deadlines.answers.unix > now,
  })
  oracle.history.forEach((h, i) =>
    t.push({ kind: i === 0 ? 'answer_posted' : 'answer_challenged', at: h.at, title: `${i === 0 ? 'Answer posted' : 'Answer challenged'}: ${answerLabel(h.answer)}`, detail: `Bond ${h.bond} ${oracle.bondToken}.`, actor: h.answerer, txHash: h.txHash }),
  )
  const arbitration = input.oracle?.arbitration
  for (const h of arbitration?.history ?? []) {
    if (h.stage === 'RequestNotified') t.push({ kind: 'arbitration_requested', at: isoFromUnix(h.at), title: 'Arbitration requested (Kleros)', txHash: h.txHash })
    if (h.stage === 'ArbitratorAnswered') t.push({ kind: 'ruling', at: isoFromUnix(h.at), title: 'Arbitrator answered', txHash: h.txHash })
  }
  const status = input.oracle ? input.oracle.status : v.oracle
  if (status?.state === 'finalized' && input.oracle?.question) {
    t.push({ kind: 'finalized', at: isoFromUnix(input.oracle.question.finalizeTs), title: `Oracle finalized: ${answerLabel(answerFromOutcome(status.outcome) ?? 'invalid')}` })
  } else if (status?.state === 'answered') {
    t.push({ kind: 'finalized', at: isoFromUnix(status.finalizesAt), title: `Finalizes if unchallenged: ${answerLabel(answerFromOutcome(status.outcome) ?? 'invalid')}`, scheduled: true })
  }
  if (v.resolution) {
    t.push({ kind: 'finalized', at: isoFromUnix(v.resolution.resolvedAt), title: 'Market resolved; winning outcome tokens are redeemable', txHash: v.resolution.txHash })
  }
  return t.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((e, i) => ({ ...e, id: `${v.market}-tl-${i + 1}` }))
}

/** The full claim page model. Moderated claims keep their platform facts and lose every user-supplied text. */
export function claimDetailFromApi(input: ApiClaimDetailInput): ApiClaimDetail {
  const summary = claimSummaryFromApi(input)
  const doc = input.hidden ? null : input.document
  const { oracle, facts: oracleFacts } = oracleFromApi(input.view, input.oracle, doc?.market.questionTimeoutSeconds)
  const yesPrice = outcomePrice(input.liquidity, 'yes')
  const sha = input.view.claimDocument.sha256
  const url = summary.api.claimDocument.url
  return {
    ...summary,
    ...(yesPrice !== undefined ? { yesPrice } : {}),
    evidenceCount: input.evidence.length,
    manifest: manifestOf(input, summary.title, input.policy, doc),
    // The download link exactly as the backend gave it, else the content address; nothing for a moderated claim.
    manifestUri: input.hidden ? '' : (url ?? `ipfs://${input.view.claimDocument.cid}`),
    manifestHash: sha,
    market: marketFromApi(input.view, input.liquidity),
    oracle,
    evidence: input.evidence,
    timeline: timelineOf(input, oracle, input.evidence),
    api: { ...summary.api, oracle: oracleFacts, liquidity: input.liquidity, membership: doc ? { ...doc.target.membership } : null },
  }
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const EVIDENCE_ACTIVITY: Record<'committed' | 'revealed' | 'published', string> = {
  committed: 'Committed sealed evidence',
  revealed: 'Revealed committed evidence',
  published: 'Published evidence',
}

/**
 * Account activity (claims created and evidence submitted), newest first. Claim titles are placeholders: the activity
 * route filters only "hide" moderation, so its titles could belong to a blocked claim.
 */
export function activityFromApi(view: WireActivityView): ActivityItem[] {
  const items: ActivityItem[] = [
    ...view.claims.map((c) => ({
      id: `claim:${c.market}`,
      type: 'market_created' as const,
      claimId: c.market,
      claimNumber: 0,
      claimTitle: claimPlaceholderTitle(c.market),
      actor: view.wallet,
      at: isoFromUnix(c.createdAt),
      txHash: c.createdTxHash,
      chainId: API_CHAIN_ID,
      summary: 'Published a claim and created its market',
      status: 'confirmed' as const,
    })),
    ...view.evidence.map((e) => ({
      id: `evidence:${e.registry}:${e.submissionId}`,
      type: 'evidence_submitted' as const,
      claimId: e.market,
      claimNumber: 0,
      claimTitle: claimPlaceholderTitle(e.market),
      actor: view.wallet,
      at: isoFromUnix(e.committedAt),
      txHash: e.committedTxHash,
      chainId: API_CHAIN_ID,
      summary: EVIDENCE_ACTIVITY[e.status],
      status: 'confirmed' as const,
    })),
  ]
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export interface ApiLiquidityPosition extends LiquidityPosition {
  api: { market: Address; liquidity: string; tickLower: number; tickUpper: number; tokensOwed0: string; tokensOwed1: string; token0: Address; token1: Address }
}

export interface ApiMarketHoldings {
  /** Every scanned page of GET /funding/positions for (wallet, market): balances plus position NFTs. */
  positions: WirePositionsView
  claim: WireClaimView | null
  liquidity: WireLiquidityView | null
}

const OUTCOME_INDEX = { yes: 0, no: 1, invalid: 2 } as const

/** Value in sDAI base units of `amount` outcome tokens at a decimal price (exact bigint arithmetic, rounded down). */
function valueAt(amount: bigint, price: string): bigint {
  return (amount * parseUnits(price, 18)) / WAD
}

/**
 * Outcome-token holdings and LP positions of one wallet in one market. Resolved markets are valued at their payout
 * (`redeemable` for winning tokens); open markets at the marginal pool price (0 for Invalid, which has no pool).
 */
export function holdingsFromApi(h: ApiMarketHoldings): { positions: OutcomePosition[]; liquidity: ApiLiquidityPosition[] } {
  const market = h.positions.market
  const claim = h.claim
  const hidden = claim ? claim.hidden || claim.moderation !== null || claim.contentModeration !== null : false
  const title = !claim ? claimPlaceholderTitle(market) : hidden ? HIDDEN_CLAIM_TITLE : (safeTitle(claim.title) ?? claimPlaceholderTitle(market))
  const status = claim ? claimStatusOf(claim).status : 'awaiting_answer'
  const payouts = claim?.resolution?.payoutNumerators.map((n) => BigInt(n)) ?? null
  const payoutTotal = payouts?.reduce((a, b) => a + b, 0n) ?? 0n
  const positions: OutcomePosition[] = []
  for (const outcome of ['yes', 'no', 'invalid'] as const) {
    const balance = BigInt(h.positions.balances[outcome])
    if (balance === 0n) continue
    let value = 0n
    let markPrice = 0
    let redeemable = false
    if (payouts && payoutTotal > 0n) {
      const share = payouts[OUTCOME_INDEX[outcome]] ?? 0n
      value = (balance * share) / payoutTotal
      markPrice = Number(share) / Number(payoutTotal)
      redeemable = share > 0n
    } else if (outcome !== 'invalid') {
      const price = h.liquidity?.outcomes.find((o) => o.outcome === outcome)?.priceSdai ?? null
      const mark = priceNumber(price)
      if (price !== null && mark !== undefined) {
        value = valueAt(balance, price)
        markPrice = mark
      }
    }
    positions.push({
      claimId: market,
      claimNumber: 0,
      claimTitle: title,
      status,
      outcome,
      balance: weiToDecimal(balance),
      markPrice,
      value: weiToDecimal(value),
      redeemable,
      ...(redeemable ? { redeemableAmount: weiToDecimal(value) } : {}),
    })
  }
  const liquidity: ApiLiquidityPosition[] = []
  for (const p of h.positions.items) {
    // LiquidityPosition is YES/NO only: an Invalid-token position stays out of this list.
    if (p.outcome === 'invalid') continue
    const pool = h.positions.pools[p.outcome] ?? h.liquidity?.outcomes.find((o) => o.outcome === p.outcome)?.pool ?? null
    if (!pool) continue
    const tick = h.liquidity?.outcomes.find((o) => o.outcome === p.outcome)?.tick ?? null
    liquidity.push({
      claimId: market,
      claimNumber: 0,
      claimTitle: title,
      tokenId: p.tokenId,
      pool,
      outcome: p.outcome,
      deposited: '0',
      currentValue: '0',
      feesEarned: '0',
      withdrawable: p.liquidity !== '0' || p.tokensOwed0 !== '0' || p.tokensOwed1 !== '0',
      inRange: tick !== null && p.tickLower <= tick && tick < p.tickUpper,
      api: { market, liquidity: p.liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper, tokensOwed0: p.tokensOwed0, tokensOwed1: p.tokensOwed1, token0: p.token0, token1: p.token1 },
    })
  }
  return { positions, liquidity }
}

/** Portfolio totals over every market's holdings (exact decimal sums). */
export function portfolioFromHoldings(address: Address, parts: readonly { positions: OutcomePosition[]; liquidity: ApiLiquidityPosition[] }[]): Portfolio {
  const positions = parts.flatMap((p) => p.positions)
  const liquidity = parts.flatMap((p) => p.liquidity)
  const sum = (values: string[]) => weiToDecimal(values.reduce((acc, v) => acc + parseUnits(v, 18), 0n))
  return {
    address,
    positions,
    liquidity,
    totals: {
      positionsValue: sum(positions.map((p) => p.value)),
      liquidityValue: '0',
      redeemable: sum(positions.map((p) => p.redeemableAmount ?? '0')),
      depositedAllTime: '0',
      withdrawnAllTime: '0',
      feesPaidAllTime: '0',
    },
  }
}
