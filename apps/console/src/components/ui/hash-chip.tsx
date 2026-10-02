'use client'

import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useClipboard } from './copy-button'

function shorten(v: string, head: number, tail: number) {
  if (v.length <= head + tail + 1) return v
  return `${v.slice(0, head)}…${v.slice(-tail)}`
}

/**
 * A labelled, copyable hash. When `value` changes, the characters that changed
 * flash on a resin fill (the console's signature "recompute" motion).
 */
export function HashChip({
  label,
  value,
  head = 6,
  tail = 4,
  className,
  pending,
  title,
  tone = 'default',
}: {
  label?: string
  value: string | undefined
  head?: number
  tail?: number
  className?: string
  /** Shown when value is undefined (e.g. "fill source") */
  pending?: string
  title?: string
  tone?: 'default' | 'frozen'
}) {
  const { copy, copied } = useClipboard()
  const prev = React.useRef<string | undefined>(value)
  const [diff, setDiff] = React.useState<{ key: number; changed: boolean[] } | null>(null)
  const [changes, setChanges] = React.useState(0)

  const short = value ? shorten(value, head, tail) : undefined

  React.useEffect(() => {
    const before = prev.current
    prev.current = value
    if (!value || before === value) return
    const a = before ? shorten(before, head, tail) : ''
    const b = shorten(value, head, tail)
    const changed = Array.from(b).map((ch, i) => a[i] !== ch)
    setDiff({ key: Date.now(), changed })
    setChanges((c) => c + 1)
  }, [value, head, tail])

  return (
    <span
      className={cn(
        'group inline-flex max-w-full items-stretch overflow-hidden rounded-chip border text-xs leading-none',
        tone === 'frozen' ? 'border-slate/40 bg-slate-soft' : 'border-line bg-surface',
        className,
      )}
      title={title ?? value}
    >
      {label ? (
        <span className="stretch-cond flex items-center border-r border-line px-1.5 text-[11px] text-muted">{label}</span>
      ) : null}
      {short ? (
        <button
          type="button"
          onClick={() => value && void copy(value, label ? `${label} hash` : 'hash')}
          className="mono-cond relative flex min-w-0 items-center gap-1 px-1.5 py-1 text-[11.5px] text-bark hover:bg-sunken"
          aria-label={`Copy ${label ?? 'hash'} ${value}`}
        >
          <span className="truncate" aria-hidden>
            {diff
              ? Array.from(short).map((ch, i) => (
                  <span
                    key={`${diff.key}-${i}`}
                    className={cn(diff.changed[i] && 'animate-resin-flash rounded-[2px] resin-static')}
                  >
                    {ch}
                  </span>
                ))
              : short}
          </span>
          {changes > 0 ? (
            <span className="sr-only" aria-live="polite">
              {label} hash recomputed
            </span>
          ) : null}
          {copied ? (
            <Check size={11} className="shrink-0 text-needle" aria-hidden />
          ) : (
            <Copy size={11} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
          )}
        </button>
      ) : (
        <span className="stretch-cond flex items-center px-1.5 py-1 text-[11px] italic text-faint">{pending ?? 'pending'}</span>
      )}
    </span>
  )
}
