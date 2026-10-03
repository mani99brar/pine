'use client'

import { useState, type ReactNode } from 'react'
import type { ComposerStage } from '@pine/core'
import type { ClaimComposer } from '@pine/react'
import { ArrowLeft, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'

export type UiStep = 'source' | 'policy' | 'claim' | 'environment' | 'deadlines' | 'funding' | 'review' | 'publish'

export const UI_STEPS: { id: UiStep; label: string; stage: ComposerStage; title: string }[] = [
  { id: 'source', label: 'Source', stage: 'source', title: 'Pin the exact commit' },
  { id: 'policy', label: 'Policy', stage: 'policy', title: 'Choose a versioned policy' },
  { id: 'claim', label: 'Claim', stage: 'claim', title: 'State one bounded claim' },
  { id: 'environment', label: 'Environment', stage: 'claim', title: 'Pin the reproduction environment' },
  { id: 'deadlines', label: 'Deadlines and oracle', stage: 'deadlines', title: 'Set the deadline and oracle' },
  { id: 'funding', label: 'Funding', stage: 'funding', title: 'Fund the market' },
  { id: 'review', label: 'Review', stage: 'review', title: 'Review the crystal before it is sealed' },
  { id: 'publish', label: 'Publish', stage: 'publish', title: 'Publish and seal' },
]

export const stepIndex = (s: UiStep) => UI_STEPS.findIndex((x) => x.id === s)

/** Validation issues for a UI step (environment issues live on the claim stage in core). */
export function issuesFor(c: ClaimComposer, step: UiStep) {
  return c.validation.issues.filter((i) => {
    const env = i.path.startsWith('spec.environment')
    if (step === 'environment') return env
    if (step === 'claim') return i.stage === 'claim' && !env
    const meta = UI_STEPS.find((s) => s.id === step)
    return meta ? i.stage === meta.stage : false
  })
}

export function issueFor(c: ClaimComposer, path: string): string | undefined {
  return c.validation.issues.find((i) => i.path === path || i.path.startsWith(`${path}.`))?.message
}

export interface StepNav {
  step: UiStep
  go: (s: UiStep) => void
}

export function StageHeader({ step, children }: { step: UiStep; children?: ReactNode }) {
  const i = stepIndex(step)
  const meta = UI_STEPS[i] ?? UI_STEPS[0]!
  return (
    <div className="mb-7">
      <p className="text-[0.84375rem] text-lumen-3">
        Step <span className="tnum">{i + 1}</span> of {UI_STEPS.length}
      </p>
      <h2 id="stage-heading" tabIndex={-1} className="t-h2 mt-1 outline-none">
        {meta.title}
      </h2>
      {children && <div className="mt-3 max-w-[64ch] text-[0.96875rem] leading-[1.6] text-lumen-2">{children}</div>}
    </div>
  )
}

export function StageIssues({ c, step, className }: { c: ClaimComposer; step: UiStep; className?: string }) {
  const issues = issuesFor(c, step)
  if (!issues.length) return null
  return (
    <div className={cn('cut-md border border-[rgba(255,182,72,0.35)] bg-[rgba(255,182,72,0.05)] px-4 py-3', className)} role="status">
      <p className="text-[0.875rem] font-semibold text-lumen">Before this facet can be cut</p>
      <ul className="mt-1.5 grid gap-1 text-[0.84375rem] text-lumen-2">
        {issues.map((i) => (
          <li key={`${i.path}-${i.message}`} className="flex gap-2">
            <span aria-hidden className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rotate-45 bg-na" />
            <span className="[overflow-wrap:anywhere]">{i.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function StageNav({ nav, nextLabel, nextDisabled, onNext }: { nav: StepNav; nextLabel?: string; nextDisabled?: boolean; onNext?: () => void }) {
  const i = stepIndex(nav.step)
  const prev = UI_STEPS[i - 1]
  const next = UI_STEPS[i + 1]
  return (
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-6">
      {prev ? (
        <Button variant="ghost" onClick={() => nav.go(prev.id)} icon={<ArrowLeft size={15} aria-hidden />}>
          {prev.label}
        </Button>
      ) : (
        <span />
      )}
      {next && (
        <Button onClick={onNext ?? (() => nav.go(next.id))} disabled={nextDisabled}>
          {nextLabel ?? `Continue to ${next.label.toLowerCase()}`}
        </Button>
      )}
    </div>
  )
}

/** Editable list of short strings (scope, assumptions, exclusions, steps). */
export function ListEditor({
  id,
  label,
  help,
  items,
  onChange,
  placeholder,
  disabled,
  mono,
}: {
  id: string
  label: string
  help?: string
  items: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v) return
    onChange([...items, v])
    setDraft('')
  }
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {help && <p className="help -mt-1 mb-2">{help}</p>}
      {items.length > 0 && (
        <ul className="mb-2 grid gap-1.5">
          {items.map((it, i) => (
            <li key={`${i}-${it}`} className="cut-sm flex items-start gap-2 border border-edge bg-void py-1.5 pl-3 pr-1">
              <input
                aria-label={`${label} ${i + 1}`}
                value={it}
                disabled={disabled}
                onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
                className={cn('min-w-0 flex-1 bg-transparent py-0.5 text-[0.9rem] text-lumen outline-none', mono && 't-code')}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen"
                aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder}
          className={cn('field', mono && 't-code')}
        />
        <Button variant="glass" onClick={add} disabled={disabled || !draft.trim()} aria-label={`Add to ${label.toLowerCase()}`} icon={<Plus size={15} aria-hidden />}>
          Add
        </Button>
      </div>
    </div>
  )
}

/** Key/value editor for non-secret configuration. */
export function KeyValueEditor({ value, onChange, disabled }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; disabled?: boolean }) {
  const rows = Object.entries(value)
  const set = (i: number, k: string, v: string) => {
    const next: Record<string, string> = {}
    rows.forEach(([rk, rv], j) => {
      if (j === i) next[k] = v
      else next[rk] = rv
    })
    onChange(next)
  }
  return (
    <div className="grid gap-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] gap-2">
          <input aria-label={`Configuration key ${i + 1}`} className="field t-code" value={k} disabled={disabled} onChange={(e) => set(i, e.target.value, v)} placeholder="KEY" />
          <input aria-label={`Configuration value ${i + 1}`} className="field t-code" value={v} disabled={disabled} onChange={(e) => set(i, k, e.target.value)} placeholder="value" />
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[4px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen"
            aria-label={`Remove configuration ${k || i + 1}`}
            onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}
          >
            <X size={15} aria-hidden />
          </button>
        </div>
      ))}
      <Button
        variant="glass"
        size="sm"
        className="w-fit"
        disabled={disabled || '' in value}
        onClick={() => onChange({ ...value, '': '' })}
        icon={<Plus size={14} aria-hidden />}
      >
        Add a setting
      </Button>
      <p className="help">Non-secret values only. Keys that look like secrets are rejected.</p>
    </div>
  )
}
