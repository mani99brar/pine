'use client'

import { useState, type ReactNode } from 'react'
import { Popover } from 'radix-ui'
import type { ClaimDraft, ClaimSpec, EnvironmentPin, PolicyParameterSpec } from '@pine/core'
import { EVIDENCE_MECHANISMS, LIMITS, formatUtcMinute, shortHash, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import type { ClaimComposer } from '@pine/react'
import { Check, ChevronDown, Lock, PenLine } from 'lucide-react'
import { Drawer, HashChip, Switch } from '@/components/ui/interactive'
import { Field, Input, Select, Textarea } from '@/components/ui/form'
import { KeyValueEditor, ListEditor } from '@/components/ui/editors'
import { Button } from '@/components/ui/Button'
import { Note } from '@/components/ui/primitives'
import { StageHeader, StageIssues, StageNav, issueFor } from './shared'
import { cn } from '@/lib/cn'

type DrawerId = 'basics' | 'scope' | 'environment' | 'fault' | 'lists' | 'params' | null

/* ------------------------------------------------------------------------------------------------
   Slot: an inline, editable blank inside the question sentence
   ------------------------------------------------------------------------------------------------ */

function Slot({
  filled,
  placeholder,
  children,
  onClick,
  locked,
  label,
  error,
  as = 'button',
}: {
  filled: boolean
  placeholder: string
  children?: ReactNode
  onClick?: () => void
  locked?: boolean
  label: string
  error?: boolean
  as?: 'button' | 'span'
}) {
  const cls = cn(
    'relative mx-[0.12em] inline rounded-[4px] px-[0.3em] py-[0.05em] align-baseline [box-decoration-break:clone] [-webkit-box-decoration-break:clone] transition-colors',
    filled
      ? locked
        ? 'bg-fog-2 text-ink'
        : 'bg-ink/[0.06] font-[650] text-ink shadow-[inset_0_-3px_0_var(--ink)] hover:bg-ink/[0.1]'
      : 'bg-lumen-wash font-[550] text-ink-2 shadow-[inset_0_-3px_0_var(--lumen)] hover:text-ink',
    error && 'shadow-[inset_0_-3px_0_var(--flare)]',
  )
  const content = (
    <>
      {filled ? children : placeholder}
      {locked ? (
        <Lock size={13} aria-hidden className="ml-1 inline -translate-y-[1px] opacity-60" />
      ) : (
        <PenLine size={13} aria-hidden className="ml-1 inline -translate-y-[1px] opacity-50" />
      )}
    </>
  )
  if (as === 'span') return <span className={cls}>{content}</span>
  return (
    <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer text-left')} aria-label={`${label}: ${filled ? 'edit' : 'fill in'}`}>
      {content}
    </button>
  )
}

/* ------------------------------------------------------------------------------------------------
   Violation editor (popover anchored to the slot)
   ------------------------------------------------------------------------------------------------ */

function ViolationSlot({ c }: { c: ClaimComposer }) {
  const [open, setOpen] = useState(false)
  const v = c.draft.spec.violation ?? ''
  const err = issueFor(c, 'spec.violation')
  const examples = c.policy?.examples ?? []
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            'mx-[0.12em] inline rounded-[4px] px-[0.3em] py-[0.05em] text-left [box-decoration-break:clone] [-webkit-box-decoration-break:clone]',
            v.trim()
              ? 'bg-flare-wash font-[650] text-ink shadow-[inset_0_-3px_0_var(--flare)] hover:brightness-[0.98]'
              : 'bg-lumen-wash font-[550] text-ink-2 shadow-[inset_0_-3px_0_var(--lumen)] hover:text-ink',
          )}
          aria-label={`Violation: ${v.trim() ? 'edit' : 'fill in'}`}
        >
          {v.trim() || 'the specific violation'}
          <PenLine size={14} aria-hidden className="ml-1 inline -translate-y-[1px] opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 w-[min(34rem,calc(100vw-24px))] rounded-[6px] border-2 border-ink bg-sheet p-4 text-ink shadow-[6px_6px_0_var(--ink)] data-[state=open]:animate-[fade-in_120ms_ease-out]"
        >
          <label htmlFor="violation" className="font-[650]">
            What exactly must a counterexample demonstrate?
          </label>
          <p className="mt-1 text-[0.84rem] text-ink-2">
            One bounded violation, as a phrase that completes &ldquo;demonstrating&nbsp;…&rdquo;. It goes into the market question verbatim.
          </p>
          <Textarea
            id="violation"
            autoFocus
            value={v}
            maxLength={LIMITS.violationMax}
            onChange={(e) => c.update({ spec: { violation: e.target.value.replace(/[\r\n]+/g, ' ') } })}
            placeholder="that reporter-deposit principal can consume the arbitration allocation or the operator gas reserve"
            className="mt-3 min-h-[5.5rem]"
            aria-invalid={!!err}
            aria-describedby="violation-help"
          />
          <div id="violation-help" className="mt-1.5 flex items-start justify-between gap-3 text-[0.78rem]">
            <span className={err ? 'font-[550] text-flare-ink' : 'text-ink-3'}>{err ?? 'Avoid words like "safe" or "secure": describe the failure, not the absence of bugs.'}</span>
            <span className="t-figure shrink-0 text-[0.85rem] text-ink-3">
              {v.length}/{LIMITS.violationMax}
            </span>
          </div>
          {examples.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="text-[0.78rem] font-[650] text-ink-3">Examples from {c.policy?.id}</p>
              <ul className="mt-1.5 space-y-1 text-[0.84rem] text-ink-2">
                {examples.slice(0, 3).map((ex, i) => (
                  <li key={i}>{ex}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Popover.Close asChild>
              <Button size="sm" icon={<Check size={14} aria-hidden />}>
                Done
              </Button>
            </Popover.Close>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function MechanismSlot({ c }: { c: ClaimComposer }) {
  const [open, setOpen] = useState(false)
  const id = c.draft.spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy'
  const mech = EVIDENCE_MECHANISMS[id]
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="mx-[0.12em] inline rounded-[4px] bg-ink/[0.06] px-[0.3em] py-[0.05em] text-left font-[650] shadow-[inset_0_-3px_0_var(--ink)] [box-decoration-break:clone] hover:bg-ink/[0.1]"
          aria-label="Evidence mechanism: change"
        >
          {mech?.label ?? id}
          <ChevronDown size={14} aria-hidden className="ml-1 inline -translate-y-[1px] opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8} collisionPadding={12} className="z-50 w-[min(30rem,calc(100vw-24px))] rounded-[6px] border-2 border-ink bg-sheet p-2 text-ink shadow-[6px_6px_0_var(--ink)]">
          {Object.values(EVIDENCE_MECHANISMS).map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={c.frozen}
              onClick={() => {
                c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, evidence: { ...(d.spec.evidence ?? { deadline: '' }), mechanism: m.id } } }))
                setOpen(false)
              }}
              className={cn('block w-full rounded-[4px] px-3 py-2.5 text-left hover:bg-fog-2', m.id === id && 'bg-fog-2')}
            >
              <span className="flex items-center gap-2 font-[650]">
                {m.id === id && <Check size={14} aria-hidden />}
                {m.label}
              </span>
              <span className="mt-0.5 block text-[0.82rem] text-ink-2">{m.description}</span>
              {m.launchGate && <span className="mt-1 block text-[0.78rem] font-[550] text-lumen-ink">Launch gate: {m.launchGate}</span>}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/* ------------------------------------------------------------------------------------------------
   Detail cards (open drawers)
   ------------------------------------------------------------------------------------------------ */

function DetailCard({ title, summary, status, onOpen }: { title: string; summary: ReactNode; status: 'done' | 'missing' | 'optional'; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex min-w-0 flex-col items-start rounded-[var(--radius-tile)] border bg-sheet p-4 text-left transition-colors hover:border-ink',
        status === 'missing' ? 'border-[1.5px] border-dashed border-ink-3' : 'border-line',
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="font-[650]">{title}</span>
        <span
          className={cn(
            'inline-flex h-5 items-center rounded-full px-2 text-[0.7rem] font-[700]',
            status === 'done' && 'bg-ink text-on-ink',
            status === 'missing' && 'bg-lumen text-[#161a33]',
            status === 'optional' && 'bg-fog-2 text-ink-2',
          )}
        >
          {status === 'done' ? 'set' : status === 'missing' ? 'needed' : 'optional'}
        </span>
      </span>
      <span className="mt-1.5 line-clamp-2 text-[0.84rem] text-ink-2 [overflow-wrap:anywhere]">{summary}</span>
      <span className="mt-2 text-[0.8rem] font-[620] text-ink-3 group-hover:text-ink">Edit</span>
    </button>
  )
}

function setSpec(c: ClaimComposer, patch: Partial<ClaimSpec>) {
  c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, ...patch } }))
}

