'use client'

import { useMemo } from 'react'
import type { ActivityItem, AgentClaimBrief, ClaimDetail } from '@pine/core'
import { explorerTxUrl, formatDate, shortHash } from '@pine/core'
import { briefToMarkdown, toAgentBrief } from '@pine/core/agent'
import { useActivity, usePine } from '@pine/react'
import { CopyButton, HashChip } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { clientSiteUrl } from '@/lib/site-client'
import { apiFactsOf } from '@/lib/claims'
import { cn } from '@/lib/cn'
import { ApiTimeline } from './ApiTimeline'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const POLICY_ID = /^[A-Z]{2,8}-\d{3}$/
const VERSION = /^\d+\.\d+\.\d+$/

/** `api` mode: the claim's market address, which names it in the backend's agent routes. */
function marketOf(claim: ClaimDetail): string | null {
  const m = claim.marketAddress ?? claim.id
  return ADDRESS.test(m) ? m.toLowerCase() : null
}

/** `api` mode links of a claim: the backend's agent view and policy route (the app's /api/agent routes do not exist). */
function backendLinks(claim: ClaimDetail, site: string): { claimJson: string | null; policyUrl: string } {
  const market = marketOf(claim)
  const { id, version } = claim.policy
  return {
    claimJson: market ? `${site}/api/v1/agents/claims/${market}` : null,
    policyUrl: POLICY_ID.test(id) && VERSION.test(version) ? `${site}/api/v1/policies/${id}/${version}` : `${site}/policies/${encodeURIComponent(id)}`,
  }
}

function withBackendLinks(brief: AgentClaimBrief, links: { claimJson: string | null; policyUrl: string }): AgentClaimBrief {
  return { ...brief, manifest: { ...brief.manifest, jsonUrl: links.claimJson ?? '' }, policy: { ...brief.policy, url: links.policyUrl } }
}

export function AgentBrief({ claim }: { claim: ClaimDetail }) {
  const site = clientSiteUrl()
  const { env } = usePine()
  const api = env.dataSource === 'api'
  const links = useMemo(() => (api ? backendLinks(claim, site) : null), [api, claim, site])
  const md = useMemo(() => {
    try {
      const brief = toAgentBrief(claim, { siteUrl: site })
      return briefToMarkdown(links ? withBackendLinks(brief, links) : brief)
    } catch {
      return null
    }
  }, [claim, site, links])
  if (links) return <BackendAgentBrief claim={claim} md={md} claimJson={links.claimJson} site={site} />
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

/** `api` mode: the Pine backend's agent view of this claim (public, cookie-free, same origin). */
function BackendAgentBrief({ claim, md, claimJson, site }: { claim: ClaimDetail; md: string | null; claimJson: string | null; site: string }) {
  const curl = claimJson ? `curl -s '${claimJson}' | jq '.item.userSupplied.document'` : `curl -s '${site}/api/v1/agents/claims?phase=evidence_open' | jq '.items[].platform.market'`
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
        <p className="text-[0.9375rem] text-lumen-2">
          Agents and people read the same pinned terms. The Pine API serves this claim as JSON: platform facts apart from the creator&apos;s document, which is marked untrusted.
        </p>
        <div className="cut-md well p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[0.78rem] text-lumen-3">curl</p>
            <CopyButton text={curl} label="Copy curl" size="xs" variant="ghost" />
          </div>
          <code className="t-code mt-1 block break-all text-[0.78rem] text-lumen">{curl}</code>
        </div>
        <ul className="grid gap-2 text-[0.9rem]">
          {claimJson && (
            <li>
              <a className="link text-lumen-2" href={claimJson}>
                Claim as JSON
              </a>
            </li>
          )}
          <li>
            <a className="link text-lumen-2" href="/api/v1/schemas/claim-document.json">
              Claim document schema
            </a>
          </li>
          <li>
            <a className="link text-lumen-2" href="/.well-known/pine.json">
              Deployment and deadline rules
            </a>
          </li>
          <li>
            <a className="link text-lumen-2" href="/llms.txt">
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
  // Backend claims: the backend lists activity per account only, so the claim's own indexed history is shown.
  if (apiFactsOf(claim)) return <ApiTimeline claim={claim} />
  return <MarketActivity claim={claim} />
}

function MarketActivity({ claim }: { claim: ClaimDetail }) {
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
