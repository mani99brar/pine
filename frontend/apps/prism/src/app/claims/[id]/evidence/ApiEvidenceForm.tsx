'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, ClaimDetail } from '@pine/core'
import { explorerTxUrl, formatDate } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { DEFAULT_ARTIFACT_MEDIA_TYPES, type ApiClaimFacts } from '@pine/data'
import { mediaTypeOf, pineKeys, useApiEvidence, usePolicy, useWallet, type EvidenceComposition, type EvidenceFieldError, type SealedEvidenceView } from '@pine/react'
import { ArrowLeft, Eye, Lock, X } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/Button'
import { HashChip, Segmented } from '@/components/ui/interactive'
import { FormField, Notice } from '@/components/ui/primitives'
import { ApiClaimNotices } from '@/components/claim/ApiNotices'
import { ApiSessionGate, PlanControls, PlanProgress, WriteErrorNotice, useSessionReady } from '@/components/claim/ApiActionKit'
import { API_DEADLINE_RULES, claimLabel, countdown, isoOfUnix } from '@/lib/claims'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'
import { addAttachments, fileProblem, kib, MAX_FILES } from './attachments'

type Mode = 'sealed' | 'publish'

interface Fields {
  title: string
  violatedRequirement: string
  summary: string
  expectedBehavior: string
  actualBehavior: string
  environment: string
  setup: string
  command: string
  initialState: string
  notes: string
}

const EMPTY: Fields = { title: '', violatedRequirement: '', summary: '', expectedBehavior: '', actualBehavior: '', environment: '', setup: '', command: '', initialState: '', notes: '' }
const ACCEPT = [...DEFAULT_ARTIFACT_MEDIA_TYPES, '.json', '.txt', '.gz', '.zip', '.tar', '.png', '.jpg', '.jpeg'].join(',')

/** Manifest paths of the composition → the form field that shows the error. */
const FIELD_OF: Record<string, keyof Fields> = {
  title: 'title',
  violatedRequirement: 'violatedRequirement',
  summary: 'summary',
  expectedBehavior: 'expectedBehavior',
  actualBehavior: 'actualBehavior',
  'reproduction.environment': 'environment',
  'reproduction.setup': 'setup',
  'reproduction.command': 'command',
  'reproduction.initialState': 'initialState',
  'reproduction.notes': 'notes',
}

const SEAL_STATE: Record<SealedEvidenceView['state'], string> = {
  sealed: 'Sealed in this browser, not committed',
  committing: 'Commit started, not confirmed on chain yet',
  committed: 'Committed on chain',
  revealing: 'Reveal sent, waiting for confirmation',
  revealed: 'Revealed',
}

interface SealRowProps {
  seal: SealedEvidenceView
  chainId: number
  /** An evidence action is being prepared or sent: no reveal can start. */
  busy: boolean
  /** This seal's reveal is being checked, uploaded or sent. */
  revealing: boolean
  /** The connected wallet has its own Pine session (the reveal template and the uploads need one). */
  canReveal: boolean
  onReveal: (files: File[], acknowledge: boolean) => void
}

