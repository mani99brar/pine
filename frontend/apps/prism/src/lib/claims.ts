import type { ClaimDetail, ClaimStatus, ClaimSummary, NextStep, Outcome, PolicyFamilyId, RealityAnswer } from '@pine/core'
import { OUTCOME_META, REALITY_ANSWER_LABEL, STATUS_META, formatAmount, formatClaimNumber, formatDate, formatDuration, fromScaled, getPolicy, shortHash, toScaled } from '@pine/core'
import { COPY } from '@pine/core/copy'
import type { ApiClaimDetailFacts, ApiClaimFacts, ApiEvidenceFacts } from '@pine/data'

export interface StatusGroup {
  id: 'open' | 'oracle' | 'contested' | 'resolved' | 'unfinished'
  label: string
  statuses: ClaimStatus[]
}

export const STATUS_GROUPS: StatusGroup[] = [
  { id: 'open', label: 'Open for evidence', statuses: ['open'] },
  { id: 'oracle', label: 'With the oracle', statuses: ['awaiting_answer', 'answer_proposed'] },
  { id: 'contested', label: 'Contested', statuses: ['disputed', 'arbitration'] },
  { id: 'resolved', label: 'Resolved', statuses: ['resolved', 'settled'] },
  { id: 'unfinished', label: 'Unfinished', statuses: ['publishing', 'failed'] },
]

export function statusLabel(status: ClaimStatus, outcome?: Outcome): string {
  if ((status === 'resolved' || status === 'settled') && outcome) return OUTCOME_META[outcome].label
  return STATUS_META[status].label
}

/** CSS color for a status (never the only signal: a label always accompanies it). */
export function statusColor(status: ClaimStatus, outcome?: Outcome): string {
  if (status === 'resolved' || status === 'settled') {
    if (outcome === 'yes') return 'var(--ha)'
    if (outcome === 'invalid') return 'var(--frost)'
    return 'var(--moon)'
  }
  if (status === 'open') return 'var(--hb)'
  if (status === 'awaiting_answer' || status === 'answer_proposed' || status === 'publishing') return 'var(--na)'
  if (status === 'disputed' || status === 'arbitration') return 'var(--ha)'
  return 'var(--lumen-3)'
}

export function familyOf(policyId: string | undefined): PolicyFamilyId {
  if (!policyId) return 'FUNC'
  const p = getPolicy(policyId)
  if (p) return p.family
  if (policyId.startsWith('BOT')) return 'BOT'
  if (policyId.startsWith('SC')) return 'SC'
  return 'FUNC'
}

/** Short time-left label: "2d 4h left", "Closed 3h ago". */
export function timeLeft(deadline: string, nowMs: number): { label: string; ms: number; past: boolean } {
  const ms = Date.parse(deadline) - nowMs
  const past = ms <= 0
  const d = formatDuration(Math.abs(ms))
  return { label: past ? `closed ${d} ago` : `${d} left`, ms, past }
}

/** Countdown with seconds for the last hour (live). */
export function countdown(deadline: string, nowMs: number): string {
  const ms = Date.parse(deadline) - nowMs
  if (ms <= 0) return 'passed'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${String(sec).padStart(2, '0')}s`
  return `${m}m ${String(sec).padStart(2, '0')}s`
}

/** Glow pulse period (seconds) from time left: faster as the evidence deadline approaches. */
export function pulseSeconds(deadline: string, nowMs: number): number | undefined {
  const ms = Date.parse(deadline) - nowMs
  if (ms <= 0) return undefined
  const hours = ms / 3_600_000
  if (hours < 12) return 1.1
  if (hours < 48) return 1.8
  if (hours < 24 * 7) return 3
  return 5
}

export function crystalSeed(c: Pick<ClaimSummary, 'id' | 'source'>): string {
  return `${c.id}:${c.source.commitSha}`
}

export function isResolved(status: ClaimStatus): boolean {
  return status === 'resolved' || status === 'settled'
}

export function shortRepo(c: Pick<ClaimSummary, 'source'>): string {
  return c.source.owner && c.source.repo ? `${c.source.owner}/${c.source.repo}` : ''
}

/** The repository as text: owner/name, else (backend claim without a readable document) its GitHub repository id. */
export function repoLabel(c: ClaimSummary): string {
  const repo = shortRepo(c)
  if (repo) return repo
  const api = apiFactsOf(c)
  return api ? `GitHub repository #${api.repositoryId}` : 'Repository not shown'
}

// ---------------------------------------------------------------------------
// `api` mode: claims served by the Pine backend carry its facts as `claim.api`
// ---------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DIGEST = /^0x[0-9a-f]{64}$/

/** Backend facts of a claim (`claim.api`), or null for claims from the mock, REST and Envio sources. */
export function apiFactsOf(c: ClaimSummary): ApiClaimFacts | null {
  const api: unknown = (c as { api?: unknown }).api
  return api !== null && typeof api === 'object' ? (api as ApiClaimFacts) : null
}

