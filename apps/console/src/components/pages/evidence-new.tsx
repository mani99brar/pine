'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Paperclip, X } from 'lucide-react'
import type { EvidenceDraft, EvidenceKind } from '@pine/core'
import { evidenceDraftSchema, formatClaimNumber, formatDate, getPolicy, timeRemaining } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { CHAINS } from '@pine/core/chains'
import { useClaim, useSubmitEvidence, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { useNowTick } from '@/lib/use-now'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { EmptyState } from '@/components/ui/empty-state'
import { Checkbox, Field, Input, Segmented, Textarea } from '@/components/ui/field'
import { PageHeader } from '@/components/ui/page-header'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { TxLog } from '@/components/ui/tx-log'
import { ListEditor } from '@/components/composer/editors'
import { StatusBadge } from '@/components/claim/status'

const KINDS: { value: EvidenceKind; label: string; help: string }[] = [
  { value: 'counterexample', label: 'Counterexample', help: 'Demonstrates the stated violation against the pinned commit.' },
  { value: 'rebuttal', label: 'Rebuttal', help: 'Argues that an earlier submission does not qualify.' },
  { value: 'clarification', label: 'Clarification', help: 'Context for answerers and jurors; not a counterexample.' },
]

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function EvidenceNew({ claimId }: { claimId: string }) {
  const claimQ = useClaim(claimId)
  const claim = claimQ.data
  const ev = useSubmitEvidence(claimId)
  const wallet = useWallet()
  const now = useNowTick(15_000)
  const [mode, setMode] = React.useState<'direct' | 'commit'>('direct')
  const [kind, setKind] = React.useState<EvidenceKind>('counterexample')
  const [title, setTitle] = React.useState('')
  const [summary, setSummary] = React.useState('')
  const [preview, setPreview] = React.useState(false)
  const [command, setCommand] = React.useState('')
  const [environment, setEnvironment] = React.useState('')
  const [expected, setExpected] = React.useState('')
  const [actual, setActual] = React.useState('')
  const [steps, setSteps] = React.useState<string[]>([])
  const [files, setFiles] = React.useState<{ name: string; mime: string; size: number }[]>([])
  const [checks, setChecks] = React.useState<Record<string, boolean>>({})
  const [error, setError] = React.useState<string | null>(null)
  const [tried, setTried] = React.useState(false)

  // Prefill the pinned environment once the claim loads (render-time sync, no effect).
  const [prefilledFor, setPrefilledFor] = React.useState<string | null>(null)
  if (claim && prefilledFor !== claim.id) {
    setPrefilledFor(claim.id)
    if (!environment) setEnvironment(`${claim.manifest.claim.environment.runtime}; env ${claim.manifest.claim.environment.envHash}`)
    if (!command) setCommand(claim.manifest.claim.environment.reproductionCommand)
  }

  if (claimQ.isLoading) return <Skeleton className="m-8 h-64" />
  if (!claim)
    return (
      <EmptyState title={`No claim with id “${claimId}”`} action={<Button asChild variant="secondary"><Link href="/claims">Browse claims</Link></Button>}>
        Evidence can only be submitted against a published claim.
      </EmptyState>
    )

  const policy = getPolicy(claim.policy.id, claim.policy.version)
  const requirements = [
    ...(policy?.evidenceRequirements ?? []),
    `Targets commit ${claim.source.commitSha.slice(0, 12)} and environment ${claim.manifest.claim.environment.envHash.slice(0, 10)}…`,
    'Reproduced only in an isolated environment, without production keys or attacks on live systems.',
  ]
  const allChecked = requirements.every((r) => checks[r])
  const rem = timeRemaining(claim.evidenceDeadline, now)
  const evChain = CHAINS[ev.chainId]
  const draft: EvidenceDraft = {
    claimId,
    kind,
    title,
    summary,
    mode,
    attachments: files,
    ...(kind === 'counterexample' || command || expected || actual
      ? { reproduction: { command, environment, expected, actual, ...(steps.filter(Boolean).length ? { steps: steps.filter(Boolean) } : {}) } }
      : {}),
  }
  const parsed = evidenceDraftSchema.safeParse(draft)
  const issues = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || 'evidence'}: ${i.message}`)
  const started = ev.runner.steps.some((s) => s.status !== 'idle')
  const canSubmit = parsed.success && allChecked && ev.blockers.length === 0 && !started

  const submit = async () => {
    setTried(true)
    setError(null)
    if (!canSubmit) return
    try {
      await ev.submit(draft)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <PageHeader
        title="Submit evidence"
        description={
          <span>
            Against <Link href={`/claims/${claim.id}`} className="mono-cond text-[12.5px] text-needle hover:underline">{formatClaimNumber(claim.number)}</Link>{' '}
            <span className="text-bark">{claim.title}</span>
          </span>
        }
        actions={<StatusBadge status={claim.status} outcome={claim.outcome} size="md" />}
      />
      <div className="grid grid-cols-1 bg-surface xl:grid-cols-[minmax(0,1fr)_400px]">
        <form
          className="min-w-0 space-y-6 border-line px-4 py-6 sm:px-8 xl:border-r"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          noValidate
        >
          {rem.past ? (
            <Callout tone="warning" title="The evidence deadline has passed">
              Submissions now are recorded but marked late; they cannot change this claim’s outcome. {COPY.lateEvidence}
            </Callout>
          ) : null}

          <Field label="Submission mode" htmlFor="mode" hint={mode === 'commit' ? 'Records only the package hash now; you reveal the package later. Commit-reveal is a launch gate and its reveal flow is not final.' : 'Uploads the evidence package publicly and submits its URI.'}>
            <Segmented
              label="Submission mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'direct', label: 'Direct' },
                { value: 'commit', label: 'Commit, reveal later' },
              ]}
            />
          </Field>

          <fieldset>
            <legend className="stretch-cond mb-1.5 text-[13px] font-medium">Kind</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {KINDS.map((k) => (
                <label key={k.value} className={cn('cursor-pointer rounded-ctl border px-3 py-2', kind === k.value ? 'border-needle bg-needle-soft/50' : 'border-line hover:bg-frost')}>
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    <input type="radio" name="kind" checked={kind === k.value} onChange={() => setKind(k.value)} className="accent-[var(--needle)]" />
                    {k.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-muted">{k.help}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <Field label="Title" htmlFor="ev-title" required aside={<span className="tnum">{title.length}/140</span>}>
            <Input id="ev-title" value={title} maxLength={140} onChange={(e) => setTitle(e.target.value)} placeholder="Reporter top-up draws principal from the arbitration allocation" />
          </Field>

          <Field
            label="Summary"
            htmlFor="ev-summary"
            required
            aside={
              <button type="button" onClick={() => setPreview((p) => !p)} className="text-needle hover:underline">
                {preview ? 'Edit' : 'Preview as published'}
              </button>
            }
            hint="Markdown. Explain how the reproduction demonstrates the exact violation. It becomes public, untrusted content."
          >
            {preview ? (
              <div className="min-h-[140px] rounded-ctl border border-dashed border-line-strong px-3 py-2">
                {summary ? <SafeMarkdown compact>{summary}</SafeMarkdown> : <p className="text-[13px] text-muted">Nothing to preview.</p>}
              </div>
            ) : (
              <Textarea id="ev-summary" rows={7} value={summary} onChange={(e) => setSummary(e.target.value)} />
            )}
          </Field>

          <fieldset className="space-y-4 rounded-ctl border border-line p-4">
            <legend className="stretch-cond px-1 text-[13px] font-semibold">Reproduction</legend>
            <Field label="Command" htmlFor="ev-cmd" required={kind === 'counterexample'} hint="Prefilled with the claim’s reproduction command. Change it only if your test lives elsewhere.">
              <Input id="ev-cmd" mono value={command} onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label="Environment" htmlFor="ev-env" hint="Must match the pinned environment. Any deviation is grounds for rejection.">
              <Input id="ev-env" mono value={environment} onChange={(e) => setEnvironment(e.target.value)} />
            </Field>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label="Expected behavior" htmlFor="ev-exp" required={kind === 'counterexample'}>
                <Textarea id="ev-exp" rows={3} mono value={expected} onChange={(e) => setExpected(e.target.value)} />
              </Field>
              <Field label="Actual behavior" htmlFor="ev-act" required={kind === 'counterexample'}>
                <Textarea id="ev-act" rows={3} mono value={actual} onChange={(e) => setActual(e.target.value)} />
              </Field>
            </div>
            <Field label="Steps" htmlFor="ev-steps">
              <ListEditor id="ev-steps" value={steps} onChange={setSteps} placeholder="Seed journal state with fixture reporter-underfunded.json" addLabel="Add step" />
            </Field>
          </fieldset>

          <Field label="Attachments" htmlFor="ev-files" hint="Logs, traces and archives support evidence; they never replace a reproducible test. Only names, types and sizes are listed in this demo.">
            <input
              id="ev-files"
              type="file"
              multiple
              onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? []).map((x) => ({ name: x.name, mime: x.type || 'application/octet-stream', size: x.size }))])}
              className="text-[13px] file:mr-3 file:h-8 file:rounded-ctl file:border file:border-line-strong file:bg-surface file:px-3 file:text-[13px] file:text-bark"
            />
            {files.length ? (
              <ul className="mt-2 divide-y divide-line rounded-ctl border border-line">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[12.5px]">
                    <Paperclip size={12} aria-hidden className="text-faint" />
                    <span className="wrap-anywhere min-w-0 flex-1">{f.name}</span>
                    <span className="text-muted">{fmtSize(f.size)}</span>
                    <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded-chip p-0.5 text-faint hover:text-flare" aria-label={`Remove ${f.name}`}>
                      <X size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Field>

          <fieldset>
            <legend className="stretch-cond mb-1.5 text-[13px] font-semibold">Admissibility checklist ({claim.policy.id})</legend>
            <p className="mb-2 text-[12.5px] text-muted">Confirm each requirement. Jurors and answerers judge admissibility; this list helps you avoid an obvious rejection.</p>
            <div className="space-y-2 rounded-ctl border border-line p-3">
              {requirements.map((r) => (
                <Checkbox key={r} id={`chk-${r}`} checked={!!checks[r]} onChange={(v) => setChecks((c) => ({ ...c, [r]: v }))} label={r} />
              ))}
            </div>
            {tried && !allChecked ? <p className="mt-1 text-xs text-flare">Confirm every requirement before submitting.</p> : null}
          </fieldset>

          {tried && issues.length ? (
            <Callout tone="critical" title="Fix these before submitting">
              <ul className="list-disc pl-4">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {ev.blockers.length && !started ? (
            <Callout tone="info">
              {ev.blockers.join(' ')}
              {!wallet.isConnected ? (
                <Button size="sm" variant="secondary" className="ml-2" onClick={() => wallet.connect()}>
                  Connect wallet
                </Button>
              ) : null}
            </Callout>
          ) : null}
          {error ? <Callout tone="critical" title="Submission stopped">{error}</Callout> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" size="lg" disabled={started && ev.runner.state !== 'failed'}>
              {mode === 'commit' ? 'Submit commitment' : 'Submit evidence'}
            </Button>
            <span className="text-[12.5px] text-muted">{COPY.evidenceIsNotPayment}</span>
          </div>

          {started ? (
            <div className="space-y-3">
              <TxLog runner={ev.runner} title="Evidence submission" />
              {ev.runner.state === 'done' ? (
                <Callout
                  tone="info"
                  title="Evidence submitted"
                  action={
                    <Button asChild size="sm" variant="primary">
                      <Link href={`/claims/${claim.id}?tab=evidence`}>View evidence</Link>
                    </Button>
                  }
                >
                  Its block timestamp is the timeliness proof. {ev.evidenceUri ? <span className="mono-cond text-[11.5px]">{ev.evidenceUri}</span> : null}
                </Callout>
              ) : null}
              {ev.runner.state === 'done' || ev.runner.state === 'failed' ? (
                <Button variant="quiet" size="sm" onClick={() => ev.reset()}>
                  File another submission
                </Button>
              ) : null}
            </div>
          ) : null}
        </form>

        <aside className="space-y-0 divide-y divide-line border-t border-line bg-frost xl:border-t-0" aria-label="Claim context">
          <div className="px-4 py-4">
            <p className="stretch-cond text-[12.5px] text-muted">Deadline</p>
            <p className={cn('tnum mt-0.5 text-[20px] font-semibold', rem.past ? 'text-flare' : rem.ms < 48 * 3600_000 ? 'text-resin' : '')}>
              {rem.past ? `closed ${rem.label} ago` : `${rem.label} left`}
            </p>
            <p className="tnum text-[12px] text-muted">{formatDate(claim.evidenceDeadline, 'utc')}</p>
          </div>
          <div className="px-4 py-4">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <ArrowLeftRight size={14} aria-hidden className="text-resin" /> Your wallet will switch to {evChain?.name ?? `chain ${ev.chainId}`}
            </p>
            <p className="mt-1 text-[12.5px] text-muted">
              Evidence is an ERC-1497 transaction to the Kleros arbitrator proxy on {evChain?.name ?? `chain ${ev.chainId}`}, even though this market trades on{' '}
              {CHAINS[claim.chainId]?.name ?? `chain ${claim.chainId}`}. You pay that network’s gas. Its block timestamp proves timeliness.
            </p>
          </div>
          <div className="px-4 py-4">
            <p className="stretch-cond text-[12.5px] text-muted">Question</p>
            <p className="mono-cond wrap-anywhere mt-1 text-[11px] leading-[1.6]">{claim.manifest.question.text}</p>
          </div>
          <div className="px-4 py-4">
            <p className="stretch-cond text-[12.5px] text-muted">Violation to demonstrate</p>
            <p className="mt-1 text-[13px]">{claim.manifest.claim.violation}</p>
          </div>
          <div className="px-4 py-4 text-[12px] text-muted">
            <p>{COPY.noAttackAuthorization}</p>
            <p className="mt-2">{COPY.untrustedContent}</p>
          </div>
        </aside>
      </div>
    </div>
  )
}
