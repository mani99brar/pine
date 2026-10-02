'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { formatDate } from '@pine/core'
import { useClaimComposer } from '@pine/react'
import { ArrowLeft, ArrowRight, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { WIZARD_STEPS, isWizardStep, stepForIssue, stepIndex, fieldIdForPath, type WizardStep } from '@/lib/wizard'
import { Button } from '@/components/ui/button'
import { Breadcrumbs, Skeleton } from '@/components/ui/layout'
import { Notice } from '@/components/ui/notice'
import { WizardContext, type WizardCtx, type WizardIssue } from './context'
import { StepRegister, StepRegisterCompact } from './step-register'
import { SourceStep } from './steps/source'
import { PolicyStep } from './steps/policy'
import { ClaimStep } from './steps/claim'
import { EnvironmentStep } from './steps/environment'
import { DeadlinesStep } from './steps/deadlines'
import { FundingStep } from './steps/funding'
import { ReviewStep } from './steps/review'
import { PublishStep } from './steps/publish'

const STEP_COMPONENT: Record<WizardStep, () => ReactNode> = {
  source: SourceStep,
  policy: PolicyStep,
  claim: ClaimStep,
  environment: EnvironmentStep,
  deadlines: DeadlinesStep,
  funding: FundingStep,
  review: ReviewStep,
  publish: PublishStep,
}

export function FilingWizard({ draftId }: { draftId: string }) {
  const composer = useClaimComposer(draftId)
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const urlStep = sp.get('step')
  const step: WizardStep = isWizardStep(urlStep) ? urlStep : isWizardStep(composer.draft.stage) ? composer.draft.stage : 'source'
  const [attempted, setAttempted] = useState<Set<WizardStep>>(new Set())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)

  const goTo = useCallback(
    (s: WizardStep) => {
      const params = new URLSearchParams(sp.toString())
      params.set('step', s)
      params.delete('ref')
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
      const stage = WIZARD_STEPS.find((w) => w.id === s)?.stage
      if (stage && stage !== composer.draft.stage) composer.setStage(stage)
    },
    [sp, router, pathname, composer],
  )

  // Move focus to the step heading on step change (not on first load) so screen readers announce it.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    window.scrollTo({ top: 0 })
    headingRef.current?.focus()
  }, [step])

  const issues: WizardIssue[] = useMemo(
    () => composer.validation.issues.map((i) => ({ path: i.path, message: i.message, step: stepForIssue(i.path, i.stage) })),
    [composer.validation.issues],
  )
  const issuesFor = useCallback((s: WizardStep) => issues.filter((i) => i.step === s), [issues])
  const errorFor = useCallback(
    (prefix: string) => {
      const i = issues.find((x) => (x.path === prefix || x.path.startsWith(`${prefix}.`)) && attempted.has(x.step))
      return i?.message
    },
    [issues, attempted],
  )

  const ctx: WizardCtx = {
    composer,
    draftId,
    step,
    goTo,
    issues,
    issuesFor,
    errorFor,
    attempted,
    frozen: composer.frozen,
  }

  const idx = stepIndex(step)
  const meta = WIZARD_STEPS[idx]!
  const prev = WIZARD_STEPS[idx - 1]
  const next = WIZARD_STEPS[idx + 1]
  const stepIssues = issuesFor(step)
  const showSummary = attempted.has(step) && stepIssues.length > 0
  const Step = STEP_COMPONENT[step]

  const onContinue = () => {
    setAttempted((a) => new Set(a).add(step))
    if (stepIssues.length > 0 && step !== 'review') {
      requestAnimationFrame(() => document.getElementById('error-summary')?.focus())
      return
    }
    if (next) goTo(next.id)
  }

  const savedLabel = composer.saving ? (
    'Saving…'
  ) : composer.lastSavedAt ? (
    <>Saved {formatDate(composer.lastSavedAt, 'long')}. Drafts save automatically in this browser.</>
  ) : (
    'Drafts save automatically in this browser as you type.'
  )

  if (composer.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <WizardContext.Provider value={ctx}>
      <Breadcrumbs items={[{ href: '/filings', label: 'Drafts and filings' }, { label: composer.draft.spec.title?.trim() || 'Untitled filing' }]} />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-bold text-graphite">File a verification</p>
          <h1 className="record-title untrusted mt-1 text-[1.75rem] leading-9 sm:text-[2.1rem] sm:leading-[2.6rem]">
            {composer.draft.spec.title?.trim() || 'Untitled filing'}
          </h1>
        </div>
        <p className="text-sm text-graphite lg:hidden" aria-live="polite">
          {composer.saving ? 'Saving…' : composer.lastSavedAt ? `Saved ${formatDate(composer.lastSavedAt, 'utc')}` : 'Saves automatically'}
        </p>
      </div>

      <div className="mb-5 lg:hidden">
        <StepRegisterCompact />
      </div>

      <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10 xl:gap-12">
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <StepRegister savedLabel={<span aria-live="polite">{savedLabel}</span>} />
          </div>
        </aside>

        <section aria-labelledby="step-heading" className="min-w-0 border border-rule bg-sheet">
          <header className="border-b border-rule px-4 pt-6 pb-5 sm:px-8">
            <p className="text-sm font-bold text-graphite">
              Step {idx + 1} of {WIZARD_STEPS.length}
            </p>
            <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="mt-0.5 text-[1.75rem] leading-9 outline-none">
              {meta.title}
            </h2>
            <p className="mt-1 text-lg text-graphite">{meta.purpose}</p>
          </header>

          <div className="space-y-8 px-4 py-7 sm:px-8">
            {composer.frozen && step !== 'publish' && step !== 'review' ? (
              <Notice tone="neutral" title="These terms are frozen">
                <span className="inline-flex items-start gap-1.5">
                  <Lock aria-hidden className="mt-1 size-4 shrink-0" />
                  The market was created, so the claim&rsquo;s terms can no longer change. A changed claim needs a new filing.
                </span>
              </Notice>
            ) : null}

            {showSummary ? (
              <div
                id="error-summary"
                tabIndex={-1}
                role="alert"
                aria-labelledby="error-summary-title"
                className="border-4 border-red bg-sheet p-5 outline-none"
              >
                <h3 id="error-summary-title" className="text-xl text-red">
                  Before you continue, fix {stepIssues.length === 1 ? 'this' : `these ${stepIssues.length} things`}
                </h3>
                <ul className="mt-3 space-y-2">
                  {stepIssues.map((i) => (
                    <li key={`${i.path}-${i.message}`}>
                      <a
                        href={`#${fieldIdForPath(i.path)}`}
                        className="font-bold text-red underline underline-offset-4"
                        onClick={(e) => {
                          const el = document.getElementById(fieldIdForPath(i.path))
                          if (el) {
                            e.preventDefault()
                            el.scrollIntoView({ block: 'center' })
                            el.focus()
                          }
                        }}
                      >
                        {i.message}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <fieldset disabled={composer.frozen && step !== 'publish' && step !== 'review' && step !== 'funding'} className="min-w-0 space-y-8">
              <Step />
            </fieldset>
          </div>

          {step !== 'publish' && step !== 'review' ? (
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-5 sm:px-8">
              {prev ? (
                <Button variant="secondary" icon={<ArrowLeft aria-hidden />} onClick={() => goTo(prev.id)}>
                  Back<span className="sr-only sm:not-sr-only">: {prev.title}</span>
                </Button>
              ) : (
                <span />
              )}
              {next ? (
                <Button
                  iconAfter={<ArrowRight aria-hidden />}
                  onClick={onContinue}
                >
                  Continue<span className="sr-only sm:not-sr-only">: {next.title}</span>
                </Button>
              ) : null}
            </footer>
          ) : null}
        </section>
      </div>
    </WizardContext.Provider>
  )
}