/** Backend facts of a claim page (oracle, liquidity and membership on top of the claim facts). */
export function apiDetailFactsOf(c: ClaimSummary): ApiClaimDetailFacts | null {
  const api = apiFactsOf(c)
  return api && 'oracle' in api ? (api as ApiClaimDetailFacts) : null
}

export function apiEvidenceFactsOf(e: object): ApiEvidenceFacts | null {
  const api: unknown = (e as { api?: unknown }).api
  return api !== null && typeof api === 'object' ? (api as ApiEvidenceFacts) : null
}

/**
 * How a claim is named: "PINE-0042", or for backend claims (identified by their market, with no numbers) the short
 * market address "0x1234…abcd".
 */
export function claimLabel(c: { number: number; id: string; marketAddress?: string }): string {
  if (c.number > 0) return formatClaimNumber(c.number)
  const address = c.marketAddress ?? c.id
  return ADDRESS.test(address) ? shortHash(address.toLowerCase(), 4) : formatClaimNumber(c.number)
}

const POLICY_VERSION = /^\d+\.\d+\.\d+$/

/**
 * The page of the policy a claim pins: for a backend claim its exact version (each catalog version is its own page and
 * older ones stay readable), else the policy's page.
 */
export function claimPolicyHref(c: ClaimSummary): string {
  const { id, version } = c.policy
  return apiFactsOf(c) && POLICY_VERSION.test(version) ? `/policies/${encodeURIComponent(`${id}@${version}`)}` : `/policies/${id}`
}

/**
 * The status text where the backend knows more than the domain status: its reveal window (status "open", but no new
 * evidence) is named as such. Undefined keeps the default label.
 */
export function apiStatusLabel(c: ClaimSummary): string | undefined {
  return apiFactsOf(c)?.phase === 'reveal_open' ? 'Reveal window open' : undefined
}

