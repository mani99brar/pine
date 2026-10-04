'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ClaimDraft, EnvironmentPin, PolicyParameterSpec } from '@pine/core'
import { formatDate, formatDuration, getEvidenceMechanism, isEvidenceMechanismEnabled, POLICIES, shortSha } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { roundUpToHourUtc, toSourceRef, useGitHubPullCommits, usePine, useResolveGitHubInput, type ClaimComposer } from '@pine/react'
import { Lock, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { FormField, Notice } from '@/components/ui/primitives'
import { HashChip } from '@/components/ui/interactive'
import { FamilyIcon } from '@/components/icons'
import { FAMILY_NAME, FAMILY_VAR } from '@/lib/crystal'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { issueFor, KeyValueEditor, ListEditor, StageHeader, StageIssues, StageNav, type StepNav } from './shared'
import { PinnedSha, SourceCard } from './SourceParts'

const DEMO_EXAMPLES = ['kleros/gateway-balancer-bot/pull/47', 'acme-labs/fastparse#231', 'northwind/auth-gateway/pull/402']

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export function StageSource({ c, nav, initialInput }: { c: ClaimComposer; nav: StepNav; initialInput?: string }) {
  const { demo } = usePine()
  const [input, setInput] = useState(initialInput ?? '')
  const [justPinned, setJustPinned] = useState(false)
  const resolved = useResolveGitHubInput(input)
  const pinned = c.draft.source
  const prCommits = useGitHubPullCommits(resolved.repo?.owner, resolved.repo?.name, resolved.pull?.number)
  const [altSha, setAltSha] = useState('')
  const candidate = useMemo(() => {
    if (!resolved.source) return undefined
    if (altSha && resolved.repo) {
      const alt = prCommits.data?.find((x) => x.sha === altSha)
      if (alt) return toSourceRef({ repo: resolved.repo, commit: alt, pull: resolved.pull })
    }
    return resolved.source
  }, [resolved.source, resolved.repo, resolved.pull, altSha, prCommits.data])

  const pin = () => {
    if (!candidate) return
    c.update({ source: candidate })
    setJustPinned(true)
  }

  if (pinned && !input) {
    return (
      <div>
        <StageHeader step="source">The claim is about this exact commit and nothing else. New commits on the pull request need a new claim.</StageHeader>
        <SourceCard source={pinned}>
          <PinnedSha sha={pinned.commit.sha} animate={justPinned} />
          <p className="mt-3 inline-flex items-center gap-2 text-[0.875rem] font-semibold text-lumen">
            <Lock size={14} aria-hidden /> Pinned. The commit facet is cut.
          </p>
        </SourceCard>
        {!c.frozen ? (
          <Button variant="ghost" className="mt-4" onClick={() => setInput(`${pinned.owner}/${pinned.repo}`)}>
            Pin a different commit
          </Button>
        ) : (
          <Notice className="mt-4" tone="boundary">
            {COPY.frozenTerms}
          </Notice>
        )}
        <StageIssues c={c} step="source" className="mt-5" />
        <StageNav nav={nav} />
      </div>
    )
  }

  return (
    <div>
      <StageHeader step="source">
        Paste a pull request, a commit URL or <code className="t-code text-lumen">owner/repo#12</code>. Pine looks it up on GitHub (public repositories only) and pins the full 40-character SHA.
      </StageHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (resolved.status === 'resolved') pin()
        }}
      >
        <label htmlFor="source-input" className="sr-only">
          Pull request, commit URL or owner/repo reference
        </label>
        <div className="relative">
          <Search size={19} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lumen-3" />
          <input
            id="source-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setJustPinned(false)
              setAltSha('')
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo/pull/12"
            aria-describedby="source-status"
            className="field t-code h-14 pl-11 text-[0.95rem]"
          />
        </div>
      </form>
      {demo && !input && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.84375rem] text-lumen-3">
          <span>Try a demo pull request:</span>
          {DEMO_EXAMPLES.map((ex) => (
            <button key={ex} type="button" onClick={() => setInput(ex)} className="chip t-code text-[0.78rem]">
              {ex}
            </button>
          ))}
        </div>
      )}
      <div id="source-status" className="mt-6" aria-live="polite">
        {resolved.status === 'empty' ? (
          <p className="text-[0.9375rem] text-lumen-2">
            Or{' '}
            <Link href="/repos" className="link">
              browse repositories
            </Link>{' '}
            and pick a commit from a pull request.
          </p>
        ) : resolved.status === 'loading' ? (
          <div className="cut-lg border border-dashed border-edge-strong p-5">
            <p className="text-[0.9rem] text-lumen-2">Looking it up on GitHub</p>
            <span className="skeleton mt-3 block h-4 w-1/2" />
            <span className="skeleton mt-2 block h-6 w-full" />
          </div>
        ) : resolved.status === 'resolved' && candidate ? (
          <SourceCard source={candidate}>
            <PinnedSha key={`${candidate.commit.sha}-${justPinned}`} sha={candidate.commit.sha} animate={justPinned} />
            {resolved.pull && (prCommits.data?.length ?? 0) > 1 && (
              <label className="mt-4 flex flex-wrap items-center gap-2 text-[0.84375rem] text-lumen-2">
                Pin a different commit from this pull request
                <select value={altSha} onChange={(e) => setAltSha(e.target.value)} className="field w-auto max-w-full text-[0.84375rem]">
                  <option value="">Head commit (latest)</option>
                  {prCommits.data!.map((cm) => (
                    <option key={cm.sha} value={cm.sha}>
                      {shortSha(cm.sha)} {(cm.message.split('\n')[0] ?? '').slice(0, 60)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button onClick={pin} disabled={c.frozen} icon={<Lock size={15} aria-hidden />}>
                Pin this commit
              </Button>
              {resolved.pull && !altSha && <p className="text-[0.8125rem] text-lumen-3">This is the pull request&apos;s head commit right now. Later pushes are not covered.</p>}
            </div>
          </SourceCard>
        ) : (
          <Notice tone="caution" title={resolved.status === 'rate_limited' ? 'GitHub rate limit reached' : resolved.status === 'not_found' ? 'Not found on GitHub' : 'That reference did not resolve'}>
            {resolved.reason ?? 'Check the URL and try again.'}
          </Notice>
        )}
      </div>
      <StageIssues c={c} step="source" className="mt-6" />
      <StageNav nav={nav} nextDisabled={!c.draft.source} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function StagePolicy({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const selected = c.draft.spec.policyId
  const policy = c.policy
  return (
    <div>
      <StageHeader step="policy">A policy defines what counts as a counterexample. Its version and content hash go into the question, so later edits to the policy never change this claim.</StageHeader>
      <div
        role="radiogroup"
        aria-label="Policy"
        className="grid gap-3"
        onKeyDown={(e) => {
          // Arrow keys move between enabled policies and select them, as in a native radio group.
          const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
          if (!d || c.frozen) return
          const enabled = POLICIES.filter((p) => p.status === 'enabled')
          const i = Math.max(0, enabled.findIndex((p) => p.id === selected))
          const next = enabled[(i + d + enabled.length) % enabled.length]
          if (!next) return
          e.preventDefault()
          c.update({ spec: { policyId: next.id, claimClass: undefined } })
          requestAnimationFrame(() => document.getElementById(`policy-${next.id}`)?.focus())
        }}
      >
        {POLICIES.map((p, idx) => {
          const gated = p.status !== 'enabled'
          const active = selected === p.id
          const firstEnabled = !selected && idx === POLICIES.findIndex((x) => x.status === 'enabled')
          return (
            <button
              key={p.id}
              id={`policy-${p.id}`}
              type="button"
              role="radio"
              aria-checked={active}
              aria-disabled={gated}
              tabIndex={active || firstEnabled || gated ? 0 : -1}
              disabled={c.frozen}
              onClick={() => {
                if (gated) return
                c.update({ spec: { policyId: p.id, claimClass: undefined } })
              }}
              className={cn(
                'cut-lg relative overflow-hidden border p-5 text-left transition-colors',
                active ? 'border-[rgba(255,236,220,0.45)] bg-smoke-2' : 'border-edge bg-smoke hover:border-edge-strong',
                gated && 'cursor-not-allowed opacity-75',
              )}
            >
              <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: FAMILY_VAR[p.family], opacity: active ? 1 : 0.5 }} />
              <div className="flex flex-wrap items-center gap-3">
                <span style={{ color: FAMILY_VAR[p.family] }}>
                  <FamilyIcon family={p.family} size={22} />
                </span>
                <span className="t-h4">
                  {p.id}@{p.version}
                </span>
                <span className="text-[0.875rem] text-lumen-2">{p.title}</span>
                {gated && <span className="tag ml-auto border-[rgba(183,154,255,0.45)] text-ca">Gated</span>}
                {active && !gated && <span className="tag ml-auto text-lumen">Selected</span>}
              </div>
              <p className="mt-2 max-w-[68ch] text-[0.90625rem] text-lumen-2">{p.summary}</p>
              <p className="mt-1 text-[0.8125rem] text-lumen-3">{FAMILY_NAME[p.family]}</p>
              {gated && <p className="mt-2 text-[0.84375rem] text-ca">{p.gateReason ?? COPY.scGate}</p>}
            </button>
          )
        })}
      </div>
      {policy && policy.claimClasses.length > 0 && (
        <fieldset className="mt-8">
          <legend className="t-h4">Claim class</legend>
          <p className="help mt-1">Optional. A suggested shape of claim inside {policy.id}. The family is not a blanket promise.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {policy.claimClasses.map((cl) => {
              const on = c.draft.spec.claimClass === cl.id
              return (
                <label key={cl.id} className={cn('cut-md flex cursor-pointer gap-3 border p-3', on ? 'border-[rgba(255,236,220,0.4)] bg-smoke-2' : 'border-edge bg-smoke hover:border-edge-strong')}>
                  <input
                    type="radio"
                    name="claim-class"
                    className="facet-check rounded-full"
                    checked={on}
                    disabled={c.frozen}
                    onChange={() => c.update({ spec: { claimClass: cl.id } })}
                  />
                  <span>
                    <span className="block text-[0.9rem] font-semibold text-lumen">{cl.label}</span>
                    <span className="block text-[0.8125rem] text-lumen-2">{cl.description}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )}
      <StageIssues c={c} step="policy" className="mt-6" />
      <StageNav nav={nav} nextDisabled={!policy || policy.status !== 'enabled'} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

function ParamField({
  p,
  value,
  onChange,
  disabled,
  error,
  apiMode,
}: {
  p: PolicyParameterSpec
  value: string | string[] | boolean | undefined
  onChange: (v: string | string[] | boolean) => void
  disabled?: boolean
  error?: string
  /** api mode: free-text lists show their issue inline and cap each entry at the schema's length. */
  apiMode?: boolean
}) {
  const id = `param-${p.key}`
  const label = (
    <>
      {p.label}
      {!p.required && <span className="ml-1.5 text-[0.8rem] font-normal text-lumen-3">optional</span>}
    </>
  )
  if (p.kind === 'multiselect' && p.options?.length) {
    // A fixed vocabulary from the policy: pick from it (chips), never free text.
    const picked = new Set(Array.isArray(value) ? value : [])
    const toggle = (v: string) => {
      const next = new Set(picked)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      // "none" excludes every fault, so it cannot be combined with the others.
      if (v === 'none' && next.has('none')) return onChange(['none'])
      next.delete(v === 'none' ? '' : 'none')
      onChange(p.options!.map((o) => o.value).filter((x) => next.has(x)))
    }
    return (
      <fieldset aria-describedby={`${id}-help`}>
        <legend className="label">
          {label}
        </legend>
        <p id={`${id}-help`} className="help -mt-1 mb-2.5">
          {p.help}
        </p>
        <div className="flex flex-wrap gap-2" id={id}>
          {p.options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="chip"
              aria-pressed={picked.has(o.value)}
              disabled={disabled}
              onClick={() => toggle(o.value)}
              title={o.help}
            >
              <span aria-hidden className={cn('h-2 w-2 rotate-45 border transition-colors', picked.has(o.value) ? 'border-lumen bg-lumen' : 'border-edge-strong')} />
              {o.label}
            </button>
          ))}
        </div>
        {error && <p className="mt-1.5 text-[0.8125rem] font-medium text-ha">{error}</p>}
      </fieldset>
    )
  }
  if (p.kind === 'list' || p.kind === 'multiselect') {
    return (
      <ListEditor
        id={id}
        label={p.label}
        help={p.help || undefined}
        items={Array.isArray(value) ? value : []}
        onChange={onChange}
        disabled={disabled}
        maxLength={apiMode ? p.maxLength : undefined}
        error={apiMode ? error : undefined}
        placeholder={typeof p.example === 'string' ? p.example : p.placeholder}
      />
    )
  }
  if (p.kind === 'boolean') {
    return (
      <label className="flex items-start gap-3">
        <input type="checkbox" className="facet-check" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <span className="block text-[0.9rem] font-semibold text-lumen">{p.label}</span>
          <span className="help block">{p.help}</span>
        </span>
      </label>
    )
  }
  if (p.kind === 'select') {
    return (
      <FormField id={id} label={label} help={p.options?.find((o) => o.value === value)?.help ?? p.help} error={error}>
        <select id={id} className="field" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose</option>
          {p.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </FormField>
    )
  }
  const common = {
    id,
    value: typeof value === 'string' ? value : '',
    disabled,
    maxLength: p.maxLength,
    placeholder: p.placeholder ?? (typeof p.example === 'string' ? p.example : undefined),
    'aria-invalid': Boolean(error) || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  }
  return (
    <FormField id={id} label={label} help={p.help} error={error}>
      {p.kind === 'longtext' ? <textarea className="field" rows={3} {...common} /> : <input className={cn('field', (p.kind === 'hash' || p.kind === 'address') && 't-code')} {...common} />}
    </FormField>
  )
}

/** In api mode, values the chosen backend policy does not define (left from another policy); Pine refuses them. */
function UnknownParameters({ c }: { c: ClaimComposer }) {
  const policy = c.policy
  if (!c.api || !policy) return null
  const known = new Set(policy.parameters.map((p) => p.key))
  const unknown = Object.entries(c.draft.spec.parameters ?? {}).filter(([k, v]) => !known.has(k) && !(v === '' || (Array.isArray(v) && v.length === 0)))
  if (unknown.length === 0) return null
  const remove = (key: string) =>
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, parameters: Object.fromEntries(Object.entries(d.spec.parameters ?? {}).filter(([k]) => k !== key)) } }))
  return (
    <Notice tone="caution" title={`Not parameters of ${policy.id}@${policy.version}`} role="status">
      <p>Pine refuses parameters the policy does not define. These are left from another policy:</p>
      <ul className="mt-1.5 grid gap-1.5">
        {unknown.map(([k]) => (
          <li key={k} className="flex flex-wrap items-center gap-2">
            <code className="t-code text-lumen">{k}</code>
            <Button size="sm" variant="ghost" disabled={c.frozen} onClick={() => remove(k)}>
              Remove {k}
            </Button>
          </li>
        ))}
      </ul>
    </Notice>
  )
}

/** The question box: the local question in demo mode; in api mode the registry's question with the document part elided. */
function QuestionPreview({ c }: { c: ClaimComposer }) {
  if (!c.api) {
    return (
      <div className="cut-lg well p-4">
        <p className="text-[0.8125rem] text-lumen-3">The question, as the market will read it</p>
        <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen [overflow-wrap:anywhere]">{c.question?.text ?? 'Pin a commit and choose a policy to see the question.'}</p>
      </div>
    )
  }
  const sketch = c.api.questionSketch
  const pending = !c.draft.source || !c.policy
  return (
    <div className="cut-lg well p-4">
      <p className="text-[0.8125rem] text-lumen-3">The question, as Pine&apos;s claim registry will compose it</p>
      <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen [overflow-wrap:anywhere]">
        {sketch ?? (pending ? 'Pin a commit and choose a policy to see the question.' : 'Write a valid title to see the question.')}
      </p>
      {sketch && (
        <p className="mt-2 text-[0.78rem] text-lumen-3">
          Only the title is yours; the rest is fixed text, digests and times. ipfs://… and sha256 … stand for the claim document, which Pine freezes when you
          request the preview. The times assume you preview now.
        </p>
      )}
    </div>
  )
}

export function StageClaim({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const spec = c.draft.spec
  const dis = c.frozen
  const api = Boolean(c.api)
  const setSpec = (patch: Partial<ClaimDraft['spec']>) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, ...patch } }))
  const policy = c.policy
  // api mode shows the backend's field rules next to the fields; demo mode keeps its stage summary only.
  const apiIssue = (path: string) => (api ? issueFor(c, path) : undefined)
  return (
    <div>
      <StageHeader step="claim">
        One exact requirement, and the violation a counterexample must demonstrate. Blanket statements about the whole codebase cannot be resolved. {COPY.boundedClaim}
      </StageHeader>
      <div className="grid gap-6">
        <FormField
          id="title"
          label="Title"
          help={
            api
              ? 'A short, specific name (90 characters or fewer). It is written into the on-chain question, so use printable ASCII only, without " \\ [ or ].'
              : 'A short, specific name shown on the light table (90 characters or fewer).'
          }
          error={issueFor(c, 'spec.title')}
        >
          <input
            id="title"
            className="field"
            maxLength={90}
            value={spec.title ?? ''}
            disabled={dis}
            aria-invalid={apiIssue('spec.title') ? true : undefined}
            onChange={(e) => c.update({ spec: { title: e.target.value } })}
            placeholder="Reporter deposits never draw principal from arbitration or gas reserves"
          />
        </FormField>
        <FormField id="requirement" label="Requirement" help="The one behavior the code must have, in plain words." error={issueFor(c, 'spec.requirement')}>
          <textarea id="requirement" className="field" rows={3} maxLength={api ? 4000 : undefined} value={spec.requirement ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { requirement: e.target.value } })} />
        </FormField>
        <FormField
          id="violation"
          label="Violation"
          help={
            api
              ? 'What a counterexample must demonstrate. It goes into the claim document, which the question pins by its digest.'
              : 'Completes the question: “Was a reproducible counterexample demonstrating … against commit …”'
          }
          error={issueFor(c, 'spec.violation')}
        >
          <textarea
            id="violation"
            className="field"
            rows={2}
            maxLength={api ? 4000 : undefined}
            value={spec.violation ?? ''}
            disabled={dis}
            onChange={(e) => c.update({ spec: { violation: e.target.value } })}
            placeholder="that reporter-deposit principal can be funded from the arbitration allocation"
          />
        </FormField>

        <QuestionPreview c={c} />

        <div className="grid gap-6 md:grid-cols-2">
          <ListEditor
            id="in-scope"
            label="In scope"
            help={api ? 'At least one component, at most 50, each up to 300 characters.' : undefined}
            maxLength={api ? 300 : undefined}
            error={apiIssue('spec.scope.inScope')}
            items={spec.scope?.inScope ?? []}
            disabled={dis}
            onChange={(v) => setSpec({ scope: { inScope: v, outOfScope: spec.scope?.outOfScope ?? [] } })}
            placeholder="src/funding/reporter-planner.ts"
          />
          <ListEditor
            id="out-scope"
            label="Out of scope"
            help={api ? 'Optional, at most 50, each up to 300 characters.' : undefined}
            maxLength={api ? 300 : undefined}
            error={apiIssue('spec.scope.outOfScope')}
            items={spec.scope?.outOfScope ?? []}
            disabled={dis}
            onChange={(v) => setSpec({ scope: { inScope: spec.scope?.inScope ?? [], outOfScope: v } })}
            placeholder="Live bridge integrations"
          />
        </div>

        {policy && policy.parameters.length > 0 && (
          <fieldset className="grid gap-5">
            <legend className="t-h4 mb-1">
              {policy.id} parameters
            </legend>
            {policy.parameters.map((p) => (
              <ParamField
                key={p.key}
                p={p}
                value={spec.parameters?.[p.key]}
                disabled={dis}
                error={issueFor(c, `spec.parameters.${p.key}`)}
                apiMode={api}
                onChange={(v) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, parameters: { ...(d.spec.parameters ?? {}), [p.key]: v } } }))}
              />
            ))}
          </fieldset>
        )}
        <UnknownParameters c={c} />

        <FormField
          id="fault-model"
          label={policy?.parameters.some((x) => x.key === 'faultModel') ? 'Fault model details' : 'Fault model'}
          optional={!api}
          help={
            api
              ? 'Which failures count, for example a process crash or an RPC timeout. Do not silently assume arbitrary corruption.'
              : policy?.parameters.some((x) => x.key === 'faultModel')
                ? `Anything the ${policy.id} fault list above does not say, for example limits on retries or timing. Do not silently assume arbitrary corruption.`
                : 'Allowed faults, for example process crash or timeout. Do not silently assume arbitrary corruption.'
          }
          error={apiIssue('spec.faultModel')}
        >
          <textarea id="fault-model" className="field" rows={2} maxLength={api ? 4000 : undefined} value={spec.faultModel ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { faultModel: e.target.value || undefined } })} />
        </FormField>
        <FormField
          id="allowed-inputs"
          label="Allowed inputs"
          optional={!api}
          help={api ? 'The inputs an investigator may use, for example any configuration of the bot, or only its public API.' : undefined}
          error={apiIssue('spec.allowedInputs')}
        >
          <input id="allowed-inputs" className="field" maxLength={api ? 4000 : undefined} value={spec.allowedInputs ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { allowedInputs: e.target.value || undefined } })} />
        </FormField>
        <div className="grid gap-6 md:grid-cols-2">
          <ListEditor
            id="assumptions"
            label="Assumptions"
            help={api ? 'Optional, at most 50, each up to 1,000 characters.' : undefined}
            maxLength={api ? 1000 : undefined}
            error={apiIssue('spec.assumptions')}
            items={spec.assumptions ?? []}
            disabled={dis}
            onChange={(v) => setSpec({ assumptions: v })}
          />
          <ListEditor
            id="exclusions"
            label="Exclusions"
            help={api ? 'Optional, at most 50, each up to 1,000 characters.' : undefined}
            maxLength={api ? 1000 : undefined}
            error={apiIssue('spec.exclusions')}
            items={spec.exclusions ?? []}
            disabled={dis}
            onChange={(v) => setSpec({ exclusions: v })}
          />
        </div>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="facet-check" checked={spec.regressionOnly ?? false} disabled={dis} onChange={(e) => c.update({ spec: { regressionOnly: e.target.checked } })} />
          <span>
            <span className="block text-[0.9rem] font-semibold text-lumen">Only regressions relative to the base commit qualify</span>
            <span className="help block">{c.draft.source?.baseCommit ? `Base commit ${shortSha(c.draft.source.baseCommit.sha)} is pinned.` : 'Needs a pinned base commit (pin a pull request to get one).'}</span>
            {apiIssue('source.baseCommit') && <span className="mt-1 block text-[0.8125rem] font-medium text-ha">{apiIssue('source.baseCommit')}</span>}
          </span>
        </label>
      </div>
      <StageIssues c={c} step="claim" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function StageEnvironment({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const env = c.spec.environment
  const dis = c.frozen
  const api = Boolean(c.api)
  const setEnv = (patch: Partial<EnvironmentPin>) =>
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, environment: { ...(d.spec.environment ?? env), ...patch } as EnvironmentPin } }))
  // api mode: the lockfile and the dependency notes become the claim document's dependencies (one of them is required).
  const exact = (path: string) => (api ? c.validation.issues.find((i) => i.path === path)?.message : undefined)
  return (
    <div>
      <StageHeader step="environment">
        {api
          ? 'Pin everything an investigator needs to reproduce the behavior. It all goes into the claim document, which the market question pins by its digest.'
          : 'Pin everything an investigator needs to reproduce the behavior. The configuration and environment hashes update as you type and go into the question.'}
      </StageHeader>
      {!api && (
        <div className="mb-6 flex flex-wrap gap-2">
          <HashChip value={env.envHash} label="Environment hash" />
          <HashChip value={env.configHash} label="Configuration hash" />
        </div>
      )}
      <div className="grid gap-6">
        <div className="grid gap-6 md:grid-cols-2">
          <FormField id="runtime" label="Runtime" help="For example node 22.14.0 or python 3.12.4." error={issueFor(c, 'spec.environment.runtime')}>
            <input id="runtime" className="field t-code" value={env.runtime} disabled={dis} onChange={(e) => setEnv({ runtime: e.target.value })} placeholder="node 22.14.0" />
          </FormField>
          <FormField id="pkg" label="Package manager" optional>
            <input id="pkg" className="field t-code" value={env.packageManager ?? ''} disabled={dis} onChange={(e) => setEnv({ packageManager: e.target.value || undefined })} placeholder="pnpm 10.9.2" />
          </FormField>
        </div>
        <div className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <FormField id="lock-path" label="Lockfile path" optional>
            <input
              id="lock-path"
              className="field t-code"
              value={env.dependencyLock?.path ?? ''}
              disabled={dis}
              onChange={(e) => setEnv({ dependencyLock: e.target.value || env.dependencyLock?.hash ? { path: e.target.value, hash: env.dependencyLock?.hash ?? ('0x' as `0x${string}`) } : undefined })}
              placeholder="pnpm-lock.yaml"
            />
          </FormField>
          <FormField
            id="lock-hash"
            label="Lockfile hash"
            optional
            help="keccak256 or sha256 as 0x-prefixed hex."
            error={api ? issueFor(c, 'spec.environment.dependencyLock.hash') ?? issueFor(c, 'spec.environment.dependencyLock.path') : issueFor(c, 'spec.environment.dependencyLock')}
          >
            <input
              id="lock-hash"
              className="field t-code"
              value={env.dependencyLock?.hash ?? ''}
              disabled={dis}
              onChange={(e) => setEnv({ dependencyLock: { path: env.dependencyLock?.path ?? '', hash: e.target.value as `0x${string}` } })}
              placeholder="0x…"
            />
          </FormField>
        </div>
        <div>
          <p className="label">Configuration</p>
          <KeyValueEditor value={env.config} disabled={dis} onChange={(config) => setEnv({ config })} />
          {issueFor(c, 'spec.environment.config') && <p className="mt-1.5 text-[0.8125rem] text-ha">{issueFor(c, 'spec.environment.config')}</p>}
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <FormField id="container" label="Container image" optional help="image@sha256:… for an exact build.">
            <input id="container" className="field t-code" value={env.containerImage ?? ''} disabled={dis} onChange={(e) => setEnv({ containerImage: e.target.value || undefined })} />
          </FormField>
          <FormField
            id="external"
            label="External state"
            optional={!api}
            help={api ? 'What the reproduction needs outside the repository, for example a chain snapshot. Write “none” if it needs none.' : 'For example a block snapshot, or none.'}
            error={exact('spec.environment.externalState')}
          >
            <input id="external" className="field" maxLength={api ? 4000 : undefined} value={env.externalState ?? ''} disabled={dis} onChange={(e) => setEnv({ externalState: e.target.value || undefined })} placeholder="none" />
          </FormField>
        </div>
        <FormField id="repro" label="Reproduction command" help="The command an investigator runs against the pinned commit." error={issueFor(c, 'spec.environment.reproductionCommand')}>
          <input id="repro" className="field t-code" maxLength={api ? 2000 : undefined} value={env.reproductionCommand} disabled={dis} onChange={(e) => setEnv({ reproductionCommand: e.target.value })} placeholder="pnpm vitest run test/reporter-funding.spec.ts" />
        </FormField>
        <ListEditor id="setup" label="Setup steps" error={exact('spec.environment.setupSteps')} items={env.setupSteps} disabled={dis} onChange={(setupSteps) => setEnv({ setupSteps })} placeholder="pnpm install --frozen-lockfile" mono />
        <FormField
          id="env-notes"
          label={api ? 'Dependency notes' : 'Notes'}
          optional={!api}
          help={api ? 'How the dependencies are installed or pinned. Required unless you pin a lockfile above; published with it as the claim document’s dependencies.' : undefined}
          error={exact('spec.environment.dependencyLock') ?? exact('spec.environment.notes')}
        >
          <textarea id="env-notes" className="field" rows={2} maxLength={api ? 4000 : undefined} value={env.notes ?? ''} disabled={dis} onChange={(e) => setEnv({ notes: e.target.value || undefined })} />
        </FormField>
      </div>
      <StageIssues c={c} step="environment" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Deadlines and oracle
// ---------------------------------------------------------------------------

const HOUR = 3_600_000
const DAY = 24 * HOUR

function isoParts(iso?: string): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  const p = (n: number) => String(n).padStart(2, '0')
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` }
}
const toIso = (date: string, time: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? `${date}T${time}:00Z` : undefined)
const isoFromMs = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

export function StageDeadlines({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const now = useNowMs()
  const spec = c.spec
  const dis = c.frozen
  const deadline = spec.evidence.deadline
  const opening = spec.oracle.openingTime
  const parts = isoParts(deadline)
  const offsetH = Math.round((Date.parse(opening) - Date.parse(deadline)) / HOUR)
  const chain = getChainOrDefault(c.fundingInput.chainId)
  const arb = chain.arbitration
  const setDeadline = (iso: string) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: d.spec.evidence?.mechanism ?? 'erc1497-arbitrator-proxy', deadline: iso } } }))
  const setOffset = (h: number) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, oracle: { ...spec.oracle, ...(d.spec.oracle ?? {}), openingTime: isoFromMs(Date.parse(deadline) + h * HOUR) } } }))
  const presets = [3, 7, 14, 30]
  const windowMs = now ? Date.parse(deadline) - now : null

  return (
    <div>
      <StageHeader step="deadlines">The evidence deadline is an absolute UTC time. After it, someone answers the question on Reality.eth, and every answer can be challenged for a fixed 3.5 days.</StageHeader>

      {/* Schematic timeline */}
      <div className="cut-lg well mb-8 p-4" aria-hidden>
        <div className="grid grid-cols-[2fr_0.5fr_1.2fr_1.6fr] gap-1 text-[0.75rem]">
          {[
            ['Evidence window', windowMs !== null && windowMs > 0 ? formatDuration(windowMs) : 'set a future time', 'var(--hb)'],
            ['Gap', `${offsetH}h`, 'var(--lumen-3)'],
            ['Answer and challenges', '3.5 days per answer', 'var(--na)'],
            ['If escalated: Kleros', `about ${arb.typicalRulingDays} days, plus ${arb.typicalAppealDays} per appeal`, 'var(--ca)'],
          ].map(([label, sub, color]) => (
            <div key={label} className="min-w-0">
              <div className="h-[3px] rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}` }} />
              <p className="mt-2 font-semibold leading-[1.3] text-lumen-2">{label}</p>
              <p className="mt-0.5 leading-[1.3] text-lumen-3">{sub}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6">
        <fieldset>
          <legend className="label">Evidence deadline (UTC)</legend>
          <div className="flex flex-wrap gap-2">
            {presets.map((days) => {
              const iso = now ? isoFromMs(roundUpToHourUtc(new Date(now + days * DAY)).getTime()) : ''
              const active = now ? Math.abs(Date.parse(deadline) - Date.parse(iso)) <= HOUR : false
              return (
                <button key={days} type="button" className="chip" aria-pressed={active} disabled={dis || !now} onClick={() => setDeadline(iso)}>
                  {days} days from now
                </button>
              )
            })}
          </div>
          <div className="mt-3 grid max-w-[28rem] grid-cols-[1.3fr_1fr] gap-2">
            <div>
              <label htmlFor="deadline-date" className="sr-only">
                Deadline date (UTC)
              </label>
              <input id="deadline-date" type="date" className="field tnum" value={parts.date} disabled={dis} onChange={(e) => toIso(e.target.value, parts.time || '00:00') && setDeadline(toIso(e.target.value, parts.time || '00:00')!)} />
            </div>
            <div>
              <label htmlFor="deadline-time" className="sr-only">
                Deadline time (UTC)
              </label>
              <input id="deadline-time" type="time" step={60} className="field tnum" value={parts.time} disabled={dis} onChange={(e) => toIso(parts.date, e.target.value) && setDeadline(toIso(parts.date, e.target.value)!)} />
            </div>
          </div>
          <p className="help mt-1.5">
            {formatDate(deadline, 'utc')}
            {now ? `, ${formatDuration(Math.max(0, Date.parse(deadline) - now))} from now` : ''}. Allowed range: 24 hours to 180 days out.
          </p>
          {issueFor(c, 'spec.evidence') && <p className="mt-1 text-[0.8125rem] text-ha">{issueFor(c, 'spec.evidence')}</p>}
          <p className="mt-2 text-[0.84375rem] text-lumen-3">{COPY.deadlineIsNotTradingCutoff}</p>
        </fieldset>

        <fieldset>
          <legend className="label">Evidence channel</legend>
          <div className="grid gap-2">
            {(['erc1497-arbitrator-proxy', 'commit-reveal'] as const).map((id) => {
              const m = getEvidenceMechanism(id, c.fundingInput.chainId)
              const enabled = isEvidenceMechanismEnabled(id)
              const on = spec.evidence.mechanism === id
              return (
                <label key={id} className={cn('cut-md flex gap-3 border p-3', on ? 'border-[rgba(255,236,220,0.4)] bg-smoke-2' : 'border-edge bg-smoke', !enabled && 'opacity-70')}>
                  <input
                    type="radio"
                    name="mechanism"
                    className="facet-check rounded-full"
                    checked={on}
                    disabled={dis || !enabled}
                    onChange={() => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, evidence: { deadline, mechanism: id } } }))}
                  />
                  <span className="min-w-0">
                    <span className="block text-[0.9rem] font-semibold text-lumen">
                      {m.label} {!enabled && <span className="tag ml-1 text-ca">Launch gate</span>}
                    </span>
                    <span className="block text-[0.8125rem] text-lumen-2">{m.description}</span>
                    {m.launchGate && <span className="mt-1 block text-[0.78rem] text-lumen-3">{m.launchGate}</span>}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <div className="grid gap-6 md:grid-cols-2">
          <FormField id="opening" label="Oracle opens" help="When Reality.eth starts accepting answers. Never before the evidence deadline." error={issueFor(c, 'spec.oracle.openingTime')}>
            <select id="opening" className="field" value={[1, 6, 24, 72].includes(offsetH) ? String(offsetH) : 'custom'} disabled={dis} onChange={(e) => e.target.value !== 'custom' && setOffset(Number(e.target.value))}>
              <option value="1">1 hour after the deadline</option>
              <option value="6">6 hours after the deadline</option>
              <option value="24">24 hours after the deadline</option>
              <option value="72">3 days after the deadline</option>
              {![1, 6, 24, 72].includes(offsetH) && <option value="custom">{offsetH} hours after the deadline</option>}
            </select>
          </FormField>
          <FormField id="min-bond" label={`Minimum answer bond (${spec.oracle.bondToken})`} help="Answerers post at least this bond. Each challenge must double it." error={issueFor(c, 'spec.oracle.minBond')}>
            <input
              id="min-bond"
              className="field tnum"
              inputMode="decimal"
              value={spec.oracle.minBond}
              disabled={dis}
              onChange={(e) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, oracle: { ...spec.oracle, ...(d.spec.oracle ?? {}), minBond: e.target.value.replace(',', '.') } } }))}
            />
          </FormField>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="flex items-center gap-1.5 text-[0.78rem] text-lumen-3">
              <Lock size={12} aria-hidden /> Answer timeout
            </dt>
            <dd className="mt-0.5 text-[0.9rem] text-lumen">3.5 days (302,400 seconds), fixed</dd>
            <dd className="mt-1 text-[0.75rem] text-lumen-3">{COPY.fixedTimeout}</dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="flex items-center gap-1.5 text-[0.78rem] text-lumen-3">
              <Lock size={12} aria-hidden /> Arbitrator
            </dt>
            <dd className="mt-0.5 text-[0.9rem] text-lumen">{spec.oracle.arbitratorName}</dd>
            <dd className="mt-1 text-[0.75rem] text-lumen-3">
              About {arb.feeEstimate} {arb.feeCurrency} on Ethereum, paid by whoever requests it. {COPY.arbitrationOnEthereum}
            </dd>
          </div>
        </dl>
      </div>
      <StageIssues c={c} step="deadlines" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}
