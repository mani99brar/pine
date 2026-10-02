/**
 * Claim manifest: the immutable published record. `hash = keccak256(canonicalJson(manifest))`.
 */
import { COPY } from './copy'
import { EVIDENCE_MECHANISMS } from './evidence'
import { formatClaimNumber, formatUtcMinute } from './format'
import { hashJson } from './hash'
import { policyPath } from './policies'
import { buildQuestion } from './question'
import type { Address, ClaimManifest, ClaimSpec, Hex, IsoDate, PolicyVersion, SourceRef } from './types'

/** Base URL for Pine JSON Schemas. */
export const PINE_SCHEMA_BASE_URL = 'https://pine.dev/schemas'
export const CLAIM_MANIFEST_SCHEMA_URL = `${PINE_SCHEMA_BASE_URL}/claim-manifest/v1.json`
export const AGENT_BRIEF_SCHEMA_URL = `${PINE_SCHEMA_BASE_URL}/agent-claim-brief/v1.json`

/** Disclaimers frozen into every manifest (hashed — changing these changes future manifest hashes only). */
export const MANIFEST_DISCLAIMERS: string[] = [
  COPY.notAReview,
  COPY.noIsNotSafety,
  COPY.priceCaveat,
  COPY.liquidityIsNotBounty,
  COPY.evidenceIsNotPayment,
  COPY.invalidIsNotRefund,
  COPY.deadlineIsNotTradingCutoff,
  COPY.lateEvidence,
  COPY.noMergeAuthority,
  COPY.noAttackAuthorization,
  COPY.untrustedContent,
]

/** ISO timestamp without milliseconds: 2026-10-10T18:00:00Z */
export function isoSeconds(d: Date = new Date()): IsoDate {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Deep-copy dropping `undefined` object properties, so the manifest object equals what canonical JSON /
 * IPFS round-trips. Other invalid values (NaN, functions…) are kept so hashing throws on them.
 */
function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => clean(v)) as T
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = clean(v)
    }
    return out as T
  }
  return value
}

export function buildManifest(input: {
  claimId: string
  creator: Address
  source: SourceRef
  spec: ClaimSpec
  policy: PolicyVersion
  createdAt?: IsoDate
}): { manifest: ClaimManifest; hash: Hex } {
  const { claimId, creator, source, spec, policy } = input
  const question = buildQuestion({ spec, source, policy })
  const manifest: ClaimManifest = clean({
    $schema: CLAIM_MANIFEST_SCHEMA_URL,
    manifestVersion: '1' as const,
    claimId,
    createdAt: input.createdAt ?? isoSeconds(),
    creator,
    source,
    policy: { id: policy.id, version: policy.version, hash: policy.contentHash, uri: policy.uri },
    claim: spec,
    question,
    disclaimers: [...MANIFEST_DISCLAIMERS],
  })
  return { manifest, hash: hashManifest(manifest) }
}

/** keccak256(canonicalJson(manifest)). */
export function hashManifest(manifest: ClaimManifest): Hex {
  return hashJson(manifest)
}

/** Recompute and compare a manifest hash (e.g. after fetching from IPFS). */
export function verifyManifestHash(manifest: ClaimManifest, expected: Hex): boolean {
  try {
    return hashManifest(manifest).toLowerCase() === expected.toLowerCase()
  } catch {
    return false
  }
}

/** "pine-0042" → "PINE-0042"; other ids returned upper-cased. */
export function displayClaimId(claimId: string): string {
  const m = /^pine-(\d+)$/i.exec(claimId)
  return m?.[1] ? formatClaimNumber(Number(m[1])) : claimId.toUpperCase()
}

/**
 * Concise market description referencing the immutable terms. Kept short for on-chain storage
 * (~700–900 chars typical).
 */
export function buildMarketDescription(manifest: ClaimManifest, manifestUri: string, manifestHash: Hex): string {
  const { source, policy, claim } = manifest
  const mechanism = EVIDENCE_MECHANISMS[claim.evidence.mechanism]?.label ?? claim.evidence.mechanism
  const pr = source.pullRequest ? ` (PR #${source.pullRequest.number})` : ''
  const base = claim.regressionOnly && source.baseCommit ? ` Only regressions relative to base ${source.baseCommit.sha} qualify.` : ''
  return [
    `Pine claim ${displayClaimId(manifest.claimId)}. Terms: policy ${policyPath(policy)} (${policy.hash}, ${policy.uri}); manifest ${manifestUri} (keccak256 ${manifestHash}).`,
    `Target: github.com/${source.owner}/${source.repo} at commit ${source.commit.sha}${pr}.${base}`,
    `Evidence: ${mechanism} before ${formatUtcMinute(claim.evidence.deadline)}; the submission block timestamp is the timeliness proof.`,
    'YES: at least one timely, admissible submission demonstrates the specified violation under the pinned commit, environment and policy.',
    'NO: no timely, admissible submission demonstrates it. NO is not a statement that the code is correct.',
    'Invalid: native Seer rules apply; Yes and No pay nothing and only Invalid-result tokens redeem. Not a refund.',
  ].join('\n')
}

/** Separator between the question text and the terms reference in the on-chain market name. */
export const MARKET_NAME_TERMS_SEPARATOR = ' — Terms: '

/**
 * On-chain market name: the question text followed by the manifest reference.
 * Seer's CreateMarketParams has no description field, so the manifest URI + hash are appended to
 * the market name (which becomes the Reality.eth question title). The question text itself (and its
 * hash) is unchanged; the full description is in the manifest.
 */
export function buildMarketName(questionText: string, manifestUri: string, manifestHash: Hex): string {
  return `${questionText}${MARKET_NAME_TERMS_SEPARATOR}${manifestUri} (manifest keccak256 ${manifestHash})`
}
