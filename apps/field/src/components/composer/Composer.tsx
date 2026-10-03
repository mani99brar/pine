'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaimDraft, ClaimSummary } from '@pine/core'
import { formatDate } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { DEFAULT_SPENDING_LIMIT, defaultDeadline, defaultOracle, useAccount, useClaimComposer, usePine, useWallet, type ClaimComposer } from '@pine/react'
import { Check, Eye } from 'lucide-react'
import { StepRail } from './StepRail'
import { StageSource } from './StageSource'
import { StagePolicy } from './StagePolicy'
import { StageClaim } from './StageClaim'
import { StageDeadlines } from './StageDeadlines'
import { StageFunding, previewDepth } from './StageFunding'
import { StageReview, ACK_KEY } from './StageReview'
import { StagePublish } from './StagePublish'
import { ClaimTile } from '@/components/board/ClaimTile'
import { HashChip } from '@/components/ui/interactive'
import { ZERO } from '@/lib/constants'
import { cn } from '@/lib/cn'

function previewSummary(c: ClaimComposer): ClaimSummary {
  const src = c.draft.source
  const chain = getChainOrDefault(c.fundingInput.chainId)
  return {
    id: c.claimId,
    number: 0,
    title: c.spec.title?.trim() || 'Your claim title',
    violation: c.spec.violation,
    policy: c.policy
      ? { id: c.policy.id, version: c.policy.version, family: c.policy.family, title: c.policy.title }
      : { id: 'No policy yet', version: '', family: 'FUNC', title: '' },
    source: {
      owner: src?.owner ?? 'owner',
      repo: src?.repo ?? 'repo',
      commitSha: src?.commit.sha ?? '0000000',
      prNumber: src?.pullRequest?.number,
      prTitle: src?.pullRequest?.title,
    },
    status: 'open',
    createdAt: c.draft.createdAt,
    evidenceDeadline: c.spec.evidence.deadline,
    chainId: chain.id,
    creator: ZERO,
    yesPrice: c.fundingInput.initialYesPrice,
    liquidity: c.fundingInput.liquidity,
    volume: '0',
    collateralSymbol: chain.collateral.symbol,
    evidenceCount: 0,
    traders: 0,
    sponsored: false,
    tags: [],
  }
}

function readAck(id: string): boolean {
  try {
    return sessionStorage.getItem(ACK_KEY(id)) === '1'
  } catch {
    return false
  }
}

