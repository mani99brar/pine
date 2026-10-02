'use client'

import Link from 'next/link'
import type { PolicyParameterSpec } from '@pine/core'
import { POLICIES, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Lock } from 'lucide-react'
import { Checkbox, Choices, Field, Input, ListInput, MarginNote, Select, Textarea } from '@/components/ui/field'
import { useWizard } from '../context'

export function PolicyStep() {
  const { composer, errorFor } = useWizard()
  const spec = composer.draft.spec
  const policy = composer.policy
  const params = (spec.parameters ?? {}) as Record<string, string | string[] | boolean>

  const setParam = (key: string, v: string | string[] | boolean) =>
    composer.update((d) => ({ ...d, spec: { ...d.spec, parameters: { ...(d.spec.parameters ?? {}), [key]: v } } }))

  return (
    <>
      <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div id="f-policy" tabIndex={-1} className="min-w-0 outline-none">
          <Choices
            name="policy"
            legend="Policy family"
            value={spec.policyId}
            onChange={(id) => composer.update({ spec: { policyId: id, claimClass: undefined, parameters: {} } })}
            options={POLICIES.map((p) => ({
              value: p.id,
              disabled: p.status !== 'enabled',
              label: (
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span>{p.title}</span>
                  <span className="font-normal text-graphite">
                    {p.id}@{p.version}
                  </span>
                </span>
              ),
              description: p.summary,
              aside:
                p.status === 'gated' ? (
                  <span className="flex items-start gap-1.5 text-sm font-bold text-plum">
                    <Lock aria-hidden className="mt-0.5 size-4 shrink-0" /> {p.gateReason ?? COPY.scGate}
                  </span>
                ) : (
                  <Link href={`/policies/${p.id}`} target="_blank" className="link text-sm">
                    Read the full policy text
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                ),
            }))}
          />
          {errorFor('spec.policyId') ? (
            <p className="mt-2 text-sm font-bold text-red" role="alert">
              {errorFor('spec.policyId')}
            </p>
          ) : null}
        </div>
        <aside>
          <MarginNote title="What a policy does">
            <p>
              The policy is the rulebook investigators and jurors apply: what evidence is admissible, what is excluded, and what Yes and No
              mean.
            </p>
            <p>Its text is hashed into the question. Later revisions of the policy never change a claim already filed.</p>
            <p>Smart-contract claims stay disabled until a responsible disclosure process exists.</p>
          </MarginNote>
        </aside>
      </div>

      {policy ? (
        <>
          <div className="border-t border-rule pt-6 text-sm text-graphite">
            Using {policy.id}@{policy.version}, text hash <code className="font-mono">{shortHash(policy.contentHash, 8)}</code>.
          </div>

          {policy.claimClasses.length > 0 ? (
            <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
              <div id="f-claimclass" tabIndex={-1} className="min-w-0 outline-none">
                <Choices
                  name="claimClass"
                  legend={
                    <>
                      Kind of claim <span className="font-normal text-graphite">(optional)</span>
                    </>
                  }
                  value={spec.claimClass}
                  onChange={(v) => composer.update({ spec: { claimClass: v } })}
                  columns={2}
                  options={policy.claimClasses.map((c) => ({ value: c.id, label: c.label, description: c.description }))}
                />
                {errorFor('spec.claimClass') ? <p className="mt-2 text-sm font-bold text-red">{errorFor('spec.claimClass')}</p> : null}
              </div>
              <aside>
                <MarginNote title="Pick the closest fit">
                  <p>The class helps investigators find claims they know how to test. It does not change the rules.</p>
                </MarginNote>
              </aside>
            </div>
          ) : null}

          {policy.parameters.length > 0 ? (
            <div className="space-y-7 border-t border-rule pt-7">
              <h3 className="text-xl">What {policy.id} needs to know</h3>
              {policy.parameters.map((p) => (
                <ParamField key={p.key} spec={p} value={params[p.key]} onChange={(v) => setParam(p.key, v)} error={errorFor(`spec.parameters.${p.key}`)} />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function ParamField({
  spec: p,
  value,
  onChange,
  error,
}: {
  spec: PolicyParameterSpec
  value: string | string[] | boolean | undefined
  onChange: (v: string | string[] | boolean) => void
  error?: string
}) {
  const id = `f-param-${p.key}`
  const example = Array.isArray(p.example) ? p.example.join('; ') : typeof p.example === 'string' ? p.example : undefined
  const guidance = (
    <>
      <p>{p.help}</p>
      {example ? (
        <p>
          <strong>Example:</strong> <span className="italic">{example}</span>
        </p>
      ) : null}
    </>
  )
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : undefined }
  let control: React.ReactNode
  switch (p.kind) {
    case 'longtext':
      control = <Textarea {...common} rows={4} value={(value as string) ?? ''} maxLength={p.maxLength} placeholder={p.placeholder} onChange={(e) => onChange(e.target.value)} />
      break
    case 'select':
      control = (
        <Select {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose one</option>
          {p.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )
      break
    case 'multiselect': {
      const arr = Array.isArray(value) ? value : []
      control = (
        <div className="space-y-2" id={id} tabIndex={-1}>
          {p.options?.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              description={o.help}
              checked={arr.includes(o.value)}
              onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
            />
          ))}
        </div>
      )
      break
    }
    case 'list':
      control = <ListInput id={id} value={Array.isArray(value) ? value : []} onChange={onChange} placeholder={p.placeholder} />
      break
    case 'boolean':
      control = (
        <div className="flex gap-6" role="radiogroup" aria-labelledby={`${id}-label`} id={id} tabIndex={-1}>
          {[
            { v: true, l: 'Yes' },
            { v: false, l: 'No' },
          ].map((o) => (
            <label key={o.l} className="flex items-center gap-2 font-bold">
              <input type="radio" name={id} checked={value === o.v} onChange={() => onChange(o.v)} className="size-5 accent-[var(--color-violet)]" />
              {o.l}
            </label>
          ))}
        </div>
      )
      break
    default:
      control = (
        <Input
          {...common}
          mono={p.kind === 'address' || p.kind === 'hash'}
          type={p.kind === 'url' ? 'url' : 'text'}
          value={(value as string) ?? ''}
          maxLength={p.maxLength}
          placeholder={p.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
  return (
    <Field id={id} label={p.label} optional={!p.required} error={error} guidance={guidance}>
      {control}
    </Field>
  )
}
