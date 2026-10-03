'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { ClaimDraft, EnvironmentPin, PolicyParameterSpec, SourceRef } from '@pine/core'
import { formatDate, formatDuration, getEvidenceMechanism, isEvidenceMechanismEnabled, POLICIES, shortSha } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { roundUpToHourUtc, toSourceRef, useGitHubPullCommits, usePine, useResolveGitHubInput, type ClaimComposer } from '@pine/react'
import { GitBranch, GitCommitHorizontal, GitPullRequest, Lock, Search } from 'lucide-react'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/Button'
import { FormField, Notice } from '@/components/ui/primitives'
import { HashChip } from '@/components/ui/interactive'
import { FamilyIcon } from '@/components/icons'
import { FAMILY_NAME, FAMILY_VAR } from '@/lib/crystal'
import { useNowMs, useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { issueFor, KeyValueEditor, ListEditor, StageHeader, StageIssues, StageNav, type StepNav } from './shared'

const DEMO_EXAMPLES = ['kleros/gateway-balancer-bot/pull/47', 'acme-labs/fastparse#231', 'northwind/auth-gateway/pull/402']

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** The SHA settles into place character by character when pinned. */
function PinnedSha({ sha, animate }: { sha: string; animate: boolean }) {
  const reduce = useReduceMotion()
  return (
    <p className="t-code flex flex-wrap gap-x-[0.5em] gap-y-1 text-[1.02rem] leading-[1.4] sm:text-[1.12rem]" aria-label={`Commit ${sha}`}>
      {(sha.match(/.{1,4}/g) ?? []).map((g, gi) => (
        <span key={gi} className="whitespace-nowrap" aria-hidden>
          {g.split('').map((ch, ci) => {
            const idx = gi * 4 + ci
            return (
              <motion.span
                key={ci}
                className={cn('inline-block', idx < 7 ? 'font-semibold text-lumen' : 'text-lumen-2')}
                initial={animate && !reduce ? { opacity: 0, y: -6, filter: 'blur(4px)' } : false}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ delay: idx * 0.018, duration: 0.3 }}
              >
                {ch}
              </motion.span>
            )
          })}
        </span>
      ))}
    </p>
  )
}

