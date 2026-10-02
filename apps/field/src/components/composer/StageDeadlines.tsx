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
import { StageHeader, StageIssues, StageNav, issueFor } from './shared'
import { cn } from '@/lib/cn'

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

/** The visual timeline: evidence window, oracle opening, fixed challenge window, possible arbitration. */
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
  const arbEnd = final + rulingDays * DAY
  const end = arbEnd
  const span = Math.max(1, end - now)
  const pct = (t: number) => `${(Math.max(0, Math.min(1, (t - now) / span)) * 100).toFixed(2)}%`
  const w = (a: number, b: number) => `${((Math.max(0, b - a) / span) * 100).toFixed(2)}%`
  const marks = [
    { t: now, label: 'Now', sub: '' },
    { t: deadline, label: 'Evidence deadline', sub: formatDate(new Date(deadline).toISOString(), 'utc') },
    { t: opening, label: 'Answers open', sub: opening - deadline > 0 ? `${formatDuration(opening - deadline)} later` : 'at the deadline' },
    { t: final, label: 'Earliest final', sub: 'if nobody challenges' },
  ]
  return (
    <figure aria-label="Claim timeline">
      <div className="relative pt-2">
        <div className="relative h-8">
          <span className="absolute inset-y-0 left-0 w-[2px] bg-ink" />
          <span className="absolute inset-y-[7px] bg-ink" style={{ left: 2, width: `calc(${w(now, deadline)} - 2px)` }} />
          <span className="absolute inset-y-[13px] bg-line-strong" style={{ left: pct(deadline), width: w(deadline, opening) }} />
          <span
            className="absolute inset-y-[7px] bg-cobalt"
            style={{
              left: pct(opening),
              width: w(opening, final),
              backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 6px, rgb(255 255 255 / .35) 6px 8px)',
            }}
          />
          <span className="absolute inset-y-[7px] rounded-r-[2px] border-[1.5px] border-dashed border-ink-3" style={{ left: pct(final), width: w(final, arbEnd) }} />
          <span className="absolute -top-1 bottom-[-4px] w-[3px] -translate-x-1/2 bg-lumen shadow-[0_0_0_1.5px_var(--ink)]" style={{ left: pct(deadline) }} />
        </div>
        <ol className="relative mt-2 h-14 text-[0.75rem]">
          {marks.map((m, i) => (
            <li
              key={m.label}
              className={cn('absolute top-0 max-w-[9rem] leading-tight', i === 0 ? '' : i === marks.length - 1 ? '-translate-x-full text-right' : '-translate-x-1/2 text-center', i === 2 && 'top-7')}
              style={{ left: pct(m.t) }}
            >
              <span className="block font-[650] text-ink">{m.label}</span>
              {m.sub && <span className="block text-ink-3">{m.sub}</span>}
            </li>
          ))}
        </ol>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.78rem] text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 bg-ink" /> Evidence window ({formatDuration(deadline - now)})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 bg-cobalt" /> Challenge window, fixed {formatDuration(timeoutSeconds * 1000)} per answer
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-5 border-[1.5px] border-dashed border-ink-3" /> If disputed: Kleros, about {rulingDays} days plus {appealDays} per appeal
        </span>
      </div>
      <figcaption className="sr-only">
        Evidence window until {formatDate(new Date(deadline).toISOString(), 'long')}. Answers open {formatDate(new Date(opening).toISOString(), 'long')}. Each answer can be challenged for{' '}
        {formatDuration(timeoutSeconds * 1000)}. Arbitration, if requested, takes about {rulingDays} days.
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
            {presets.map((p) => (
              <button
                key={p.days}
                type="button"
                disabled={c.frozen}
                onClick={() => setDeadline(roundUpToHourUtc(new Date(Date.now() + p.days * DAY)).toISOString().replace('.000Z', 'Z'))}
                className="rounded-full border-[1.5px] border-line-strong bg-sheet px-3 py-1 text-[0.84rem] font-[600] hover:border-ink"
              >
                {p.label}
              </button>
            ))}
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
