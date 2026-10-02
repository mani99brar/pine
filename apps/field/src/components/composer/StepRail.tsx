'use client'

import { useEffect, useRef } from 'react'
import type { ComposerStage } from '@pine/core'
import type { ClaimComposer } from '@pine/react'
import { Lock } from 'lucide-react'
import { STAGES, issuesFor, stageIndex } from './shared'
import { cn } from '@/lib/cn'

/** The composer's progress rope: seven knots, the current one marked, blocked ones flagged. */
export function StepRail({ c }: { c: ClaimComposer }) {
  const cur = stageIndex(c.draft.stage)
  const frozenStages: ComposerStage[] = c.frozen ? ['source', 'policy', 'claim', 'deadlines'] : []
  const listRef = useRef<HTMLOListElement | null>(null)
  // Keep the current step visible when the rail scrolls horizontally on phones.
  useEffect(() => {
    const ol = listRef.current
    const li = ol?.children[cur] as HTMLElement | undefined
    if (!ol || !li || ol.scrollWidth <= ol.clientWidth) return
    ol.scrollTo({ left: Math.max(0, li.offsetLeft - ol.clientWidth / 2 + li.clientWidth / 2), behavior: 'smooth' })
  }, [cur])
  return (
    <nav aria-label="Composer steps">
      <ol ref={listRef} className="scrollbar-none relative -mx-4 flex overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {STAGES.map((s, i) => {
          const issues = issuesFor(c, s.id).length
          const here = i === cur
          const past = i < cur
          const frozen = frozenStages.includes(s.id)
          return (
            <li key={s.id} className="relative min-w-[5.5rem] flex-1">
              <button
                type="button"
                onClick={() => c.setStage(s.id)}
                aria-current={here ? 'step' : undefined}
                className="group flex w-full flex-col items-start pb-1 pr-2 text-left"
              >
                <span className="relative flex h-5 w-full items-center">
                  <span
                    aria-hidden
                    className={cn('h-[5px] w-full', past || here ? 'bg-ink' : 'bg-line-strong', i === 0 && 'rounded-l-[2px]', i === STAGES.length - 1 && 'rounded-r-[2px]')}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'absolute left-0 h-5 w-[5px] rounded-[1px]',
                      here ? 'bg-ink shadow-[0_0_0_3px_var(--lumen)]' : past ? 'bg-ink' : 'bg-line-strong group-hover:bg-ink-3',
                    )}
                  />
                </span>
                <span className={cn('mt-2 flex items-center gap-1.5 text-[0.84rem]', here ? 'font-[720] text-ink' : 'font-[550] text-ink-2 group-hover:text-ink')}>
                  <span className="t-figure text-[0.9rem] text-ink-3">{i + 1}</span>
                  {s.label}
                  {frozen && <Lock size={11} aria-label="frozen" />}
                  {issues > 0 && s.id !== 'publish' && (past || here) && (
                    <span className="h-2 w-2 rounded-full bg-lumen shadow-[0_0_0_1.5px_var(--ink)]" aria-label={`${issues} to fix`} />
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
