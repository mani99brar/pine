'use client'

import type { ClaimDraft } from '@pine/core'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/components/ui/tooltip'
import { useComposerCtx, sectionForPath, SECTIONS, type SectionId } from './context'

const filled = (s: string | undefined | null) => !!s && s.trim().length > 0

/** Minor ticks: one per field that matters for the section. */
export function fieldTicks(d: ClaimDraft): Record<SectionId, { label: string; done: boolean }[]> {
  const s = d.spec
  const env = s.environment
  return {
    source: [
      { label: 'Repository', done: !!d.source },
      { label: 'Commit SHA', done: !!d.source && /^[0-9a-f]{40}$/i.test(d.source.commit.sha) },
      { label: 'Base commit', done: !s.regressionOnly || !!d.source?.baseCommit },
    ],
    policy: [
      { label: 'Policy', done: !!s.policyId },
      { label: 'Claim class', done: !!s.claimClass },
    ],
    claim: [
      { label: 'Title', done: filled(s.title) },
      { label: 'Requirement', done: filled(s.requirement) },
      { label: 'Violation', done: filled(s.violation) },
      { label: 'In scope', done: (s.scope?.inScope ?? []).some(filled) },
      { label: 'Out of scope', done: (s.scope?.outOfScope ?? []).some(filled) },
      { label: 'Fault model', done: filled(s.faultModel) },
      { label: 'Assumptions', done: (s.assumptions ?? []).some(filled) },
      { label: 'Exclusions', done: (s.exclusions ?? []).some(filled) },
    ],
    environment: [
      { label: 'Runtime', done: filled(env?.runtime) },
      { label: 'Lockfile', done: !!env?.dependencyLock?.hash },
      { label: 'Container', done: filled(env?.containerImage) },
      { label: 'Reproduction command', done: filled(env?.reproductionCommand) },
      { label: 'Setup steps', done: (env?.setupSteps ?? []).some(filled) },
      { label: 'Config', done: Object.keys(env?.config ?? {}).length > 0 },
    ],
    deadlines: [
      { label: 'Deadline', done: !!s.evidence?.deadline },
      { label: 'Evidence channel', done: !!s.evidence?.mechanism },
      { label: 'Oracle opening', done: !!s.oracle?.openingTime },
      { label: 'Minimum bond', done: filled(s.oracle?.minBond) },
    ],
    funding: [
      { label: 'Liquidity', done: filled(d.funding?.liquidity) },
      { label: 'Spending limit', done: filled(d.funding?.spendingLimit) },
      { label: 'Initial price', done: typeof d.funding?.initialYesPrice === 'number' },
      { label: 'Price range', done: Array.isArray(d.funding?.priceRange) },
    ],
    review: [{ label: 'Published', done: !!d.publication?.steps?.some((x) => x.id === 'create_market' && x.status === 'confirmed') }],
  }
}

/**
 * The progress gutter: a vertical graduated rule. A major tick per section, a minor tick per field.
 * Filled ticks are done; a resin needle marks the section in view; flare marks sections with problems.
 */
export function Gutter({ active, onJump, wide }: { active: SectionId; onJump: (id: SectionId) => void; wide?: boolean }) {
  const { c, showAll, touched } = useComposerCtx()
  const ticks = fieldTicks(c.draft)
  return (
    <nav aria-label="Composer sections" className={cn('flex flex-col py-6', wide ? 'pl-5 pr-3' : 'items-center px-2')}>
      <ol className="relative flex flex-col">
        <span aria-hidden className={cn('absolute bottom-2 top-2 w-px bg-line-strong', wide ? 'left-[5px]' : 'left-1/2')} />
        {SECTIONS.map((s, i) => {
          const issues = c.validation.issues.filter((x) => sectionForPath(x.path) === s.id).length
          const engaged = showAll || [...touched].some((p) => sectionForPath(p) === s.id)
          const minor = ticks[s.id]
          const done = issues === 0 && minor.filter((t) => t.done).length > 0
          const isActive = active === s.id
          const button = (
            <button
              type="button"
              onClick={() => onJump(s.id)}
              aria-current={isActive ? 'step' : undefined}
              aria-label={`${i + 1}. ${s.label}${issues ? `, ${issues} to resolve` : done ? ', complete' : ''}`}
              className={cn('group relative flex items-center gap-2.5 py-1 text-left', !wide && 'justify-center')}
            >
              <span
                aria-hidden
                className={cn(
                  'relative z-10 h-[3px] rounded-full transition-colors',
                  wide ? 'w-3' : 'w-4',
                  isActive ? 'bg-resin-fill' : issues && engaged ? 'bg-flare' : done ? 'bg-bark' : 'bg-faint',
                )}
              />
              {wide ? (
                <span className={cn('text-[12.5px] leading-tight', isActive ? 'font-semibold text-bark' : 'text-muted group-hover:text-bark')}>
                  {s.label}
                  {issues && engaged ? <span className="tnum ml-1.5 text-[11px] text-flare">{issues}</span> : null}
                </span>
              ) : null}
            </button>
          )
          return (
            <li key={s.id} className="flex flex-col">
              {wide ? button : <Tooltip content={`${s.label}${issues ? `: ${issues} to resolve` : ''}`} side="right">{button}</Tooltip>}
              <span className={cn('flex flex-col gap-[5px] py-1.5', wide ? 'pl-[2px]' : 'items-center')} aria-hidden>
                {minor.map((t) => (
                  <span
                    key={t.label}
                    title={t.label}
                    className={cn('relative z-10 h-px w-2 transition-colors', t.done ? 'bg-bark' : 'bg-line-strong', isActive && t.done && 'bg-resin')}
                  />
                ))}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