function SourceCard({ source, children }: { source: SourceRef; children?: React.ReactNode }) {
  const first = (source.commit.message ?? '').split('\n')[0] ?? ''
  return (
    <div className="glass cut-lg overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-4 py-3 text-[0.875rem]">
        <span className="inline-flex items-center gap-1.5 font-semibold text-lumen">
          <GitBranch size={15} aria-hidden /> {source.owner}/{source.repo}
        </span>
        {source.license && <span className="text-lumen-3">{source.license}</span>}
        {source.pullRequest && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-lumen-2">
            <GitPullRequest size={14} aria-hidden />
            <span className="untrusted line-clamp-1 [white-space:normal]">
              #{source.pullRequest.number} {source.pullRequest.title}
            </span>
          </span>
        )}
      </div>
      <div className="px-4 py-4">
        <p className="flex items-start gap-2 text-[0.9375rem] text-lumen">
          <GitCommitHorizontal size={16} aria-hidden className="mt-0.5 shrink-0 text-lumen-3" />
          {/* Commit messages are untrusted text */}
          <span className="untrusted min-w-0 font-semibold [white-space:normal]">{first || '(no commit message)'}</span>
        </p>
        <p className="mt-1 pl-6 text-[0.8125rem] text-lumen-3">
          {source.commit.author} committed {formatDate(source.commit.committedAt, 'long')}
        </p>
        <div className="mt-4">{children}</div>
        {source.baseCommit && (
          <p className="mt-3 text-[0.8125rem] text-lumen-3">
            Base commit <code className="t-code text-lumen-2">{shortSha(source.baseCommit.sha)}</code> is pinned too, for regression-only claims.
          </p>
        )}
      </div>
    </div>
  )
}

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
      <div role="radiogroup" aria-label="Policy" className="grid gap-3">
        {POLICIES.map((p) => {
          const gated = p.status !== 'enabled'
          const active = selected === p.id
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-disabled={gated}
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

function ParamField({ p, value, onChange, disabled, error }: { p: PolicyParameterSpec; value: string | string[] | boolean | undefined; onChange: (v: string | string[] | boolean) => void; disabled?: boolean; error?: string }) {
  const id = `param-${p.key}`
  const label = (
    <>
      {p.label}
      {!p.required && <span className="ml-1.5 text-[0.8rem] font-normal text-lumen-3">optional</span>}
    </>
  )
  if (p.kind === 'list' || p.kind === 'multiselect') {
    return <ListEditor id={id} label={p.label} help={p.help} items={Array.isArray(value) ? value : []} onChange={onChange} disabled={disabled} placeholder={typeof p.example === 'string' ? p.example : p.placeholder} />
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

export function StageClaim({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const spec = c.draft.spec
  const dis = c.frozen
  const setSpec = (patch: Partial<ClaimDraft['spec']>) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, ...patch } }))
  const policy = c.policy
  return (
    <div>
      <StageHeader step="claim">
        One exact requirement, and the violation a counterexample must demonstrate. Blanket statements about the whole codebase cannot be resolved. {COPY.boundedClaim}
      </StageHeader>
      <div className="grid gap-6">
        <FormField id="title" label="Title" help="A short, specific name shown on the light table (90 characters or fewer)." error={issueFor(c, 'spec.title')}>
          <input id="title" className="field" maxLength={90} value={spec.title ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { title: e.target.value } })} placeholder="Reporter deposits never draw principal from arbitration or gas reserves" />
        </FormField>
        <FormField id="requirement" label="Requirement" help="The one behavior the code must have, in plain words." error={issueFor(c, 'spec.requirement')}>
          <textarea id="requirement" className="field" rows={3} value={spec.requirement ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { requirement: e.target.value } })} />
        </FormField>
        <FormField id="violation" label="Violation" help="Completes the question: “Was a reproducible counterexample demonstrating … against commit …”" error={issueFor(c, 'spec.violation')}>
          <textarea id="violation" className="field" rows={2} value={spec.violation ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { violation: e.target.value } })} placeholder="that reporter-deposit principal can be funded from the arbitration allocation" />
        </FormField>

        <div className="cut-lg well p-4">
          <p className="text-[0.8125rem] text-lumen-3">The question, as the market will read it</p>
          <p className="mt-2 text-[0.96875rem] leading-[1.6] text-lumen [overflow-wrap:anywhere]">{c.question?.text ?? 'Pin a commit and choose a policy to see the question.'}</p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <ListEditor id="in-scope" label="In scope" items={spec.scope?.inScope ?? []} disabled={dis} onChange={(v) => setSpec({ scope: { inScope: v, outOfScope: spec.scope?.outOfScope ?? [] } })} placeholder="src/funding/reporter-planner.ts" />
          <ListEditor id="out-scope" label="Out of scope" items={spec.scope?.outOfScope ?? []} disabled={dis} onChange={(v) => setSpec({ scope: { inScope: spec.scope?.inScope ?? [], outOfScope: v } })} placeholder="Live bridge integrations" />
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
                onChange={(v) => c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, parameters: { ...(d.spec.parameters ?? {}), [p.key]: v } } }))}
              />
            ))}
          </fieldset>
        )}

        <FormField id="fault-model" label="Fault model" optional help="Allowed faults, for example process crash or timeout. Do not silently assume arbitrary corruption.">
          <textarea id="fault-model" className="field" rows={2} value={spec.faultModel ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { faultModel: e.target.value || undefined } })} />
        </FormField>
        <FormField id="allowed-inputs" label="Allowed inputs" optional>
          <input id="allowed-inputs" className="field" value={spec.allowedInputs ?? ''} disabled={dis} onChange={(e) => c.update({ spec: { allowedInputs: e.target.value || undefined } })} />
        </FormField>
        <div className="grid gap-6 md:grid-cols-2">
          <ListEditor id="assumptions" label="Assumptions" items={spec.assumptions ?? []} disabled={dis} onChange={(v) => setSpec({ assumptions: v })} />
          <ListEditor id="exclusions" label="Exclusions" items={spec.exclusions ?? []} disabled={dis} onChange={(v) => setSpec({ exclusions: v })} />
        </div>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="facet-check" checked={spec.regressionOnly ?? false} disabled={dis} onChange={(e) => c.update({ spec: { regressionOnly: e.target.checked } })} />
          <span>
            <span className="block text-[0.9rem] font-semibold text-lumen">Only regressions relative to the base commit qualify</span>
            <span className="help block">{c.draft.source?.baseCommit ? `Base commit ${shortSha(c.draft.source.baseCommit.sha)} is pinned.` : 'Needs a pinned base commit (pin a pull request to get one).'}</span>
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
  const setEnv = (patch: Partial<EnvironmentPin>) =>
    c.update((d: ClaimDraft) => ({ ...d, spec: { ...d.spec, environment: { ...(d.spec.environment ?? env), ...patch } as EnvironmentPin } }))
  return (
    <div>
      <StageHeader step="environment">Pin everything an investigator needs to reproduce the behavior. The configuration and environment hashes update as you type and go into the question.</StageHeader>
      <div className="mb-6 flex flex-wrap gap-2">
        <HashChip value={env.envHash} label="Environment hash" />
        <HashChip value={env.configHash} label="Configuration hash" />
      </div>
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
          <FormField id="lock-hash" label="Lockfile hash" optional help="keccak256 or sha256 as 0x-prefixed hex." error={issueFor(c, 'spec.environment.dependencyLock')}>
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
          <FormField id="external" label="External state" optional help="For example a block snapshot, or none.">
            <input id="external" className="field" value={env.externalState ?? ''} disabled={dis} onChange={(e) => setEnv({ externalState: e.target.value || undefined })} placeholder="none" />
          </FormField>
        </div>
        <FormField id="repro" label="Reproduction command" help="The command an investigator runs against the pinned commit." error={issueFor(c, 'spec.environment.reproductionCommand')}>
          <input id="repro" className="field t-code" value={env.reproductionCommand} disabled={dis} onChange={(e) => setEnv({ reproductionCommand: e.target.value })} placeholder="pnpm vitest run test/reporter-funding.spec.ts" />
        </FormField>
        <ListEditor id="setup" label="Setup steps" items={env.setupSteps} disabled={dis} onChange={(setupSteps) => setEnv({ setupSteps })} placeholder="pnpm install --frozen-lockfile" mono />
        <FormField id="env-notes" label="Notes" optional>
          <textarea id="env-notes" className="field" rows={2} value={env.notes ?? ''} disabled={dis} onChange={(e) => setEnv({ notes: e.target.value || undefined })} />
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
              <p className="mt-2 truncate font-semibold text-lumen-2">{label}</p>
              <p className="truncate text-lumen-3">{sub}</p>
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
