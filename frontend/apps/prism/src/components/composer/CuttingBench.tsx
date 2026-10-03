'use client'

import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ClaimComposer } from '@pine/react'
import { formatAmount, formatDate, shortHash } from '@pine/core'
import { Check, Lock } from 'lucide-react'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { FACET_LABEL, FACET_ORDER, FAMILY_HEX, type FacetId } from '@/lib/crystal'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { stepIndex, UI_STEPS, type UiStep } from './shared'

export interface FacetState {
  cut: FacetId[]
  seeds: Partial<Record<FacetId, string | undefined>>
  values: Partial<Record<FacetId, string>>
}

/** Which facets are cut, from what the creator has pinned so far. Each facet is shaded by its input's hash. */
export function facetState(c: ClaimComposer, furthest: UiStep): FacetState {
  if (c.api) return apiFacetState(c, c.api, furthest)
  const d = c.draft
  const env = c.spec.environment
  const reached = (s: UiStep) => stepIndex(furthest) > stepIndex(s)
  const cut: FacetId[] = []
  if (d.source) cut.push('commit')
  if (c.policy && c.policy.status === 'enabled') cut.push('policy')
  if (d.spec.title?.trim() && d.spec.requirement?.trim() && d.spec.violation?.trim() && c.question) cut.push('question')
  if (env.runtime.trim() && env.reproductionCommand.trim()) cut.push('environment')
  if (reached('deadlines')) cut.push('deadline', 'oracle')
  if (reached('funding') && c.funding?.withinLimit) cut.push('funding')
  if (reached('review') && c.manifestHash && c.validation.ok) cut.push('manifest')
  if (c.frozen) cut.push('market')
  return {
    cut,
    seeds: {
      commit: d.source?.commit.sha,
      policy: c.policy?.contentHash,
      question: c.question?.hash,
      environment: env.envHash,
      deadline: c.spec.evidence.deadline,
      oracle: `${c.spec.oracle.openingTime}:${c.spec.oracle.minBond}`,
      funding: `${c.fundingInput.liquidity}:${c.fundingInput.spendingLimit}:${c.fundingInput.initialYesPrice}`,
      manifest: c.manifestHash,
      market: d.publication?.marketAddress,
    },
    values: {
      commit: d.source ? d.source.commit.sha.slice(0, 12) : undefined,
      policy: c.policy ? `${c.policy.id}@${c.policy.version}` : undefined,
      question: c.question ? shortHash(c.question.hash) : undefined,
      environment: env.runtime ? shortHash(env.envHash) : undefined,
      deadline: formatDate(c.spec.evidence.deadline, 'short'),
      oracle: `opens ${formatDate(c.spec.oracle.openingTime, 'short')}`,
      funding: `${formatAmount(c.fundingInput.liquidity)} of ${formatAmount(c.fundingInput.spendingLimit)} limit`,
      manifest: c.manifestHash ? shortHash(c.manifestHash) : undefined,
      market: d.publication?.marketAddress ? shortHash(d.publication.marketAddress) : undefined,
    },
  }
}

/**
 * api mode: the question facet is cut once the registry's question can be composed, the oracle facet shows the opening
 * Pine fixes (the reveal deadline), funding is the optional liquidity after publication, and the manifest facet is the
 * claim document Pine froze at preview.
 */
