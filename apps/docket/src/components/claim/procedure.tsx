'use client'

import { Check, Minus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ClaimStatus } from '@pine/core'
import { formatDate } from '@pine/core'
import { cn } from '@/lib/cn'
import type { ProcedureStage, StageState } from '@/lib/procedure'

function Marker({ state, n, animate }: { state: StageState; n: number; animate?: boolean }) {
  const base = 'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-[800] tabular'
  switch (state) {
    case 'done':
      return (
        <span className={cn(base, 'bg-ink text-white')}>
          <Check aria-hidden className="size-4" strokeWidth={3} />
        </span>
      )
    case 'current':
      return (
        <span className={cn(base, 'bg-violet text-white ring-4 ring-violet-line', animate && 'motion-safe:animate-settle')}>
          {n}
        </span>
      )
    case 'failed':
      return (
        <span className={cn(base, 'bg-red text-white')}>
          <X aria-hidden className="size-4" strokeWidth={3} />
        </span>
      )
    case 'skipped':
      return (
        <span className={cn(base, 'border-2 border-dashed border-rule-strong bg-sheet text-graphite')}>
          <Minus aria-hidden className="size-3.5" strokeWidth={3} />
        </span>
      )
    default:
      return <span className={cn(base, 'border-2 border-rule-strong bg-sheet text-graphite')}>{n}</span>
  }
}

const STATE_SR: Record<StageState, string> = {
  done: 'completed',
  current: 'current stage',
  upcoming: 'not yet reached',
  skipped: 'not needed',
  failed: 'failed',
}

/**
 * The procedural timeline, used as the claim page's navigation.
 * Vertical sticky rail at desktop; horizontal strip on small screens.
 */
export function ProcedureRail({ stages, className }: { stages: ProcedureStage[]; className?: string }) {
  return (
    <nav aria-label="Procedure" className={className}>
      <h2 className="mb-3 text-sm font-bold text-graphite">Procedure</h2>
      <ol className="relative">
        {stages.map((st, i) => {
          const last = i === stages.length - 1
          const nextDone = stages[i + 1]?.state === 'done' || stages[i + 1]?.state === 'current'
          return (
            <li key={st.id} className="relative pb-1">
              {!last ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-8 bottom-0 left-[13px] w-0.5',
                    st.state === 'done' && nextDone ? 'bg-ink' : 'border-l-2 border-dashed border-rule-strong bg-transparent',
                  )}
                />
              ) : null}
              <a
                href={`#${st.anchor}`}
                aria-current={st.state === 'current' ? 'step' : undefined}
                className={cn(
                  'group relative flex gap-3 rounded-xs py-1.5 pr-2 no-underline',
                  st.state === 'current' && 'bg-violet-wash',
                )}
              >
                <Marker state={st.state} n={st.n} animate />
                <span className="min-w-0 pt-0.5">
                  <span
                    className={cn(
                      'block leading-6 font-bold group-hover:underline group-hover:underline-offset-4',
                      st.state === 'current' ? 'text-violet' : st.state === 'upcoming' || st.state === 'skipped' ? 'text-graphite' : 'text-ink',
                    )}
                  >
                    {st.title}
                    {st.optional && st.state === 'upcoming' ? <span className="font-normal"> (if disputed)</span> : null}
                  </span>
                  <span className="block text-sm text-graphite">
                    <span className="sr-only">{STATE_SR[st.state]}. </span>
                    {st.state === 'skipped'
                      ? 'Not needed'
                      : st.at
                        ? `${st.atLabel ?? ''} ${formatDate(st.at, st.id === 'filed' || st.id === 'settlement' ? 'short' : 'long')}`.trim()
                        : st.state === 'upcoming'
                          ? 'Not yet scheduled'
                          : null}
                  </span>
                </span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Horizontal strip for small screens. Scrolls the current stage into view. */
export function ProcedureStrip({ stages, className }: { stages: ProcedureStage[]; className?: string }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="step"]')
    if (el && ref.current) {
      ref.current.scrollLeft = Math.max(0, el.offsetLeft - 16)
    }
  }, [stages])
  return (
    <nav aria-label="Procedure" className={className}>
      <ol ref={ref} className="no-scrollbar -mx-4 flex snap-x overflow-x-auto px-4 pb-1">
        {stages.map((st, i) => (
          <li key={st.id} className="flex shrink-0 snap-start items-start">
            <a
              href={`#${st.anchor}`}
              aria-current={st.state === 'current' ? 'step' : undefined}
              className={cn(
                'flex w-[7.5rem] flex-col items-start gap-1.5 rounded-xs px-1 py-1.5 no-underline',
                st.state === 'current' && 'bg-violet-wash',
              )}
            >
              <span className="flex w-full items-center">
                <Marker state={st.state} n={st.n} />
                {i < stages.length - 1 ? (
                  <span
                    aria-hidden
                    className={cn(
                      'ml-1 h-0.5 flex-1',
                      st.state === 'done' ? 'bg-ink' : 'border-t-2 border-dashed border-rule-strong',
                    )}
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-sm leading-5 font-bold',
                  st.state === 'current' ? 'text-violet' : st.state === 'upcoming' || st.state === 'skipped' ? 'text-graphite' : 'text-ink',
                )}
              >
                {st.title}
              </span>
              <span className="text-xs text-graphite">
                <span className="sr-only">{STATE_SR[st.state]}. </span>
                {st.state === 'skipped' ? 'Not needed' : st.at ? formatDate(st.at, 'short') : ''}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}

const MINI_INDEX: Record<ClaimStatus, number> = {
  draft: 0,
  publishing: 0,
  failed: 0,
  open: 1,
  awaiting_answer: 3,
  answer_proposed: 4,
  disputed: 4,
  arbitration: 5,
  resolved: 7,
  settled: 8,
}

/** Eight-segment progress glyph for docket rows. */
export function ProcedureMini({ status, className }: { status: ClaimStatus; className?: string }) {
  const cur = MINI_INDEX[status]
  const failed = status === 'failed'
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)} aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-2.5 rounded-[1px]',
            failed && i === 0
              ? 'bg-red'
              : i < cur
                ? 'bg-ink'
                : i === cur
                  ? 'bg-violet ring-2 ring-violet-line'
                  : 'bg-rule',
          )}
        />
      ))}
    </span>
  )
}
