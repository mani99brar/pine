'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatDate, nextStep } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { Clock, Users } from 'lucide-react'
import { apiDetailFactsOf, apiFactsOf, apiLifecycleStages, apiNextStep, countdown } from '@/lib/claims'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const ACTOR: Record<string, string> = {
  anyone: 'Anyone',
  investigators: 'Investigators and agents',
  answerers: 'Answerers on Reality.eth',
  creator: 'The claim creator',
  arbitrator: 'Kleros jurors',
  holders: 'Outcome-token holders',
}

/** What happens next, who acts, and by when, straight from the lifecycle rules (the backend's phase in api mode). */
export function NextStepCard({ claim }: { claim: ClaimDetail }) {
  const now = useNowMs()
  const api = apiDetailFactsOf(claim)
  const step = api ? apiNextStep(claim, api) : nextStep(claim, now ? new Date(now) : undefined)
  const urgent = step.at && now ? Date.parse(step.at) - now < 24 * 3_600_000 && Date.parse(step.at) > now : false
  return (
    <section className="glass cut-xl relative overflow-hidden p-5 sm:p-6" aria-labelledby="next-title">
      <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: 'var(--spectrum)', opacity: 0.55 }} />
      <p className="text-[0.8125rem] text-lumen-3">What happens next</p>
      <h2 id="next-title" className="t-h3 mt-1">
        {step.title}
      </h2>
      <p className="mt-2 text-[0.9375rem] leading-[1.55] text-lumen-2">{step.detail}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div className="cut-sm border border-edge bg-void px-3 py-2.5">
          <dt className="flex items-center gap-1.5 text-[0.78rem] text-lumen-3">
            <Users size={13} aria-hidden /> Who acts
          </dt>
          <dd className="mt-0.5 text-[0.9375rem] font-medium text-lumen">{ACTOR[step.actor] ?? step.actor}</dd>
        </div>
        <div className="cut-sm border border-edge bg-void px-3 py-2.5">
          <dt className="flex items-center gap-1.5 text-[0.78rem] text-lumen-3">
            <Clock size={13} aria-hidden /> By when
          </dt>
          <dd className={cn('tnum mt-0.5 text-[0.9375rem] font-medium', urgent ? 'text-na' : 'text-lumen')}>
            {step.at ? (now ? countdown(step.at, now) : formatDate(step.at, 'utc')) : 'No fixed time'}
          </dd>
        </div>
      </dl>
      {step.at && <p className="mt-2 text-[0.78rem] text-lumen-3">{formatDate(step.at, 'utc')}</p>}
    </section>
  )
}

type Stage = { id: string; label: string; at?: string; done: boolean; current: boolean; note?: string }

function stagesFor(claim: ClaimDetail): Stage[] {
  const s = claim.status
  const order = ['publishing', 'open', 'oracle', 'dispute', 'final'] as const
  const idx =
    s === 'publishing' || s === 'failed' || s === 'draft'
      ? 0
      : s === 'open'
        ? 1
        : s === 'awaiting_answer' || s === 'answer_proposed'
          ? 2
          : s === 'disputed' || s === 'arbitration'
            ? 3
            : 4
  const disputed = Boolean(claim.oracle?.arbitration.requested) || (claim.oracle?.history.length ?? 0) > 1
  const created = claim.market?.createdAt ?? claim.createdAt
  const labels: Record<(typeof order)[number], { label: string; at?: string; note?: string }> = {
    publishing: { label: 'Published', at: created },
    open: { label: 'Evidence window', at: claim.evidenceDeadline, note: 'closes' },
    oracle: { label: 'Oracle answer', at: claim.oracle?.finalizesAt ?? claim.oracle?.openingTime, note: claim.oracle?.finalizesAt ? 'finalizes' : 'opens' },
    dispute: { label: disputed || idx === 3 ? 'Dispute and arbitration' : 'No dispute so far' },
    final: { label: claim.outcome ? 'Final' : 'Final answer' },
  }
  return order.map((id, i) => ({
    id,
    ...labels[id],
    done: i < idx || (i === idx && idx === 4),
    current: i === idx && idx !== 4,
  }))
}

