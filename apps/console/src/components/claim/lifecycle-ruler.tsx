'use client'

import type { ClaimDetail, TimelineEvent } from '@pine/core'
import { formatDate, timeRemaining } from '@pine/core'
import { cn } from '@/lib/cn'

interface Mark {
  id: string
  at: number
  label: string
  detail?: string
  kind: 'milestone' | 'event'
  scheduled?: boolean
  tone?: 'deadline' | 'oracle' | 'flare' | 'default'
}

const EVENT_TONE: Partial<Record<TimelineEvent['kind'], Mark['tone']>> = {
  evidence_deadline: 'deadline',
  oracle_opened: 'oracle',
  answer_challenged: 'flare',
  arbitration_requested: 'flare',
}

function collectMarks(claim: ClaimDetail): Mark[] {
  const marks: Mark[] = []
  const seen = new Set<string>()
  const push = (m: Mark) => {
    if (!Number.isFinite(m.at)) return
    const key = `${m.label}-${Math.round(m.at / 60000)}`
    if (seen.has(key)) return
    seen.add(key)
    marks.push(m)
  }
  push({ id: 'created', at: Date.parse(claim.createdAt), label: 'Published', kind: 'milestone' })
  push({ id: 'deadline', at: Date.parse(claim.evidenceDeadline), label: 'Evidence deadline', kind: 'milestone', tone: 'deadline', scheduled: Date.parse(claim.evidenceDeadline) > Date.now() })
  if (claim.oracle) {
    push({ id: 'opening', at: Date.parse(claim.oracle.openingTime), label: 'Oracle opens', kind: 'milestone', tone: 'oracle', scheduled: Date.parse(claim.oracle.openingTime) > Date.now() })
    if (claim.oracle.finalizesAt && !claim.oracle.isFinalized)
      push({ id: 'finalizes', at: Date.parse(claim.oracle.finalizesAt), label: 'Answer finalizes if unchallenged', kind: 'milestone', scheduled: true })
  }
  for (const e of claim.timeline) {
    if (e.kind === 'evidence_deadline' || e.kind === 'oracle_opened' || e.kind === 'drafted') continue
    push({ id: e.id, at: Date.parse(e.at), label: e.title, detail: e.detail, kind: 'event', scheduled: e.scheduled, tone: EVENT_TONE[e.kind] ?? 'default' })
  }
  return marks.sort((a, b) => a.at - b.at)
}

/** Assigns each label a row so labels closer than `minGap` (in %) do not collide. */
function assignRows(positions: number[], minGap: number, maxRows: number) {
  const lastInRow: number[] = []
  return positions.map((p) => {
    for (let r = 0; r < maxRows; r++) {
      if (lastInRow[r] === undefined || p - lastInRow[r]! >= minGap) {
        lastInRow[r] = p
        return r
      }
    }
    lastInRow[maxRows - 1] = p
    return maxRows - 1
  })
}

/**
 * Lifecycle ruler: the claim's whole life drawn on one graduated time axis.
 * Milestones (deadline, oracle opening, finalization) sit above; recorded events below; a resin needle marks now.
 */
