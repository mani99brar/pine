'use client'

import { Check, ChevronDown, CircleAlert, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { WIZARD_STEPS, stepIndex, type WizardStep } from '@/lib/wizard'
import { useWizard } from './context'

type RegisterState = 'done' | 'current' | 'issues' | 'todo' | 'locked'

function useRegister() {
  const w = useWizard()
  const cur = stepIndex(w.step)
  return WIZARD_STEPS.map((s, i) => {
    const issues = w.issuesFor(s.id).length
    let state: RegisterState = 'todo'
    if (s.id === w.step) state = 'current'
    else if (s.id === 'publish' && w.issues.length > 0) state = 'locked'
    else if (issues > 0 && (i < cur || w.attempted.has(s.id))) state = 'issues'
    else if (i < cur || (issues === 0 && w.attempted.has(s.id))) state = 'done'
    return { ...s, n: i + 1, state, issues }
  })
}

function Marker({ state, n }: { state: RegisterState; n: number }) {
  const base = 'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-[800] tabular'
  if (state === 'done')
    return (
      <span className={cn(base, 'bg-ink text-white')}>
        <Check aria-hidden className="size-4" strokeWidth={3} />
      </span>
    )
  if (state === 'current') return <span className={cn(base, 'bg-violet text-white ring-4 ring-violet-line')}>{n}</span>
  if (state === 'issues')
    return (
      <span className={cn(base, 'bg-red text-white')}>
        <CircleAlert aria-hidden className="size-4" strokeWidth={2.75} />
      </span>
    )
  if (state === 'locked')
    return (
      <span className={cn(base, 'border-2 border-rule-strong bg-sheet text-graphite')}>
        <Lock aria-hidden className="size-3.5" />
      </span>
    )
  return <span className={cn(base, 'border-2 border-rule-strong bg-sheet text-graphite')}>{n}</span>
}

const SR: Record<RegisterState, string> = {
  done: 'complete',
  current: 'current step',
  issues: 'needs attention',
  todo: 'not started',
  locked: 'available once every earlier step is complete',
}

/** The always-visible step overview. Every step can be revisited. */
export function StepRegister({ savedLabel }: { savedLabel: React.ReactNode }) {
  const w = useWizard()
  const items = useRegister()
  return (
    <nav aria-label="Filing steps">
      <h2 className="mb-3 text-sm font-bold text-graphite">Filing steps</h2>
      <ol>
        {items.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => w.goTo(s.id)}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className={cn(
                'flex w-full items-start gap-3 rounded-xs py-1.5 pr-2 pl-1 text-left',
                s.state === 'current' ? 'bg-violet-wash' : 'hover:bg-sheet',
              )}
            >
              <Marker state={s.state} n={s.n} />
              <span className="min-w-0 pt-0.5">
                <span className={cn('block leading-6 font-bold', s.state === 'current' ? 'text-violet' : s.state === 'todo' || s.state === 'locked' ? 'text-graphite' : 'text-ink')}>
                  {s.title}
                </span>
                <span className="sr-only">, {SR[s.state]}</span>
                {s.state === 'issues' ? (
                  <span className="block text-sm text-red">
                    {s.issues} thing{s.issues === 1 ? '' : 's'} to fix
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-5 border-t border-rule pt-3 text-sm text-graphite">{savedLabel}</div>
    </nav>
  )
}

/** Mobile header: "Step 3 of 8: Claim" with the full register in a disclosure. */
export function StepRegisterCompact() {
  const w = useWizard()
  const items = useRegister()
  const cur = items.find((s) => s.id === w.step)!
  return (
    <details className="group border border-rule bg-sheet">
      <summary className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm text-graphite">
            Step {cur.n} of {items.length}
          </span>
          <span className="block font-bold text-violet">{cur.title}</span>
        </span>
        <span className="flex items-center gap-1 text-sm font-bold text-violet">
          All steps <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="mb-3 flex gap-1 px-4" aria-hidden>
        {items.map((s) => (
          <span
            key={s.id}
            className={cn(
              'h-1.5 flex-1 rounded-[1px]',
              s.state === 'done' ? 'bg-ink' : s.state === 'current' ? 'bg-violet' : s.state === 'issues' ? 'bg-red' : 'bg-rule',
            )}
          />
        ))}
      </div>
      <ol className="border-t border-rule px-2 py-2">
        {items.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={(e) => {
                ;(e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open')
                w.goTo(s.id as WizardStep)
              }}
              aria-current={s.state === 'current' ? 'step' : undefined}
              className={cn('flex w-full items-center gap-3 rounded-xs px-2 py-1.5 text-left', s.state === 'current' && 'bg-violet-wash')}
            >
              <Marker state={s.state} n={s.n} />
              <span className="font-bold">{s.title}</span>
              {s.state === 'issues' ? <span className="ml-auto text-sm text-red">{s.issues} to fix</span> : null}
            </button>
          </li>
        ))}
      </ol>
    </details>
  )
}