function apiFacetState(c: ClaimComposer, api: NonNullable<ClaimComposer['api']>, furthest: UiStep): FacetState {
  const d = c.draft
  const env = c.spec.environment
  const reached = (s: UiStep) => stepIndex(furthest) > stepIndex(s)
  const documentSha256 = d.publication?.backend?.documentSha256
  const cut: FacetId[] = []
  if (d.source) cut.push('commit')
  if (c.policy && api.policyPublishable) cut.push('policy')
  if (d.spec.requirement?.trim() && d.spec.violation?.trim() && api.questionSketch) cut.push('question')
  if (env.runtime.trim() && env.reproductionCommand.trim()) cut.push('environment')
  if (reached('deadlines')) cut.push('deadline', 'oracle')
  if (reached('funding')) cut.push('funding')
  if (documentSha256 && c.validation.ok) cut.push('manifest')
  if (c.frozen) cut.push('market')
  return {
    cut,
    seeds: {
      commit: d.source?.commit.sha,
      policy: c.policy?.contentHash,
      question: api.questionSketch ?? undefined,
      environment: env.envHash,
      deadline: c.spec.evidence.deadline,
      oracle: `${api.timeline?.answersOpen ?? ''}:${c.spec.oracle.minBond}`,
      funding: `${c.fundingInput.spendingLimit}`,
      manifest: documentSha256,
      market: d.publication?.marketAddress,
    },
    values: {
      commit: d.source ? d.source.commit.sha.slice(0, 12) : undefined,
      policy: c.policy ? `${c.policy.id}@${c.policy.version}` : undefined,
      question: api.questionSketch ? 'composed' : undefined,
      environment: env.runtime ? env.runtime.slice(0, 24) : undefined,
      deadline: formatDate(c.spec.evidence.deadline, 'short'),
      oracle: api.timeline ? `opens ${formatDate(api.timeline.answersOpen, 'short')}` : undefined,
      funding: 'after publishing',
      manifest: documentSha256 ? shortHash(documentSha256) : undefined,
      market: d.publication?.marketAddress ? shortHash(d.publication.marketAddress) : undefined,
    },
  }
}

