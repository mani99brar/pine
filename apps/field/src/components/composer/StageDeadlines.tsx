'use client'

import { useMemo } from 'react'
import type { ClaimDraft } from '@pine/core'
import { formatDate, formatDuration } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { roundUpToHourUtc, type ClaimComposer } from '@pine/react'
import { Lock } from 'lucide-react'
import { Field, Input } from '@/components/ui/form'
import { Note } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'
import { StageHeader, StageIssues, StageNav, issueFor } from './shared'

const HOUR = 3_600_000
const DAY = 24 * HOUR

function isoToParts(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const p = (n: number) => String(n).padStart(2, '0')
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }
}

function partsToIso(date: string, time: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return undefined
  return `${date}T${time}:00Z`
}

function localLabel(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return `${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} in your time zone (${tz})`
  } catch {
    return ''
  }
}

/**
 * The visual timeline, drawn as a schematic (segments are not to scale, durations are written on
 * them): evidence window, the gap until answers open, the fixed challenge window, and arbitration if
 * someone escalates.
 */
export function DeadlineTimeline({
  now,
  deadline,
  opening,
  timeoutSeconds,
  rulingDays,
  appealDays,
}: {
  now: number
  deadline: number
  opening: number
  timeoutSeconds: number
  rulingDays: number
  appealDays: number
}) {
  const final = opening + timeoutSeconds * 1000
  const iso = (t: number) => new Date(t).toISOString()
  const gap = opening - deadline
  return (
    <figure aria-label="Claim timeline">
      <div className="relative pt-7">
        {/* above-bar label for the oracle opening */}
        <span className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[0.75rem] font-[650]" style={{ left: '49%' }}>
          Answers open{gap > 0 ? ` +${formatDuration(gap)}` : ''}
        </span>
        <div className="flex h-9 items-stretch gap-[3px] text-[0.75rem] font-[650]">
          <div className="flex w-[46%] min-w-0 items-center rounded-l-[3px] bg-ink px-3 text-on-ink">
            <span className="block truncate">Evidence window, {formatDuration(deadline - now)}</span>
          </div>
          <div className="w-[3%] bg-line-strong" aria-hidden />
          <div
            className="flex w-[23%] min-w-0 items-center bg-cobalt px-3 text-white"
            style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 10px, rgb(255 255 255 / .18) 10px 12px)' }}
          >
            <span className="block truncate">Challenge, {formatDuration(timeoutSeconds * 1000)}</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center rounded-r-[3px] border-[1.5px] border-dashed border-ink-3 px-3 text-ink-2">
            <span className="block truncate">If disputed: Kleros, ~{rulingDays}d</span>
          </div>
        </div>
        {/* boundary posts */}
        <span aria-hidden className="absolute bottom-[-6px] top-6 w-[3px] -translate-x-1/2 bg-lumen shadow-[0_0_0_1.5px_var(--ink)]" style={{ left: '46%' }} />
        <span aria-hidden className="absolute bottom-[-6px] top-6 w-[2px] -translate-x-1/2 bg-ink" style={{ left: '49%' }} />
        <span aria-hidden className="absolute bottom-[-6px] top-6 w-[2px] -translate-x-1/2 bg-ink" style={{ left: '72.5%' }} />
      </div>
      <ol className="relative mt-3 grid grid-cols-[46%_26.5%_1fr] text-[0.75rem] leading-tight">
        <li>
          <span className="block font-[650]">Now</span>
        </li>
        <li className="-ml-1">
          <span className="block font-[650]">Evidence deadline</span>
          <span className="block text-ink-3">{formatDate(iso(deadline), 'utc')}</span>
        </li>
        <li className="-ml-1">
          <span className="block font-[650]">Earliest final</span>
          <span className="block text-ink-3">{formatDate(iso(final), 'utc')}, if unchallenged</span>
        </li>
      </ol>
      <p className="mt-4 text-[0.78rem] text-ink-3">
        Segments are not to scale. Each new answer restarts the {formatDuration(timeoutSeconds * 1000)} challenge window, fixed by Seer. Arbitration takes about {rulingDays} days plus about {appealDays}{' '}
        days per appeal.
      </p>
      <figcaption className="sr-only">
        Evidence window until {formatDate(iso(deadline), 'long')}. Answers open {formatDate(iso(opening), 'long')}. Each answer can be challenged for {formatDuration(timeoutSeconds * 1000)}.
        Arbitration, if requested, takes about {rulingDays} days.
      </figcaption>
    </figure>
  )
}

