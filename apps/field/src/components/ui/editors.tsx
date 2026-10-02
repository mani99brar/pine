'use client'

import { useId, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Input } from './form'
import { cn } from '@/lib/cn'

/** Editable list of short strings (scope items, assumptions, setup steps). */
export function ListEditor({
  value,
  onChange,
  placeholder,
  addLabel = 'Add item',
  label,
  mono,
  max = 30,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  addLabel?: string
  label: string
  mono?: boolean
  max?: number
}) {
  const id = useId()
  // Local rows keep blank lines while editing; the draft only ever receives non-empty items.
  const [rows, setRows] = useState<string[]>(value.length ? value : [''])
  const clean = (r: string[]) => r.map((x) => x.trim()).filter(Boolean)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (JSON.stringify(clean(rows)) !== JSON.stringify(value)) setRows(value.length ? value : [''])
  }
  const items = rows
  const push = (next: string[]) => {
    setRows(next.length ? next : [''])
    onChange(clean(next))
  }
  const set = (i: number, v: string) => {
    const next = [...items]
    next[i] = v
    push(next)
  }
  return (
    <div role="group" aria-label={label} className="grid gap-2">
      {items.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <span aria-hidden className="t-figure w-5 shrink-0 text-right text-[0.85rem] text-ink-3">
            {i + 1}
          </span>
          <Input
            id={`${id}-${i}`}
            aria-label={`${label} ${i + 1}`}
            value={v}
            placeholder={i === 0 ? placeholder : undefined}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (items.length < max) {
                  const next = [...items]
                  next.splice(i + 1, 0, '')
                  push(next)
                  requestAnimationFrame(() => document.getElementById(`${id}-${i + 1}`)?.focus())
                }
              }
            }}
            className={cn('h-9', mono && 'font-mono text-[0.85rem]')}
          />
          <button
            type="button"
            onClick={() => push(items.filter((_, j) => j !== i))}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] text-ink-3 hover:bg-ink/[0.07] hover:text-ink"
            aria-label={`Remove ${label} ${i + 1}`}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={() => push([...items, ''])} className="ml-7 inline-flex w-fit items-center gap-1.5 text-[0.84rem] font-[620] text-ink-2 hover:text-ink">
          <Plus size={14} aria-hidden /> {addLabel}
        </button>
      )}
    </div>
  )
}

/** Key/value rows for non-secret configuration. */
export function KeyValueEditor({ value, onChange, label }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; label: string }) {
  const rows = Object.entries(value)
  const list = rows.length ? rows : [['', ''] as [string, string]]
  const commit = (next: [string, string][]) => {
    const out: Record<string, string> = {}
    for (const [k, v] of next) if (k.trim() || v.trim()) out[k] = v
    onChange(out)
  }
  return (
    <div role="group" aria-label={label} className="grid gap-2">
      {list.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] items-center gap-2">
          <Input
            aria-label={`${label} key ${i + 1}`}
            value={k}
            placeholder={i === 0 ? 'KEY' : undefined}
            onChange={(e) => {
              const next = [...list]
              next[i] = [e.target.value, v]
              commit(next)
            }}
            className="h-9 font-mono text-[0.82rem]"
          />
          <Input
            aria-label={`${label} value ${i + 1}`}
            value={v}
            placeholder={i === 0 ? 'value' : undefined}
            onChange={(e) => {
              const next = [...list]
              next[i] = [k, e.target.value]
              commit(next)
            }}
            className="h-9 font-mono text-[0.82rem]"
          />
          <button
            type="button"
            onClick={() => commit(list.filter((_, j) => j !== i))}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] text-ink-3 hover:bg-ink/[0.07] hover:text-ink"
            aria-label={`Remove ${label} row ${i + 1}`}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => commit([...list, [`KEY_${list.length + 1}`, '']])} className="inline-flex w-fit items-center gap-1.5 text-[0.84rem] font-[620] text-ink-2 hover:text-ink">
        <Plus size={14} aria-hidden /> Add a setting
      </button>
    </div>
  )
}