export function Composer({ draftId, initialInput, fromClaimId, initialPolicy }: { draftId: string; initialInput?: string; fromClaimId?: string; initialPolicy?: string }) {
  const c = useClaimComposer(draftId)
  const { data } = usePine()
  const wallet = useWallet()
  const [ack, setAckState] = useState(() => readAck(draftId))
  const setAck = (v: boolean) => {
    setAckState(v)
    try {
      sessionStorage.setItem(ACK_KEY(draftId), v ? '1' : '0')
    } catch {
      /* session storage unavailable: acknowledgement lasts for this view */
    }
  }

  // Prefill from an existing claim's terms ("Start a new claim from these terms").
  const prefilled = useRef(false)
  useEffect(() => {
    if (!fromClaimId || prefilled.current || c.isLoading || c.draft.source) return
    prefilled.current = true
    void data.getClaim(fromClaimId).then((claim) => {
      if (!claim) return
      const deadline = defaultDeadline()
      c.update((d: ClaimDraft) => ({
        ...d,
        stage: 'claim',
        source: claim.manifest.source,
        spec: {
          ...claim.manifest.claim,
          evidence: { mechanism: claim.manifest.claim.evidence.mechanism, deadline },
          oracle: defaultOracle(claim.chainId, deadline),
        },
      }))
    })
  }, [fromClaimId, c, data])

  // A new draft can be created before the account has loaded, so it starts with the package default
  // spending limit. Apply the account's default once, as long as funding has not been reached yet.
  const account = useAccount()
  const prefLimit = account.account?.preferences.defaultSpendingLimit
  const limitApplied = useRef(false)
  useEffect(() => {
    if (limitApplied.current || c.isLoading || !prefLimit || c.frozen) return
    const early = c.draft.stage === 'source' || c.draft.stage === 'policy' || c.draft.stage === 'claim' || c.draft.stage === 'deadlines'
    const current = c.draft.funding?.spendingLimit
    limitApplied.current = true
    if (!early || c.draft.publication?.steps.length || (current !== undefined && current !== DEFAULT_SPENDING_LIMIT) || prefLimit === current) return
    c.update((d: ClaimDraft) => ({ ...d, funding: { ...d.funding, spendingLimit: prefLimit } }))
  }, [prefLimit, c])

  // Preselect a policy (from a policy page's "Put a … claim on the board").
  const policySet = useRef(false)
  useEffect(() => {
    if (!initialPolicy || policySet.current || c.isLoading || c.draft.spec.policyId) return
    policySet.current = true
    c.update({ spec: { policyId: initialPolicy } })
  }, [initialPolicy, c])

  const stage = c.draft.stage
  const summary = useMemo(() => previewSummary(c), [c])

  // On a stage change, bring the step rail back into view and move focus to the new stage heading,
  // so "Continue" never leaves people halfway down the next stage.
  const railRef = useRef<HTMLDivElement | null>(null)
  const lastStage = useRef<string | null>(null)
  useEffect(() => {
    if (c.isLoading) return
    const prev = lastStage.current
    lastStage.current = stage
    if (prev === null || prev === stage) return
    const rail = railRef.current
    if (rail) {
      const top = rail.getBoundingClientRect().top + window.scrollY - 96
      if (window.scrollY > top) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' })
      }
    }
    requestAnimationFrame(() => document.getElementById('stage-heading')?.focus({ preventScroll: true }))
  }, [stage, c.isLoading])
  const f = c.fundingInput
  const pDepth = useMemo(() => previewDepth(Number(f.liquidity) || 0, f.initialYesPrice, f.priceRange[0], f.priceRange[1]), [f.liquidity, f.initialYesPrice, f.priceRange])
  const showPreview = stage === 'source' || stage === 'policy' || stage === 'claim' || stage === 'deadlines'

  if (c.isLoading) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-6">
        <span className="skeleton block h-8 w-72" />
        <span className="skeleton mt-6 block h-6 w-full" />
        <span className="skeleton mt-10 block h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="t-h2">Put a claim on the board</h1>
          <p className="mt-1 text-[0.86rem] text-ink-3">
            {c.saving ? 'Saving draft…' : c.lastSavedAt ? (
              <span className="inline-flex items-center gap-1">
                <Check size={13} aria-hidden /> Draft saved {formatDate(c.lastSavedAt, 'long').split(', ').slice(-1)[0]}
              </span>
            ) : (
              'Drafts save automatically as you go.'
            )}{' '}
            <Link href="/drafts" className="ml-3 underline underline-offset-2 hover:text-ink">
              All drafts
            </Link>
          </p>
        </div>
        {c.frozen && <p className="rounded-full bg-ink px-3 py-1 text-[0.78rem] font-[650] text-on-ink">Market created: terms frozen</p>}
      </div>

      <div className="mt-6" ref={railRef}>
        <StepRail c={c} />
      </div>

      <div className={cn('mt-10 grid gap-10', showPreview && 'xl:grid-cols-[minmax(0,1fr)_21rem]')}>
        <div className="min-w-0" key={stage} style={{ animation: 'rise-in 260ms cubic-bezier(.2,.8,.2,1)' }}>
          {stage === 'source' && <StageSource c={c} initialInput={initialInput} />}
          {stage === 'policy' && <StagePolicy c={c} />}
          {stage === 'claim' && <StageClaim c={c} />}
          {stage === 'deadlines' && <StageDeadlines c={c} />}
          {stage === 'funding' && <StageFunding c={c} />}
          {stage === 'review' && <StageReview c={c} acknowledged={ack} setAcknowledged={setAck} />}
          {stage === 'publish' && <StagePublish c={c} acknowledged={ack} />}
        </div>
        {showPreview && (
          <aside className="min-w-0" aria-label="Live preview">
            <div className="xl:sticky xl:top-24">
              <p className="mb-3 flex items-center gap-2 text-[0.8rem] font-[650] text-ink-2">
                <Eye size={14} aria-hidden /> On the board it will look like this
              </p>
              <ClaimTile claim={summary} preview numberLabel="New claim" depth={pDepth} />
              <div className="mt-5 grid gap-2 text-[0.78rem] text-ink-3">
                <p>Hashes update as you edit. The manifest hash is what gets pinned.</p>
                {c.manifestHash ? <HashChip value={c.manifestHash} label="manifest" className="w-fit" /> : <p>Pin a commit and choose a policy to see the manifest hash.</p>}
                {c.question && <HashChip value={c.question.hash} label="question" className="w-fit" />}
                {!wallet.isConnected && c.manifestHash && <p>The manifest includes the creator address, so the hash changes once you connect a wallet.</p>}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
