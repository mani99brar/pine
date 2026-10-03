'use client'

import { Field, Input, ListInput, Textarea } from '@/components/ui/field'
import { useWizard } from '../context'

export function ClaimStep() {
  const { composer, errorFor } = useWizard()
  const spec = composer.draft.spec
  const set = (patch: Partial<typeof spec>) => composer.update({ spec: patch })
  const scope = spec.scope ?? { inScope: [], outOfScope: [] }
  const q = composer.question?.text
  const v = spec.violation?.trim()

  return (
    <>
      <Field
        id="f-title"
        label="Short title"
        hint="How the claim is listed on the docket. Up to 90 characters."
        error={errorFor('spec.title')}
        guidance={
          <>
            <p>Name the property, not the project. Readers should know what is being tested from the title alone.</p>
            <p>
              <strong>Good:</strong> &ldquo;Reporter deposits never draw on arbitration or gas reserves&rdquo;
            </p>
            <p>
              <strong>Too broad:</strong> &ldquo;Keeper bot is secure&rdquo;
            </p>
          </>
        }
      >
        <Input
          id="f-title"
          value={spec.title ?? ''}
          maxLength={90}
          onChange={(e) => set({ title: e.target.value })}
          aria-invalid={!!errorFor('spec.title')}
          placeholder="e.g. Reporter deposits never draw on arbitration or gas reserves"
        />
        <p className="mt-1 text-right text-sm text-graphite tabular">{(spec.title ?? '').length} of 90</p>
      </Field>

      <Field
        id="f-requirement"
        label="The requirement"
        hint="One exact behavior that must hold for the pinned commit."
        error={errorFor('spec.requirement')}
        guidance={
          <>
            <p>Write the one sentence that would be true if the code works. Investigators try to make it false.</p>
            <p>Name the components, inputs and conditions. If you need the word &ldquo;and&rdquo; twice, you probably have two claims.</p>
          </>
        }
      >
        <Textarea
          id="f-requirement"
          record
          rows={4}
          value={spec.requirement ?? ''}
          onChange={(e) => set({ requirement: e.target.value })}
          aria-invalid={!!errorFor('spec.requirement')}
          placeholder="e.g. For the frozen configuration and allowed states, each reporter-funding deposit’s principal is allocated only from eligible bridging funds…"
        />
      </Field>

      <Field
        id="f-violation"
        label="The violation a counterexample must demonstrate"
        hint="A short phrase. It is inserted word for word into the market question."
        error={errorFor('spec.violation')}
        guidance={
          <>
            <p>This is the heart of the question. Phrase it as what would go wrong, starting with a noun.</p>
            <p>
              <strong>Good:</strong> &ldquo;reporter-deposit principal can consume arbitration funds or the operator gas reserve&rdquo;
            </p>
            <p>Avoid words like safe, secure or bug-free. They make a claim nobody can resolve.</p>
          </>
        }
      >
        <Textarea
          id="f-violation"
          record
          rows={2}
          value={spec.violation ?? ''}
          onChange={(e) => set({ violation: e.target.value.replace(/[\r\n]+/g, ' ') })}
          aria-invalid={!!errorFor('spec.violation')}
          placeholder="e.g. reporter-deposit principal can consume arbitration funds or the operator gas reserve"
        />
        {q ? (
          <div className="mt-3 border-l-4 border-violet-line bg-bond px-4 py-3">
            <p className="text-sm font-bold text-graphite">How it reads in the question</p>
            <p className="record mt-1 text-[16px] leading-7">
              {v ? <QuestionWithViolation text={q} violation={v} /> : <span className="text-graphite">Write the violation to see it in place.</span>}
            </p>
          </div>
        ) : null}
      </Field>

      <div className="space-y-7 border-t border-rule pt-7">
        <h3 className="text-xl">Scope</h3>
        <Field
          id="f-inscope"
          label="In scope"
          hint="Files, modules or operations the counterexample may exercise. Add one at a time."
          error={errorFor('spec.scope.inScope') ?? errorFor('spec.scope')}
          guidance={<p>Be concrete: paths, function names, API routes. Investigators read this to decide where to look.</p>}
        >
          <ListInput id="f-inscope" value={scope.inScope} onChange={(x) => set({ scope: { ...scope, inScope: x } })} placeholder="e.g. src/planner/reporter-funding.ts" />
        </Field>
        <Field
          id="f-outscope"
          label="Out of scope"
          optional
          error={errorFor('spec.scope.outOfScope')}
          guidance={<p>Anything that could look related but is not part of this claim. Exhibits that rely on it do not count.</p>}
        >
          <ListInput id="f-outscope" value={scope.outOfScope} onChange={(x) => set({ scope: { ...scope, outOfScope: x } })} placeholder="e.g. Live LI.FI routing and bridge execution" />
        </Field>
      </div>

      <div className="space-y-7 border-t border-rule pt-7">
        <h3 className="text-xl">Conditions</h3>
        <Field
          id="f-fault"
          label="Fault model"
          optional
          error={errorFor('spec.faultModel')}
          guidance={
            <p>
              Which failures an investigator may simulate: a process crash, a timeout, a replaced transaction. Do not silently allow
              arbitrary database corruption.
            </p>
          }
        >
          <Textarea id="f-fault" rows={3} value={spec.faultModel ?? ''} onChange={(e) => set({ faultModel: e.target.value || undefined })} />
        </Field>
        <Field id="f-inputs" label="Allowed inputs" optional error={errorFor('spec.allowedInputs')} guidance={<p>The input domain an exhibit may use. Inputs outside it do not count.</p>}>
          <Textarea id="f-inputs" rows={2} value={spec.allowedInputs ?? ''} onChange={(e) => set({ allowedInputs: e.target.value || undefined })} />
        </Field>
        <Field
          id="f-assumptions"
          label="Assumptions"
          optional
          error={errorFor('spec.assumptions')}
          guidance={<p>What is taken as given: trusted roles, starting balances, external services that behave correctly.</p>}
        >
          <ListInput id="f-assumptions" value={spec.assumptions ?? []} onChange={(x) => set({ assumptions: x })} placeholder="e.g. Price feeds return fresh observations" />
        </Field>
        <Field
          id="f-exclusions"
          label="Extra exclusions"
          optional
          error={errorFor('spec.exclusions')}
          guidance={<p>On top of the policy&rsquo;s own exclusions. Keep this short: every exclusion narrows what investigators can find.</p>}
        >
          <ListInput id="f-exclusions" value={spec.exclusions ?? []} onChange={(x) => set({ exclusions: x })} placeholder="e.g. Paying the reporter transaction’s own gas fee" />
        </Field>
        <Field
          id="f-specref"
          label="Source requirement document"
          optional
          hint="A link to the spec this requirement comes from, if there is one."
          error={errorFor('spec.specReference')}
          guidance={<p>Linking the source spec helps jurors interpret the requirement the way you meant it.</p>}
        >
          <div className="grid gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <Input
              id="f-specref"
              aria-label="Document name"
              placeholder="e.g. Keeper spec, section 4.2"
              value={spec.specReference?.label ?? ''}
              onChange={(e) =>
                set({ specReference: e.target.value || spec.specReference?.url ? { label: e.target.value, url: spec.specReference?.url ?? '' } : undefined })
              }
            />
            <Input
              aria-label="Document link"
              type="url"
              placeholder="e.g. https://github.com/…/spec.md"
              value={spec.specReference?.url ?? ''}
              onChange={(e) =>
                set({ specReference: e.target.value || spec.specReference?.label ? { label: spec.specReference?.label ?? '', url: e.target.value } : undefined })
              }
            />
          </div>
        </Field>
      </div>
    </>
  )
}

function QuestionWithViolation({ text, violation }: { text: string; violation: string }) {
  const i = text.indexOf(violation)
  if (i < 0) return <span className="untrusted">{text}</span>
  return (
    <span className="untrusted">
      {text.slice(0, i)}
      <mark className="bg-flag px-0.5 text-ink">{violation}</mark>
      {text.slice(i + violation.length)}
    </span>
  )
}
