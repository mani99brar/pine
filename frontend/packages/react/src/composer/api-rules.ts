/**
 * Composer rules in `api` mode (Pine backend). The backend's strict draft input is the contract (packages/api
 * drafts.ts, preview.ts), so the composer checks the draft against it and shows what the backend will do with it:
 *
 * - The policy comes from the backend catalog: approved policies, and draft policies where the deployment allows them
 *   (development, staging), are usable; parameters come from the policy's JSON schema.
 * - The evidence deadline the user picks stays absolute. The backend takes a window (3..30 days) measured from the
 *   preview and rounds the deadline up to the minute, so the deadline must still lie inside that window when the
 *   preview is requested.
 * - The reveal deadline, the oracle opening (= the reveal deadline), the answer timeout and the arbitrator are fixed by
 *   Pine; the composer derives them for display only. The preview states the exact values.
 * - The market question is composed on-chain from the title, the deadlines, the repository id, the commit and the
 *   digests of the claim document and the policy. Before the preview only the claim document's digest is unknown, so
 *   the composer shows the question with that part elided ("sketch"), never with a made-up digest.
 * - Liquidity is a separate plan after the claim exists: funding never blocks publishing.
 */
import type { ClaimDraft, IsoDate, PolicyVersion, ValidationIssue } from '@pine/core'
import { BLANKET_CLAIM_PATTERN, COPY, stageForPath, validateClaimDraft } from '@pine/core'
import { rawCidFromSha256, renderQuestion, type Hex32 } from '@pine/core/pine-shared'
import { isoNow } from '../internal/util'
import { toDraftInput } from '../api/draft-input'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_S = 86_400
const DAY_MS = DAY_S * 1000

/** Backend bounds shown and checked by the composer in `api` mode. */
export const API_COMPOSER_RULES = {
  /**
   * Seconds from the preview to the evidence deadline (ADR D6: 3..30 days). The preview rounds the deadline up to the
   * next minute, so 30 days minus 60 s is the largest window that always passes.
   */
  evidenceWindowSeconds: { min: 3 * DAY_S, max: 30 * DAY_S - 60 },
  /** The backend's default window (PINE_DEFAULT_EVIDENCE_WINDOW_SECONDS); new drafts start with it. */
  defaultEvidenceWindowDays: 7,
  /** Evidence deadline presets, in days from now. */
  presetDays: [3, 7, 14, 30],
  /**
   * Pine's default reveal window (PINE_REVEAL_WINDOW_SECONDS, 48 h): sealed evidence is revealed until the reveal deadline
   * and Reality accepts answers from then on. A deployment may configure 12 h .. 7 days; the preview states the time.
   */
  revealWindowSeconds: 48 * 3600,
  /** Seer's fixed Reality answer timeout. */
  answerTimeoutSeconds: 302_400,
  /** Reality minimum bond (native xDAI). Empty means the deployment default (10 xDAI). */
  minBondXdai: { min: '1', max: '100' },
  /** The composer caps titles at 90 characters (the backend allows 120): titles are read on the light table. */
  titleMaxLength: 90,
  /** In-scope components: 1..50 entries of at most 300 characters each. */
  scope: { min: 1, max: 50, itemMax: 300 },
} as const

function ceilTo(ms: number, unit: number): number {
  return Math.ceil(ms / unit) * unit
}

/** New drafts in `api` mode: the backend's default window (7 days), rounded up to the next whole hour (UTC). */
export function apiDefaultDeadline(now: Date = new Date()): IsoDate {
  return isoNow(new Date(ceilTo(now.getTime() + API_COMPOSER_RULES.defaultEvidenceWindowDays * DAY_MS, HOUR_MS)))
}

/**
 * Evidence deadline for "N days from now", on a whole hour and inside the backend window with a margin: the shortest
 * preset is at least an hour past the 3-day minimum (the window is measured again at preview time), the longest stays
 * under the 30-day maximum.
 */
export function apiDeadlineForDays(days: number, now: Date = new Date()): IsoDate {
  const t = now.getTime()
  const lower = ceilTo(t + API_COMPOSER_RULES.evidenceWindowSeconds.min * 1000, HOUR_MS) + HOUR_MS
  const upper = Math.floor((t + API_COMPOSER_RULES.evidenceWindowSeconds.max * 1000) / HOUR_MS) * HOUR_MS
  const target = ceilTo(t + days * DAY_MS, HOUR_MS)
  return isoNow(new Date(Math.min(upper, Math.max(lower, target))))
}

