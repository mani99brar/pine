'use client'

import { useMemo } from 'react'
import { formatDate, shortHash, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { ArrowRight, Check, Eye, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { HashValue } from '@/components/ui/copy'
import { MarginNote } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { AnnotatedQuestion } from '@/components/claim/annotated-question'
import { TermsOnRecord } from '@/components/claim/terms'
import { CostBreakdown, FundingTotals } from '@/components/funding/cost-breakdown'
import { questionAnnotations } from '@/lib/annotations'
import { useAcknowledgements } from '@/lib/ack'
import { WIZARD_STEPS, fieldIdForPath } from '@/lib/wizard'
import { planSignature, riskItems, RiskAcknowledgement } from '../risk'
import { useWizard } from '../context'

export function ReviewStep() {
  const { composer, issues, goTo, draftId } = useWizard()
  const { manifest, manifestHash, question, policy, funding: plan, draft } = composer
  const annotations = useMemo(() => (manifest ? questionAnnotations(manifest) : []), [manifest])
  const bond = { minBond: composer.spec.oracle?.minBond, token: composer.spec.oracle?.bondToken }
  const ack = useAcknowledgements(draftId, planSignature(plan))
  const required = plan ? riskItems(plan, bond).map((r) => r.id) : []
  const acked = required.length > 0 && required.every((r) => ack.has(r))
  const ready = issues.length === 0 && acked

  if (!manifest || !question || !policy || !draft.source) {
    return (
      <Notice tone="warning" title="There is nothing to read yet">
        The question is built from the pinned commit and the policy. Complete the <button type="button" className="link" onClick={() => goTo('source')}>source</button> and{' '}
        <button type="button" className="link" onClick={() => goTo('policy')}>policy</button> steps first.
      </Notice>
    )
  }

  const spec = composer.spec
  const counts = [
    `A reproducible demonstration that ${spec.violation}.`,
    `It runs against commit ${shortSha(draft.source.commit.sha)} of ${draft.source.owner}/${draft.source.repo}${spec.regressionOnly ? ', and the violation is absent at the base commit' : ''}.`,
    `It reproduces under the pinned environment (hash ${shortHash(spec.environment.envHash, 6)}).`,
    `It is filed on-chain before ${formatDate(spec.evidence.deadline, 'long')}.`,
    ...policy.evidenceRequirements,
  ]
  const notCounts = [
    'Anything filed after the deadline, however convincing.',
    'A failure against a different commit, branch, configuration or environment.',
    ...policy.exclusions,
    ...spec.exclusions.map((x) => `Excluded by this claim: ${x}`),
    ...spec.scope.outOfScope.map((x) => `Out of scope: ${x}`),
  ]

  return (
    <>
      <div className="flex gap-4 border-l-8 border-violet bg-violet-wash px-5 py-4">
        <Eye aria-hidden className="mt-1 size-6 shrink-0 text-violet" />
        <div>
          <h3 className="text-xl">Read it as an investigator would</h3>
          <p className="mt-1 measure">
            This is exactly what an outsider sees. Read it as someone who wants to prove you wrong. Every marked term binds, and none of it
            can change once the market is created.
          </p>
        </div>
      </div>

      <section aria-labelledby="rv-q">
        <h3 id="rv-q" className="mb-1 text-xl">
          The question, exactly as it will be published
        </h3>
        <p className="mb-5 text-[15px] text-graphite">Select a marked term or a numbered note to see what it commits you to.</p>
        <AnnotatedQuestion text={question.text} annotations={annotations} idPrefix="review-q" />
        <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-graphite">
          <span className="inline-flex items-center gap-1">
            Question hash <HashValue value={question.hash} display={shortHash(question.hash, 8)} label="question hash" />
          </span>
          {manifestHash ? (
            <span className="inline-flex items-center gap-1">
              Manifest hash <HashValue value={manifestHash} display={shortHash(manifestHash, 8)} label="manifest hash" />
            </span>
          ) : null}
        </p>
      </section>

      <section aria-labelledby="rv-count" className="border-t border-rule pt-7">
        <h3 id="rv-count" className="text-xl">
          What would count as a counterexample, and what would not
        </h3>
        <p className="mt-1 text-[15px] text-graphite">Drawn from the policy and your terms. If something here surprises you, go back and fix it now.</p>
        <div className="mt-5 grid gap-8 md:grid-cols-2">
          <div>
            <h4 className="border-b-2 border-ink pb-1.5 font-bold">Would count, when all of these hold</h4>
            <ul className="divide-y divide-rule">
              {counts.map((c, i) => (
                <li key={i} className="flex gap-3 py-2.5 text-[15px]">
                  <Check aria-hidden className="mt-1 size-4 shrink-0 text-violet" strokeWidth={3} />
                  <span className="untrusted">{c}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="border-b-2 border-ink pb-1.5 font-bold">Would not count</h4>
            <ul className="divide-y divide-rule">
              {notCounts.map((c, i) => (
                <li key={i} className="flex gap-3 py-2.5 text-[15px]">
                  <X aria-hidden className="mt-1 size-4 shrink-0 text-red" strokeWidth={3} />
                  <span className="untrusted">{c}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section aria-labelledby="rv-terms" className="border-t border-rule pt-7">
        <h3 id="rv-terms" className="mb-4 text-xl">
          Every term on record
        </h3>
        <TermsOnRecord manifest={manifest} manifestHash={manifestHash} />
        <details className="mt-5">
          <summary className="font-bold text-violet underline underline-offset-4">Show the manifest as JSON</summary>
          <pre className="mt-3 max-h-[28rem] overflow-auto border border-rule bg-bond p-4 font-mono text-[12.5px] leading-5 whitespace-pre-wrap break-all">
            {JSON.stringify(manifest, null, 2)}
          </pre>
        </details>
      </section>

      {plan ? (
        <section aria-labelledby="rv-risk" className="border-t-2 border-ink pt-7">
          <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
            <div className="min-w-0">
              <h3 id="rv-risk" className="text-xl">
                Acknowledge the risks, with the real numbers
              </h3>
              <p className="mt-1 text-[15px] text-graphite">Each one is required. They are the same figures the publish step checks against your limit.</p>
              <FundingTotals plan={plan} className="mt-4" />
              <details className="mt-3">
                <summary className="font-bold text-violet underline underline-offset-4">Every cost line</summary>
                <CostBreakdown plan={plan} className="mt-3" />
              </details>
              <div className="mt-6">
                <RiskAcknowledgement draftId={draftId} plan={plan} bond={bond} />
              </div>
            </div>
            <aside>
              <MarginNote title="Why we ask">
                <p>Prediction markets are new to most people filing claims. These are the points people most often get wrong.</p>
                <p>{COPY.noMergeAuthority}</p>
              </MarginNote>
            </aside>
          </div>
        </section>
      ) : null}

      {issues.length > 0 ? (
        <section aria-labelledby="rv-issues" className="border-4 border-red p-5">
          <h3 id="rv-issues" className="text-xl text-red">
            {issues.length === 1 ? 'One thing to fix' : `${issues.length} things to fix`} before publishing
          </h3>
          <ul className="mt-3 space-y-3">
            {WIZARD_STEPS.map((s) => {
              const list = issues.filter((i) => i.step === s.id)
              if (list.length === 0) return null
              return (
                <li key={s.id}>
                  <p className="font-bold">{s.title}</p>
                  <ul className="mt-1 space-y-1">
                    {list.map((i) => (
                      <li key={i.path + i.message}>
                        <button
                          type="button"
                          className="text-left text-[15px] text-red underline underline-offset-4"
                          onClick={() => {
                            goTo(s.id)
                            setTimeout(() => document.getElementById(fieldIdForPath(i.path))?.focus(), 150)
                          }}
                        >
                          {i.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-6">
        <Button variant="secondary" onClick={() => goTo('funding')}>
          Back: Funding
        </Button>
        <div className="flex flex-col items-end gap-1">
          <Button iconAfter={<ArrowRight aria-hidden />} disabled={!ready} onClick={() => goTo('publish')}>
            Continue: Publish
          </Button>
          <p className={cn('text-sm', ready ? 'text-graphite' : 'text-red')}>
            {issues.length > 0 ? 'Fix the items above first.' : !acked ? 'Tick every acknowledgement to continue.' : 'Ready to publish.'}
          </p>
        </div>
      </div>
    </>
  )
}
