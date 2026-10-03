'use client'

import type { ClaimDetail, TimelineEvent } from '@pine/core'
import { formatDate, timeRemaining } from '@pine/core'
import * as React from 'react'
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

function shortGap(ms: number) {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// Approximate glyph widths (px per character) for the ruler's label styles; generous so labels never touch.
const MILESTONE_CH = 6.4 // Archivo 12px medium
const EVENT_CH = 6.1 // Archivo 11.5px
const DATE_CH = 6.3 // Martian Mono condensed 10–10.5px
const LABEL_GAP = 14

interface Placed {
  row: number
  align: 'left' | 'right'
  from: number
  to: number
  x: number
}

/**
 * Places labels in rows so no two overlap and no milestone line (drawn from a label down to the axis)
 * crosses another label's text. Returns null for a label that fits in no row.
 */
function layoutLabels(items: { x: number; w: number }[], width: number, maxRows: number, withLines: boolean): (Placed | null)[] {
  const placed: Placed[] = []
  return items.map(({ x, w }) => {
    const align: Placed['align'] = x + w > width && x - w >= 0 ? 'right' : 'left'
    const from = align === 'left' ? x - 2 : x - w
    const to = align === 'left' ? x + w : x + 2
    for (let row = 0; row < maxRows; row++) {
      const clash = placed.some((o) => {
        if (o.row === row && from < o.to + LABEL_GAP && to + LABEL_GAP > o.from) return true
        if (!withLines) return false
        // A line from a label above passes down through this row; this label's line passes through rows below.
        if (o.row < row && o.x > from - 6 && o.x < to + 6) return true
        if (o.row > row && x > o.from - 6 && x < o.to + 6) return true
        return false
      })
      if (!clash) {
        const p = { row, align, from, to, x }
        placed.push(p)
        return p
      }
    }
    return null
  })
}

/** Width of a container, tracked with ResizeObserver (desktop ruler only). */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = React.useRef<T>(null)
  const [w, setW] = React.useState(fallback)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (e && e.contentRect.width > 0) setW(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/**
 * Lifecycle ruler: the claim's whole life drawn on one graduated time axis.
 * Milestones (deadline, oracle opening, finalization) sit above; recorded events below; a resin needle marks now.
 */
export function LifecycleRuler({ claim, now }: { claim: ClaimDetail; now: Date }) {
  const [boxRef, width] = useWidth<HTMLDivElement>(820)
  const marks = collectMarks(claim)
  const n = now.getTime()
  const min = Math.min(...marks.map((m) => m.at), n)
  const rawMax = Math.max(...marks.map((m) => m.at), n)
  const span = Math.max(rawMax - min, 3600_000)
  const max = rawMax + span * 0.04
  const pct = (t: number) => ((t - min) / (max - min)) * 100
  const px = (t: number) => (pct(t) / 100) * width

  // Milestones too close to label separately (often the evidence deadline and the oracle opening) share one
  // label: "Evidence deadline, oracle opens 1h later". Each keeps its own tick on the axis.
  const milestones: (Mark & { members: Mark[] })[] = []
  for (const m of marks.filter((x) => x.kind === 'milestone')) {
    const near = milestones.find((o) => Math.abs(px(o.at) - px(m.at)) < 44)
    if (near) {
      const gap = m.at - near.at
      const lower = `${m.label.charAt(0).toLowerCase()}${m.label.slice(1)}`
      near.label = `${near.label}, ${lower}${gap >= 60_000 ? ` ${shortGap(gap)} later` : ''}`
      near.members.push(m)
      if (m.tone === 'deadline') near.tone = 'deadline'
    } else milestones.push({ ...m, members: [m] })
  }
  const mWidth = (m: Mark) => Math.max(m.label.length * MILESTONE_CH, 20 * DATE_CH)
  let mPlaced = layoutLabels(milestones.map((m) => ({ x: px(m.at), w: mWidth(m) })), width, 3, true)
  // Anything that still does not fit goes on a fourth row rather than overlapping.
  mPlaced = mPlaced.map((p, i) => p ?? { row: 3, align: px(milestones[i]!.at) > width * 0.6 ? 'right' : 'left', from: 0, to: 0, x: px(milestones[i]!.at) })

  // Events: cluster those that are close on the axis, then merge any that cannot be placed into the previous one.
  let events: (Mark & { more: Mark[] })[] = []
  for (const e of marks.filter((m) => m.kind === 'event')) {
    const last = events[events.length - 1]
    if (last && px(e.at) - px(last.at) < 18) last.more.push(e)
    else events.push({ ...e, more: [] })
  }
  const eWidth = (e: Mark & { more: Mark[] }) => Math.max((e.label.length + (e.more.length ? 8 : 0)) * EVENT_CH, 12 * DATE_CH)
  let ePlaced = layoutLabels(events.map((e) => ({ x: px(e.at), w: eWidth(e) })), width, 2, false)
  for (let guard = 0; guard < 12 && ePlaced.some((p) => !p); guard++) {
    const i = ePlaced.findIndex((p) => !p)
    const into = Math.max(0, i - 1)
    if (i === 0) break
    events[into]!.more.push(events[i]!, ...events[i]!.more)
    events = events.filter((_, j) => j !== i)
    ePlaced = layoutLabels(events.map((e) => ({ x: px(e.at), w: eWidth(e) })), width, 2, false)
  }
  const topRows = Math.max(1, ...mPlaced.map((p) => (p?.row ?? 0) + 1))
  const bottomRows = events.length ? Math.max(1, ...ePlaced.map((p) => (p?.row ?? 0) + 1)) : 0
  const nowPct = pct(n)
  const tickCount = 96

  return (
    <div>
      {/* Desktop ruler */}
      <div ref={boxRef} className="relative hidden md:block" style={{ paddingTop: topRows * 34 + 6, paddingBottom: bottomRows * 30 + 4 }}>
        {milestones.map((m, i) => {
          const p = pct(m.at)
          const right = mPlaced[i]?.align === 'right'
          return (
            <div
              key={m.id}
              className="absolute"
              style={{ left: `${p}%`, top: (mPlaced[i]?.row ?? 0) * 34, bottom: '50%' }}
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
          {milestones.flatMap((g) => g.members).map((m) => (
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
          const right = ePlaced[i]?.align === 'right'
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
                style={{ top: 10 + (ePlaced[i]?.row ?? 0) * 30 }}
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

      {/* Mobile: the vertical list is the ruler. Desktop: the same list, folded, so every clustered event is reachable. */}
      <div className="md:hidden">
        <EventList marks={marks} now={now} />
      </div>
      <details className="group mt-3 hidden md:block">
        <summary className="w-fit cursor-pointer text-[12.5px] text-needle hover:underline">
          <span className="group-open:hidden">List all {marks.length} lifecycle events</span>
          <span className="hidden group-open:inline">Hide the event list</span>
        </summary>
        <div className="mt-3">
          <EventList marks={marks} now={now} />
        </div>
      </details>
    </div>
  )
}

function EventList({ marks, now }: { marks: Mark[]; now: Date }) {
  return (
    <ol className="relative space-y-3 border-l border-line-strong pl-4">
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
            <p className="text-[13px] font-medium">
              {m.label}
              {m.scheduled ? <span className="ml-1.5 text-[12px] font-normal text-muted">scheduled</span> : null}
            </p>
            {m.detail ? <p className="wrap-anywhere line-clamp-2 max-w-[68ch] text-[12.5px] text-muted" title={m.detail}>{m.detail}</p> : null}
            <p className="mono-cond tnum text-[11px] text-muted">
              {formatDate(new Date(m.at).toISOString(), 'utc')} ({rem.past ? `${rem.label} ago` : `in ${rem.label}`})
            </p>
          </li>
        )
      })}
    </ol>
  )
}