function setEnv(c: ClaimComposer, patch: Partial<EnvironmentPin>) {
  c.update((d: ClaimDraft) => {
    const env = (d.spec.environment ?? c.spec.environment) as EnvironmentPin
    return { ...d, spec: { ...d.spec, environment: { ...env, ...patch } } }
  })
}

function ParamInput({ p, value, onChange }: { p: PolicyParameterSpec; value: unknown; onChange: (v: string | string[] | boolean) => void }) {
  const id = `param-${p.key}`
  if (p.kind === 'boolean') {
    return <Switch id={id} checked={value === true} onChange={onChange} label={p.label} description={p.help} />
  }
  return (
    <Field label={p.label} htmlFor={id} help={p.help} optional={!p.required}>
      {p.kind === 'select' ? (
        <Select id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {p.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : p.kind === 'multiselect' ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={p.label}>
          {p.options?.map((o) => {
            const arr = Array.isArray(value) ? (value as string[]) : []
            const on = arr.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
                className={cn('rounded-full border-[1.5px] px-3 py-1 text-[0.84rem] font-[580]', on ? 'border-ink bg-ink text-on-ink' : 'border-line-strong hover:border-ink')}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      ) : p.kind === 'list' ? (
        <ListEditor label={p.label} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} placeholder={p.placeholder} />
      ) : p.kind === 'longtext' ? (
        <Textarea id={id} value={typeof value === 'string' ? value : ''} maxLength={p.maxLength} placeholder={p.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input
          id={id}
          value={typeof value === 'string' ? value : ''}
          maxLength={p.maxLength}
          placeholder={p.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={p.kind === 'address' || p.kind === 'hash' ? 'font-mono text-[0.85rem]' : undefined}
        />
      )}
    </Field>
  )
}

/* ------------------------------------------------------------------------------------------------
   The stage
   ------------------------------------------------------------------------------------------------ */

export function StageClaim({ c }: { c: ClaimComposer }) {
  const [drawer, setDrawer] = useState<DrawerId>(null)
  const spec = c.draft.spec
  const env = (spec.environment ?? c.spec.environment) as EnvironmentPin
  const src = c.draft.source
  const policy = c.policy
  const deadline = spec.evidence?.deadline
  const envFilled = !!env.runtime?.trim() && !!env.reproductionCommand?.trim()
  const scopeCount = spec.scope?.inScope?.length ?? 0
  const requiredParams = policy?.parameters.filter((p) => p.required) ?? []
  const paramsMissing = requiredParams.filter((p) => {
    const v = spec.parameters?.[p.key]
    return v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  }).length

  return (
    <div>
      <StageHeader stage="claim">
        Read the sentence. It is the exact question the market will answer. Fill each highlighted blank; everything else on this page travels with the claim as its terms.
      </StageHeader>

      {c.frozen && (
        <Note className="mb-6" icon={<Lock size={15} aria-hidden />}>
          {COPY.frozenTerms}
        </Note>
      )}

      {/* The sentence */}
      <div className="rounded-[var(--radius-tile)] border-2 border-ink bg-sheet px-5 py-6 sm:px-8 sm:py-8">
        <p className="text-[1.3rem] leading-[1.75] font-[430] text-ink sm:text-[1.6rem] sm:leading-[1.7]">
          Was a reproducible counterexample demonstrating <ViolationSlot c={c} /> against commit{' '}
          <Slot as="span" filled={!!src} locked placeholder="(pin a commit)" label="Commit">
            <code className="font-mono text-[0.88em]">{src ? shortSha(src.commit.sha) : ''}</code>
          </Slot>
          , under configuration/environment{' '}
          <Slot filled={envFilled} placeholder="the pinned environment" label="Environment" onClick={() => setDrawer('environment')} error={!!issueFor(c, 'spec.environment')}>
            <code className="font-mono text-[0.88em]">{shortHash(env.envHash, 4)}</code>
          </Slot>{' '}
          and policy{' '}
          <Slot as="span" filled={!!policy} locked placeholder="(choose a policy)" label="Policy">
            {policy ? `${policy.id}@${policy.version}` : ''}
          </Slot>
          , submitted through <MechanismSlot c={c} /> before{' '}
          <Slot filled={!!deadline} placeholder="the deadline" label="Evidence deadline" onClick={() => c.setStage('deadlines')}>
            {deadline ? formatUtcMinute(deadline) : ''}
          </Slot>
          ?
        </p>
        <p className="mt-5 text-[0.82rem] text-ink-3">
          Yes means {COPY.outcome.yes.toLowerCase()}. No means {COPY.outcome.no.toLowerCase()}, which is not proof the code is correct.
        </p>
      </div>

      {/* Details that travel with the claim */}
      <h3 className="t-h3 mt-10">Terms that travel with the claim</h3>
      <p className="mt-1 text-[0.88rem] text-ink-2">Investigators read these to decide what is in bounds. Each opens in a side panel.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <DetailCard
          title="Title and requirement"
          status={spec.title?.trim() && spec.requirement?.trim() ? 'done' : 'missing'}
          summary={spec.title?.trim() || 'A short title and the one exact requirement or invariant.'}
          onOpen={() => setDrawer('basics')}
        />
        <DetailCard
          title="Scope"
          status={scopeCount > 0 ? 'done' : 'missing'}
          summary={scopeCount > 0 ? `${scopeCount} in scope, ${spec.scope?.outOfScope?.length ?? 0} out of scope` : 'Which components are in bounds, and which are not.'}
          onOpen={() => setDrawer('scope')}
        />
        <DetailCard
          title="Environment and reproduction"
          status={envFilled ? 'done' : 'missing'}
          summary={envFilled ? `${env.runtime}, ${env.reproductionCommand}` : 'Runtime, lockfile, configuration and the command investigators run.'}
          onOpen={() => setDrawer('environment')}
        />
        <DetailCard
          title="Fault model and inputs"
          status={spec.faultModel?.trim() || spec.allowedInputs?.trim() ? 'done' : 'optional'}
          summary={spec.faultModel?.trim() || 'Which faults and inputs a counterexample may use.'}
          onOpen={() => setDrawer('fault')}
        />
        <DetailCard
          title="Assumptions and exclusions"
          status={(spec.assumptions?.length ?? 0) + (spec.exclusions?.length ?? 0) > 0 ? 'done' : 'optional'}
          summary={`${spec.assumptions?.length ?? 0} assumptions, ${spec.exclusions?.length ?? 0} exclusions${spec.regressionOnly ? ', regressions only' : ''}`}
          onOpen={() => setDrawer('lists')}
        />
        {policy && policy.parameters.length > 0 && (
          <DetailCard
            title={`${policy.id} parameters`}
            status={paramsMissing > 0 ? 'missing' : 'done'}
            summary={paramsMissing > 0 ? `${paramsMissing} required by the policy` : `${policy.parameters.length} parameters set`}
            onOpen={() => setDrawer('params')}
          />
        )}
      </div>

      {/* Exact text */}
      <section className="mt-10 rounded-[var(--radius-tile)] bg-fog-2/70 p-4 sm:p-5" aria-labelledby="exact-q">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="exact-q" className="text-[0.88rem] font-[650]">
            Exact question text
          </h3>
          {c.question && <HashChip value={c.question.hash} label="question hash" />}
        </div>
        {c.question ? (
          <p className="mt-2 text-[0.9rem] leading-[1.6] text-ink-2 [overflow-wrap:anywhere]">{c.question.text}</p>
        ) : (
          <p className="mt-2 text-[0.9rem] text-ink-3">Pin a commit and choose a policy to generate the full question.</p>
        )}
      </section>

      <StageIssues c={c} stage="claim" className="mt-6" />
      <StageNav c={c} />

      {/* Drawers */}
      <Drawer open={drawer === 'basics'} onOpenChange={(o) => setDrawer(o ? 'basics' : null)} title="Title and requirement" description="The title is how the claim appears on the board. The requirement is the one exact behaviour the claim is about.">
        <div className="grid gap-5">
          <Field label="Title" htmlFor="title" help={`Up to ${LIMITS.titleMax} characters. Name the behaviour, not a verdict.`} error={issueFor(c, 'spec.title')}>
            <Input id="title" value={spec.title ?? ''} maxLength={LIMITS.titleMax} onChange={(e) => setSpec(c, { title: e.target.value })} placeholder="Reporter deposits never draw principal from arbitration or gas reserves" />
          </Field>
          <Field label="Requirement" htmlFor="requirement" help="One exact requirement or invariant, precise enough that a reproducible test can violate it." error={issueFor(c, 'spec.requirement')}>
            <Textarea id="requirement" value={spec.requirement ?? ''} onChange={(e) => setSpec(c, { requirement: e.target.value })} className="min-h-[9rem]" />
          </Field>
          <Field label="Source requirement document" htmlFor="specref" optional help="A link to the spec or issue the requirement comes from.">
            <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
              <Input id="specref" placeholder="Label" value={spec.specReference?.label ?? ''} onChange={(e) => setSpec(c, { specReference: e.target.value || spec.specReference?.url ? { label: e.target.value, url: spec.specReference?.url ?? '' } : undefined })} />
              <Input aria-label="Source requirement URL" placeholder="https://…" value={spec.specReference?.url ?? ''} onChange={(e) => setSpec(c, { specReference: e.target.value || spec.specReference?.label ? { label: spec.specReference?.label ?? '', url: e.target.value } : undefined })} />
            </div>
          </Field>
        </div>
      </Drawer>

      <Drawer open={drawer === 'scope'} onOpenChange={(o) => setDrawer(o ? 'scope' : null)} title="Scope" description="Name components, files, endpoints or functions. Anything not in scope cannot support a counterexample.">
        <div className="grid gap-6">
          <Field label="In scope" htmlFor="in-scope" error={issueFor(c, 'spec.scope.inScope')}>
            <ListEditor label="In scope" value={spec.scope?.inScope ?? []} onChange={(v) => setSpec(c, { scope: { inScope: v, outOfScope: spec.scope?.outOfScope ?? [] } })} placeholder="src/planner/reporter-funding.ts" />
          </Field>
          <Field label="Out of scope" htmlFor="out-scope" optional>
            <ListEditor label="Out of scope" value={spec.scope?.outOfScope ?? []} onChange={(v) => setSpec(c, { scope: { inScope: spec.scope?.inScope ?? [], outOfScope: v } })} placeholder="LI.FI bridge execution" />
          </Field>
        </div>
      </Drawer>

      <Drawer
        open={drawer === 'environment'}
        onOpenChange={(o) => setDrawer(o ? 'environment' : null)}
        title="Environment and reproduction"
        description="Pin everything an investigator needs to reproduce. The environment hash in the question changes as you edit."
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 text-[0.8rem] text-ink-3">
            <span>Environment hash</span>
            <HashChip value={env.envHash} label="env" />
          </div>
        }
      >
        <div className="grid gap-5">
          <Note tone="caution">Never pin secrets. This configuration is published with the claim. Use placeholders and describe how to supply real values.</Note>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Runtime" htmlFor="runtime" error={issueFor(c, 'spec.environment.runtime')}>
              <Input id="runtime" value={env.runtime ?? ''} onChange={(e) => setEnv(c, { runtime: e.target.value })} placeholder="node 22.14.0" />
            </Field>
            <Field label="Package manager" htmlFor="pm" optional>
              <Input id="pm" value={env.packageManager ?? ''} onChange={(e) => setEnv(c, { packageManager: e.target.value || undefined })} placeholder="pnpm 10.9.2" />
            </Field>
          </div>
          <Field label="Reproduction command" htmlFor="repro" error={issueFor(c, 'spec.environment.reproductionCommand')} help="What investigators run against the pinned commit.">
            <Textarea id="repro" value={env.reproductionCommand ?? ''} onChange={(e) => setEnv(c, { reproductionCommand: e.target.value })} className="min-h-[4.5rem] font-mono text-[0.85rem]" placeholder="pnpm vitest run test/reporter-funding.spec.ts" />
          </Field>
          <Field label="Setup steps" htmlFor="setup" optional>
            <ListEditor label="Setup step" mono value={env.setupSteps ?? []} onChange={(v) => setEnv(c, { setupSteps: v })} placeholder="pnpm install --frozen-lockfile" addLabel="Add a step" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_1.4fr]">
            <Field label="Lockfile path" htmlFor="lockpath" optional>
              <Input id="lockpath" value={env.dependencyLock?.path ?? ''} onChange={(e) => setEnv(c, { dependencyLock: e.target.value || env.dependencyLock?.hash ? { path: e.target.value, hash: env.dependencyLock?.hash ?? ('' as `0x${string}`) } : undefined })} placeholder="pnpm-lock.yaml" />
            </Field>
            <Field label="Lockfile hash" htmlFor="lockhash" optional error={issueFor(c, 'spec.environment.dependencyLock')}>
              <Input id="lockhash" value={env.dependencyLock?.hash ?? ''} onChange={(e) => setEnv(c, { dependencyLock: e.target.value || env.dependencyLock?.path ? { path: env.dependencyLock?.path ?? '', hash: e.target.value as `0x${string}` } : undefined })} placeholder="0x…" className="font-mono text-[0.82rem]" />
            </Field>
          </div>
          <Field label="Container image" htmlFor="image" optional>
            <Input id="image" value={env.containerImage ?? ''} onChange={(e) => setEnv(c, { containerImage: e.target.value || undefined })} placeholder="ghcr.io/org/image@sha256:…" className="font-mono text-[0.82rem]" />
          </Field>
          <Field label="External state" htmlFor="extstate" optional help='For example "Gnosis block 41,200,000 fork" or "none".'>
            <Input id="extstate" value={env.externalState ?? ''} onChange={(e) => setEnv(c, { externalState: e.target.value || undefined })} />
          </Field>
          <Field label="Non-secret configuration" htmlFor="config" optional error={issueFor(c, 'spec.environment.config')}>
            <KeyValueEditor label="Configuration" value={env.config ?? {}} onChange={(v) => setEnv(c, { config: v })} />
          </Field>
        </div>
      </Drawer>

      <Drawer open={drawer === 'fault'} onOpenChange={(o) => setDrawer(o ? 'fault' : null)} title="Fault model and inputs" description="Be explicit. Do not silently assume arbitrary corruption.">
        <div className="grid gap-5">
          <Field label="Fault model" htmlFor="fault" optional help="For example: process crash between plan and broadcast, RPC timeout, replacement transaction.">
            <Textarea id="fault" value={spec.faultModel ?? ''} onChange={(e) => setSpec(c, { faultModel: e.target.value || undefined })} />
          </Field>
          <Field label="Allowed inputs" htmlFor="inputs" optional help="The input domain a counterexample may use.">
            <Textarea id="inputs" value={spec.allowedInputs ?? ''} onChange={(e) => setSpec(c, { allowedInputs: e.target.value || undefined })} />
          </Field>
        </div>
      </Drawer>

      <Drawer open={drawer === 'lists'} onOpenChange={(o) => setDrawer(o ? 'lists' : null)} title="Assumptions and exclusions">
        <div className="grid gap-6">
          <Field label="Assumptions" htmlFor="assumptions" optional>
            <ListEditor label="Assumption" value={spec.assumptions ?? []} onChange={(v) => setSpec(c, { assumptions: v })} placeholder="The operator EOA holds funds for all categories" />
          </Field>
          <Field label="Exclusions" htmlFor="exclusions" optional help={policy ? `${policy.id} already excludes: ${policy.exclusions.slice(0, 2).join('; ')}…` : undefined}>
            <ListEditor label="Exclusion" value={spec.exclusions ?? []} onChange={(v) => setSpec(c, { exclusions: v })} placeholder="Legitimate gas paid by the operator reserve" />
          </Field>
          <div className="rounded-[3px] border border-line p-4">
            <Switch
              id="regression-only"
              checked={!!spec.regressionOnly}
              onChange={(v) => setSpec(c, { regressionOnly: v })}
              label="Only regressions qualify"
              description={src?.baseCommit ? `Relative to the pinned base commit ${shortSha(src.baseCommit.sha)}.` : 'Needs a base commit: pin the commit from a pull request.'}
            />
            {issueFor(c, 'source.baseCommit') && <p className="mt-2 text-[0.82rem] font-[550] text-flare-ink">{issueFor(c, 'source.baseCommit')}</p>}
          </div>
        </div>
      </Drawer>

      {policy && (
        <Drawer open={drawer === 'params'} onOpenChange={(o) => setDrawer(o ? 'params' : null)} title={`${policy.id} parameters`} description="The policy template asks for these to bound the claim.">
          <div className="grid gap-5">
            {policy.parameters.map((p) => (
              <div key={p.key}>
                <ParamInput
                  p={p}
                  value={spec.parameters?.[p.key]}
                  onChange={(v) => setSpec(c, { parameters: { ...(spec.parameters ?? {}), [p.key]: v } })}
                />
                {issueFor(c, `spec.parameters.${p.key}`) && <p className="mt-1 text-[0.8rem] font-[550] text-flare-ink">{issueFor(c, `spec.parameters.${p.key}`)}</p>}
              </div>
            ))}
          </div>
        </Drawer>
      )}
    </div>
  )
}
