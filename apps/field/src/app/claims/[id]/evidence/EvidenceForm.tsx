'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { EvidenceDraft, EvidenceKind } from '@pine/core'
import { LIMITS, formatClaimNumber, formatDate } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useClaim, usePolicy, useSubmitEvidence, useWallet } from '@pine/react'
import { ArrowLeft, Lock, Paperclip, Send, X } from 'lucide-react'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { StatusPill } from '@/components/glyphs/Status'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { Field, Input, Textarea } from '@/components/ui/form'
import { ListEditor } from '@/components/ui/editors'
import { Segmented } from '@/components/ui/interactive'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Note, Skeleton } from '@/components/ui/primitives'
import { EmptyState } from '@/components/ui/states'
import { TxSteps } from '@/components/tx/TxSteps'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

const KINDS: { value: Exclude<EvidenceKind, 'commitment'>; label: string; help: string }[] = [
  { value: 'counterexample', label: 'Counterexample', help: 'A reproducible demonstration of the exact violation.' },
  { value: 'rebuttal', label: 'Rebuttal', help: 'Why a submitted counterexample does not qualify.' },
  { value: 'clarification', label: 'Clarification', help: 'Context for answerers and jurors.' },
]

export function EvidenceForm({ id }: { id: string }) {
  const claimQ = useClaim(id)
  const claim = claimQ.data
  const policyQ = usePolicy(claim?.policy.id, claim?.policy.version)
  const sub = useSubmitEvidence(id)
  const wallet = useWallet()
  const now = useNowMs()

  const [mode, setMode] = useState<'direct' | 'commit'>('direct')
  const [kind, setKind] = useState<Exclude<EvidenceKind, 'commitment'>>('counterexample')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [preview, setPreview] = useState(false)
  const [command, setCommand] = useState('')
  const [environment, setEnvironment] = useState('')
  const [expected, setExpected] = useState('')
  const [actual, setActual] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [attachments, setAttachments] = useState<EvidenceDraft['attachments']>([])
  const [checks, setChecks] = useState<Record<number, boolean>>({})
  const [touched, setTouched] = useState(false)

  if (claimQ.isLoading) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-10 sm:px-6" aria-busy>
        <Skeleton className="h-10 w-96" />
        <Skeleton className="mt-8 h-96" />
      </div>
    )
  }
  if (!claim) {
    return (
      <div className="mx-auto max-w-[1320px] px-4 py-12 sm:px-6">
        <EmptyState title="No claim with this id" action={<ButtonLink href="/board">Browse open claims</ButtonLink>} />
      </div>
    )
  }

  const deadlineMs = new Date(claim.evidenceDeadline).getTime()
  const past = now !== null && now > deadlineMs
  const reqs = policyQ.data?.evidenceRequirements ?? []
  const allChecked = reqs.every((_, i) => checks[i])
  const isCounter = kind === 'counterexample'
  const arb = getChainOrDefault(claim.chainId).arbitration
  const evChain = getChainOrDefault(sub.chainId)
  const errors = {
    title: !title.trim() ? 'Give the evidence a title.' : title.length > LIMITS.evidenceTitleMax ? `Keep the title under ${LIMITS.evidenceTitleMax} characters.` : undefined,
    summary: !summary.trim() ? 'Explain what you found and how it violates the requirement.' : undefined,
    command: isCounter && !command.trim() ? 'A counterexample needs a reproduction command.' : undefined,
    actual: isCounter && !actual.trim() ? 'Describe the actual behaviour you observed.' : undefined,
    checks: isCounter && reqs.length > 0 && !allChecked ? 'Confirm each admissibility requirement.' : undefined,
  }
  const valid = !Object.values(errors).some(Boolean)
  const running = sub.runner.state === 'running' || sub.runner.state === 'paused'
  const done = sub.runner.state === 'done'

  const submit = async () => {
    setTouched(true)
    if (!valid) return
    const draft: EvidenceDraft = {
      claimId: id,
      kind,
      title: title.trim(),
      summary: summary.trim(),
      reproduction: command.trim() || actual.trim() ? { command: command.trim(), environment: environment.trim(), expected: expected.trim(), actual: actual.trim(), steps } : undefined,
      attachments,
      mode,
    }
    await sub.submit(draft)
  }

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-6 sm:px-6">
      <Link href={`/claims/${id}`} className="inline-flex items-center gap-1.5 text-[0.86rem] text-ink-2 hover:text-ink hover:underline">
        <ArrowLeft size={14} aria-hidden /> {formatClaimNumber(claim.number)}
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0 max-w-[48rem]">
          <h1 className="t-h1">Submit evidence</h1>
          <p className="mt-2 text-ink-2 [overflow-wrap:anywhere]">
            For <span className="font-[650] text-ink">{claim.title}</span>
          </p>
          <div className="mt-3">
            <StatusPill status={claim.status} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <TimeRing start={claim.createdAt} end={claim.evidenceDeadline} size={64} />
          <div className="text-[0.84rem]">
            <p className="font-[650]">{past ? 'Deadline passed' : 'Until the deadline'}</p>
            <p className="text-ink-3">{formatDate(claim.evidenceDeadline, 'long')}</p>
          </div>
        </div>
      </div>

      {past && (
        <Note tone="caution" className="mt-6" title="The evidence deadline has passed">
          A counterexample submitted now is not timely and cannot make the answer Yes. Rebuttals and clarifications can still help answerers and jurors. {COPY.lateEvidence}
        </Note>
      )}

      {done ? (
        <section className="mt-8 rounded-[var(--radius-tile)] border-2 border-ink bg-sheet p-6">
          <h2 className="t-h2">Evidence submitted</h2>
          <p className="mt-2 max-w-[60ch] text-ink-2">
            {mode === 'commit'
              ? 'The commitment hash is on-chain. The package is kept in this browser until you reveal it; do not clear site data.'
              : `The package is pinned and the submission transaction is on ${evChain.name}; its block timestamp is your timeliness proof.`}
          </p>
          <TxSteps runner={sub.runner} className="mt-6" chainId={sub.chainId} />
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href={`/claims/${id}`}>Back to the claim</ButtonLink>
            <Button variant="secondary" onClick={() => sub.reset()}>
              Submit something else
            </Button>
          </div>
        </section>
      ) : (
        <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <form
            className="grid min-w-0 content-start gap-7"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
            noValidate
          >
            <fieldset>
              <legend className="t-h3">What are you submitting?</legend>
              <div role="radiogroup" className="mt-3 grid gap-2 sm:grid-cols-3">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.value}
                    onClick={() => setKind(k.value)}
                    className={cn(
                      'rounded-[var(--radius-tile)] border-[1.5px] bg-sheet p-3 text-left transition-colors',
                      kind === k.value ? 'border-ink shadow-[0_0_0_1px_var(--ink)]' : 'border-line hover:border-ink',
                    )}
                  >
                    <span className="block font-[650]">{k.label}</span>
                    <span className="mt-0.5 block text-[0.8rem] text-ink-2">{k.help}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <Field label="Title" htmlFor="ev-title" error={touched ? errors.title : undefined} help={`${title.length}/${LIMITS.evidenceTitleMax}`}>
              <Input id="ev-title" value={title} maxLength={LIMITS.evidenceTitleMax} onChange={(e) => setTitle(e.target.value)} aria-invalid={touched && !!errors.title} />
            </Field>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="ev-summary" className="text-[0.88rem] font-[620]">
                  Summary
                </label>
                <Segmented
                  size="sm"
                  label="Summary view"
                  value={preview ? 'preview' : 'write'}
                  onChange={(v) => setPreview(v === 'preview')}
                  options={[
                    { value: 'write', label: 'Write' },
                    { value: 'preview', label: 'Preview' },
                  ]}
                />
              </div>
              {preview ? (
                <div className="min-h-[9rem] rounded-[4px] border-[1.5px] border-line-strong bg-sheet px-3 py-2">
                  {summary.trim() ? <SafeMarkdown className="text-[0.92rem]">{summary}</SafeMarkdown> : <p className="text-ink-3">Nothing to preview yet.</p>}
                </div>
              ) : (
                <Textarea id="ev-summary" value={summary} onChange={(e) => setSummary(e.target.value)} className="min-h-[9rem]" aria-invalid={touched && !!errors.summary} placeholder="What you found, and exactly how it violates the requirement. Markdown is allowed; it is shown sanitized." />
              )}
              {touched && errors.summary && <p className="mt-1.5 text-[0.82rem] font-[550] text-flare-ink">{errors.summary}</p>}
            </div>

            <fieldset className="grid gap-4 rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:p-5">
              <legend className="px-1 t-h3">Reproduction</legend>
              <p className="-mt-1 text-[0.84rem] text-ink-2">
                Against commit <code className="t-code">{claim.source.commitSha.slice(0, 7)}</code> with the pinned environment. Screenshots and logs support evidence but do not replace reproducibility.
              </p>
              <Field label="Command" htmlFor="ev-cmd" optional={!isCounter} error={touched ? errors.command : undefined}>
                <Textarea id="ev-cmd" value={command} onChange={(e) => setCommand(e.target.value)} className="min-h-[3.5rem] font-mono text-[0.84rem]" placeholder={claim.manifest.claim.environment.reproductionCommand} />
              </Field>
              <Field label="Steps" htmlFor="ev-steps" optional>
                <ListEditor label="Step" value={steps} onChange={setSteps} placeholder="Seed the journal with the reachable state from fixtures/state-17.json" addLabel="Add a step" />
              </Field>
              <Field label="Environment" htmlFor="ev-env" optional help="Anything that differs from the pinned environment, or 'as pinned'.">
                <Input id="ev-env" value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="as pinned" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Expected" htmlFor="ev-exp" optional>
                  <Textarea id="ev-exp" value={expected} onChange={(e) => setExpected(e.target.value)} />
                </Field>
                <Field label="Actual" htmlFor="ev-act" optional={!isCounter} error={touched ? errors.actual : undefined}>
                  <Textarea id="ev-act" value={actual} onChange={(e) => setActual(e.target.value)} />
                </Field>
              </div>
            </fieldset>

            <div>
              <p className="text-[0.88rem] font-[620]">Attachments</p>
              <p className="mt-0.5 text-[0.8rem] text-ink-3">Their names, types and sizes go into the package. Host the files durably and link them in the summary.</p>
              {attachments.length > 0 && (
                <ul className="mt-2 grid gap-1.5">
                  {attachments.map((a, i) => (
                    <li key={`${a.name}-${i}`} className="flex items-center gap-2 text-[0.84rem]">
                      <Paperclip size={13} aria-hidden className="text-ink-3" />
                      <span className="untrusted min-w-0 truncate [white-space:normal]">{a.name}</span>
                      <span className="text-ink-3">{Math.round(a.size / 1024)} KB</span>
                      <button type="button" onClick={() => setAttachments(attachments.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`} className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-[4px] hover:bg-ink/[0.07]">
                        <X size={13} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-[var(--radius-btn)] border-[1.5px] border-dashed border-ink-3 px-3 py-2 text-[0.86rem] font-[600] hover:border-ink">
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
            </div>

            {reqs.length > 0 && (
              <fieldset className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-4 sm:p-5">
                <legend className="px-1 t-h3">Admissibility check</legend>
                <p className="-mt-1 text-[0.84rem] text-ink-2">
                  From {claim.policy.id}@{claim.policy.version}. {isCounter ? 'Confirm each one for a counterexample.' : 'Useful to keep in mind.'}
                </p>
                <ul className="mt-3 grid gap-2.5">
                  {reqs.map((r, i) => (
                    <li key={i}>
                      <label className="flex cursor-pointer items-start gap-3 text-[0.88rem]">
                        <input type="checkbox" checked={!!checks[i]} onChange={(e) => setChecks({ ...checks, [i]: e.target.checked })} className="mt-1 h-4 w-4 shrink-0 accent-[var(--ink)]" />
                        <span className="text-ink-2">{r}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {touched && errors.checks && <p className="mt-2 text-[0.82rem] font-[550] text-flare-ink">{errors.checks}</p>}
              </fieldset>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
              {!wallet.isConnected ? (
                <Button onClick={() => wallet.connect()}>{wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}</Button>
              ) : sub.runner.state === 'failed' ? (
                <Button onClick={() => void sub.runner.retry()}>Retry the failed step</Button>
              ) : (
                <Button type="submit" loading={running} icon={<Send size={15} aria-hidden />} disabled={running}>
                  {mode === 'commit' ? 'Commit the evidence hash' : `Submit on ${evChain.name}`}
                </Button>
              )}
              <DemoFailToggle />
              {touched && !valid && <p className="text-[0.84rem] font-[550] text-flare-ink">Fix the highlighted fields first.</p>}
            </div>
            {sub.blockers.length > 0 && (
              <ul className="-mt-4 list-disc pl-5 text-[0.84rem] text-ink-2">
                {sub.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </form>

          <aside className="grid min-w-0 content-start gap-5">
            <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5" aria-labelledby="mode-title">
              <h2 id="mode-title" className="t-h3">
                How it is submitted
              </h2>
              <Segmented
                className="mt-3"
                label="Submission mode"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'direct', label: 'Publish now' },
                  { value: 'commit', label: <><Lock size={13} aria-hidden />Commit, reveal later</> },
                ]}
              />
              {mode === 'direct' ? (
                <p className="mt-3 text-[0.86rem] text-ink-2">The package is pinned to IPFS and its URI is submitted on-chain. Anyone can read it as soon as it lands, including other traders.</p>
              ) : (
                <Note tone="caution" className="mt-3" title="Launch gate: commit-reveal">
                  Only the package hash goes on-chain now, which limits front-running. The package stays in this browser until you reveal it. How reveals are judged is not settled yet.
                </Note>
              )}
              <ol className="mt-4 grid gap-2 text-[0.86rem]">
                <li className="flex gap-2">
                  <span className="t-figure w-4 text-ink-3">1</span>
                  {mode === 'direct' ? 'Pin the evidence package (no wallet prompt).' : 'Hash the package locally.'}
                </li>
                <li className="flex gap-2">
                  <span className="t-figure w-4 text-ink-3">2</span>
                  <span>
                    Your wallet switches to <span className="font-[650]">{evChain.name}</span>
                    {claim.chainId !== sub.chainId ? `, even though the market is on ${getChainOrDefault(claim.chainId).name}` : ''}.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="t-figure w-4 text-ink-3">3</span>
                  Sign one transaction to {arb.requestContractName}. It costs {evChain.name} gas.
                </li>
              </ol>
              <p className="mt-3 text-[0.8rem] text-ink-3">The block timestamp of that transaction is the timeliness proof.</p>
            </section>

            {sub.runner.steps.length > 0 && sub.runner.state !== 'idle' && (
              <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5" aria-label="Submission progress">
                <TxSteps runner={sub.runner} chainId={sub.chainId} />
              </section>
            )}

            <Note tone="boundary">{COPY.evidenceIsNotPayment}</Note>
            <Note tone="boundary">{COPY.noAttackAuthorization}</Note>
          </aside>
        </div>
      )}
    </div>
  )
}
