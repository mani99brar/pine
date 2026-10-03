'use client'

import type { ClaimDetail } from '@pine/core'
import { explorerAddressUrl, explorerTxUrl, formatDate, shortHash } from '@pine/core'
import { EmptyState } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'

/**
 * A backend claim's history from Pine's indexed facts: publication, evidence, deadlines, oracle answers, arbitration
 * and resolution. Pine indexes no trades or liquidity changes, so they are not listed.
 */
export function ApiTimeline({ claim }: { claim: ClaimDetail }) {
  const now = useNowMs()
  const events = claim.timeline
  if (events.length === 0) return <EmptyState title="No activity yet">Publication, evidence and oracle events for this market appear here.</EmptyState>
  return (
    <div className="glass cut-lg px-4 py-2 sm:px-5">
      <ol className="divide-y divide-[var(--edge)]" aria-label="Claim history">
        {events.map((e) => {
          const ahead = e.scheduled || (now !== null && Date.parse(e.at) > now)
          return (
            <li key={e.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
              <p className={cn('tnum text-[0.8125rem]', ahead ? 'text-na' : 'text-lumen-3')}>
                {formatDate(e.at, 'utc')}
                {ahead && <span className="block text-[0.75rem]">scheduled</span>}
              </p>
              <div className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
                <p className={cn('text-[0.875rem] font-semibold', ahead ? 'text-lumen-2' : 'text-lumen')}>{e.title}</p>
                {/* Evidence titles come from submitters' manifests: plain text only. */}
                {e.detail && <p className="untrusted mt-0.5 text-[0.8125rem] text-lumen-3">{e.detail}</p>}
              </div>
              <p className="text-right text-[0.78rem] text-lumen-3">
                {e.actor && (
                  <a className="t-code link block" href={explorerAddressUrl(claim.chainId, e.actor)} target="_blank" rel="noopener noreferrer nofollow">
                    {shortHash(e.actor)}
                  </a>
                )}
                {e.txHash && (
                  <a className="link" href={explorerTxUrl(claim.chainId, e.txHash)} target="_blank" rel="noopener noreferrer nofollow">
                    transaction
                  </a>
                )}
              </p>
            </li>
          )
        })}
      </ol>
      <p className="border-t border-edge py-3 text-[0.78rem] text-lumen-3">From Pine&apos;s indexer. Trades and liquidity changes happen on Seer and are not indexed here.</p>
    </div>
  )
}
