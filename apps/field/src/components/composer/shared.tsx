'use client'

import { useState, type ReactNode } from 'react'
import type { ComposerStage } from '@pine/core'
import type { ClaimComposer } from '@pine/react'
import { AlertCircle, ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/cn'

export const STAGES: { id: ComposerStage; label: string; title: string }[] = [
  { id: 'source', label: 'Commit', title: 'Pin the exact commit' },
  { id: 'policy', label: 'Policy', title: 'Choose the policy' },
  { id: 'claim', label: 'Claim', title: 'Write the claim' },
  { id: 'deadlines', label: 'Deadlines', title: 'Set the deadlines' },
  { id: 'funding', label: 'Funding', title: 'Fund the market' },
  { id: 'review', label: 'Review', title: 'Check it before it freezes' },
  { id: 'publish', label: 'Publish', title: 'Publish' },
]

export function stageIndex(s: ComposerStage): number {
  return Math.max(0, STAGES.findIndex((x) => x.id === s))
}

export function issuesFor(c: ClaimComposer, stage: ComposerStage) {
  return c.validation.issues.filter((i) => i.stage === stage)
}

export function issueFor(c: ClaimComposer, pathPrefix: string): string | undefined {
  return c.validation.issues.find((i) => i.path === pathPrefix || i.path.startsWith(`${pathPrefix}.`))?.message
}

export function StageIssues({ c, stage, className }: { c: ClaimComposer; stage: ComposerStage; className?: string }) {
  const [all, setAll] = useState(false)
  const list = issuesFor(c, stage)
  if (!list.length) return null
  const shown = all ? list : list.slice(0, 5)
  return (
    <div className={cn('rounded-[3px] border-l-[3px] border-lumen bg-lumen-wash px-3.5 py-2.5', className)} role="status">
      <p className="flex items-center gap-1.5 text-[0.84rem] font-[650]">
        <AlertCircle size={14} aria-hidden /> {list.length === 1 ? 'One thing to fix before publishing' : `${list.length} things to fix before publishing`}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[0.84rem] text-ink-2">
        {shown.map((i) => (
          <li key={i.path + i.message}>{i.message}</li>
        ))}
      </ul>
      {list.length > 5 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1.5 text-[0.82rem] font-[650] underline underline-offset-2">
          {all ? 'Show fewer' : `Show ${list.length - 5} more`}
        </button>
      )}
    </div>
  )
}

export function StageNav({
  c,
  next,
  nextLabel,
  nextDisabled,
  extra,
}: {
  c: ClaimComposer
  next?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  extra?: ReactNode
}) {
  const idx = stageIndex(c.draft.stage)
  const prev = STAGES[idx - 1]
  const nxt = STAGES[idx + 1]
  return (
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
      {prev ? (
        <Button variant="ghost" onClick={() => c.setStage(prev.id)} icon={<ArrowLeft size={16} aria-hidden />}>
          {prev.label}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex flex-wrap items-center gap-3">
        {extra}
        {nxt && (
          <Button onClick={next ?? (() => c.setStage(nxt.id))} disabled={nextDisabled}>
            {nextLabel ?? `Continue to ${nxt.label.toLowerCase()}`}
            <ArrowRight size={16} aria-hidden />
          </Button>
        )}
      </div>
    </div>
  )
}

export function StageHeader({ stage, children }: { stage: ComposerStage; children?: ReactNode }) {
  const s = STAGES[stageIndex(stage)]!
  return (
    <div className="mb-7">
      <p className="t-figure text-[0.95rem] text-ink-3">
        Step {stageIndex(stage) + 1} of {STAGES.length}
      </p>
      <h2 className="t-h1 mt-1">{s.title}</h2>
      {children && <div className="mt-2 max-w-[62ch] text-ink-2">{children}</div>}
    </div>
  )
}
