import type { ClaimStatus, ClaimSummary, Outcome, PolicyFamilyId } from '@pine/core'
import { OUTCOME_META, STATUS_META, formatDuration, getPolicy } from '@pine/core'

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
  return `${c.source.owner}/${c.source.repo}`
}
