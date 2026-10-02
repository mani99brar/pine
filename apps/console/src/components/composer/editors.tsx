'use client'

import * as React from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from '@/components/ui/field'

/** Editable list of strings. Enter in the last row adds a row; Backspace on an empty row removes it. */
export function ListEditor({
  id,
  value,
  onChange,
  placeholder,
  addLabel = 'Add item',
  mono,
  onBlur,
  disabled,
}: {
  id: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  addLabel?: string
  mono?: boolean
  onBlur?: () => void
  disabled?: boolean
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([])
  const focusAt = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (focusAt.current !== null) {
      refs.current[focusAt.current]?.focus()
      focusAt.current = null
    }
  })
  const rows = value.length ? value : []
  return (
    <div className="flex flex-col gap-1.5" id={id}>
      {rows.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span aria-hidden className="h-px w-2.5 shrink-0 bg-faint" />
          <Input
            ref={(el) => {
              refs.current[i] = el
            }}
            value={v}
            mono={mono}
            disabled={disabled}
            aria-label={`${placeholder ?? 'Item'} ${i + 1}`}
            placeholder={placeholder}
            onBlur={onBlur}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const next = [...rows]
                next.splice(i + 1, 0, '')
                focusAt.current = i + 1
                onChange(next)
              } else if (e.key === 'Backspace' && v === '' && rows.length > 0) {
                e.preventDefault()
                focusAt.current = Math.max(0, i - 1)
                onChange(rows.filter((_, j) => j !== i))
              }
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="rounded-chip p-1 text-faint hover:bg-sunken hover:text-flare"
            aria-label={`Remove item ${i + 1}`}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          focusAt.current = rows.length
          onChange([...rows, ''])
        }}
        className="flex h-7 w-fit items-center gap-1.5 rounded-ctl px-1.5 text-[12.5px] text-needle hover:bg-needle-soft disabled:opacity-50"
      >
        <Plus size={13} aria-hidden /> {addLabel}
      </button>
    </div>
  )
}

/** Key/value editor for non-secret configuration (hashed into configHash). */
export function KeyValueEditor({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  disabled?: boolean
}) {
  const [rows, setRows] = React.useState<[string, string][]>(() => Object.entries(value))
  const lastSent = React.useRef(JSON.stringify(value))
  React.useEffect(() => {
    const incoming = JSON.stringify(value)
    if (incoming !== lastSent.current) {
      lastSent.current = incoming
      setRows(Object.entries(value))
    }
  }, [value])
  const commit = (next: [string, string][]) => {
    setRows(next)
    const obj: Record<string, string> = {}
    for (const [k, v] of next) if (k.trim()) obj[k.trim()] = v
    lastSent.current = JSON.stringify(obj)
    onChange(obj)
  }
  const secretish = (k: string) => /(secret|token|password|passwd|private|api[_-]?key|mnemonic|seed)/i.test(k)
  return (
    <div id={id} className="flex flex-col gap-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5">
          <Input
            mono
            value={k}
            disabled={disabled}
            placeholder="KEY"
            aria-label={`Config key ${i + 1}`}
            aria-invalid={secretish(k) || undefined}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
          />
          <Input
            mono
            value={v}
            disabled={disabled}
            placeholder="value"
            aria-label={`Config value ${i + 1}`}
            onChange={(e) => commit(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => commit(rows.filter((_, j) => j !== i))}
            className="rounded-chip p-1 text-faint hover:bg-sunken hover:text-flare"
            aria-label={`Remove config ${k || i + 1}`}
          >
            <X size={13} aria-hidden />
          </button>
          {secretish(k) ? (
            <p className="col-span-3 text-xs text-flare">This key looks like a secret. Configuration is published; never include secrets.</p>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => commit([...rows, ['', '']])}
        className="flex h-7 w-fit items-center gap-1.5 rounded-ctl px-1.5 text-[12.5px] text-needle hover:bg-needle-soft disabled:opacity-50"
      >
        <Plus size={13} aria-hidden /> Add config value
      </button>
    </div>
  )
}

/** Absolute UTC datetime input. The value is an ISO string ending in Z; the control never uses local time. */
export function UtcDateTimeInput({
  id,
  value,
  onChange,
  onBlur,
  invalid,
  disabled,
  min,
}: {
  id: string
  value: string | undefined
  onChange: (iso: string) => void
  onBlur?: () => void
  invalid?: boolean
  disabled?: boolean
  min?: string
}) {
  const local = value ? value.slice(0, 16) : ''
  const [localTz, setLocalTz] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!value) return setLocalTz(null)
    try {
      setLocalTz(
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }).format(new Date(value)),
      )
    } catch {
      setLocalTz(null)
    }
  }, [value])
  return (
    <div className="flex flex-col gap-1">
      <div className={cn('flex items-stretch overflow-hidden rounded-ctl border bg-surface focus-within:border-needle', invalid ? 'border-flare' : 'border-line-strong')}>
        <input
          id={id}
          type="datetime-local"
          step={60}
          value={local}
          min={min ? min.slice(0, 16) : undefined}
          disabled={disabled}
          onBlur={onBlur}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-tz`}
          onChange={(e) => {
            const v = e.target.value
            if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) onChange(`${v}:00Z`)
          }}
          className="tnum mono-cond h-8 min-w-0 flex-1 bg-transparent px-2.5 text-[12.5px] outline-none"
        />
        <span id={`${id}-tz`} className="stretch-cond flex items-center border-l border-line bg-sunken px-2 text-[12px] font-semibold text-bark">
          UTC
        </span>
      </div>
      {localTz ? <p className="text-[11.5px] text-muted">Your local time: {localTz}</p> : null}
    </div>
  )
}