/** The cutting bench: the claim's crystal, cut one facet per pinned input, sealed when the market exists. */
export function CuttingBench({ c, facets, compact }: { c: ClaimComposer; facets: FacetState; compact?: boolean }) {
  const reduce = useReduceMotion()
  const hue = FAMILY_HEX[c.policy?.family ?? 'FUNC']
  const sealed = c.frozen
  const n = facets.cut.length
  const sharp = Math.round((n / FACET_ORDER.length) * 100)
  const title = c.draft.spec.title?.trim()

  if (compact) {
    return (
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <CrystalGlyph seed={c.draft.id} facetSeeds={facets.seeds} hue={hue} state="partial" cut={facets.cut} size={64} glow={false} animateCut sealed={sealed} decorative />
          <AnimatePresence>
            {sealed && !reduce && (
              <motion.span
                key="seal-sm"
                aria-hidden
                className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ boxShadow: '0 0 0 1.5px rgba(255,236,220,0.75), 0 0 22px 4px rgba(90,216,255,0.35)' }}
                initial={{ scale: 0.4, opacity: 0.9 }}
                animate={{ scale: 2.2, opacity: 0 }}
                transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
          </AnimatePresence>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[0.875rem] font-semibold text-lumen">{title || 'Untitled claim'}</p>
          <p className="tnum text-[0.78rem] text-lumen-3">
            {n} of {FACET_ORDER.length} facets cut{sealed ? ', sealed' : ''}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="glass cut-xl relative overflow-hidden p-5">
      <div className="relative flex justify-center py-2">
        <div aria-hidden className="absolute inset-x-6 top-6 bottom-2 rounded-full bg-[radial-gradient(closest-side,rgba(255,236,220,0.07),transparent)]" />
        <CrystalGlyph
          seed={c.draft.id}
          facetSeeds={facets.seeds}
          hue={hue}
          state={sealed || n === FACET_ORDER.length ? 'luminous' : 'partial'}
          cut={facets.cut}
          size={250}
          animateCut
          sealed={sealed}
          label={`The claim's crystal: ${n} of ${FACET_ORDER.length} facets cut${sealed ? ', sealed' : ''}`}
        />
        <AnimatePresence>
          {sealed && !reduce && (
            <motion.span
              key="seal"
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ boxShadow: '0 0 0 2px rgba(255,236,220,0.7), 0 0 40px 6px rgba(90,216,255,0.35), inset 0 0 30px rgba(255,107,131,0.3)' }}
              initial={{ scale: 0.4, opacity: 0.9 }}
              animate={{ scale: 2.6, opacity: 0 }}
              transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
            />
          )}
        </AnimatePresence>
      </div>
      <p
        className="font-cut mt-2 text-center text-[1.15rem] leading-snug text-lumen transition-[font-variation-settings] duration-700"
        style={{ fontVariationSettings: `'SHRP' ${sharp}`, fontWeight: 400 + Math.round(n * 15) }}
      >
        {title || 'Untitled claim'}
      </p>
      <p className="mt-1 text-center text-[0.78rem] text-lumen-3" aria-live="polite">
        {sealed ? (
          <span className="inline-flex items-center gap-1.5 text-lumen">
            <Lock size={12} aria-hidden /> Sealed: terms frozen
          </span>
        ) : (
          `${n} of ${FACET_ORDER.length} facets cut`
        )}
      </p>
      <ul className="mt-5 grid gap-1">
        {FACET_ORDER.map((f) => {
          const isCut = facets.cut.includes(f)
          return (
            <li key={f} className={cn('flex min-w-0 items-center gap-2.5 rounded-[4px] px-2 py-1 text-[0.8125rem] transition-colors', isCut ? 'text-lumen' : 'text-lumen-3')}>
              <span
                aria-hidden
                className={cn('flex h-4 w-4 shrink-0 rotate-45 items-center justify-center border transition-colors duration-500', isCut ? 'border-lumen bg-lumen' : 'border-edge-strong')}
                style={isCut ? { boxShadow: `0 0 10px ${hue}` } : undefined}
              >
                {isCut && <Check size={10} className="-rotate-45 text-umbra" strokeWidth={3} />}
              </span>
              <span className="w-[6.25rem] shrink-0">{FACET_LABEL[f]}</span>
              <span className={cn('min-w-0 flex-1 truncate', isCut ? 'text-lumen-2' : 'text-lumen-3')} title={f === 'commit' ? c.draft.source?.commit.sha : undefined}>
                {facets.values[f] && isCut ? (
                  <span className={f === 'commit' || f === 'question' || f === 'environment' || f === 'manifest' || f === 'market' ? 't-code text-[0.75rem]' : ''}>{facets.values[f]}</span>
                ) : facets.values[f] && (f === 'deadline' || f === 'oracle' || f === 'funding') ? (
                  // Prefilled defaults: shown, but clearly not cut until the creator reviews that stage.
                  <span>
                    <span className="sr-only">not cut, default </span>
                    {facets.values[f]}
                    <span aria-hidden className="ml-1.5 text-[0.75rem] text-lumen-3">default</span>
                  </span>
                ) : (
                  'not cut'
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {!c.policy && <p className="mt-4 text-[0.78rem] text-lumen-3">The crystal takes the hue of its policy family once you choose one.</p>}
    </div>
  )
}

/** Step rail: each step is a small facet; done, current, blocked or locked. */
export function FacetRail({ step, furthest, onGo, blocked, frozen }: { step: UiStep; furthest: UiStep; onGo: (s: UiStep) => void; blocked: Set<UiStep>; frozen: boolean }) {
  const navRef = useRef<HTMLElement | null>(null)
  const reduce = useReduceMotion()
  useEffect(() => {
    const nav = navRef.current
    const cur = nav?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return
    const left = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2
    nav.scrollTo({ left: Math.max(0, left), behavior: reduce ? 'auto' : 'smooth' })
  }, [step, reduce])
  return (
    <nav ref={navRef} aria-label="Composer steps" className="relative overflow-x-auto pb-1">
      <ol className="flex min-w-max items-center gap-1">
        {UI_STEPS.map((s, i) => {
          const current = s.id === step
          const visited = i <= stepIndex(furthest)
          const locked = frozen && i < stepIndex('publish') && s.id !== 'review'
          const hasIssue = blocked.has(s.id) && visited && !current
          return (
            <li key={s.id} className="flex items-center">
              {i > 0 && <span aria-hidden className={cn('mx-1 h-px w-4 sm:w-6', visited ? 'bg-lumen-2' : 'bg-edge-strong')} />}
              <button
                type="button"
                onClick={() => onGo(s.id)}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'group inline-flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-[0.84375rem] font-medium transition-colors',
                  current ? 'bg-smoke-3 text-lumen' : visited ? 'text-lumen-2 hover:text-lumen' : 'text-lumen-3 hover:text-lumen-2',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-2.5 w-2.5 rotate-45 border transition-colors',
                    current ? 'border-hb bg-hb shadow-[0_0_10px_rgba(90,216,255,0.8)]' : visited && !hasIssue ? 'border-lumen bg-lumen' : hasIssue ? 'border-na bg-transparent' : 'border-edge-strong',
                  )}
                />
                {s.label}
                {locked && <Lock size={11} aria-label="locked" className="text-lumen-3" />}
                {hasIssue && <span className="sr-only">(needs attention)</span>}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
