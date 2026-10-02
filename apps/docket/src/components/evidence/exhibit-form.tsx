'use client'

import Link from 'next/link'
import { useMemo, useRef, useState } from 'react'
import type { ClaimDetail, EvidenceDraft, EvidenceKind } from '@pine/core'
import { formatClaimNumber, formatDate, getPolicy, shortHash, shortSha } from '@pine/core'
import { CHAINS } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useClaim, useDemoWallet, useSubmitEvidence, useWallet } from '@pine/react'
import { FileUp, Lock, Paperclip, ShieldAlert, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button, ButtonLink } from '@/components/ui/button'
import { Checkbox, Choices, Field, Input, ListInput, MarginNote, Textarea } from '@/components/ui/field'
import { Breadcrumbs, EmptyState, Skeleton } from '@/components/ui/layout'
import { Notice } from '@/components/ui/notice'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { StageTag } from '@/components/ui/stage'
import { When, useClientNow } from '@/components/ui/when'
import { TxSteps } from '@/components/tx/tx-steps'
import { exhibitLetter } from '@/components/claim/exhibits'

type Attachment = EvidenceDraft['attachments'][number]

export function ExhibitFiling({ claimId, initial }: { claimId: string; initial: ClaimDetail | null }) {
  const q = useClaim(claimId)
  const claim = q.data ?? initial
  if (!claim) {
    if (q.isLoading) return <Skeleton className="h-96 w-full" />
    return (
      <EmptyState title="There is no claim with this number" action={<ButtonLink href="/docket">Search the docket</ButtonLink>}>
        Exhibits are filed against a claim on the docket.
      </EmptyState>
    )
  }
  return <Form claim={claim} />
}