/** The claim's path from publication to a final answer, lit up to where it is now. */
export function LifecyclePath({ claim }: { claim: ClaimDetail }) {
  const api = apiDetailFactsOf(claim)
  const stages: Stage[] = api ? apiLifecycleStages(claim, api) : stagesFor(claim)
  const failed = claim.status === 'failed'
  return (
    <ol className="grid grid-cols-5 gap-x-1.5 gap-y-1 sm:gap-1" aria-label="Lifecycle">
      {stages.map((st) => (
        <li key={st.id} className="min-w-0" aria-current={st.current ? 'step' : undefined}>
          <div
            className={cn('h-[3px] rounded-full', st.current && 'animate-[glow-pulse_2.4s_ease-in-out_infinite]')}
            style={{
              background: failed ? 'rgba(166,151,137,0.35)' : st.done ? 'linear-gradient(90deg,#f5ede4,#fff6ec)' : st.current ? 'linear-gradient(90deg,#f5ede4,#5ad8ff)' : 'rgba(255,228,206,0.12)',
              boxShadow: st.current ? '0 0 12px rgba(90,216,255,0.6)' : undefined,
            }}
          />
          <p className={cn('mt-2 text-[0.75rem] font-semibold leading-[1.25] sm:truncate sm:text-[0.78rem]', st.current ? 'text-lumen' : st.done ? 'text-lumen-2' : 'text-lumen-3')}>{st.label}</p>
          {st.at && (
            <p className="mt-0.5 text-[0.75rem] leading-[1.25] text-lumen-3 sm:mt-0 sm:truncate">
              {st.note ? `${st.note} ` : ''}
              {formatDate(st.at, 'short')}
            </p>
          )}
        </li>
      ))}
    </ol>
  )
}

/** The headline facts for a claim's market, with the honesty captions. */
export function MarketFacts({ claim }: { claim: ClaimDetail }) {
  const m = claim.market
  const chain = getChainOrDefault(claim.chainId)
  if (!m) return null
  const items = [
    ['Liquidity', `${m.liquidity} ${m.collateral.symbol}`],
    ['Volume, 24 hours', `${m.volume24h} ${m.collateral.symbol}`],
    ['Volume, all time', `${m.volumeTotal} ${m.collateral.symbol}`],
    ['Traders', String(m.traders)],
    ['Open interest', `${m.openInterest} ${m.collateral.symbol}`],
    ['Chain', chain.name],
  ]
  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map(([k, v]) => (
          <div key={k} className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.78rem] text-lumen-3">{k}</dt>
            <dd className="tnum mt-0.5 text-[1rem] text-lumen">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[0.78rem] text-lumen-3">{COPY.volumeCaveat}</p>
      {m.pools.length > 0 && (
        <ul className="mt-4 grid gap-2 text-[0.84375rem] text-lumen-2">
          {m.pools.map((p) => (
            <li key={p.address} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="tag">{p.outcome === 'yes' ? 'Yes pool' : 'No pool'}</span>
              <span>{p.dex}</span>
              <span className="tnum">
                {p.tvl} {m.collateral.symbol} in pool
              </span>
              <span className="tnum text-lumen-3">fee {(p.feeBps / 100).toFixed(2)}%</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[0.84375rem] text-lumen-3">
        Trading happens on Seer.{' '}
        <a href={m.seerUrl} target="_blank" rel="noopener noreferrer nofollow" className="link text-lumen-2">
          Open this market on Seer
        </a>
        . {COPY.deadlineIsNotTradingCutoff}
      </p>
    </div>
  )
}

export function StartFromTerms({ claim }: { claim: ClaimDetail }) {
  const api = apiFactsOf(claim)
  // Withheld or unverified terms are never offered as a template.
  if (api && !api.documentVerified) return null
  return (
    <Link href={`/compose?from=${claim.id}`} className="link text-[0.875rem] text-lumen-2">
      Start a new claim from these terms
    </Link>
  )
}
