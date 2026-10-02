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

const HEX = /(0x[0-9a-fA-F]{8,}|\b[0-9a-f]{40}\b)/g

/** Long hex values (hashes, SHAs, addresses) are set in mono so they read character by character. */
function WithHex({ text }: { text: string }) {
  const parts = text.split(HEX)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-[0.8em] tracking-tight break-all">
            {p}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
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
  collapseAfter,
  compact = false,
}: {
  text: string
  annotations: Annotation[]
  idPrefix?: string
  className?: string
  notesTitle?: string
  layout?: 'side' | 'stacked'
  /** Show only the first N notes until the reader asks for all of them */
  collapseAfter?: number
  /** Slightly smaller record type, for previews */
  compact?: boolean
}) {
  const [active, setActive] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const visible = collapseAfter && !showAll ? annotations.slice(0, collapseAfter) : annotations
  const { segments, found } = useMemo(() => segment(text, annotations), [text, annotations])

  return (
    <div className={cn('grid gap-x-10 gap-y-6', layout === 'side' && 'xl:grid-cols-[minmax(0,1fr)_21rem]', className)}>
      <blockquote
        className={cn(
          'record self-start border-l-4 border-ink pl-5 text-ink sm:pl-6',
          compact && 'text-[1.0625rem] leading-[1.8rem]',
          layout === 'side' && 'xl:sticky xl:top-6',
        )}
      >
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
                <WithHex text={s.text} />
                <sup className="term-mark">{s.n}</sup>
              </a>
            ) : (
              <span key={i}>
                <WithHex text={s.text} />
              </span>
            ),
          )}
        </p>
      </blockquote>
      <div>
        <h3 className="text-sm font-bold text-graphite">{notesTitle}</h3>
        <ol className={cn('mt-2', layout === 'stacked' ? 'grid gap-x-4 gap-y-1 sm:grid-cols-2' : 'space-y-1')}>
          {visible.map((a, i) => {
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
        {collapseAfter && annotations.length > collapseAfter ? (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            aria-expanded={showAll}
            className="mt-2 text-sm font-bold text-violet underline underline-offset-4"
          >
            {showAll ? 'Show fewer' : `See all ${annotations.length} binding terms`}
          </button>
        ) : null}
      </div>
    </div>
  )
}
