'use client'

import type { ClaimSummary } from '@pine/core'
import { formatDate } from '@pine/core'
import { Clock } from 'lucide-react'
import { API_DEADLINE_RULES, apiFactsOf, countdown, isoOfUnix } from '@/lib/claims'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'

/**
 * The three deadlines of a backend claim with their exact operators (block time, UTC): commit or publish strictly
 * before the evidence deadline, reveal strictly before the reveal deadline, answers from the reveal deadline on.
 */
export function ApiDeadlines({ claim, className }: { claim: ClaimSummary; className?: string }) {
  const api = apiFactsOf(claim)
  const now = useNowMs()
  if (!api) return null
  const rows = [
    { id: 'evidence', label: 'Evidence deadline', at: isoOfUnix(api.evidenceDeadline), rule: API_DEADLINE_RULES.evidence },
    { id: 'reveal', label: 'Reveal deadline', at: isoOfUnix(api.revealDeadline), rule: API_DEADLINE_RULES.reveal },
    { id: 'answers', label: 'Answers open', at: isoOfUnix(api.revealDeadline), rule: API_DEADLINE_RULES.answers },
  ]
  return (
    <div className={className}>
      <h3 className="t-h4 flex items-center gap-2">
        <Clock size={16} aria-hidden className="text-na" /> Deadlines
      </h3>
      <p className="mt-1 text-[0.8125rem] text-lumen-3">Absolute UTC times, compared with the block timestamp of each transaction.</p>
      <dl className="mt-3 grid gap-2">
        {rows.map((r) => {
          const left = now !== null ? Date.parse(r.at) - now : null
          return (
            <div key={r.id} className="cut-sm grid gap-x-4 gap-y-1 border border-edge bg-void px-3 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
              <dt className="text-[0.84375rem] font-semibold text-lumen">{r.label}</dt>
              <dd className="min-w-0 text-[0.84375rem] text-lumen-2">
                <span className="tnum text-lumen">{formatDate(r.at, 'utc')}</span>
                {left !== null && (
                  <span className={cn('tnum ml-2', left > 0 && left < 24 * 3_600_000 ? 'text-na' : 'text-lumen-3')}>{left > 0 ? `in ${countdown(r.at, now ?? 0)}` : 'passed'}</span>
                )}
                <span className="mt-0.5 block text-[0.8125rem] text-lumen-3">{r.rule}</span>
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