export interface ApiTimeline {
  /** Evidence is committed or published while block.timestamp < evidenceDeadline (rounded up to the minute). */
  evidenceDeadline: IsoDate
  /** Sealed evidence is revealed while block.timestamp < revealDeadline. */
  revealDeadline: IsoDate
  /** Reality accepts answers once block.timestamp >= the opening time, which is the reveal deadline. */
  answersOpen: IsoDate
  /** Opening time plus the answer timeout; every new answer restarts the timeout. */
  earliestFinalization: IsoDate
}

/** The timeline the preview would fix for this evidence deadline (Pine's default reveal window). */
export function apiTimeline(deadline: IsoDate | undefined): ApiTimeline | undefined {
  const at = deadline ? Date.parse(deadline) : Number.NaN
  if (!Number.isFinite(at)) return undefined
  const evidence = ceilTo(at, MINUTE_MS)
  const reveal = evidence + API_COMPOSER_RULES.revealWindowSeconds * 1000
  const iso = (ms: number) => isoNow(new Date(ms))
  return {
    evidenceDeadline: iso(evidence),
    revealDeadline: iso(reveal),
    answersOpen: iso(reveal),
    earliestFinalization: iso(reveal + API_COMPOSER_RULES.answerTimeoutSeconds * 1000),
  }
}

/** Seconds from `now` to the evidence deadline (what the backend receives as the window); null when unset. */
export function apiEvidenceWindowSeconds(deadline: IsoDate | undefined, now: Date): number | null {
  const at = deadline ? Date.parse(deadline) : Number.NaN
  return Number.isFinite(at) ? Math.floor((at - now.getTime()) / 1000) : null
}

/** True for a policy new claims may use on this deployment (approved, or draft where the deployment allows drafts). */
export function isPublishablePolicy(p: Pick<PolicyVersion, 'status'> | null | undefined): boolean {
  return p?.status === 'enabled' || p?.status === 'draft'
}

// A digest no real document has; it only marks where the claim document's CID and digest go in the question.
const SKETCH_DIGEST = `0x${'5a'.repeat(32)}` as Hex32

export interface ApiQuestionSketchInput {
  title: string | undefined
  /** GitHub's numeric repository id (the question names the repository by id). */
  repositoryId: number | undefined
  /** 40-hex commit. */
  commit: string | undefined
  timeline: ApiTimeline | undefined
  /** sha256 of the policy document (the backend catalog digest). */
  policySha256: string | undefined
  /** Pine's EvidenceRegistry (pinned deployment). */
  evidenceRegistry: string | undefined
}

/**
 * The market question as the claim registry will compose it, with the claim document's CID and digest elided ("…"):
 * they exist only once the preview freezes the document. Null while an input is missing or invalid (for example a
 * title with a forbidden character), and whenever the elided part cannot be located, so a placeholder digest is never
 * shown as if it were real.
 */
export function apiQuestionSketch(input: ApiQuestionSketchInput): string | null {
  const { title, repositoryId, commit, timeline, policySha256, evidenceRegistry } = input
  if (!title || !repositoryId || !commit || !timeline || !policySha256 || !evidenceRegistry) return null
  try {
    const question = renderQuestion({
      evidenceRegistry: evidenceRegistry as Hex32,
      title,
      evidenceDeadline: Math.floor(Date.parse(timeline.evidenceDeadline) / 1000),
      revealDeadline: Math.floor(Date.parse(timeline.revealDeadline) / 1000),
      repositoryId,
      commit,
      claimDocumentSha256: SKETCH_DIGEST,
      policyDocumentSha256: policySha256 as Hex32,
    })
    const marker = `ipfs://${rawCidFromSha256(SKETCH_DIGEST)} (sha256 ${SKETCH_DIGEST})`
    if (!question.includes(marker) || question.indexOf(marker) !== question.lastIndexOf(marker)) return null
    return question.replace(marker, 'ipfs://… (sha256 …)')
  } catch {
    return null
  }
}

export interface ApiIssueContext {
  /** The chosen policy from the backend catalog: undefined while loading or unknown, null when the catalog lacks it. */
  policy: PolicyVersion | null | undefined
  /** The catalog lookup failed (network, backend). */
  policyError?: boolean
  now: Date
  /** The chain Pine publishes on (default 100, Gnosis). */
  chainId?: number
}

function isEmptyParam(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'string' || x.trim() === '')
  return false
}

