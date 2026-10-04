'use client'

import Link from 'next/link'
import { useEffect, useRef, type ReactNode } from 'react'
import type { IsoDate } from '@pine/core'
import { formatDate } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useWallet, type ClaimComposer } from '@pine/react'
import { ArrowLeft, Check, Lock, RotateCw, Wallet } from 'lucide-react'
import { motion } from 'motion/react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Notice } from '@/components/ui/primitives'
import { TxSteps } from '@/components/tx/TxSteps'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { StageHeader, type StepNav } from '../shared'
import { publicationLocked, useApiPublication } from './context'
import { ApiIdentityGate, identityReady, useApiIdentity } from './identity'
import { ApiLadder } from './ApiLadder'
import { WriteErrorNotice } from './WriteError'

// Publish in api mode: Pine proposes one createClaim transaction for the verified preview; the browser checks it against
// the previewed document before the wallet sees it, sends it from the user's wallet and reports the hash; Pine then
// follows it (planned → submitted → mined → confirmed) until the claim is indexed and its market is known. The market is
// accepted only once ClaimRegistry on the user's own RPC records this document for it.

const isoOf = (unix: number): IsoDate => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

const PHASES = [
  { id: 'planned', label: 'Planned', text: 'Pine proposed the createClaim transaction and this app checked it against the previewed document.' },
  { id: 'submitted', label: 'Submitted', text: 'The transaction was sent from your wallet. Waiting for it to be mined.' },
  { id: 'mined', label: 'Mined', text: 'The transaction is in a block. Pine waits for it to become final and indexes the claim.' },
  { id: 'confirmed', label: 'Confirmed', text: 'The claim exists and its terms are frozen.' },
] as const

function PhaseRail({ state }: { state: string | null }) {
  const at = PHASES.findIndex((p) => p.id === state)
  const current = PHASES[at]
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-2" aria-label="Publication status">
        {PHASES.map((p, i) => {
          const done = at > i || state === 'confirmed'
          const active = at === i && state !== 'confirmed'
          return (
            <li key={p.id} className={cn('tag', done && 'border-[rgba(90,216,255,0.45)] text-hb', active && 'text-lumen')} aria-current={active ? 'step' : undefined}>
              {done && <Check size={12} aria-hidden />}
              {p.label}
              {done && <span className="sr-only"> (done)</span>}
            </li>
          )
        })}
      </ol>
      <p className="mt-2 min-h-[1.4em] text-[0.875rem] text-lumen-2" role="status" aria-live="polite">
        {current ? current.text : 'Nothing has been sent yet.'}
      </p>
    </div>
  )
}

/** Brings the published confirmation into view and focus once, when it first appears. */
function RevealOnMount({ children, reduce }: { children: ReactNode; reduce: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const reduceRef = useRef(reduce)
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'center', behavior: reduceRef.current ? 'auto' : 'smooth' })
    ref.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }, [])
  return <div ref={ref}>{children}</div>
}

