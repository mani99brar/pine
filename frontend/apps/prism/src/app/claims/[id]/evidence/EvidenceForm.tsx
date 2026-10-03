'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDetail, EvidenceDraft, EvidenceKind } from '@pine/core'
import { formatDate } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useClaim, usePolicy, useSubmitEvidence, useWallet } from '@pine/react'
import { ArrowLeft, Lock, Paperclip, RotateCw, Shuffle, X } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState, FormField, Notice, Skeleton } from '@/components/ui/primitives'
import { Segmented } from '@/components/ui/interactive'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { TxSteps } from '@/components/tx/TxSteps'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { ListEditor } from '@/components/composer/shared'
import { apiFactsOf, claimLabel, countdown } from '@/lib/claims'
import { useMounted, useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { ApiEvidenceForm } from './ApiEvidenceForm'

const KINDS: { value: EvidenceKind; label: string; help: string }[] = [
  { value: 'counterexample', label: 'Counterexample', help: 'A reproducible demonstration of the stated violation.' },
  { value: 'rebuttal', label: 'Rebuttal', help: 'Shows why another submission does not demonstrate the violation.' },
  { value: 'clarification', label: 'Clarification', help: 'Context for jurors and answerers, without a new demonstration.' },
]

export function EvidenceForm({ id }: { id: string }) {
  const claimQ = useClaim(id)
  const claim = claimQ.data ?? undefined
  if (claimQ.isLoading) return <Skeleton className="mt-10 h-96 w-full" />
  if (claimQ.isError) return <ErrorState className="mt-10" error={claimQ.error} onRetry={() => void claimQ.refetch()} />
  if (!claim)
    return (
      <EmptyState className="mt-10" title="No claim at this address" action={<ButtonLink href="/claims">Open the light table</ButtonLink>}>
        Evidence can only be filed against a published claim.
      </EmptyState>
    )
  // Backend claims (api mode) record evidence in Pine's evidence registry: sealed commit and reveal, or direct publish.
  const api = apiFactsOf(claim)
  if (api) return <ApiEvidenceForm claim={claim} api={api} />
  return <LocalEvidenceForm claim={claim} />
}

function LocalEvidenceForm({ claim }: { claim: ClaimDetail }) {
  const id = claim.id
  const mounted = useMounted()
  const now = useNowMs()
  const policyQ = usePolicy(claim.policy.id, claim.policy.version)
  const sub = useSubmitEvidence(id)
  const wallet = useWallet()
  const [kind, setKind] = useState<EvidenceKind>('counterexample')
  const [mode, setMode] = useState<'direct' | 'commit'>('direct')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [preview, setPreview] = useState(false)
  const [command, setCommand] = useState('')
  const [environment, setEnvironment] = useState<string | null>(null)
  const [expected, setExpected] = useState('')
  const [actual, setActual] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [attachments, setAttachments] = useState<EvidenceDraft['attachments']>([])
  const [checks, setChecks] = useState<Record<number, boolean>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  const pinnedEnv = `As pinned: ${claim.manifest.claim.environment.runtime || 'runtime not stated'}, environment ${claim.manifest.claim.environment.envHash.slice(0, 10)}…`
  const env = environment ?? pinnedEnv
  const reqs = policyQ.data?.evidenceRequirements ?? []
  const allChecked = reqs.every((_, i) => checks[i])
  const evChain = getChainOrDefault(sub.chainId)
  const marketChain = getChainOrDefault(claim.chainId)
  // Package copy for the commitment step ends with "the content becomes public", which is wrong in
  // commit mode: only the hash is published until the reveal. Say what actually happens.
  const describe = (s: { id: string }) =>
    mode === 'commit' && s.id === 'submit_evidence'
      ? `Records only the hash of your evidence package, through the Kleros arbitration contract on ${evChain.name}. The block timestamp of this transaction is the timeliness proof, and it costs ${evChain.nativeSymbol} gas. The package itself stays private in this browser until you reveal it. Switch your wallet to ${evChain.name} first.`
      : undefined
  const late = now !== null && Date.parse(claim.evidenceDeadline) < now
  const running = sub.runner.state === 'running'
  const done = sub.runner.state === 'done'
  const isCounter = kind === 'counterexample'
  const reproOk = !isCounter || mode === 'commit' || (command.trim() && env.trim() && expected.trim() && actual.trim())
  const ready = title.trim().length > 3 && (mode === 'commit' || summary.trim().length > 10) && reproOk && allChecked && sub.blockers.length === 0

  const submit = async () => {
    setSubmitError(null)
    const draft: EvidenceDraft = {
      claimId: claim.id,
      kind,
      title: title.trim(),
      summary: summary.trim(),
      ...(isCounter && command.trim()
        ? { reproduction: { command: command.trim(), environment: env.trim(), expected: expected.trim(), actual: actual.trim(), ...(steps.length ? { steps } : {}) } }
        : {}),
      attachments,
      mode,
    }
    try {
      await sub.submit(draft)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <Link href={`/claims/${claim.id}`} className="mt-6 inline-flex items-center gap-1.5 text-[0.875rem] text-lumen-3 hover:text-lumen">
        <ArrowLeft size={14} aria-hidden /> {claimLabel(claim)}
      </Link>
      <header className="pb-8 pt-6">
        <h1 className="t-h1 chroma">Submit evidence</h1>
        <p className="t-lead mt-3 max-w-[64ch] [overflow-wrap:anywhere]">{claim.title}</p>
        <p className="mt-2 text-[0.9rem] text-lumen-3">
          Deadline {formatDate(claim.evidenceDeadline, 'utc')}
          {now !== null && !late && <span className="tnum ml-2 text-na">{countdown(claim.evidenceDeadline, now)} left</span>}
        </p>
      </header>

      {done ? (
        <div className="glass cut-xl p-6 sm:p-8">
          <p className="tag gap-1.5 text-lumen">Filed on {evChain.name}</p>
          <h2 className="t-h2 mt-4">{mode === 'commit' ? 'Your commitment is on-chain.' : 'Your evidence is on-chain.'}</h2>
          <p className="mt-3 max-w-[60ch] text-lumen-2">
            {mode === 'commit'
              ? 'Only the hash of your package is recorded. The package stays in this browser until you reveal it; do not clear site data.'
              : 'The block timestamp is your proof of timeliness. Answerers and jurors decide whether it demonstrates the violation.'}{' '}
            {COPY.evidenceIsNotPayment}
          </p>
          <TxSteps runner={sub.runner} chainId={sub.chainId} className="mt-6" describe={describe} />
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href={`/claims/${claim.id}#evidence`}>Back to the claim</ButtonLink>
            <Button variant="glass" onClick={() => sub.reset()}>
              File another
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)] lg:grid-rows-[auto_1fr]">
          <aside className="grid content-start gap-5 lg:col-start-2 lg:row-start-1" aria-label="How evidence is filed">
            <section className="glass cut-lg p-5" aria-labelledby="mode-title">
              <h2 id="mode-title" className="t-h4">
                How it is filed
              </h2>
              <Segmented
                className="mt-3"
                label="Submission mode"
                size="sm"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'direct', label: 'Direct' },
                  { value: 'commit', label: 'Commit, reveal later' },
                ]}
              />
              {mode === 'direct' ? (
                <p className="mt-3 text-[0.875rem] text-lumen-2">The evidence package is pinned publicly, then its URI is submitted on-chain. Anyone can read it immediately.</p>
              ) : (
                <Notice tone="caution" className="mt-3" title="Launch gate: commit-reveal">
                  Only the package hash goes on-chain now, which limits front-running. The package stays in this browser until you reveal it. How reveals are judged is not settled yet.
                </Notice>
              )}
              <div className="cut-md mt-4 flex gap-3 border border-[rgba(90,216,255,0.35)] bg-[rgba(90,216,255,0.06)] p-3 text-[0.84375rem] text-lumen-2">
                <Shuffle size={16} aria-hidden className="mt-0.5 shrink-0 text-hb" />
                <span>
                  Your wallet switches to <strong className="text-lumen">{evChain.name}</strong> for this transaction
                  {claim.chainId !== sub.chainId ? `, even though the market is on ${marketChain.name}` : ''}. Evidence goes to the Kleros arbitration contract there, and the block timestamp proves timeliness.
                </span>
              </div>
            </section>
          </aside>
          <form
            className="grid content-start gap-6 lg:col-start-1 lg:row-span-2 lg:row-start-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (ready && !running) void submit()
            }}
          >
            {late && (
              <Notice tone="caution" title="The evidence deadline has passed">
                Submissions after {formatDate(claim.evidenceDeadline, 'utc')} do not count toward this claim. {COPY.lateEvidence}
              </Notice>
            )}
            <fieldset>
              <legend id="ev-kind-label" className="label">
                Kind
              </legend>
              <div
                role="radiogroup"
                aria-labelledby="ev-kind-label"
                className="grid items-stretch gap-2 sm:grid-cols-3"
                onKeyDown={(e) => {
                  const i = KINDS.findIndex((k) => k.value === kind)
                  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
                  if (!d) return
                  e.preventDefault()
                  const next = KINDS[(i + d + KINDS.length) % KINDS.length]!
                  setKind(next.value)
                  requestAnimationFrame(() => document.getElementById(`ev-kind-${next.value}`)?.focus())
                }}
              >
                {KINDS.map((k) => {
                  const on = kind === k.value
                  return (
                    <button
                      key={k.value}
                      id={`ev-kind-${k.value}`}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      onClick={() => setKind(k.value)}
                      className={cn(
                        'cut-md relative flex flex-col items-start border p-3 text-left transition-colors',
                        on ? 'border-[rgba(255,236,220,0.5)] bg-smoke-2 shadow-[inset_0_1px_0_rgba(255,240,228,0.08)]' : 'border-edge bg-smoke hover:border-edge-strong',
                      )}
                    >
                      <span className="flex items-center gap-2 font-semibold text-lumen">
                        <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rotate-45 border transition-colors', on ? 'border-lumen bg-lumen shadow-[0_0_10px_rgba(255,236,220,0.6)]' : 'border-edge-strong')} />
                        {k.label}
                      </span>
                      <span className="mt-1 block text-[0.8125rem] leading-[1.45] text-lumen-3">{k.help}</span>
                    </button>
                  )
                })}
              </div>
            </fieldset>
            <FormField id="ev-title" label="Title" help="One line naming what you demonstrate.">
              <input id="ev-title" className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
            </FormField>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="ev-summary" className="label mb-0">
                  Summary {mode === 'commit' && <span className="text-[0.8rem] font-normal text-lumen-3">kept private until you reveal</span>}
                </label>
                <Segmented
                  label="Summary view"
                  size="sm"
                  value={preview ? 'preview' : 'write'}
                  onChange={(v) => setPreview(v === 'preview')}
                  options={[
                    { value: 'write', label: 'Write' },
                    { value: 'preview', label: 'Preview' },
                  ]}
                />
              </div>
              {preview ? (
                <div className="cut-md well min-h-[9rem] p-4">{summary.trim() ? <SafeMarkdown>{summary}</SafeMarkdown> : <p className="text-lumen-3">Nothing to preview.</p>}</div>
              ) : (
                <textarea id="ev-summary" className="field" rows={7} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What you ran, what happened, and why it is the stated violation. Markdown is shown sanitized." />
              )}
            </div>

            {isCounter && (
              <fieldset className="cut-lg well grid gap-5 p-4 sm:p-5">
                <legend className="px-1 text-[0.9375rem] font-semibold text-lumen">Reproduction</legend>
                <FormField id="ev-cmd" label="Command" help="Run against the pinned commit and environment.">
                  <input id="ev-cmd" className="field t-code" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={claim.manifest.claim.environment.reproductionCommand} />
                </FormField>
                <FormField id="ev-env" label="Environment" help="Where you ran it. It should match the pinned environment; say so, or say exactly what differs.">
                  <input id="ev-env" className="field" value={env} onChange={(e) => setEnvironment(e.target.value)} />
                </FormField>
                <div className="grid gap-5 md:grid-cols-2">
                  <FormField id="ev-exp" label="Expected">
                    <textarea id="ev-exp" className="field" rows={3} value={expected} onChange={(e) => setExpected(e.target.value)} />
                  </FormField>
                  <FormField id="ev-act" label="Actual">
                    <textarea id="ev-act" className="field" rows={3} value={actual} onChange={(e) => setActual(e.target.value)} />
                  </FormField>
                </div>
                <ListEditor id="ev-steps" label="Steps" items={steps} onChange={setSteps} placeholder="Seed the journal with state S3" />
              </fieldset>
            )}

            <div>
              <p className="label">Attachments</p>
              <p className="help -mt-1 mb-2">Listed by name, type and size in the package. Files are not uploaded in this release; host them where jurors can reach them and reference them in the summary.</p>
              <label className="btn btn-glass btn-sm cursor-pointer">
                <Paperclip size={14} aria-hidden /> Add files
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? [])
                    setAttachments((prev) => [...prev, ...files.map((f) => ({ name: f.name, mime: f.type || 'application/octet-stream', size: f.size }))])
                    e.target.value = ''
                  }}
                />
              </label>
              {attachments.length > 0 && (
                <ul className="mt-3 grid gap-1.5">
                  {attachments.map((a, i) => (
                    <li key={`${a.name}-${i}`} className="cut-sm flex items-center gap-3 border border-edge bg-void px-3 py-1.5 text-[0.84375rem]">
                      <span className="untrusted min-w-0 flex-1 text-lumen-2">{a.name}</span>
                      <span className="text-lumen-3">{a.mime}</span>
                      <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen" onClick={() => setAttachments(attachments.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`}>
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <fieldset className="glass cut-lg p-4 sm:p-5">
              <legend className="px-1 text-[0.9375rem] font-semibold text-lumen">Admissibility under {claim.policy.id}</legend>
              <p className="help mb-3">Check each requirement your submission meets. Jurors judge admissibility; this list helps you not miss one.</p>
              {policyQ.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <ul className="grid gap-2.5">
                  {reqs.map((r, i) => (
                    <li key={i}>
                      <label className="flex items-start gap-3 text-[0.90625rem] text-lumen-2">
                        <input type="checkbox" className="facet-check" checked={Boolean(checks[i])} onChange={(e) => setChecks({ ...checks, [i]: e.target.checked })} />
                        <span>{r}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            {sub.runner.steps.length > 0 && sub.runner.state !== 'idle' && (
              <div className="glass cut-lg p-5">
                <TxSteps runner={sub.runner} chainId={sub.chainId} describe={describe} />
              </div>
            )}
            {(submitError ?? sub.runner.error) && (
              <Notice tone="critical" role="alert">
                <span className="untrusted [white-space:normal]">{submitError ?? sub.runner.error}</span>
              </Notice>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-5">
              {!mounted ? null : !wallet.isConnected ? (
                <Button
                  key="connect"
                  type="button"
                  onClick={(e) => {
                    // Connecting swaps this button for the submit button; don't let the same click submit the form.
                    e.preventDefault()
                    wallet.connect()
                  }}
                >
                  {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
                </Button>
              ) : sub.runner.state === 'failed' ? (
                <Button onClick={() => void sub.runner.retry()} icon={<RotateCw size={15} aria-hidden />}>
                  Retry the failed step
                </Button>
              ) : (
                <Button key="submit" type="submit" loading={running} disabled={!ready || running} icon={mode === 'commit' ? <Lock size={15} aria-hidden /> : undefined}>
                  {mode === 'commit' ? 'Commit the evidence hash' : `Submit on ${evChain.name}`}
                </Button>
              )}
              <DemoFailToggle />
              {!ready && !running && <p className="text-[0.8125rem] text-lumen-3">{!allChecked ? 'Check every admissibility requirement first.' : 'Add a title, a summary and, for a counterexample, the reproduction.'}</p>}
            </div>
          </form>
          <aside className="grid content-start gap-5 lg:col-start-2 lg:row-start-2" aria-label="Before you file">
            <Notice tone="boundary">{COPY.untrustedContent}</Notice>
            <Notice tone="boundary">{COPY.noAttackAuthorization}</Notice>
            <p className="text-[0.84375rem] text-lumen-3">{COPY.evidenceIsNotPayment}</p>
          </aside>

        </div>
      )}
    </div>
  )
}
