'use client'

import * as React from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import type { PolicyParameterSpec } from '@pine/core'
import { POLICIES } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { cn } from '@/lib/cn'
import { Callout } from '@/components/ui/callout'
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field'
import { HashChip } from '@/components/ui/hash-chip'
import { useComposerCtx, fieldId } from './context'
import { ListEditor } from './editors'
import { Section } from './section'

export function PolicySection() {
  const { c, err, touch, disabled, updateSpec } = useComposerCtx()
  const selected = c.draft.spec.policyId
  const policy = c.policy
  return (
    <Section
      id="policy"
      index={2}
      title="Policy"
      description="The policy defines what counts as an admissible counterexample. Its full text and hash are referenced in the immutable question."
    >
      <div role="radiogroup" aria-label="Policy" id={fieldId('spec.policyId')} className="overflow-hidden rounded-ctl border border-line">
        {POLICIES.map((p) => {
          const gated = p.status !== 'enabled'
          const checked = selected === p.id
          return (
            <label
              key={p.id}
              className={cn(
                'flex gap-3 border-b border-line px-3 py-3 last:border-b-0',
                gated ? 'cursor-not-allowed bg-sunken/60' : 'cursor-pointer hover:bg-frost',
                checked && 'bg-needle-soft/50 shadow-[inset_2px_0_0_var(--needle)]',
              )}
            >
              <input
                type="radio"
                name="policy"
                value={p.id}
                checked={checked}
                disabled={gated || disabled}
                onChange={() => {
                  updateSpec((s) => ({ ...s, policyId: p.id, policyVersion: p.version, claimClass: undefined }))
                  touch('spec.policyId')
                }}
                className="mt-1 accent-[var(--needle)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="mono-cond text-[12px] font-semibold">{p.id}</span>
                  <span className="text-[14px] font-medium">{p.title}</span>
                  <span className="mono-cond text-[11px] text-muted">v{p.version}</span>
                  {gated ? (
                    <span className="flex items-center gap-1 text-[11.5px] font-medium text-violet">
                      <Lock size={11} aria-hidden /> gated
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[13px] text-muted">{p.summary}</span>
                {gated ? <span className="mt-1 block text-[12px] text-violet">{p.gateReason ?? COPY.scGate}</span> : null}
              </span>
            </label>
          )
        })}
      </div>
      {err('spec.policyId') ? <p className="text-xs text-flare">{err('spec.policyId')}</p> : null}
      {policy ? (
        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          {policy.claimClasses.length ? (
            <Field label="Claim class" htmlFor={fieldId('spec.claimClass')} hint="Optional. Narrows the family to one candidate class of claim.">
              <Select
                id={fieldId('spec.claimClass')}
                value={c.draft.spec.claimClass ?? ''}
                disabled={disabled}
                onChange={(e) => updateSpec((s) => ({ ...s, claimClass: e.target.value || undefined }))}
              >
                <option value="">No specific class</option>
                {policy.claimClasses.map((cc) => (
                  <option key={cc.id} value={cc.id}>
                    {cc.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <span />
          )}
          <div className="flex flex-col gap-1.5 md:items-end">
            <HashChip label="policy" value={policy.contentHash} />
            <Link href={`/policies/${policy.id}?version=${policy.version}`} target="_blank" className="text-[12.5px] text-needle hover:underline">
              Read the full policy text
            </Link>
          </div>
          {c.draft.spec.claimClass ? (
            <p className="text-[12.5px] text-muted md:col-span-2">
              {policy.claimClasses.find((cc) => cc.id === c.draft.spec.claimClass)?.description}
            </p>
          ) : null}
          <details className="rounded-ctl border border-line px-3 py-2 md:col-span-2">
            <summary className="cursor-pointer text-[13px] font-medium">What evidence qualifies under {policy.id}</summary>
            <div className="mt-2 grid gap-4 text-[13px] md:grid-cols-2">
              <div>
                <p className="stretch-cond mb-1 text-[12.5px] text-muted">Evidence must include</p>
                <ul className="list-disc space-y-1 pl-4">
                  {policy.evidenceRequirements.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="stretch-cond mb-1 text-[12.5px] text-muted">Never qualifies</p>
                <ul className="list-disc space-y-1 pl-4">
                  {policy.exclusions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </Section>
  )
}

function ParamInput({ p }: { p: PolicyParameterSpec }) {
  const { c, err, touch, disabled, updateSpec } = useComposerCtx()
  const path = `spec.parameters.${p.key}`
  const id = fieldId(path)
  const v = c.draft.spec.parameters?.[p.key]
  const set = (val: string | string[] | boolean) => updateSpec((s) => ({ ...s, parameters: { ...(s.parameters ?? {}), [p.key]: val } }))
  const placeholder = p.placeholder ?? (typeof p.example === 'string' ? p.example : undefined)
  let control: React.ReactNode
  switch (p.kind) {
    case 'longtext':
      control = <Textarea id={id} rows={3} value={(v as string) ?? ''} placeholder={placeholder} disabled={disabled} maxLength={p.maxLength} onBlur={() => touch(path)} onChange={(e) => set(e.target.value)} />
      break
    case 'select':
      control = (
        <Select id={id} value={(v as string) ?? ''} disabled={disabled} onBlur={() => touch(path)} onChange={(e) => set(e.target.value)}>
          <option value="">Choose…</option>
          {p.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )
      break
    case 'multiselect': {
      const arr = Array.isArray(v) ? v : []
      control = (
        <div id={id} className="flex flex-col gap-1.5">
          {p.options?.map((o) => (
            <Checkbox
              key={o.value}
              id={`${id}-${o.value}`}
              checked={arr.includes(o.value)}
              disabled={disabled}
              onChange={(on) => set(on ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
              label={o.label}
              description={o.help}
            />
          ))}
        </div>
      )
      break
    }
    case 'list':
      control = <ListEditor id={id} value={Array.isArray(v) ? v : []} disabled={disabled} onBlur={() => touch(path)} onChange={set} placeholder={placeholder} />
      break
    case 'boolean':
      control = <Checkbox id={id} checked={v === true} disabled={disabled} onChange={set} label={p.label} />
      break
    default:
      control = (
        <Input
          id={id}
          value={(v as string) ?? ''}
          mono={p.kind === 'address' || p.kind === 'hash'}
          type={p.kind === 'url' ? 'url' : 'text'}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={p.maxLength}
          onBlur={() => touch(path)}
          onChange={(e) => set(e.target.value)}
        />
      )
  }
  if (p.kind === 'boolean') return <div>{control}{p.help ? <p className="ml-6 mt-0.5 text-xs text-muted">{p.help}</p> : null}</div>
  return (
    <Field label={p.label} htmlFor={id} required={p.required} hint={p.help} error={err(path)}>
      {control}
    </Field>
  )
}

export function ClaimSection() {
  const { c, err, touch, disabled, updateSpec } = useComposerCtx()
  const s = c.draft.spec
  const policy = c.policy
  const title = s.title ?? ''
  return (
    <Section
      id="claim"
      index={3}
      title="Claim"
      description={COPY.boundedClaim}
    >
      <Field label="Title" htmlFor={fieldId('spec.title')} required error={err('spec.title')} aside={<span className="tnum">{title.length}/90</span>} hint="A short human label. The question text below is what resolves.">
        <Input id={fieldId('spec.title')} value={title} maxLength={90} disabled={disabled} onBlur={() => touch('spec.title')} onChange={(e) => updateSpec((x) => ({ ...x, title: e.target.value }))} placeholder="Reporter deposits never draw on protected funds" />
      </Field>
      <Field label="Requirement" htmlFor={fieldId('spec.requirement')} required error={err('spec.requirement')} hint="One exact behavioral requirement or invariant, in the terms of the source specification.">
        <Textarea id={fieldId('spec.requirement')} rows={4} value={s.requirement ?? ''} disabled={disabled} onBlur={() => touch('spec.requirement')} onChange={(e) => updateSpec((x) => ({ ...x, requirement: e.target.value }))} placeholder="For the frozen configuration and allowed states, each reporter-funding deposit's principal is allocated only from eligible bridging funds…" />
      </Field>
      <Field
        label="Violation that resolves YES"
        htmlFor={fieldId('spec.violation')}
        required
        error={err('spec.violation')}
        hint="Inserted verbatim into the question after “demonstrating”. Describe the failure, not a quality judgement."
      >
        <Textarea id={fieldId('spec.violation')} rows={2} value={s.violation ?? ''} disabled={disabled} onBlur={() => touch('spec.violation')} onChange={(e) => updateSpec((x) => ({ ...x, violation: e.target.value }))} placeholder="reporter-deposit principal can consume arbitration funds or the operator transaction-gas reserve" />
      </Field>

      {policy?.parameters.length ? (
        <fieldset className="flex flex-col gap-4 rounded-ctl border border-line p-4">
          <legend className="stretch-cond px-1 text-[13px] font-semibold">
            {policy.id} parameters
          </legend>
          {policy.parameters.map((p) => (
            <ParamInput key={p.key} p={p} />
          ))}
        </fieldset>
      ) : !policy ? (
        <Callout tone="info">Choose a policy to see its required parameters.</Callout>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <Field label="In scope" htmlFor={fieldId('spec.scope.inScope')} error={err('spec.scope')} hint="Components, entry points or files the claim covers.">
          <ListEditor id={fieldId('spec.scope.inScope')} value={s.scope?.inScope ?? []} disabled={disabled} onBlur={() => touch('spec.scope')} onChange={(v) => updateSpec((x) => ({ ...x, scope: { inScope: v, outOfScope: x.scope?.outOfScope ?? [] } }))} placeholder="src/planner/reporter-funding.ts" addLabel="Add in-scope item" />
        </Field>
        <Field label="Out of scope" htmlFor={fieldId('spec.scope.outOfScope')} hint="Explicitly excluded so investigators do not waste effort.">
          <ListEditor id={fieldId('spec.scope.outOfScope')} value={s.scope?.outOfScope ?? []} disabled={disabled} onChange={(v) => updateSpec((x) => ({ ...x, scope: { inScope: x.scope?.inScope ?? [], outOfScope: v } }))} placeholder="Live LI.FI route execution" addLabel="Add out-of-scope item" />
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Fault model" htmlFor={fieldId('spec.faultModel')} error={err('spec.faultModel')} hint="Allowed faults, such as a process crash or a replaced transaction.">
          <Textarea id={fieldId('spec.faultModel')} rows={3} value={s.faultModel ?? ''} disabled={disabled} onBlur={() => touch('spec.faultModel')} onChange={(e) => updateSpec((x) => ({ ...x, faultModel: e.target.value || undefined }))} />
        </Field>
        <Field label="Allowed inputs" htmlFor={fieldId('spec.allowedInputs')} hint="Input domain and starting states investigators may use.">
          <Textarea id={fieldId('spec.allowedInputs')} rows={3} value={s.allowedInputs ?? ''} disabled={disabled} onChange={(e) => updateSpec((x) => ({ ...x, allowedInputs: e.target.value || undefined }))} />
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Assumptions" htmlFor={fieldId('spec.assumptions')} error={err('spec.assumptions')}>
          <ListEditor id={fieldId('spec.assumptions')} value={s.assumptions ?? []} disabled={disabled} onBlur={() => touch('spec.assumptions')} onChange={(v) => updateSpec((x) => ({ ...x, assumptions: v }))} placeholder="Operator EOA holds both reserves" addLabel="Add assumption" />
        </Field>
        <Field label="Exclusions" htmlFor={fieldId('spec.exclusions')} hint="In addition to the policy exclusions.">
          <ListEditor id={fieldId('spec.exclusions')} value={s.exclusions ?? []} disabled={disabled} onChange={(v) => updateSpec((x) => ({ ...x, exclusions: v }))} placeholder="Legitimate gas paid from the operator reserve" addLabel="Add exclusion" />
        </Field>
      </div>
      <div className="grid gap-5 md:grid-cols-[1fr_1.4fr]">
        <Field label="Source requirement label" htmlFor="spec-ref-label" hint="Optional pointer to the spec this claim comes from.">
          <Input id="spec-ref-label" value={s.specReference?.label ?? ''} disabled={disabled} onChange={(e) => updateSpec((x) => ({ ...x, specReference: e.target.value || x.specReference?.url ? { label: e.target.value, url: x.specReference?.url ?? '' } : undefined }))} placeholder="Gateway balancer bot spec §4.2" />
        </Field>
        <Field label="Source requirement URL" htmlFor={fieldId('spec.specReference')} error={err('spec.specReference')}>
          <Input id={fieldId('spec.specReference')} type="url" mono value={s.specReference?.url ?? ''} disabled={disabled} onBlur={() => touch('spec.specReference')} onChange={(e) => updateSpec((x) => ({ ...x, specReference: e.target.value || x.specReference?.label ? { label: x.specReference?.label ?? '', url: e.target.value } : undefined }))} placeholder="https://github.com/…/spec.md#4-2" />
        </Field>
      </div>
    </Section>
  )
}