export function isoOfUnix(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A backend decimal price as a display number in [0, 1]; undefined when absent or out of range (never 0 for unknown). */
export function priceOf(decimal: string | null | undefined): number | undefined {
  if (!decimal || decimal.startsWith('-')) return undefined
  const n = Number(decimal)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

export interface OutcomePrices {
  yes?: number
  no?: number
  invalid?: number
}

/**
 * The prices the backend actually reported for a claim: marginal pool prices in sDAI on a claim page, nothing in
 * listings. Invalid has no Pine pool, so it is never priced. Unknown prices stay undefined, never 0.
 */
export function apiOutcomePrices(c: ClaimSummary): OutcomePrices {
  const d = apiDetailFactsOf(c)
  if (!d) return c.yesPrice !== undefined ? { yes: c.yesPrice } : {}
  const of = (o: 'yes' | 'no') => priceOf(d.liquidity?.outcomes.find((x) => x.outcome === o)?.priceSdai)
  const yes = of('yes')
  const no = of('no')
  return { ...(yes !== undefined ? { yes } : {}), ...(no !== undefined ? { no } : {}) }
}

/**
 * A download link for content Pine stores (`/c/<sha256>` on the user-content origin the backend named for the claim
 * document). Links only: the app never fetches user content. Null without a backend origin (moderated claims) or
 * for a malformed digest.
 */
export function userContentUrl(c: ClaimSummary, sha256: string | null | undefined): string | null {
  const base = apiFactsOf(c)?.claimDocument.url
  const digest = sha256?.toLowerCase()
  if (!base || !digest || !DIGEST.test(digest)) return null
  try {
    const u = new URL(base)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return `${u.origin}/c/${digest}`
  } catch {
    return null
  }
}

/** The frozen deadline operators of Pine claims (ClaimRegistry / EvidenceRegistry NatSpec). */
export const API_DEADLINE_RULES = {
  evidence: 'Commit sealed evidence or publish evidence while block.timestamp < the evidence deadline.',
  reveal: 'Reveal sealed evidence while block.timestamp < the reveal deadline.',
  answers: 'Reality.eth accepts answers once block.timestamp ≥ the reveal deadline.',
} as const

function answerText(a: RealityAnswer | undefined): string {
  return a ? REALITY_ANSWER_LABEL[a] : 'The current answer'
}

/** 2 × a decimal amount (18 decimals, exact); null when it does not parse or is not positive. */
export function doubleAmount(amount: string): string | null {
  const scaled = toScaled(amount, 18)
  return scaled && scaled.value > 0n ? fromScaled(scaled.value * 2n, 18) : null
}

/** "What happens next" for a backend claim, from its phase (which knows the reveal window) and oracle state. */
export function apiNextStep(c: ClaimDetail, api: ApiClaimDetailFacts): NextStep {
  const evidence = isoOfUnix(api.evidenceDeadline)
  const reveal = isoOfUnix(api.revealDeadline)
  const o = c.oracle
  const bondToken = o?.bondToken ?? 'xDAI'
  const status = api.oracle.status
  switch (api.phase) {
    case 'evidence_open':
      if (api.hidden) {
        return {
          title: 'Evidence window open',
          detail: `Pine withholds this claim after a moderation decision and offers no evidence actions for it. The window closes at ${formatDate(evidence, 'utc')}.`,
          at: evidence,
          actor: 'investigators',
        }
      }
      return {
        title: 'Evidence window open',
        detail: `Investigators can commit sealed evidence or publish evidence until ${formatDate(evidence, 'utc')}. Sealed evidence counts only if it is revealed before ${formatDate(reveal, 'utc')}. ${COPY.deadlineIsNotTradingCutoff}`,
        at: evidence,
        actor: 'investigators',
      }
    case 'reveal_open':
      return {
        title: 'Reveal window open',
        detail: `The evidence deadline has passed, so no new evidence can be recorded. Submitters reveal sealed evidence until ${formatDate(reveal, 'utc')}; from then anyone can answer on Reality.eth.`,
        at: reveal,
        actor: 'investigators',
      }
    case 'pending_arbitration':
      return {
        title: 'In arbitration',
        detail: 'Kleros jurors on Ethereum review the evidence. The ruling is relayed back to Reality.eth on Gnosis, which then finalizes the answer. Anyone can send the relay steps.',
        actor: 'arbitrator',
      }
    case 'finalized':
      if (status?.state === 'finalized' && status.outcome === 'answered_too_soon') {
        return { title: 'Question must be reopened', detail: `The final answer was "answered too soon". ${COPY.answeredTooSoon} Anyone can reopen it.`, actor: 'anyone' }
      }
      return {
        title: 'Answer final: resolve the market',
        detail: 'Reality.eth finalized the answer. Anyone can now resolve the Seer market, after which winning outcome tokens can be redeemed.',
        actor: 'anyone',
      }
    case 'resolved':
      return {
        title: 'Market resolved',
        detail: `Holders of winning outcome tokens can redeem them under Seer's native payout rules.${c.outcome === 'invalid' ? ` ${COPY.invalidIsNotRefund}` : ''}`,
        actor: 'holders',
      }
    case 'oracle_open':
    default: {
      if (status?.state === 'answered' && o?.finalizesAt) {
        const doubled = o.currentBond ? doubleAmount(o.currentBond) : null
        const min = doubled ? `${formatAmount(doubled, { maxDecimals: 6 })} ${bondToken}` : null
        return {
          title: `Answer "${answerText(o.currentAnswer)}" proposed`,
          detail: `It becomes final at ${formatDate(o.finalizesAt, 'utc')} unless someone posts a different answer${min ? ` with a bond of at least ${min}` : ' with a doubled bond'}.`,
          at: o.finalizesAt,
          actor: 'anyone',
        }
      }
      return {
        title: 'Waiting for an answer',
        detail: `Anyone can answer on Reality.eth with a bond of at least ${o ? `${formatAmount(o.minBond)} ${bondToken}` : 'the minimum bond'}. Pine never answers or posts bonds. ${COPY.unanswered}`,
        actor: 'answerers',
      }
    }
  }
}

export interface LifecycleStage {
  id: string
  label: string
  at?: string
  note?: string
  done: boolean
  current: boolean
}

/** A backend claim's path: published, evidence window, reveal window, oracle (and arbitration), final. */
export function apiLifecycleStages(c: ClaimDetail, api: ApiClaimDetailFacts): LifecycleStage[] {
  const phase = api.phase
  const idx = phase === 'evidence_open' ? 1 : phase === 'reveal_open' ? 2 : phase === 'oracle_open' || phase === 'pending_arbitration' ? 3 : 4
  const finalizes = c.oracle?.finalizesAt
  const stages: Omit<LifecycleStage, 'done' | 'current'>[] = [
    { id: 'published', label: 'Published', at: c.createdAt },
    { id: 'evidence', label: 'Evidence window', at: isoOfUnix(api.evidenceDeadline), note: 'closes' },
    { id: 'reveal', label: 'Reveal window', at: isoOfUnix(api.revealDeadline), note: 'closes' },
    phase === 'pending_arbitration'
      ? { id: 'oracle', label: 'Kleros arbitration' }
      : { id: 'oracle', label: 'Oracle answer', at: finalizes ?? isoOfUnix(api.revealDeadline), note: finalizes ? 'finalizes' : 'opens' },
    { id: 'final', label: phase === 'resolved' ? 'Resolved' : phase === 'finalized' ? 'Final, not resolved' : 'Final answer' },
  ]
  return stages.map((s, i) => ({ ...s, done: i < idx || (phase === 'resolved' && i === 4), current: i === idx && phase !== 'resolved' }))
}
