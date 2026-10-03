'use client'

import { useMemo } from 'react'
import type { ActivityItem, ClaimDetail } from '@pine/core'
import { explorerTxUrl, formatDate, shortHash } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { useActivity } from '@pine/react'
import { CopyButton, HashChip } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { clientSiteUrl } from '@/lib/site-client'
import { cn } from '@/lib/cn'

export function AgentBrief({ claim }: { claim: ClaimDetail }) {
  const site = clientSiteUrl()
  const md = useMemo(() => {
    try {
      return briefToMarkdown(toAgentBrief(claim, { siteUrl: site }))
    } catch {
      return null
    }
  }, [claim, site])
  const json = `${site}/api/agent/v1/claims/${claim.id}`
  const curl = `curl -s '${json}?format=md'`
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="cut-xl well overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge px-4 py-2.5">
          <p className="text-[0.8125rem] text-lumen-3">Investigation brief (Markdown)</p>
          {md && <CopyButton text={md} label="Copy Markdown" size="xs" variant="ghost" />}
        </div>
        {md ? (
          <pre className="t-code max-h-[26rem] overflow-auto whitespace-pre-wrap break-words px-4 py-4 text-[0.78rem] text-lumen-2">{md}</pre>
        ) : (
          <p className="px-4 py-4 text-lumen-3">The brief could not be built for this claim.</p>
        )}
      </div>
      <div className="grid content-start gap-4">
        <p className="text-[0.9375rem] text-lumen-2">Agents and people read the same pinned terms. Fetch the brief as JSON or Markdown, or the canonical manifest with its hash header.</p>
        <div className="cut-md well p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[0.78rem] text-lumen-3">curl</p>
            <CopyButton text={curl} label="Copy curl" size="xs" variant="ghost" />
          </div>
          <code className="t-code mt-1 block break-all text-[0.78rem] text-lumen">{curl}</code>
        </div>
        <ul className="grid gap-2 text-[0.9rem]">
          <li>
            <a className="link text-lumen-2" href={`/api/agent/v1/claims/${claim.id}`}>
              Brief as JSON
            </a>
          </li>
          <li>
            <a className="link text-lumen-2" href={`/api/agent/v1/claims/${claim.id}/manifest.json`}>
              Canonical manifest.json
            </a>
          </li>
          <li>
            <a className="link text-lumen-2" href="/agents">
              How the agent API works
            </a>
          </li>
        </ul>
        <HashChip value={claim.manifestHash} label="Manifest hash" className="w-fit max-w-full" />
      </div>
    </div>
  )
}

const TYPE_LABEL: Record<ActivityItem['type'], string> = {
  market_created: 'Market created',
  manifest_pinned: 'Manifest pinned',
  liquidity_added: 'Liquidity added',
  liquidity_removed: 'Liquidity removed',
  split: 'Collateral split',
  merge: 'Positions merged',
  trade: 'Trade',
  evidence_submitted: 'Evidence filed',
  answer_posted: 'Answer posted',
  arbitration_requested: 'Arbitration requested',
  ruling: 'Ruling',
  finalized: 'Finalized',
  redeemed: 'Redeemed',
  approval: 'Exact approval',
}

export function ActivityRows({ items, showClaim = false }: { items: ActivityItem[]; showClaim?: boolean }) {
  return (
    <ul className="divide-y divide-[var(--edge)]">
      {items.map((a) => {
        const amt = a.amount ? Number(a.amount) : null
        return (
          <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_8rem_9rem]">
            <p className="text-[0.84375rem] font-semibold text-lumen">
              {TYPE_LABEL[a.type]}
              {a.outcome && <span className="ml-1.5 font-normal text-lumen-3">{a.side ? `${a.side} ` : ''}{a.outcome}</span>}
              {a.status && a.status !== 'confirmed' && <span className={cn('ml-1.5 tag', a.status === 'failed' && 'text-ha')}>{a.status}</span>}
            </p>
            <p className="order-3 col-span-2 min-w-0 text-[0.84375rem] text-lumen-2 sm:order-none sm:col-span-1">
              <span className="[overflow-wrap:anywhere]">{a.summary}</span>
              {showClaim && <span className="block text-[0.78rem] text-lumen-3">{a.claimTitle}</span>}
            </p>
            <p className={cn('tnum text-right text-[0.875rem]', amt === null ? 'text-lumen-3' : amt < 0 ? 'text-lumen' : 'text-hb')}>
              {amt === null ? '—' : `${amt > 0 ? '+' : ''}${a.amount} ${a.token ?? ''}`}
            </p>
            <p className="hidden text-right text-[0.78rem] text-lumen-3 sm:block">
              {formatDate(a.at, 'short')}
              <br />
              <a className="link" href={explorerTxUrl(a.chainId, a.txHash)} target="_blank" rel="noopener noreferrer nofollow">
                {shortHash(a.txHash)}
              </a>
            </p>
          </li>
        )
      })}
    </ul>
  )
}

export function ClaimActivity({ claim }: { claim: ClaimDetail }) {
  const q = useActivity({ claimId: claim.id, limit: 40 })
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  if (q.isLoading) return <LoadingBlock lines={5} />
  const items = q.data?.items ?? []
  if (!items.length) return <EmptyState title="No activity yet">Trades, liquidity, evidence and oracle actions for this market appear here.</EmptyState>
  return (
    <div className="glass cut-lg px-4 sm:px-5">
      <ActivityRows items={items} />
    </div>
  )
}