export function LifecycleRuler({ claim, now }: { claim: ClaimDetail; now: Date }) {
  const marks = collectMarks(claim)
  const n = now.getTime()
  const min = Math.min(...marks.map((m) => m.at), n)
  const rawMax = Math.max(...marks.map((m) => m.at), n)
  const span = Math.max(rawMax - min, 3600_000)
  const max = rawMax + span * 0.04
  const pct = (t: number) => ((t - min) / (max - min)) * 100
  const milestones = marks.filter((m) => m.kind === 'milestone')
  // Events closer than ~7% of the axis are clustered under one marker so labels never collide.
  const events: (Mark & { more: Mark[] })[] = []
  for (const e of marks.filter((m) => m.kind === 'event')) {
    const last = events[events.length - 1]
    if (last && pct(e.at) - pct(last.at) < 7) last.more.push(e)
    else events.push({ ...e, more: [] })
  }
  const mRows = assignRows(milestones.map((m) => pct(m.at)), 17, 3)
  const eRows = assignRows(events.map((m) => pct(m.at)), 16, 2)
  const topRows = Math.max(1, ...mRows.map((r) => r + 1))
  const bottomRows = events.length ? Math.max(1, ...eRows.map((r) => r + 1)) : 0
  const nowPct = pct(n)
  const tickCount = 96

  return (
    <div>
      {/* Desktop ruler */}
      <div className="relative hidden md:block" style={{ paddingTop: topRows * 34 + 6, paddingBottom: bottomRows * 30 + 4 }}>
        {milestones.map((m, i) => {
          const p = pct(m.at)
          const right = p > 70
          return (
            <div
              key={m.id}
              className="absolute"
              style={{ left: `${p}%`, top: mRows[i]! * 34, bottom: '50%' }}
            >
              <div className={cn('absolute bottom-0 top-[30px] w-px', m.tone === 'deadline' ? 'bg-bark' : 'bg-line-strong')} />
              <div className={cn('absolute top-0 whitespace-nowrap', right ? 'right-0 text-right' : 'left-0')} style={{ transform: right ? 'translateX(1px)' : 'translateX(-1px)' }}>
                <p className={cn('text-[12px] font-medium leading-tight', m.tone === 'deadline' && 'text-bark', m.scheduled && 'text-muted')}>{m.label}</p>
                <p className="mono-cond tnum text-[10.5px] leading-tight text-muted">{formatDate(new Date(m.at).toISOString(), 'utc')}</p>
              </div>
            </div>
          )
        })}

        <div className="relative h-5" aria-hidden>
          <div className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />
          {Array.from({ length: tickCount + 1 }, (_, i) => {
            const p = (i / tickCount) * 100
            const past = p <= nowPct
            return (
              <span
                key={i}
                className={cn('absolute bottom-0 w-px', past ? 'bg-bark/70' : 'bg-line-strong')}
                style={{ left: `${p}%`, height: i % 8 === 0 ? 12 : 6 }}
              />
            )
          })}
          {milestones.map((m) => (
            <span
              key={m.id}
              className={cn('absolute bottom-0 h-5 w-[2px] -translate-x-1/2', m.tone === 'deadline' ? 'bg-bark' : m.tone === 'oracle' ? 'bg-slate' : 'bg-faint')}
              style={{ left: `${pct(m.at)}%` }}
            />
          ))}
          <span className="absolute -bottom-1 -top-1 w-[3px] -translate-x-1/2 rounded-full bg-resin-fill" style={{ left: `${nowPct}%` }} />
        </div>
        <span
          className={cn(
            'absolute rounded-chip bg-resin-fill px-1 text-[10px] font-semibold leading-[14px] text-[#16231f]',
            nowPct > 92 ? '-translate-x-[calc(100%+5px)]' : 'translate-x-[5px]',
          )}
          style={{ left: `${nowPct}%`, top: topRows * 34 + 6 + 1 }}
        >
          now
        </span>

        {events.map((m, i) => {
          const p = pct(m.at)
          const right = p > 70
          return (
            <div key={m.id} className="absolute" style={{ left: `${p}%`, top: `calc(${topRows * 34 + 6}px + 20px)` }}>
              <span
                className={cn(
                  'absolute -top-[5px] size-[9px] -translate-x-1/2 rounded-full border-2 border-surface',
                  [m, ...m.more].some((x) => x.tone === 'flare') ? 'bg-flare' : m.scheduled ? 'bg-line-strong' : 'bg-needle',
                )}
              />
              <div
                className={cn('absolute whitespace-nowrap text-[11.5px] leading-tight text-muted', right ? 'right-0 text-right' : 'left-0')}
                style={{ top: 10 + eRows[i]! * 30 }}
                title={[m, ...m.more].map((x) => x.label).join('\n')}
              >
                <span className="text-bark">{m.label}</span>
                {m.more.length ? <span className="ml-1 text-muted">+{m.more.length} more</span> : null}
                <br />
                <span className="mono-cond tnum text-[10px]">{formatDate(new Date(m.at).toISOString(), 'short')}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Mobile: vertical list */}
      <ol className="relative space-y-3 border-l border-line-strong pl-4 md:hidden">
        {marks.map((m) => {
          const rem = timeRemaining(new Date(m.at).toISOString(), now)
          return (
            <li key={m.id} className="relative">
              <span
                aria-hidden
                className={cn(
                  'absolute -left-[21px] top-1 size-[9px] rounded-full border-2 border-surface',
                  m.kind === 'milestone' ? 'bg-bark' : m.tone === 'flare' ? 'bg-flare' : 'bg-needle',
                  m.scheduled && 'bg-line-strong',
                )}
              />
              <p className="text-[13px] font-medium">{m.label}</p>
              <p className="mono-cond tnum text-[11px] text-muted">
                {formatDate(new Date(m.at).toISOString(), 'utc')} ({rem.past ? `${rem.label} ago` : `in ${rem.label}`})
              </p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
