'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaimDraft, ComposerStage } from '@pine/core'
import { formatDate } from '@pine/core'
import { DEFAULT_SPENDING_LIMIT, defaultDeadline, defaultOracle, useAccount, useClaimComposer, usePine, type ClaimComposer } from '@pine/react'
import { AnimatePresence, motion } from 'motion/react'
import { Check, Lock } from 'lucide-react'
import { CuttingBench, FacetRail, facetState } from './CuttingBench'
import { stepIndex, issuesFor, UI_STEPS, type UiStep } from './shared'
import { StageClaim, StageDeadlines, StageEnvironment, StagePolicy, StageSource } from './StagesA'
import { StageFunding, StagePublish, StageReview } from './StagesB'
import { ApiComposerScope, useApiPublication } from './api/context'
import { ApiStageSource } from './api/ApiSource'
import { ApiStagePolicy } from './api/ApiPolicy'
import { ApiStageDeadlines } from './api/ApiDeadlines'
import { ApiStageFunding } from './api/ApiFunding'
import { ApiStageReview } from './api/ApiReview'
import { ApiStagePublish } from './api/ApiPublish'
import { Skeleton } from '@/components/ui/primitives'
import { useReduceMotion } from '@/lib/hooks'

const ACK_KEY = (id: string) => `pine-prism:ack:${id}`
const STEP_KEY = (id: string) => `pine-prism:step:${id}`
const FURTHEST_KEY = (id: string) => `pine-prism:furthest:${id}`

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}
function writeSession(key: string, v: string) {
  try {
    sessionStorage.setItem(key, v)
  } catch {
    /* storage unavailable: lasts for this view */
  }
}

function stepFromStage(stage: ComposerStage, saved: string | null): UiStep {
  if (stage === 'claim' && saved === 'environment') return 'environment'
  return (UI_STEPS.find((s) => s.stage === stage)?.id ?? 'source') as UiStep
}

interface ComposerProps {
  draftId: string
  initialInput?: string
  fromClaimId?: string
  initialPolicy?: string
}

/**
 * The claim composer. In api mode (Pine backend) the stages share the draft's backend publication (draft, verified
 * preview, createClaim plan, status) and the source, policy, deadlines, funding, review and publish stages follow the
 * backend's rules; demo mode is unchanged.
 */
export function Composer(props: ComposerProps) {
  const c = useClaimComposer(props.draftId, { backendPolicy: true })
  if (c.api) {
    return (
      <ApiComposerScope c={c} draftId={props.draftId}>
        {(view) => <ComposerBody c={view} {...props} />}
      </ApiComposerScope>
    )
  }
  return <ComposerBody c={c} {...props} />
}