// Core checks that still hold in api mode: secret-looking configuration keys (the configuration is published with the
// claim), the lockfile digest format and the environment hashes. Everything else is the backend's draft input
// (toDraftInput: source, membership, texts, window, bond…) plus the backend policy below; the static policy catalog,
// the 24 h..180 d deadline range, the oracle settings and funding do not apply.
function keepCoreIssue(path: string): boolean {
  return path === 'spec.environment' || path.startsWith('spec.environment.config') || path.startsWith('spec.environment.dependencyLock')
}

function draftInputIssues(draft: ClaimDraft, ctx: ApiIssueContext): { path: string; message: string }[] {
  const result = toDraftInput(draft, { chainId: ctx.chainId ?? 100, now: ctx.now })
  return result.ok ? [] : result.errors.map((e) => ({ path: e.composerPath, message: e.message }))
}

function policyIssues(draft: ClaimDraft, ctx: ApiIssueContext): { path: string; message: string }[] {
  const { policyId, policyVersion, parameters } = draft.spec
  const p = ctx.policy
  if (!policyId) return [{ path: 'spec.policyId', message: 'Choose a policy.' }]
  if (p === null) {
    return [{ path: 'spec.policyId', message: `This Pine deployment does not list ${policyId}${policyVersion ? `@${policyVersion}` : ''}. Choose a policy from the list.` }]
  }
  if (!p) return ctx.policyError ? [{ path: 'spec.policyId', message: 'Pine’s policy catalog could not be loaded, so this policy cannot be checked yet. Try again.' }] : []
  const out: { path: string; message: string }[] = []
  if (!isPublishablePolicy(p)) {
    out.push({ path: 'spec.policyId', message: p.gateReason ?? `${p.id}@${p.version} is ${p.status} and cannot be used for new claims.` })
  }
  const values = (parameters ?? {}) as Record<string, unknown>
  const known = new Set(p.parameters.map((x) => x.key))
  for (const spec of p.parameters) {
    const v = values[spec.key]
    if (spec.required && spec.kind === 'boolean' && typeof v !== 'boolean') {
      out.push({ path: `spec.parameters.${spec.key}`, message: `Answer “${spec.label}”.` })
    } else if (spec.required && isEmptyParam(v)) {
      out.push({ path: `spec.parameters.${spec.key}`, message: `${spec.label} is required by ${p.id}.` })
    } else if (spec.maxLength !== undefined) {
      const long = typeof v === 'string' ? v.trim().length > spec.maxLength : Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim().length > (spec.maxLength ?? 0))
      if (long) out.push({ path: `spec.parameters.${spec.key}`, message: `${spec.label} must be at most ${spec.maxLength} characters${Array.isArray(v) ? ' per entry' : ''}.` })
    }
  }
  for (const [key, v] of Object.entries(values)) {
    if (!known.has(key) && !isEmptyParam(v)) {
      out.push({ path: `spec.parameters.${key}`, message: `“${key}” is not a parameter of ${p.id}@${p.version}. Remove it: Pine refuses parameters the policy does not define.` })
    }
  }
  return out
}

function blanketIssues(draft: ClaimDraft): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = []
  for (const field of ['title', 'violation'] as const) {
    const value = draft.spec[field]
    const m = typeof value === 'string' ? BLANKET_CLAIM_PATTERN.exec(value) : null
    if (m) {
      out.push({
        path: `spec.${field}`,
        message: `"${m[0]}" implies a blanket claim about the code. Pine claims are bounded: describe the one specific violation a counterexample must demonstrate (for example "an unauthenticated caller can read another user's file through GET /files/:id"). ${COPY.noIsNotSafety}`,
      })
    }
  }
  return out
}

/**
 * Every issue that keeps an `api`-mode draft from being sent to the backend, with the composer stage it belongs to.
 * Funding never appears here: liquidity is a separate plan after the claim exists.
 */
export function apiComposerIssues(draft: ClaimDraft, ctx: ApiIssueContext): ValidationIssue[] {
  let core: { path: string; message: string }[] = []
  try {
    core = validateClaimDraft(draft, ctx.now).issues.filter((i) => keepCoreIssue(i.path))
  } catch (e) {
    core = [{ path: 'source', message: e instanceof Error ? e.message : String(e) }]
  }
  const raw = [...core, ...policyIssues(draft, ctx), ...draftInputIssues(draft, ctx), ...blanketIssues(draft)]
  const seen = new Set<string>()
  const out: ValidationIssue[] = []
  for (const i of raw) {
    const key = `${i.path}|${i.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: i.path, message: i.message, stage: stageForPath(i.path) })
  }
  return out
}
