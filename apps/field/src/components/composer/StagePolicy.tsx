'use client'

import Link from 'next/link'
import type { PolicyVersion } from '@pine/core'
import { POLICIES, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { usePolicies, type ClaimComposer } from '@pine/react'
import { Check, Lock } from 'lucide-react'
import { PolicyShape } from '@/components/glyphs/PolicyMark'
import { Chip } from '@/components/ui/interactive'
import { StageHeader, StageIssues, StageNav } from './shared'
import { cn } from '@/lib/cn'

function PolicyCard({ p, selected, onSelect, disabled }: { p: PolicyVersion; selected: boolean; onSelect: () => void; disabled?: boolean }) {
  const gated = p.status === 'gated'
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={gated || disabled}
      tabIndex={gated || disabled ? -1 : 0}
      onClick={() => !gated && !disabled && onSelect()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !gated && !disabled) {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'relative flex min-w-0 flex-col rounded-[var(--radius-tile)] bg-sheet p-5 outline-none transition-[box-shadow,border-color]',
        gated ? 'cursor-not-allowed border-[1.5px] border-dashed border-line-strong' : 'cursor-pointer border-[1.5px]',
        !gated && (selected ? 'border-ink shadow-[0_0_0_1.5px_var(--ink)]' : 'border-line hover:border-ink'),
        'focus-visible:shadow-[0_0_0_3px_var(--lumen)]',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={gated ? 'text-ink-3' : 'text-ink'}>
          <PolicyShape family={p.family} gated={gated} size={56} />
        </span>
        <span
          aria-hidden
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full border-[1.5px]',
            gated ? 'border-line-strong text-ink-3' : selected ? 'border-ink bg-ink text-on-ink' : 'border-ink-3',
          )}
        >
          {gated ? <Lock size={12} /> : selected ? <Check size={14} strokeWidth={3} /> : null}
        </span>
      </div>
      <p className="t-figure mt-4 text-[1.6rem]">{p.id}</p>
      <p className="mt-1 font-[650]">{p.title}</p>
      <p className="mt-2 text-[0.88rem] text-ink-2">{p.summary}</p>
      {p.examples.length > 0 && (
        <ul className="mt-3 space-y-1 text-[0.84rem] text-ink-2" aria-label="For example">
          {p.examples.slice(0, 2).map((u, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="mt-[0.6em] h-[3px] w-2 shrink-0 bg-ink-3" />
              {u}
            </li>
          ))}
        </ul>
      )}
      {gated && (
        <p className="mt-4 rounded-[3px] bg-fog-2 px-3 py-2 text-[0.82rem] font-[600] text-ink">
          <Lock size={12} aria-hidden className="mr-1.5 inline" />
          {(p.gateReason ?? COPY.scGate).split('. ')[0]}.
          <span className="mt-0.5 block font-[450] text-ink-2">Shown for reference; it cannot be selected yet.</span>
        </p>
      )}
      <p className="mt-auto flex items-center justify-between gap-2 pt-4 text-[0.75rem] text-ink-3">
        <span>
          v{p.version} <code className="t-code">{shortHash(p.contentHash)}</code>
        </span>
        <Link href={`/policies/${p.id}`} onClick={(e) => e.stopPropagation()} className="underline underline-offset-2 hover:text-ink" target="_blank">
          Full text
        </Link>
      </p>
    </div>
  )
}

export function StagePolicy({ c }: { c: ClaimComposer }) {
  const q = usePolicies()
  const policies = q.data ?? POLICIES
  const selected = policies.find((p) => p.id === c.draft.spec.policyId)
  return (
    <div>
      <StageHeader stage="policy">
        A policy is a reviewed template that defines what counts as a counterexample. Your claim selects one bounded requirement inside it; the policy text and its hash
        go into the market question.
      </StageHeader>
      <div role="radiogroup" aria-label="Policy" className="grid gap-4 md:grid-cols-3">
        {policies.map((p) => (
          <PolicyCard
            key={p.id}
            p={p}
            selected={c.draft.spec.policyId === p.id}
            disabled={c.frozen}
            onSelect={() => c.update({ spec: { policyId: p.id, policyVersion: p.version, claimClass: undefined } })}
          />
        ))}
      </div>

      {selected && selected.claimClasses.length > 0 && (
        <section className="mt-8" aria-labelledby="class-title">
          <h3 id="class-title" className="t-h3">
            What kind of {selected.family} claim?
          </h3>
          <p className="mt-1 text-[0.88rem] text-ink-2">Optional. It labels the claim and helps investigators find it.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {selected.claimClasses.map((cl) => (
              <Chip
                key={cl.id}
                active={c.draft.spec.claimClass === cl.id}
                onClick={() => c.update({ spec: { claimClass: c.draft.spec.claimClass === cl.id ? undefined : cl.id } })}
              >
                {cl.label}
              </Chip>
            ))}
          </div>
          {c.draft.spec.claimClass && (
            <p className="mt-3 max-w-[65ch] text-[0.88rem] text-ink-2">{selected.claimClasses.find((x) => x.id === c.draft.spec.claimClass)?.description}</p>
          )}
        </section>
      )}

      <StageIssues c={c} stage="policy" className="mt-6" />
      <StageNav c={c} nextDisabled={!selected || selected.status === 'gated'} />
    </div>
  )
}