function ComposerBody({ c, draftId, initialInput, fromClaimId, initialPolicy }: ComposerProps & { c: ClaimComposer }) {
  const { data } = usePine()
  const reduce = useReduceMotion()
  const pub = useApiPublication()

  // UI step: the core stage, plus "environment" (a sub-step of the claim stage) remembered per draft.
  const [step, setStepState] = useState<UiStep>(() => stepFromStage(c.draft.stage, readSession(STEP_KEY(draftId))))
  const [furthest, setFurthest] = useState<UiStep>(() => (readSession(FURTHEST_KEY(draftId)) as UiStep | null) ?? step)
  const synced = useRef(false)
  useEffect(() => {
    if (c.isLoading || synced.current) return
    synced.current = true
    const s = stepFromStage(c.draft.stage, readSession(STEP_KEY(draftId)))
    setStepState(s)
    setFurthest((f) => (stepIndex(s) > stepIndex(f) ? s : f))
  }, [c.isLoading, c.draft.stage, draftId])

  const go = (s: UiStep) => {
    setStepState(s)
    writeSession(STEP_KEY(draftId), s)
    if (stepIndex(s) > stepIndex(furthest)) {
      setFurthest(s)
      writeSession(FURTHEST_KEY(draftId), s)
    }
    const stage = UI_STEPS.find((x) => x.id === s)!.stage
    if (stage !== c.draft.stage) c.setStage(stage)
  }

  const [ack, setAckState] = useState(() => readSession(ACK_KEY(draftId)) === '1')
  const setAck = (v: boolean) => {
    setAckState(v)
    writeSession(ACK_KEY(draftId), v ? '1' : '0')
  }

  // Prefill from an existing claim ("Start a new claim from these terms").
  const prefilled = useRef(false)
  useEffect(() => {
    if (!fromClaimId || prefilled.current || c.isLoading || c.draft.source) return
    prefilled.current = true
    void data.getClaim(fromClaimId).then((claim) => {
      if (!claim) return
      const deadline = c.api ? c.api.defaultDeadline() : defaultDeadline()
      c.update((d: ClaimDraft) => ({
        ...d,
        stage: 'claim',
        source: claim.manifest.source,
        spec: { ...claim.manifest.claim, evidence: { mechanism: claim.manifest.claim.evidence.mechanism, deadline }, oracle: defaultOracle(claim.chainId, deadline) },
      }))
      setStepState('claim')
    })
  }, [fromClaimId, c, data])

  // Known package caveat: a new draft can be created before the account query resolves, so it starts
  // with the package default limit. Apply the account default once, before the funding stage.
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

  // Preselect a policy (from a policy page). In api mode the composer then takes the backend's latest version.
  const policySet = useRef(false)
  useEffect(() => {
    if (!initialPolicy || policySet.current || c.isLoading || c.draft.spec.policyId) return
    policySet.current = true
    c.update({ spec: { policyId: initialPolicy } })
  }, [initialPolicy, c])

  // Move focus to the new stage heading and bring the top of the stage into view.
  const topRef = useRef<HTMLDivElement | null>(null)
  const lastStep = useRef<UiStep | null>(null)
  useEffect(() => {
    const prev = lastStep.current
    lastStep.current = step
    if (prev === null || prev === step) return
    const el = topRef.current
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 90
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: reduce ? 'auto' : 'smooth' })
    }
    requestAnimationFrame(() => document.getElementById('stage-heading')?.focus({ preventScroll: true }))
  }, [step, reduce])

  const facets = useMemo(() => facetState(c, furthest), [c, furthest])
  const blocked = useMemo(() => new Set(UI_STEPS.filter((s) => issuesFor(c, s.id).length > 0).map((s) => s.id)), [c])
  const nav = { step, go }

  if (c.isLoading) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6 lg:px-8" aria-busy>
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-6 h-8 w-full" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[22rem_1fr]">
          <Skeleton className="h-[30rem] w-full" />
          <Skeleton className="h-[30rem] w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-12 pt-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="t-h1 chroma">Compose a claim</h1>
          <p className="mt-2 text-[0.875rem] text-lumen-3" aria-live="polite">
            {c.saving ? (
              'Saving the draft'
            ) : c.lastSavedAt ? (
              <span className="inline-flex items-center gap-1.5">
                <Check size={13} aria-hidden /> Draft saved {formatDate(c.lastSavedAt, 'utc').split(' ').slice(-2).join(' ')}
              </span>
            ) : (
              'Drafts save automatically as you go.'
            )}{' '}
            <Link href="/drafts" className="link ml-2">
              All drafts
            </Link>
          </p>
        </div>
        {c.frozen && (
          <p className="tag gap-1.5 px-3 py-1 text-[0.84375rem] text-lumen">
            <Lock size={13} aria-hidden /> Sealed: terms frozen
          </p>
        )}
      </div>

      <div ref={topRef} className="mt-7">
        <FacetRail step={step} furthest={furthest} onGo={go} blocked={blocked} frozen={c.frozen} />
      </div>

      {/* Phone: compact bench, flush under the header so nothing scrolls through a gap above it */}
      <div className="glass-float sticky top-16 z-[30] -mx-4 mt-5 border-x-0 border-t-0 !bg-[rgba(24,19,16,0.96)] px-4 py-2 sm:-mx-6 sm:px-6 lg:hidden">
        <CuttingBench c={c} facets={facets} compact />
      </div>

      <div className="mt-8 grid gap-10 lg:grid-cols-[21rem_minmax(0,1fr)] xl:grid-cols-[23rem_minmax(0,1fr)]">
        <aside className="hidden lg:block" aria-label="The claim's crystal">
          <div className="sticky top-24">
            <CuttingBench c={c} facets={facets} />
          </div>
        </aside>
        <div className="min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={reduce ? false : { opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none', transform: 'none' } }}
              exit={reduce ? undefined : { opacity: 0, y: -6, transition: { duration: 0.14 } }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            >
              {step === 'source' && (pub ? <ApiStageSource c={c} nav={nav} initialInput={initialInput} /> : <StageSource c={c} nav={nav} initialInput={initialInput} />)}
              {step === 'policy' && (pub ? <ApiStagePolicy c={c} nav={nav} /> : <StagePolicy c={c} nav={nav} />)}
              {step === 'claim' && <StageClaim c={c} nav={nav} />}
              {step === 'environment' && <StageEnvironment c={c} nav={nav} />}
              {step === 'deadlines' && (pub ? <ApiStageDeadlines c={c} nav={nav} /> : <StageDeadlines c={c} nav={nav} />)}
              {step === 'funding' && (pub ? <ApiStageFunding c={c} nav={nav} /> : <StageFunding c={c} nav={nav} />)}
              {step === 'review' &&
                (pub ? <ApiStageReview c={c} nav={nav} acknowledged={ack} setAcknowledged={setAck} /> : <StageReview c={c} nav={nav} acknowledged={ack} setAcknowledged={setAck} />)}
              {step === 'publish' && (pub ? <ApiStagePublish c={c} nav={nav} acknowledged={ack} /> : <StagePublish c={c} nav={nav} acknowledged={ack} />)}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