export function ApiStagePublish({ c, nav, acknowledged }: { c: ClaimComposer; nav: StepNav; acknowledged: boolean }) {
  const pub = useApiPublication()
  const id = useApiIdentity()
  const wallet = useWallet()
  const reduce = useReduceMotion()
  if (!pub) return null

  const market = pub.market
  if (pub.status === 'confirmed' && market) {
    return (
      <div className="grid gap-8">
        <RevealOnMount reduce={reduce}>
          <motion.div className="glass cut-xl relative overflow-hidden p-6 sm:p-8" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: 'var(--spectrum)' }} />
            <p className="tag gap-1.5 text-lumen">
              <Lock size={12} aria-hidden /> Sealed and published
            </p>
            <h2 tabIndex={-1} className="t-h1 mt-4 max-w-[18ch] outline-none">
              Your claim is on the light table.
            </h2>
            <p className="mt-3 max-w-[60ch] text-lumen-2">
              The market is open for evidence until the deadline. Pine lists it once it has verified the published claim document, usually within a minute.{' '}
              {COPY.noMergeAuthority}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href={`/claims/${market}`}>Watch it live</ButtonLink>
              <ButtonLink href="/claims" variant="glass">
                Open the light table
              </ButtonLink>
              <ButtonLink href="/compose?new=1" variant="ghost">
                Compose another claim
              </ButtonLink>
            </div>
          </motion.div>
        </RevealOnMount>
        <ApiLadder market={market} defaultLimit={c.fundingInput.spendingLimit} />
      </div>
    )
  }

  const runner = pub.runner.runner
  const preview = pub.preview
  const state = pub.publication?.state ?? null
  // A claim found on chain for this document (a transaction of an earlier visit landed) freezes the terms as well.
  const locked = publicationLocked(pub) || market !== null
  const ready = identityReady(id, 'publish')
  const failedRun = runner.state === 'failed' && !locked
  // Defence in depth (the hook already marks such a preview stale): never publish while the composed claim has issues.
  // The evidence window alone may drift with the clock: what is published is the preview's own deadline, and moving
  // the deadline makes the preview stale.
  const termIssues = c.validation.issues.filter((i) => i.path !== 'spec.evidence.deadline')
  const canPublish = pub.status === 'reviewable' && acknowledged && ready && termIssues.length === 0
  const needsPreview = !preview || pub.status === 'blocked' || pub.status === 'expired' || pub.status === 'failed' || pub.status === 'invalid'

  return (
    <div>
      <StageHeader step="publish">
        One transaction from your wallet creates the market and seals the terms. Pine follows it until the claim is confirmed; you can close this tab and come
        back from Drafts.
      </StageHeader>
      <div className="grid gap-4">
        {!locked && !acknowledged && pub.status === 'reviewable' && (
          <Notice tone="caution" title="Disclosures not acknowledged">
            Go back to review and acknowledge Pine&apos;s disclosures first.{' '}
            <button type="button" className="link font-semibold" onClick={() => nav.go('review')}>
              Back to review
            </button>
          </Notice>
        )}
        {!locked && !needsPreview && termIssues.length > 0 && (
          <Notice
            tone="caution"
            title="The claim has unresolved issues"
            action={
              <Button size="sm" onClick={() => nav.go('review')} icon={<ArrowLeft size={14} aria-hidden />}>
                Back to review
              </Button>
            }
          >
            <span className="[overflow-wrap:anywhere]">{termIssues[0]?.message}</span> Fix the claim, then request a new preview.
          </Notice>
        )}
        {!locked && needsPreview && (
          <Notice
            tone="caution"
            title={pub.status === 'expired' ? 'The offer to publish expired' : pub.status === 'failed' ? 'The publication failed' : 'Request a verified preview first'}
            action={
              <Button size="sm" onClick={() => nav.go('review')} icon={<ArrowLeft size={14} aria-hidden />}>
                Request a new preview
              </Button>
            }
          >
            {pub.status === 'failed' && pub.publication?.failureReason ? (
              <span className="untrusted [white-space:normal]">{pub.publication.failureReason}</span>
            ) : pub.status === 'expired' ? (
              'Pine only publishes a preview for a limited time. A new preview fixes the document again with fresh deadlines.'
            ) : pub.verifyIssues.length > 0 ? (
              pub.verifyIssues[0]?.message
            ) : (
              'Publishing needs a preview of the current terms that this browser verified.'
            )}
          </Notice>
        )}
        {locked && (
          <Notice tone="boundary" title="Terms are frozen">
            {COPY.frozenTerms}
          </Notice>
        )}
        {market && pub.status === 'confirming' && (
          <Notice tone="boundary" title="Your claim is already on chain">
            Pine&apos;s claim registry records this claim from your wallet: an earlier transaction created it, so nothing more is sent. Pine confirms it once it
            has indexed the claim.
          </Notice>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="glass cut-xl p-5 sm:p-6" aria-labelledby="pub-steps">
          <h3 id="pub-steps" className="t-h4 mb-4">
            Publication
          </h3>
          <PhaseRail state={state} />
          <div className="mt-6">
            {runner.steps.length > 0 ? (
              <TxSteps runner={runner} chainId={c.fundingInput.chainId} />
            ) : (
              <p className="text-[0.9rem] text-lumen-2">
                One step: <span className="font-semibold text-lumen">ClaimRegistry.createClaim</span> from your wallet, with no value and no token approval. It
                appears here once Pine proposes it and this app has checked it.
              </p>
            )}
          </div>
          {pub.status === 'confirmed' && !market && (
            <p className="mt-4 text-[0.875rem] text-lumen-2" role="status">
              Pine reports the claim as confirmed. Checking the market in Pine&apos;s claim registry through your wallet&apos;s network…
            </p>
          )}
          {pub.error && <WriteErrorNotice className="mt-5" error={pub.error} onRetry={() => void pub.publish()} onRepreview={() => nav.go('review')} saveDraft={c.saveNow} />}
          {pub.existingMarket && (
            <p className="mt-3 text-[0.875rem]">
              <Link href={`/claims/${pub.existingMarket}`} className="link">
                Open the existing claim
              </Link>
            </p>
          )}
          {!ready && !locked && <ApiIdentityGate need="publish" className="mt-5" saveDraft={c.saveNow} reason="Pine publishes claims for the wallet you signed in with." />}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-edge pt-5">
            {pub.status === 'confirming' || (pub.status === 'confirmed' && !market) ? (
              <Button variant="glass" onClick={() => void pub.refresh()} icon={<RotateCw size={15} aria-hidden />}>
                Refresh the status
              </Button>
            ) : !ready ? null : !wallet.isConnected ? (
              <Button onClick={() => wallet.connect()} icon={<Wallet size={15} aria-hidden />}>
                Connect wallet
              </Button>
            ) : (
              <Button onClick={() => void pub.publish()} loading={pub.status === 'publishing'} disabled={!canPublish || pub.busy}>
                {failedRun ? 'Publish and seal again' : 'Publish and seal'}
              </Button>
            )}
            {!locked && (
              <Button variant="ghost" onClick={() => nav.go('review')} icon={<ArrowLeft size={15} aria-hidden />}>
                Back to review
              </Button>
            )}
          </div>
        </section>
        <aside className="grid content-start gap-5">
          <section className="glass cut-lg p-5" aria-labelledby="pub-what">
            <h3 id="pub-what" className="t-h4">
              What your wallet signs
            </h3>
            <p className="mt-2 text-[0.9rem] text-lumen-2">
              A call to Pine&apos;s claim registry that pins the previewed document&apos;s digest, the policy digest, the repository id, the commit, the deadlines,
              the minimum bond and the title. This app decoded Pine&apos;s proposal and compared every parameter with the preview; it sends no value and approves
              no token.
            </p>
            {preview && !locked && (
              <p className="mt-3 text-[0.8125rem] text-lumen-3">Publish before {formatDate(isoOf(preview.planExpiresAt), 'utc')}.</p>
            )}
          </section>
          <Notice tone="boundary" title="What freezes, and when">
            {COPY.frozenTerms} Liquidity is optional and comes after the claim is confirmed.
          </Notice>
          <p className="text-[0.84375rem] text-lumen-2">
            Interrupted? Everything is saved.{' '}
            <Link href="/drafts" className="link">
              Drafts and unfinished publications
            </Link>
          </p>
        </aside>
      </div>
    </div>
  )
}