function SealRow({ seal, chainId, busy, revealing, canReveal, onReveal }: SealRowProps) {
  const [files, setFiles] = useState<File[]>([])
  const [acknowledge, setAcknowledge] = useState(false)
  const missing = seal.missingArtifacts
  // Pine refuses empty uploads: an empty file of an earlier seal can never be attached again.
  const absent = missing.filter((m) => m.size > 0)
  const empty = missing.filter((m) => m.size === 0)
  const inputId = `reveal-files-${seal.contentSha256.slice(2, 10)}`
  const deadline = seal.revealDeadline !== null ? isoOfUnix(seal.revealDeadline) : null
  return (
    <li className="cut-md border border-edge bg-void p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tag" style={{ color: 'var(--ca)' }}>
          {SEAL_STATE[seal.state]}
        </span>
        {seal.state === 'committed' && deadline && <span className={cn('tag', seal.revealOpen ? 'text-na' : 'text-lumen-3')}>{seal.revealOpen ? `Reveal before ${formatDate(deadline, 'utc')}` : 'Reveal window closed'}</span>}
      </div>
      {/* Your own title, as plain text. */}
      <p className="untrusted mt-2 font-semibold text-lumen">{seal.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.8125rem]">
        <HashChip value={seal.commitment} label="Commitment" />
        {seal.commitTxHash && (
          <a className="link text-lumen-2" href={explorerTxUrl(chainId, seal.commitTxHash)} target="_blank" rel="noopener noreferrer nofollow">
            Commit transaction
          </a>
        )}
        {seal.revealTxHash && (
          <a className="link text-lumen-2" href={explorerTxUrl(chainId, seal.revealTxHash)} target="_blank" rel="noopener noreferrer nofollow">
            Reveal transaction
          </a>
        )}
      </div>
      {seal.state === 'committed' && !seal.revealOpen && <p className="mt-2 text-[0.84375rem] text-na">The reveal deadline has passed: this commitment can no longer be revealed and does not count.</p>}
      {seal.state === 'committed' && seal.revealOpen && !canReveal && (
        <p className="mt-3 text-[0.84375rem] text-lumen-2">Sign in to Pine with this wallet (above) to reveal it.</p>
      )}
      {seal.state === 'committed' && seal.revealOpen && canReveal && (
        <form
          className="mt-3 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) onReveal(files, acknowledge)
          }}
        >
          {missing.length > 0 && (
            <div>
              <label htmlFor={inputId} className="label">
                Attach the committed files again
              </label>
              {absent.length > 0 && (
                <p className="help -mt-1">
                  This browser no longer holds {absent.map((m) => m.name).join(', ')}. Pick the same files: they are matched by their SHA-256 and uploaded only now, with the reveal. Pine
                  stores your written report only together with every file it lists.
                </p>
              )}
              {empty.length > 0 && <p className="help -mt-1">{empty.map((m) => m.name).join(', ')} {empty.length === 1 ? 'is' : 'are'} empty, and Pine does not store empty files.</p>}
              <input
                id={inputId}
                type="file"
                multiple
                accept={ACCEPT}
                className="block text-[0.875rem] text-lumen-2 file:mr-3 file:rounded-[5px] file:border file:border-[var(--edge-strong)] file:bg-smoke-2 file:px-3 file:py-1.5 file:font-semibold file:text-lumen"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              <label className="mt-2 flex items-start gap-3 text-[0.84375rem] text-lumen-2">
                <input type="checkbox" className="facet-check" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                <span>
                  Reveal without the missing files. This reveal then uploads nothing to Pine: not the files I did attach, and not my written report (title, summary,
                  reproduction). Only the digest goes on chain. Unless Pine already holds the report from an earlier attempt, adjudicators cannot obtain my evidence,
                  and under policy C4 an evidence manifest they cannot obtain is inadmissible.
                </span>
              </label>
            </div>
          )}
          <div>
            <Button type="submit" size="sm" disabled={busy} loading={revealing} icon={<Eye size={14} aria-hidden />}>
              Reveal sealed evidence
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}

/**
 * Evidence for a backend claim (useApiEvidence): compose a manifest locally, then either commit a sealed hash (the salt
 * and the content stay in this browser until the reveal) or publish directly. Every transaction is a Pine plan the app
 * verifies before the wallet signs it.
 */
export function ApiEvidenceForm({ claim, api }: { claim: ClaimDetail; api: ApiClaimFacts }) {
  const market = (claim.marketAddress ?? claim.id) as Address
  const ev = useApiEvidence(market)
  const now = useNowMs()
  const qc = useQueryClient()
  const ready = useSessionReady()
  const walletConnected = Boolean(useWallet().address)
  const policyQ = usePolicy(claim.policy.id, claim.policy.version || undefined)
  const [mode, setMode] = useState<Mode>('sealed')
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [files, setFiles] = useState<File[]>([])
  /** Names of the last picked files beyond MAX_FILES. */
  const [notAdded, setNotAdded] = useState<string[]>([])
  const [preview, setPreview] = useState(false)
  const [checks, setChecks] = useState<Record<number, boolean>>({})
  const queued = useRef<{ kind: 'commit' | 'publish'; sha: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [submitting, setSubmitting] = useState(false)

  // The hook reads the prepared manifest after a render: run the queued commit or publish once it is there.
  const { prepared, commit, publish } = ev
  useEffect(() => {
    const q = queued.current
    if (!q || prepared?.contentSha256 !== q.sha) return
    queued.current = null
    void (q.kind === 'commit' ? commit() : publish()).finally(() => setSubmitting(false))
  }, [tick, prepared, commit, publish])

  // Show the new submission in the claim's feed once the wallet steps are done.
  const runState = ev.runner.runner.state
  useEffect(() => {
    if (runState !== 'done') return
    void qc.invalidateQueries({ queryKey: pineKeys.evidence(claim.id) })
    void qc.invalidateQueries({ queryKey: pineKeys.claim(claim.id) })
  }, [runState, qc, claim.id])

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields((f) => ({ ...f, [k]: e.target.value }))
  const errorOf = (k: keyof Fields) => ev.fieldErrors.find((e: EvidenceFieldError) => FIELD_OF[e.field] === k)?.message
  const fileErrors = ev.fieldErrors.filter((e) => e.field.startsWith('artifacts'))
  const evidenceDeadline = isoOfUnix(api.evidenceDeadline)
  const revealDeadline = isoOfUnix(api.revealDeadline)
  const open = api.phase === 'evidence_open' && !api.hidden
  const busy = ev.busy || submitting
  const doc = api.documentVerified ? claim.manifest.claim : null
  const reqs = policyQ.data?.evidenceRequirements ?? []
  const badFiles = files.some((f) => fileProblem(f) !== null)
  const action = ev.action
  const done = runState === 'done' && action !== null && action.kind !== 'reveal'
  const stopped = runState === 'failed' || ev.runner.phase === 'error'
  // Where `ev.error` belongs: the reveal the user last started (it may fail before its plan replaces the stored commit
  // action), else the submission form. After a reload, the stored action decides.
  const revealErrors = ev.attempt === 'reveal' || (ev.attempt === null && action?.kind === 'reveal')
  const revealable = ev.seals.some((s) => s.state === 'committed' && s.revealOpen)

  const submit = async () => {
    const composition: EvidenceComposition = {
      title: fields.title,
      violatedRequirement: fields.violatedRequirement,
      summary: fields.summary,
      expectedBehavior: fields.expectedBehavior,
      actualBehavior: fields.actualBehavior,
      reproduction: { environment: fields.environment, setup: fields.setup, command: fields.command, initialState: fields.initialState, notes: fields.notes },
      artifacts: files.map((file) => ({ file })),
    }
    setSubmitting(true)
    const p = await ev.prepare(composition).catch(() => null)
    if (!p) {
      setSubmitting(false)
      return
    }
    queued.current = { kind: mode === 'sealed' ? 'commit' : 'publish', sha: p.contentSha256 }
    setTick((t) => t + 1)
  }

  return (
    <div>
      <Link href={`/claims/${claim.id}`} className="mt-6 inline-flex items-center gap-1.5 text-[0.875rem] text-lumen-3 hover:text-lumen">
        <ArrowLeft size={14} aria-hidden /> <span className="t-code">{claimLabel(claim)}</span>
      </Link>
      <header className="pb-8 pt-6">
        <h1 className="t-h1 chroma">Submit evidence</h1>
        <p className="t-lead mt-3 max-w-[64ch] [overflow-wrap:anywhere]">{claim.title}</p>
        <p className="mt-2 text-[0.9rem] text-lumen-3">
          Commit or publish before {formatDate(evidenceDeadline, 'utc')}
          {now !== null && Date.parse(evidenceDeadline) > now && <span className="tnum ml-2 text-na">{countdown(evidenceDeadline, now)} left</span>}
          <span className="block">Reveal sealed evidence before {formatDate(revealDeadline, 'utc')}.</span>
        </p>
      </header>

      <ApiClaimNotices claim={claim} className="mb-8" />

      {done ? (
        <div className="glass cut-xl mb-8 p-6 sm:p-8" role="status">
          <p className="tag gap-1.5 text-lumen">Recorded on Gnosis</p>
          <h2 className="t-h2 mt-4">{action?.kind === 'commit' ? 'Your sealed commitment is on chain.' : 'Your evidence is on chain.'}</h2>
          <p className="mt-3 max-w-[62ch] text-lumen-2">
            {action?.kind === 'commit'
              ? `Only its hash is recorded. The content and the salt stay in this browser: reveal them below before ${formatDate(revealDeadline, 'utc')}, or the evidence does not count. Do not clear this site's data.`
              : 'The block timestamp is your proof of timeliness. Answerers and jurors decide whether it demonstrates the violation.'}{' '}
            {COPY.evidenceIsNotPayment}
          </p>
          <PlanProgress runner={ev.runner} chainId={claim.chainId} className="mt-6" />
          {ev.planState && <p className="mt-3 text-[0.84375rem] text-lumen-3">Pine sees this plan as {ev.planState.state}.</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href={`/claims/${claim.id}#evidence`}>Back to the claim</ButtonLink>
            <Button
              variant="glass"
              onClick={() => {
                ev.abandon()
                setFields(EMPTY)
                setFiles([])
                setNotAdded([])
                setChecks({})
              }}
            >
              File another
            </Button>
          </div>
        </div>
      ) : !open ? (
        <Notice tone="caution" title={api.hidden ? 'Evidence is closed for this claim' : 'The evidence window has closed'} className="mb-8">
          {api.hidden
            ? 'Pine withholds this claim after a moderation decision and offers no evidence actions for it.'
            : `New evidence had to be recorded before ${formatDate(evidenceDeadline, 'utc')}. ${api.phase === 'reveal_open' ? 'Sealed evidence can still be revealed below until the reveal deadline.' : ''} ${COPY.lateEvidence}`}
        </Notice>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.5fr)_minmax(18rem,1fr)] lg:grid-rows-[auto_1fr]">
          <aside className="grid content-start gap-5 lg:col-start-2 lg:row-start-1" aria-label="How evidence is recorded">
            <section className="glass cut-lg p-5" aria-labelledby="mode-title">
              <h2 id="mode-title" className="t-h4">
                How it is recorded
              </h2>
              <Segmented
                className="mt-3"
                label="Submission mode"
                size="sm"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'sealed', label: 'Sealed, reveal later' },
                  { value: 'publish', label: 'Publish now' },
                ]}
              />
              {mode === 'sealed' ? (
                <div className="mt-3 grid gap-2 text-[0.875rem] text-lumen-2">
                  <p>Only a hash of your evidence goes on chain now, so nobody can copy it before the deadline. Your files are uploaded to Pine only when you reveal.</p>
                  <Notice tone="caution" title="Keep this browser">
                    The random salt that opens the seal is stored only in this browser. Clearing site data or switching browsers loses it, and unrevealed evidence does not count. Reveal before {formatDate(revealDeadline, 'utc')}.
                  </Notice>
                </div>
              ) : (
                <p className="mt-3 text-[0.875rem] text-lumen-2">Your files and the evidence manifest are uploaded to Pine and its digest is recorded on chain. Everyone can read it at once.</p>
              )}
            </section>
            <section className="glass cut-lg p-5 text-[0.84375rem] text-lumen-2" aria-label="Deadline rules">
              <p>{API_DEADLINE_RULES.evidence}</p>
              <p className="mt-1">{API_DEADLINE_RULES.reveal}</p>
              <p className="mt-2 text-lumen-3">Your wallet sends the transaction on Gnosis; the block timestamp proves timeliness.</p>
            </section>
          </aside>

          <form
            className="grid content-start gap-6 lg:col-start-1 lg:row-span-2 lg:row-start-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy && !badFiles) void submit()
            }}
          >
            <FormField id="ev-title" label="Title" help="One line naming what you demonstrate." error={errorOf('title')}>
              <input id="ev-title" className="field" value={fields.title} onChange={set('title')} maxLength={200} aria-invalid={Boolean(errorOf('title'))} />
            </FormField>
            <div>
              <FormField
                id="ev-requirement"
                label="Requirement violated"
                help="Quote the exact requirement from the claim that your evidence violates."
                error={errorOf('violatedRequirement')}
              >
                <textarea id="ev-requirement" className="field" rows={3} value={fields.violatedRequirement} onChange={set('violatedRequirement')} maxLength={4000} aria-invalid={Boolean(errorOf('violatedRequirement'))} />
              </FormField>
              {doc?.requirement && (
                <button type="button" className="link mt-1 text-[0.8125rem] text-lumen-2" onClick={() => setFields((f) => ({ ...f, violatedRequirement: doc.requirement }))}>
                  Quote the claim&apos;s requirement
                </button>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label htmlFor="ev-summary" className="label mb-0">
                  Summary
                </label>
                <Segmented
                  label="Write or preview"
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
                // As the evidence feed shows it (SEC-EVID-10): plain text, line breaks kept, nothing clickable.
                <div className="cut-md well min-h-[9rem] p-4">
                  {fields.summary.trim() ? (
                    <p className="untrusted whitespace-pre-wrap text-[0.9375rem] leading-[1.6] text-lumen-2 [overflow-wrap:anywhere]">{fields.summary}</p>
                  ) : (
                    <p className="text-lumen-3">Nothing to preview.</p>
                  )}
                </div>
              ) : (
                <textarea
                  id="ev-summary"
                  className="field"
                  rows={7}
                  value={fields.summary}
                  onChange={set('summary')}
                  maxLength={10000}
                  aria-invalid={Boolean(errorOf('summary'))}
                  aria-describedby="ev-summary-help"
                  placeholder="What you ran, what happened, and why it is the stated violation. Everyone sees it as plain text: links are not clickable."
                />
              )}
              <p id="ev-summary-help" className="help mt-1">
                {mode === 'sealed' ? 'Kept in this browser until you reveal it.' : 'Public as soon as it is published.'}
              </p>
              {errorOf('summary') && <p className="mt-1.5 text-[0.8125rem] font-medium text-ha">{errorOf('summary')}</p>}
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <FormField id="ev-expected" label="Expected behavior" error={errorOf('expectedBehavior')}>
                <textarea id="ev-expected" className="field" rows={3} value={fields.expectedBehavior} onChange={set('expectedBehavior')} maxLength={4000} aria-invalid={Boolean(errorOf('expectedBehavior'))} />
              </FormField>
              <FormField id="ev-actual" label="Actual behavior" error={errorOf('actualBehavior')}>
                <textarea id="ev-actual" className="field" rows={3} value={fields.actualBehavior} onChange={set('actualBehavior')} maxLength={4000} aria-invalid={Boolean(errorOf('actualBehavior'))} />
              </FormField>
            </div>

            <fieldset className="cut-lg well grid gap-5 p-4 sm:p-5">
              <legend className="px-1 text-[0.9375rem] font-semibold text-lumen">Reproduction</legend>
              <div>
                <FormField id="ev-env" label="Environment" help="Where you ran it. It should match the claim's pinned environment; say exactly what differs." error={errorOf('environment')}>
                  <textarea id="ev-env" className="field" rows={2} value={fields.environment} onChange={set('environment')} maxLength={4000} aria-invalid={Boolean(errorOf('environment'))} />
                </FormField>
                {doc?.environment.runtime && (
                  <button
                    type="button"
                    className="link mt-1 text-[0.8125rem] text-lumen-2"
                    onClick={() => setFields((f) => ({ ...f, environment: `As pinned by the claim: ${doc.environment.runtime}` }))}
                  >
                    Use the claim&apos;s pinned runtime
                  </button>
                )}
              </div>
              <FormField id="ev-setup" label="Setup" help="Steps that prepare the environment, one per line." error={errorOf('setup')}>
                <textarea id="ev-setup" className="field t-code" rows={3} value={fields.setup} onChange={set('setup')} maxLength={10000} aria-invalid={Boolean(errorOf('setup'))} />
              </FormField>
              <FormField id="ev-cmd" label="Command" help="Run against the pinned commit." error={errorOf('command')}>
                <input id="ev-cmd" className="field t-code" value={fields.command} onChange={set('command')} maxLength={2000} placeholder={doc?.environment.reproductionCommand || undefined} aria-invalid={Boolean(errorOf('command'))} />
              </FormField>
              <div className="grid gap-5 md:grid-cols-2">
                <FormField id="ev-initial" label="Initial state" optional error={errorOf('initialState')}>
                  <textarea id="ev-initial" className="field" rows={2} value={fields.initialState} onChange={set('initialState')} maxLength={10000} />
                </FormField>
                <FormField id="ev-notes" label="Notes" optional error={errorOf('notes')}>
                  <textarea id="ev-notes" className="field" rows={2} value={fields.notes} onChange={set('notes')} maxLength={10000} />
                </FormField>
              </div>
            </fieldset>

            <div>
              <label htmlFor="ev-files" className="label">
                Attachments
              </label>
              <p id="ev-files-help" className="help -mt-1 mb-2">
                Up to {MAX_FILES} files of at most 256 KiB each: JSON, plain text, gzip, zip, tar, PNG or JPEG. They are hashed here; {mode === 'sealed' ? 'uploaded to Pine only when you reveal.' : 'uploaded to Pine when you publish.'}
              </p>
              <input
                id="ev-files"
                type="file"
                multiple
                accept={ACCEPT}
                aria-describedby="ev-files-help"
                className="block text-[0.875rem] text-lumen-2 file:mr-3 file:rounded-[5px] file:border file:border-[var(--edge-strong)] file:bg-smoke-2 file:px-3 file:py-1.5 file:font-semibold file:text-lumen"
                onChange={(e) => {
                  const next = addAttachments(files, Array.from(e.target.files ?? []))
                  setFiles(next.files)
                  setNotAdded(next.notAdded.map((f) => f.name))
                  e.target.value = ''
                }}
              />
              {files.length > 0 && (
                <ul className="mt-3 grid gap-1.5">
                  {files.map((f, i) => {
                    const problem = fileProblem(f)
                    return (
                      <li key={`${f.name}-${i}`} className="cut-sm flex flex-wrap items-center gap-x-3 gap-y-1 border border-edge bg-void px-3 py-1.5 text-[0.84375rem]">
                        <span className="untrusted min-w-0 flex-1 text-lumen-2">{f.name}</span>
                        <span className="text-lumen-3">{mediaTypeOf(f) || 'unknown type'}</span>
                        <span className="tnum text-lumen-3">{kib(f.size)}</span>
                        {problem && <span className="w-full text-[0.8125rem] text-ha">Not accepted: {problem}.</span>}
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-lumen-3 hover:bg-smoke-3 hover:text-lumen"
                          onClick={() => {
                            setFiles(files.filter((_, j) => j !== i))
                            setNotAdded([])
                          }}
                          aria-label={`Remove ${f.name}`}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {notAdded.length > 0 && (
                <p className="mt-1.5 text-[0.8125rem] font-medium text-ha" role="alert">
                  At most {MAX_FILES} files. Not added: <span className="untrusted">{notAdded.join(', ')}</span>.
                </p>
              )}
              {fileErrors.map((e) => (
                <p key={e.field} className="mt-1.5 text-[0.8125rem] font-medium text-ha">
                  {e.message}
                </p>
              ))}
            </div>

            {reqs.length > 0 && (
              <fieldset className="glass cut-lg p-4 sm:p-5">
                <legend className="px-1 text-[0.9375rem] font-semibold text-lumen">Admissibility under {claim.policy.id}</legend>
                <p className="help mb-3">A checklist for you: jurors and answerers judge admissibility, not this form.</p>
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
              </fieldset>
            )}

            {!revealErrors && <WriteErrorNotice error={ev.error} />}
            {action?.kind !== 'reveal' && <PlanProgress runner={ev.runner} chainId={claim.chainId} />}
            <div className="flex flex-wrap items-center gap-3 border-t border-edge pt-5">
              {ready ? (
                <>
                  {/* After a failed step the plan is resumed (Try again) or dropped (Start over), not sent twice. */}
                  {!(stopped && action?.kind !== 'reveal') && (
                    <Button type="submit" loading={busy} disabled={busy || badFiles} icon={mode === 'sealed' ? <Lock size={15} aria-hidden /> : undefined}>
                      {mode === 'sealed' ? 'Commit sealed evidence' : 'Publish evidence'}
                    </Button>
                  )}
                  <PlanControls runner={ev.runner} busy={busy} onRetry={() => void ev.runner.run()} onAbandon={ev.abandon} />
                  {badFiles && <p className="text-[0.8125rem] text-ha">Remove the files Pine does not accept.</p>}
                </>
              ) : (
                <ApiSessionGate purpose="submit evidence" />
              )}
            </div>
          </form>
          <aside className="grid content-start gap-5 lg:col-start-2 lg:row-start-2" aria-label="Before you submit">
            <Notice tone="boundary">{COPY.untrustedContent}</Notice>
            <Notice tone="boundary">{COPY.noAttackAuthorization}</Notice>
            <p className="text-[0.84375rem] text-lumen-3">{COPY.evidenceIsNotPayment}</p>
          </aside>
        </div>
      )}

      <section id="sealed" className="scroll-mt-28 pt-12" aria-labelledby="sealed-title">
        <h2 id="sealed-title" className="t-h3">
          Your sealed evidence in this browser
        </h2>
        <p className="mt-1 max-w-[70ch] text-[0.875rem] text-lumen-3">Commitments made from this browser with the connected wallet. Reveal each one before {formatDate(revealDeadline, 'utc')}.</p>
        {!walletConnected ? (
          <p className="mt-3 text-[0.9rem] text-lumen-2">Connect the wallet you committed with to see your sealed evidence.</p>
        ) : ev.seals.length === 0 ? (
          <p className="mt-3 text-[0.9rem] text-lumen-2">None for this wallet and claim in this browser.</p>
        ) : (
          <>
            {/* Revealing needs the wallet's own Pine session, like committing: the template and the uploads require it. */}
            {revealable && !ready && <ApiSessionGate purpose="reveal your sealed evidence" className="mt-4" />}
            <ul className="mt-4 grid gap-3">
              {ev.seals.map((s) => (
                <SealRow
                  key={s.contentSha256}
                  seal={s}
                  chainId={claim.chainId}
                  busy={busy}
                  revealing={ev.revealing === s.contentSha256}
                  canReveal={ready}
                  onReveal={(f, ack) => void ev.reveal(s.contentSha256, { files: f, acknowledgeUnavailableContent: ack })}
                />
              ))}
            </ul>
            {ev.revealWarnings.length > 0 && (
              <Notice tone="caution" title="Pine's notes on this reveal" className="mt-4">
                <ul className="grid gap-1">
                  {ev.revealWarnings.map((w) => (
                    <li key={w.code} className="untrusted">
                      {w.text}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            {(revealErrors || action?.kind === 'reveal') && (
              <div className="mt-4">
                {revealErrors && <WriteErrorNotice error={ev.error} />}
                {action?.kind === 'reveal' && <PlanProgress runner={ev.runner} chainId={claim.chainId} className="mt-3" />}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
