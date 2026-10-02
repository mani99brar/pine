'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface Annotation {
  /** Exact substring of the question to mark; omitted or not found → note without an in-text mark */
  match?: string
  term: string
  note: ReactNode
}

interface Segment {
  text: string
  n?: number
}

function segment(text: string, annotations: Annotation[]): { segments: Segment[]; found: Set<number> } {
  const hits: { start: number; end: number; n: number }[] = []
  annotations.forEach((a, i) => {
    if (!a.match) return
    const start = text.indexOf(a.match)
    if (start < 0) return
    const end = start + a.match.length
    if (hits.some((h) => start < h.end && end > h.start)) return
    hits.push({ start, end, n: i + 1 })
  })
  hits.sort((a, b) => a.start - b.start)
  const segments: Segment[] = []
  let pos = 0
  for (const h of hits) {
    if (h.start > pos) segments.push({ text: text.slice(pos, h.start) })
    segments.push({ text: text.slice(h.start, h.end), n: h.n })
    pos = h.end
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) })
  return { segments, found: new Set(hits.map((h) => h.n)) }
}

/**
 * The question as an investigator reads it: exact text, binding terms marked, numbered notes beside it.
 * Hovering or focusing a note highlights its term, and the reverse.
 */
export function AnnotatedQuestion({
  text,
  annotations,
  idPrefix = 'q',
  className,
  notesTitle = 'What each binding term means',
  layout = 'side',
}: {
  text: string
  annotations: Annotation[]
  idPrefix?: string
  className?: string
  notesTitle?: string
  layout?: 'side' | 'stacked'
}) {
  const [active, setActive] = useState<number | null>(null)
  const { segments, found } = useMemo(() => segment(text, annotations), [text, annotations])

  return (
    <div className={cn('grid gap-x-10 gap-y-6', layout === 'side' && 'xl:grid-cols-[minmax(0,1fr)_21rem]', className)}>
      <blockquote className="record border-l-4 border-ink pl-5 text-ink sm:pl-6" cite="#manifest">
        <p className="untrusted">
          {segments.map((s, i) =>
            s.n ? (
              <a
                key={i}
                href={`#${idPrefix}-note-${s.n}`}
                className="term text-ink no-underline"
                data-active={active === s.n}
                onMouseEnter={() => setActive(s.n!)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(s.n!)}
                onBlur={() => setActive(null)}
                aria-describedby={`${idPrefix}-note-${s.n}`}
              >
                {s.text}
                <sup className="term-mark">{s.n}</sup>
              </a>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </p>
      </blockquote>
      <div>
        <h3 className="text-sm font-bold text-graphite">{notesTitle}</h3>
        <ol className="mt-2 space-y-1">
          {annotations.map((a, i) => {
            const n = i + 1
            return (
              <li
                key={n}
                id={`${idPrefix}-note-${n}`}
                tabIndex={0}
                onMouseEnter={() => setActive(n)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(n)}
                onBlur={() => setActive(null)}
                className={cn(
                  'flex gap-3 rounded-xs border-l-4 py-2 pr-2 pl-3 text-sm leading-6 transition-colors',
                  active === n ? 'border-flag bg-flag-wash' : 'border-violet-line',
                )}
              >
                <span className="w-4 shrink-0 font-[800] text-violet tabular">{n}</span>
                <span className="min-w-0">
                  <span className="block font-bold text-ink">
                    {a.term}
                    {!found.has(n) && a.match ? <span className="font-normal text-graphite"> (in the description)</span> : null}
                  </span>
                  <span className="text-graphite">{a.note}</span>
                </span>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