function Form({ claim }: { claim: ClaimDetail }) {
  const ev = useSubmitEvidence(claim.id)
  const wallet = useWallet()
  const demo = useDemoWallet()
  const now = useClientNow(30_000)
  const policy = getPolicy(claim.policy.id, claim.policy.version)
  const env = claim.manifest.claim.environment
  const evidenceChain = CHAINS[ev.chainId]
  const marketChain = CHAINS[claim.chainId]

  const [kind, setKind] = useState<EvidenceKind>('counterexample')
  const [mode, setMode] = useState<'direct' | 'commit'>('direct')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [preview, setPreview] = useState(false)
  const [command, setCommand] = useState(env?.reproductionCommand ?? '')
  const [environment, setEnvironment] = useState(
    env ? `${env.runtime}${env.packageManager ? `, ${env.packageManager}` : ''}; environment hash ${env.envHash}` : '',
  )
  const [expected, setExpected] = useState('')
  const [actual, setActual] = useState('')
  const [steps, setSteps] = useState<string[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [checks, setChecks] = useState<Set<number>>(new Set())
  const [tried, setTried] = useState(false)
  const [submitError, setSubmitError] = useState<string | undefined>()
  const [filedAs, setFiledAs] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const deadlineMs = new Date(claim.evidenceDeadline).getTime()
  const late = now ? now.getTime() > deadlineMs : false
  const requirements = useMemo(() => policy?.evidenceRequirements ?? [], [policy])
  const needsRepro = kind === 'counterexample' && mode === 'direct'

  const errors: Record<string, string> = {}
  if (!title.trim()) errors.title = 'Give the exhibit a title, for example the behavior you demonstrate.'
  if (mode === 'direct' && summary.trim().length < 20) errors.summary = 'Explain the exhibit in at least a sentence or two.'
  if (needsRepro && !command.trim()) errors.command = 'A counterexample needs the command that reproduces it.'
  if (needsRepro && !expected.trim()) errors.expected = 'Describe what the requirement says should happen.'
  if (needsRepro && !actual.trim()) errors.actual = 'Describe what actually happens when you run it.'
  if (kind === 'counterexample' && checks.size < requirements.length) errors.checks = 'Confirm each admissibility point, or fix the exhibit until you can.'
  const valid = Object.keys(errors).length === 0
  const show = (k: string) => (tried ? errors[k] : undefined)

  const running = ev.runner.state === 'running' || ev.runner.state === 'paused' || ev.runner.state === 'failed'
  const done = ev.runner.state === 'done'

  const onSubmit = async () => {
    setTried(true)
    setSubmitError(undefined)
    if (!valid) {
      requestAnimationFrame(() => document.getElementById('exhibit-errors')?.focus())
      return
    }
    const draft: EvidenceDraft = {
      claimId: claim.id,
      kind,
      title: title.trim(),
      summary: summary.trim() || title.trim(),
      reproduction:
        mode === 'direct' && (command || expected || actual)
          ? { command, environment, expected, actual, ...(steps.length ? { steps } : {}) }
          : undefined,
      attachments,
      mode,
    }
    setFiledAs(nextLetter)
    try {
      await ev.submit(draft)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e))
    }
  }

  const nextLetter = exhibitLetter(claim.evidence.length)
  const shownLetter = (done || running) && filedAs ? filedAs : nextLetter

  return (
    <>
      <Breadcrumbs
        items={[
          { href: '/docket', label: 'Docket' },
          { href: `/claims/${claim.id}`, label: formatClaimNumber(claim.number) },
          { label: 'File an exhibit' },
        ]}
      />
      <header className="mb-8 max-w-[52rem]">
        <p className="flex flex-wrap items-center gap-3">
          <span className="font-[800] text-violet tabular">{formatClaimNumber(claim.number)}</span>
          <StageTag status={claim.status} outcome={claim.outcome} />
        </p>
        <h1 className="mt-2 text-[2rem] leading-[2.4rem] sm:text-3xl">{done ? `Exhibit ${shownLetter} is filed` : `File exhibit ${shownLetter}`}</h1>
        <p className="record-title untrusted mt-2 text-xl text-graphite">{claim.title}</p>
      </header>

      <div className={cn('mb-8 border-l-8 px-5 py-4', late ? 'border-ochre bg-wheat' : 'border-violet bg-violet-wash')}>
        <p className="text-lg font-bold">
          {late ? 'The evidence deadline has passed' : 'Timely if filed before '}
          {!late ? <When at={claim.evidenceDeadline} /> : null}
        </p>
        <p className="mt-1 measure">
          {late
            ? `Anything filed now is recorded but marked not timely, so it cannot decide this claim. ${COPY.lateEvidence}`
            : 'The block timestamp of your transaction on Ethereum decides whether the exhibit is on time, not when you wrote it. Leave margin for confirmation.'}
        </p>
      </div>

      {claim.status !== 'open' && !late ? (
        <Notice tone="warning" className="mb-8" title="This claim is not in its evidence window">
          Exhibits can still be recorded, but check the claim&rsquo;s stage first.
        </Notice>
      ) : null}

      {done ? (
        <div className="border border-rule bg-sheet p-8 text-center">
          <div className="mx-auto inline-block -rotate-2 border-4 border-violet px-6 py-4 motion-safe:animate-stamp">
            <p className="text-sm font-bold text-violet">Entered as</p>
            <p className="text-3xl font-[800] text-violet">Exhibit {shownLetter}</p>
          </div>
          <p className="mx-auto mt-6 max-w-[48ch] text-lg">
            {mode === 'commit'
              ? 'Your commitment is recorded. Keep this browser’s data: the sealed package is stored here until you reveal it.'
              : 'Your exhibit is public and timestamped. Answerers and, if it comes to it, Kleros jurors will weigh it.'}
          </p>
          {ev.contentHash ? (
            <p className="mt-2 text-sm text-graphite">
              Content hash <code className="font-mono">{shortHash(ev.contentHash, 10)}</code>
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink href={`/claims/${claim.id}#exhibits`}>Back to the case file</ButtonLink>
            <Button
              variant="secondary"
              onClick={() => {
                ev.reset()
                setFiledAs(null)
                setTried(false)
              }}
            >
              File another exhibit
            </Button>
          </div>
        </div>
      ) : (
        <div className="-mx-4 border-y border-rule bg-sheet sm:mx-0 sm:border-x">
          <div className="space-y-9 px-4 py-7 sm:px-8">
            {tried && !valid ? (
              <div id="exhibit-errors" tabIndex={-1} role="alert" className="border-4 border-red p-5 outline-none">
                <h2 className="text-xl text-red">Before filing, fix these</h2>
                <ul className="mt-2 space-y-1.5 text-[15px] font-bold">
                  {Object.entries(errors).map(([k, m]) => {
                    const target = k === 'checks' ? 'adm-0' : `ex-${k}`
                    return (
                      <li key={k}>
                        <a
                          href={`#${target}`}
                          className="text-red underline underline-offset-4"
                          onClick={(e) => {
                            const el = document.getElementById(target)
                            if (el) {
                              e.preventDefault()
                              el.scrollIntoView({ block: 'center' })
                              el.focus()
                            }
                          }}
                        >
                          {m}
                        </a>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ) : null}

            <section aria-labelledby="ex-kind" className="space-y-7">
              <h2 id="ex-kind" className="text-2xl">
                What you are filing
              </h2>
              <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
                <Choices<EvidenceKind>
                  name="kind"
                  legend="Kind of exhibit"
                  value={kind}
                  onChange={setKind}
                  options={[
                    { value: 'counterexample', label: 'Counterexample', description: 'Demonstrates the violation named in the question.' },
                    { value: 'rebuttal', label: 'Rebuttal', description: 'Argues that another exhibit does not qualify.' },
                    { value: 'clarification', label: 'Clarification', description: 'Context for answerers or jurors, without a new demonstration.' },
                  ]}
                />
                <aside>
                  <MarginNote title="What qualifies">
                    <p>Only a counterexample can make the answer Yes. It must reproduce the violation against the pinned commit and environment.</p>
                    <p>{COPY.evidenceIsNotPayment}</p>
                  </MarginNote>
                </aside>
              </div>
              <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
                <Choices<'direct' | 'commit'>
                  name="mode"
                  legend="How to file it"
                  value={mode}
                  onChange={setMode}
                  options={[
                    {
                      value: 'direct',
                      label: 'File it publicly now',
                      description: 'The exhibit is stored and recorded on-chain in one go. Everyone can read it immediately.',
                    },
                    {
                      value: 'commit',
                      label: 'Seal it first, reveal later',
                      description: 'Record only a hash now, so nobody can copy your counterexample before it is timestamped. Reveal the package later.',
                      aside: (
                        <span className="flex items-start gap-1.5 text-sm font-bold text-plum">
                          <Lock aria-hidden className="mt-0.5 size-4 shrink-0" /> Launch gate: reveal windows and juror access to sealed exhibits are not settled.
                        </span>
                      ),
                    },
                  ]}
                />
                <aside>
                  <MarginNote title="Why seal an exhibit">
                    <p>
                      Public evidence can be front-run: someone could trade on it, or refile it, before yours confirms. A sealed commitment
                      proves you had it first.
                    </p>
                  </MarginNote>
                </aside>
              </div>
            </section>

            <section aria-labelledby="ex-content" className="space-y-7 border-t border-rule pt-7">
              <h2 id="ex-content" className="text-2xl">
                The exhibit
              </h2>
              <Field
                id="ex-title"
                label="Title"
                error={show('title')}
                guidance={<p>One line naming the behavior you demonstrate, in plain words.</p>}
              >
                <Input id="ex-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!show('title')} />
              </Field>
              <Field
                id="ex-summary"
                label="Explanation"
                hint="Markdown is allowed. Links are shown as plain links; images and HTML are removed."
                error={show('summary')}
                guidance={
                  <>
                    <p>Connect your demonstration to the exact requirement. Say which part of the violation phrase it shows.</p>
                    <p>Jurors read this. Short and specific beats long.</p>
                  </>
                }
              >
                <div className="mb-2 flex gap-2" role="group" aria-label="Editor mode">
                  {[
                    { v: false, l: 'Write' },
                    { v: true, l: 'Preview' },
                  ].map((o) => (
                    <button
                      key={o.l}
                      type="button"
                      aria-pressed={preview === o.v}
                      onClick={() => setPreview(o.v)}
                      className={cn('rounded-xs px-2.5 py-1 text-sm font-bold', preview === o.v ? 'bg-ink text-white' : 'border border-rule-strong hover:bg-bond')}
                    >
                      {o.l}
                    </button>
                  ))}
                </div>
                {preview ? (
                  <div className="min-h-32 border-2 border-dashed border-rule-strong px-3 py-2">
                    {summary ? <SafeMarkdown>{summary}</SafeMarkdown> : <p className="text-graphite">Nothing to preview yet.</p>}
                  </div>
                ) : (
                  <Textarea id="ex-summary" rows={7} value={summary} onChange={(e) => setSummary(e.target.value)} aria-invalid={!!show('summary')} />
                )}
              </Field>
            </section>

            {mode === 'direct' ? (
              <section aria-labelledby="ex-repro" className="space-y-7 border-t border-rule pt-7">
                <div>
                  <h2 id="ex-repro" className="text-2xl">
                    Reproduction
                  </h2>
                  <p className="mt-1 text-graphite measure">
                    Against commit <code className="font-mono">{shortSha(claim.source.commitSha)}</code> under the pinned environment. Start
                    from the claim&rsquo;s own reproduction command where you can.
                  </p>
                </div>
                <Field id="ex-command" label="Command" error={show('command')} guidance={<p>The exact command a juror would run. Prefilled with the claim&rsquo;s command.</p>}>
                  <Textarea id="ex-command" mono rows={2} value={command} onChange={(e) => setCommand(e.target.value)} aria-invalid={!!show('command')} />
                </Field>
                <Field id="ex-env" label="Environment" guidance={<p>Prefilled from the claim. Change it only to note differences, and expect exhibits on another environment not to count.</p>}>
                  <Textarea id="ex-env" rows={2} value={environment} onChange={(e) => setEnvironment(e.target.value)} />
                </Field>
                <Field id="ex-expected" label="Expected behavior" error={show('expected')} guidance={<p>What the requirement says should happen, in your words.</p>}>
                  <Textarea id="ex-expected" rows={3} value={expected} onChange={(e) => setExpected(e.target.value)} aria-invalid={!!show('expected')} />
                </Field>
                <Field id="ex-actual" label="Actual behavior" error={show('actual')} guidance={<p>What you observed. Include the failing assertion or the relevant output.</p>}>
                  <Textarea id="ex-actual" rows={3} value={actual} onChange={(e) => setActual(e.target.value)} aria-invalid={!!show('actual')} />
                </Field>
                <Field id="ex-steps" label="Steps" optional guidance={<p>Setup beyond the claim&rsquo;s own steps, in order.</p>}>
                  <ListInput id="ex-steps" value={steps} onChange={setSteps} mono placeholder="pnpm vitest run test/repro.spec.ts" />
                </Field>
                <Field
                  id="ex-files"
                  label="Attachments"
                  optional
                  hint="Logs, test files or recordings. Their names, sizes and types are listed in the package."
                  guidance={<p>Screenshots and logs support evidence. They do not replace a reproducible demonstration.</p>}
                >
                  {attachments.length > 0 ? (
                    <ul className="mb-2 divide-y divide-rule border border-rule">
                      {attachments.map((a, i) => (
                        <li key={`${a.name}-${i}`} className="flex items-center gap-3 px-3 py-2 text-[15px]">
                          <Paperclip aria-hidden className="size-4 text-graphite" />
                          <span className="untrusted min-w-0 flex-1">{a.name}</span>
                          <span className="text-sm text-graphite">{(a.size / 1024).toFixed(1)} KB</span>
                          <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))} className="rounded-xs p-1 hover:bg-bond">
                            <X aria-hidden className="size-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <input
                    ref={fileRef}
                    id="ex-files"
                    type="file"
                    multiple
                    className="sr-only"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? [])
                      setAttachments([...attachments, ...files.map((f) => ({ name: f.name, mime: f.type || 'application/octet-stream', size: f.size }))])
                      e.target.value = ''
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex h-11 items-center gap-2 rounded-sm border border-rule-strong bg-sheet px-3 text-sm font-bold shadow-[0_2px_0_var(--color-rule)] hover:bg-bond"
                  >
                    <FileUp aria-hidden className="size-4" /> Choose files
                  </button>
                </Field>
              </section>
            ) : null}

            {kind === 'counterexample' && requirements.length > 0 ? (
              <section aria-labelledby="ex-adm" className="border-t border-rule pt-7">
                <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
                  <div className="min-w-0">
                    <h2 id="ex-adm" className="text-2xl">
                      Admissibility check
                    </h2>
                    <p className="mt-1 text-graphite">From {claim.policy.id}@{claim.policy.version}. Confirm each point honestly; jurors apply the same list.</p>
                    <fieldset className="mt-4 space-y-3">
                      <legend className="sr-only">Admissibility points</legend>
                      {requirements.map((r, i) => (
                        <Checkbox
                          key={i}
                          id={`adm-${i}`}
                          label={r}
                          checked={checks.has(i)}
                          onChange={(e) => {
                            const n = new Set(checks)
                            if (e.target.checked) n.add(i)
                            else n.delete(i)
                            setChecks(n)
                          }}
                        />
                      ))}
                    </fieldset>
                    {show('checks') ? <p className="mt-3 text-sm font-bold text-red">{show('checks')}</p> : null}
                    {policy?.exclusions.length ? (
                      <details className="mt-5">
                        <summary className="font-bold text-violet underline underline-offset-4">What the policy excludes ({policy.exclusions.length})</summary>
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px]">
                          {policy.exclusions.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                          {claim.manifest.claim.exclusions.map((x) => (
                            <li key={x} className="untrusted">
                              {x} (this claim)
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                  <aside>
                    <MarginNote title="No attacks on live systems">
                      <p>{COPY.noAttackAuthorization}</p>
                    </MarginNote>
                  </aside>
                </div>
              </section>
            ) : null}

            <section aria-labelledby="ex-file" className="border-t-2 border-ink pt-7">
              <h2 id="ex-file" className="text-2xl">
                File it
              </h2>
              <div className="mt-3 flex gap-3 border-l-4 border-wheat-line bg-flag-wash px-4 py-3">
                <ShieldAlert aria-hidden className="mt-1 size-5 shrink-0 text-ochre" />
                <p className="measure">
                  <strong>Your wallet will switch to {evidenceChain?.name ?? 'Ethereum'}.</strong> Exhibits are recorded with the Kleros arbitration
                  contract on {evidenceChain?.name ?? 'Ethereum'}
                  {marketChain && marketChain.id !== ev.chainId ? `, even though this market is on ${marketChain.name}` : ''}. Filing costs{' '}
                  {evidenceChain?.nativeSymbol ?? 'ETH'} gas, which you pay. The exhibit becomes public as soon as it is filed.
                </p>
              </div>
              {ev.blockers.length > 0 && !running ? (
                <ul className="mt-4 space-y-1 text-[15px] text-graphite">
                  {ev.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
              {submitError && !running ? (
                <p className="mt-4 border-l-4 border-red bg-red-wash px-3 py-2 font-bold text-red" role="alert">
                  {submitError}
                </p>
              ) : null}
              {ev.runner.steps.length > 0 && ev.runner.state !== 'idle' ? (
                <TxSteps className="mt-5" runner={ev.runner} startLabel="File the exhibit" doneLabel="Filed" chainId={ev.chainId} />
              ) : (
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  {!wallet.isConnected ? (
                    <Button variant="secondary" onClick={() => wallet.connect()}>
                      Connect wallet
                    </Button>
                  ) : null}
                  <Button onClick={() => void onSubmit()} disabled={!wallet.isConnected}>
                    {mode === 'commit' ? 'Seal and file the commitment' : `File exhibit ${shownLetter}`}
                  </Button>
                  {demo.enabled ? (
                    <button type="button" className="link text-sm" onClick={() => demo.failNext()}>
                      {demo.pendingFailure ? 'Next transaction will fail' : 'Reviewer control: make the next transaction fail'}
                    </button>
                  ) : null}
                </div>
              )}
              <p className="mt-4 text-sm text-graphite">
                Filed against {claim.source.owner}/{claim.source.repo} at <code className="font-mono">{shortSha(claim.source.commitSha)}</code>, deadline{' '}
                {formatDate(claim.evidenceDeadline, 'long')}. <Link href={`/claims/${claim.id}#terms`} className="link">Read the terms on record</Link>
              </p>
            </section>
          </div>
        </div>
      )}
    </>
  )
}