export function StageDeadlines({ c }: { c: ClaimComposer }) {
  const nowMs = useNowMs()
  const spec = c.draft.spec
  const deadline = spec.evidence?.deadline
  const oracle = spec.oracle ?? c.spec.oracle
  const chain = getChainOrDefault(oracle.chainId)
  const parts = isoToParts(deadline)
  const opening = oracle.openingTime
  const offsetH = deadline && opening ? Math.round((Date.parse(opening) - Date.parse(deadline)) / HOUR) : 1

  const setDeadline = (iso: string | undefined) => {
    if (!iso) return
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: d.spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } } }))
  }
  const setOpeningOffset = (h: number) => {
    if (!deadline) return
    const iso = new Date(Date.parse(deadline) + h * HOUR).toISOString().replace('.000Z', 'Z')
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, oracle: { ...(d.spec.oracle ?? oracle), openingTime: iso } } }))
  }
  const presets = useMemo(() => [3, 7, 14, 30].map((days) => ({ days, label: `${days} days` })), [])

  return (
    <div>
      <StageHeader stage="deadlines">
        The evidence deadline is an absolute UTC time. After it, someone answers the question on Reality.eth, and every answer can be challenged for a fixed 3.5 days.
      </StageHeader>

      <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5 sm:p-6">
        {nowMs !== null && deadline && opening ? (
          <DeadlineTimeline
            now={nowMs}
            deadline={Date.parse(deadline)}
            opening={Date.parse(opening)}
            timeoutSeconds={oracle.timeoutSeconds}
            rulingDays={chain.arbitration.typicalRulingDays}
            appealDays={chain.arbitration.typicalAppealDays}
          />
        ) : (
          <div className="skeleton h-28" />
        )}
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="dl-title">
          <h3 id="dl-title" className="t-h3">
            Evidence deadline
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {presets.map((p) => {
              const active = nowMs !== null && !!deadline && Math.abs(Date.parse(deadline) - roundUpToHourUtc(new Date(nowMs + p.days * DAY)).getTime()) <= HOUR
              return (
                <button
                  key={p.days}
                  type="button"
                  disabled={c.frozen}
                  aria-pressed={active}
                  onClick={() => setDeadline(roundUpToHourUtc(new Date(Date.now() + p.days * DAY)).toISOString().replace('.000Z', 'Z'))}
                  className={cn(
                    'rounded-full border-[1.5px] px-3 py-1 text-[0.84rem] font-[600]',
                    active ? 'border-ink bg-ink text-on-ink' : 'border-line-strong bg-sheet hover:border-ink',
                  )}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="mt-4 grid grid-cols-[1.3fr_1fr_auto] items-end gap-2">
            <Field label="Date (UTC)" htmlFor="dl-date" className="min-w-0">
              <Input id="dl-date" type="date" value={parts.date} disabled={c.frozen} onChange={(e) => setDeadline(partsToIso(e.target.value, parts.time || '18:00'))} />
            </Field>
            <Field label="Time (UTC)" htmlFor="dl-time" className="min-w-0">
              <Input id="dl-time" type="time" step={60} value={parts.time} disabled={c.frozen} onChange={(e) => setDeadline(partsToIso(parts.date, e.target.value))} />
            </Field>
            <span className="pb-2.5 text-[0.9rem] font-[700]">UTC</span>
          </div>
          {deadline && <p className="mt-2 text-[0.8rem] text-ink-3">{localLabel(deadline)}</p>}
          {issueFor(c, 'spec.evidence') && <p className="mt-2 text-[0.84rem] font-[550] text-flare-ink">{issueFor(c, 'spec.evidence')}</p>}
          <Note className="mt-4">{COPY.deadlineIsNotTradingCutoff}</Note>
        </section>

        <section aria-labelledby="or-title">
          <h3 id="or-title" className="t-h3">
            Oracle
          </h3>
          <Field label="Answers open" htmlFor="or-offset" className="mt-3" help={opening ? `${formatDate(opening, 'long')}` : undefined} error={issueFor(c, 'spec.oracle.openingTime')}>
            <select
              id="or-offset"
              value={[1, 6, 24, 72].includes(offsetH) ? String(offsetH) : 'custom'}
              disabled={c.frozen}
              onChange={(e) => e.target.value !== 'custom' && setOpeningOffset(Number(e.target.value))}
              className="h-10 w-full rounded-[4px] border-[1.5px] border-line-strong bg-sheet px-3"
            >
              <option value="1">1 hour after the deadline (default)</option>
              <option value="6">6 hours after the deadline</option>
              <option value="24">24 hours after the deadline</option>
              <option value="72">3 days after the deadline</option>
              {![1, 6, 24, 72].includes(offsetH) && <option value="custom">{offsetH} hours after the deadline</option>}
            </select>
          </Field>
          <dl className="mt-4 grid gap-3 text-[0.88rem]">
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <dt className="text-ink-2">Challenge window per answer</dt>
              <dd className="inline-flex items-center gap-1.5 font-[650]">
                <Lock size={13} aria-hidden /> {formatDuration(oracle.timeoutSeconds * 1000)}, fixed by Seer
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <dt className="text-ink-2">Minimum answer bond</dt>
              <dd className="flex items-center gap-2">
                <Input
                  aria-label="Minimum answer bond"
                  value={oracle.minBond}
                  disabled={c.frozen}
                  inputMode="decimal"
                  onChange={(e) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, oracle: { ...(d.spec.oracle ?? oracle), minBond: e.target.value } } }))}
                  className="h-9 w-24 text-right"
                />
                <span className="font-[600]">{oracle.bondToken}</span>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <dt className="text-ink-2">Arbitrator</dt>
              <dd className="text-right font-[600]">{oracle.arbitratorName}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[0.8rem] text-ink-3">{COPY.oracleActors}</p>
        </section>
      </div>

      <Note tone="boundary" className="mt-8" title="Not yet agreed: investigation duration">
        A 72-hour window was proposed for the first pilot but has not been agreed, and arbitration can take longer than the evidence window. Choose a duration that gives investigators a fair chance.
      </Note>

      <StageIssues c={c} stage="deadlines" className="mt-6" />
      <StageNav c={c} />
    </div>
  )
}
