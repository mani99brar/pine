'use client'

import * as React from 'react'
import { ChevronRight, Download, TriangleAlert } from 'lucide-react'
import { evidenceMechanismQuestionLabel, formatUtcMinute, normalizeViolation } from '@pine/core'
import type { PublishClaim } from '@pine/react'
import { cn } from '@/lib/cn'
import { CopyButton } from '@/components/ui/copy-button'
import { HashChip } from '@/components/ui/hash-chip'
import { JsonView } from '@/components/ui/json-view'
import { TxLog } from '@/components/ui/tx-log'
import { useComposerCtx, sectionForPath, SECTIONS } from './context'

interface Slot {
  key: string
  label: string
  value: string | undefined
  missing?: boolean
}

function useSlots(): Slot[] {
  const { c } = useComposerCtx()
  const spec = c.spec
  const violation = normalizeViolation(spec.violation)
  const missingViolation = !c.draft.spec.violation?.trim()
  let mechanism: string | undefined
  try {
    mechanism = evidenceMechanismQuestionLabel(spec.evidence.mechanism, spec.oracle.chainId)
  } catch {
    mechanism = undefined
  }
  let deadline: string | undefined
  try {
    deadline = spec.evidence.deadline ? formatUtcMinute(spec.evidence.deadline) : undefined
  } catch {
    deadline = undefined
  }
  return [
    { key: 'violation', label: 'violation', value: violation, missing: missingViolation },
    { key: 'sha', label: 'commit', value: c.draft.source?.commit.sha?.toLowerCase() },
    { key: 'env', label: 'environment hash', value: spec.environment.envHash },
    { key: 'policy', label: 'policy version', value: c.policy ? `${c.policy.id}@${c.policy.version}` : undefined },
    { key: 'policyHash', label: 'policy hash', value: c.policy?.contentHash },
    { key: 'mechanism', label: 'evidence channel', value: mechanism },
    { key: 'deadline', label: 'deadline (UTC)', value: deadline },
  ]
}

/** The immutable question with each inserted value marked; a value that changes flashes resin. */
function QuestionPreview() {
  const { c } = useComposerCtx()
  const slots = useSlots()
  const current = Object.fromEntries(slots.map((s) => [s.key, s.value])) as Record<string, string | undefined>
  const sig = slots.map((s) => `${s.key}=${s.value}`).join('|')
  const [prev, setPrev] = React.useState<{ sig: string; values: Record<string, string | undefined> }>({ sig, values: current })
  const [flashKeys, setFlashKeys] = React.useState<Record<string, number>>({})
  const [seq, setSeq] = React.useState(0)
  // Compare with the previous render's slot values (render-time sync, no effect).
  if (prev.sig !== sig) {
    const changed: Record<string, number> = {}
    for (const s of slots) if (prev.values[s.key] !== undefined && prev.values[s.key] !== s.value) changed[s.key] = seq + 1
    setSeq(seq + 1)
    setPrev({ sig, values: current })
    if (Object.keys(changed).length) setFlashKeys((f) => ({ ...f, ...changed }))
  }
  React.useEffect(() => {
    if (!Object.keys(flashKeys).length) return
    const t = window.setTimeout(() => setFlashKeys({}), 1200)
    return () => window.clearTimeout(t)
  }, [flashKeys])

  const text = c.question?.text
  if (!text) {
    const needs = [!c.draft.source && 'pin a commit', !c.policy && 'choose a policy'].filter(Boolean).join(' and ')
    return (
      <p className="mono-cond px-4 py-4 text-[12px] leading-[1.7] text-faint">
        Was a reproducible counterexample demonstrating <span className="rounded-[2px] bg-sunken px-0.5">[violation]</span> against commit{' '}
        <span className="rounded-[2px] bg-sunken px-0.5">[sha]</span>, under configuration/environment <span className="rounded-[2px] bg-sunken px-0.5">[env]</span> and
        policy <span className="rounded-[2px] bg-sunken px-0.5">[policy]</span>, submitted through <span className="rounded-[2px] bg-sunken px-0.5">[channel]</span> before{' '}
        <span className="rounded-[2px] bg-sunken px-0.5">[UTC deadline]</span>?
        <span className="mt-2 block font-sans text-[12px] text-muted">The question appears once you {needs}.</span>
      </p>
    )
  }

  const marks: (Slot & { start: number; end: number })[] = []
  for (const s of slots) {
    if (!s.value) continue
    const i = text.indexOf(s.value)
    if (i >= 0) marks.push({ ...s, start: i, end: i + s.value.length })
  }
  marks.sort((a, b) => a.start - b.start)
  const parts: React.ReactNode[] = []
  let at = 0
  for (const m of marks) {
    if (m.start < at) continue
    if (m.start > at) parts.push(text.slice(at, m.start))
    parts.push(
      <span
        key={`${m.key}-${flashKeys[m.key] ?? 0}`}
        title={m.label}
        className={cn(
          'rounded-[2px] px-[1px] [box-decoration-break:clone]',
          m.missing ? 'bg-flare-soft text-flare shadow-[inset_0_-1px_0_var(--flare)]' : 'bg-needle-soft text-bark shadow-[inset_0_-1px_0_var(--needle)]',
          flashKeys[m.key] && 'animate-resin-flash resin-static',
        )}
      >
        {text.slice(m.start, m.end)}
      </span>,
    )
    at = m.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <p className="mono-cond wrap-anywhere px-4 py-3 text-[12px] leading-[1.75] text-bark">{parts}</p>
}

interface HashEvent {
  t: number
  labels: string[]
}

function useHashLog(hashes: Record<string, string | undefined>) {
  const sig = JSON.stringify(hashes)
  const [prev, setPrev] = React.useState<{ sig: string; hashes: Record<string, string | undefined> }>({ sig, hashes })
  const [log, setLog] = React.useState<HashEvent[]>([])
  if (prev.sig !== sig) {
    const labels = Object.keys(hashes).filter((k) => prev.hashes[k] !== hashes[k] && hashes[k])
    setPrev({ sig, hashes })
    if (labels.length) setLog((l) => [{ t: Date.now(), labels }, ...l].slice(0, 4))
  }
  return log
}

export function ArtifactsPane({
  publish,
  onFocusProblem,
  className,
}: {
  publish: PublishClaim
  onFocusProblem: (path: string) => void
  className?: string
}) {
  const { c } = useComposerCtx()
  const hashes = {
    manifest: c.manifestHash,
    question: c.question?.hash,
    policy: c.policy?.contentHash,
    env: c.spec.environment.envHash,
    config: c.spec.environment.configHash,
  }
  const log = useHashLog(hashes)
  const needs = !c.draft.source && !c.policy ? 'needs commit + policy' : !c.draft.source ? 'needs a commit' : !c.policy ? 'needs a policy' : 'building…'
  const issues = c.validation.issues
  const started = publish.steps.some((s) => s.status !== 'idle')
  const [panel, setPanel] = React.useState<'problems' | 'publish'>(started ? 'publish' : 'problems')
  const [wasStarted, setWasStarted] = React.useState(started)
  if (started !== wasStarted) {
    setWasStarted(started)
    if (started) setPanel('publish')
  }
  const frozen = c.frozen
  const manifestJson = c.manifest ? JSON.stringify(c.manifest, null, 2) : ''

  return (
    <div className={cn('flex min-h-0 flex-col bg-frost', className)}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <h2 className="stretch-cond text-[13px] font-semibold">Live artifacts</h2>
        {frozen ? <span className="rounded-chip bg-slate-soft px-1.5 text-[11px] text-slate">frozen</span> : null}
        <span className="ml-auto text-[11.5px] text-muted" aria-live="polite">
          {c.saving ? 'Saving draft…' : c.lastSavedAt ? `Draft saved ${c.lastSavedAt.slice(11, 19)} UTC` : 'Autosaves as you type'}
        </span>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Hashes" className="border-b border-line px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            <HashChip label="manifest" value={hashes.manifest} pending={needs} tone={frozen ? 'frozen' : 'default'} />
            <HashChip label="question" value={hashes.question} pending={needs} tone={frozen ? 'frozen' : 'default'} />
            <HashChip label="policy" value={hashes.policy} pending="choose a policy" tone={frozen ? 'frozen' : 'default'} />
            <HashChip label="env" value={hashes.env} tone={frozen ? 'frozen' : 'default'} />
            <HashChip label="config" value={hashes.config} tone={frozen ? 'frozen' : 'default'} />
          </div>
          <ol className="mono-cond mt-2 space-y-0.5 text-[10.5px] text-muted" aria-label="Recent recomputations">
            {log.length === 0 ? (
              <li className="text-faint">keccak256(canonical JSON). Edit any field to watch the hashes recompute.</li>
            ) : (
              log.map((e) => (
                <li key={e.t} className="flex gap-2">
                  <span className="tnum text-faint">{new Date(e.t).toISOString().slice(11, 19)}</span>
                  <span>
                    recomputed <span className="text-resin">{e.labels.join(', ')}</span>
                  </span>
                </li>
              ))
            )}
          </ol>
        </section>

        <section aria-labelledby="q-h" className="border-b border-line">
          <div className="flex items-center gap-2 px-4 pt-2.5">
            <h3 id="q-h" className="mono-cond text-[11.5px] font-semibold">
              question.txt
            </h3>
            <span className="text-[11px] text-muted">exact text sent to Reality.eth</span>
            {c.question ? <CopyButton value={c.question.text} label="question text" size={12} className="ml-auto" /> : null}
          </div>
          <QuestionPreview />
        </section>

        <section aria-labelledby="m-h">
          <div className="flex items-center gap-2 px-4 pt-2.5">
            <h3 id="m-h" className="mono-cond text-[11.5px] font-semibold">
              manifest.json
            </h3>
            <span className="text-[11px] text-muted">pinned to IPFS on publish</span>
            {c.manifest ? (
              <span className="ml-auto flex items-center">
                <CopyButton value={manifestJson} label="manifest JSON" size={12} />
                <a
                  href={`data:application/json;charset=utf-8,${encodeURIComponent(manifestJson)}`}
                  download={`${c.claimId}.manifest.json`}
                  className="rounded-chip p-1 text-muted hover:bg-sunken hover:text-bark"
                  aria-label="Download manifest JSON"
                  title="Download manifest JSON"
                >
                  <Download size={12} aria-hidden />
                </a>
              </span>
            ) : null}
          </div>
          <div className="px-3 pb-4 pt-1.5">
            {c.manifest ? (
              <JsonView value={c.manifest} defaultDepth={2} collapsedPaths={['source', 'policy', 'disclaimers', 'claim.environment', 'claim.oracle', 'question']} />
            ) : (
              <p className="px-1 text-[12px] text-faint">The manifest is built once a commit is pinned and a policy chosen.</p>
            )}
          </div>
        </section>
      </div>

      <div className="flex h-[min(38%,280px)] min-h-[150px] flex-col border-t border-line-strong bg-surface">
        <div role="tablist" aria-label="Output" className="flex items-stretch border-b border-line">
          <button
            role="tab"
            type="button"
            aria-selected={panel === 'problems'}
            onClick={() => setPanel('problems')}
            className={cn('flex h-8 items-center gap-1.5 px-3 text-[12.5px] text-muted', panel === 'problems' && 'text-bark shadow-[inset_0_-2px_0_var(--needle)]')}
          >
            Problems
            <span className={cn('tnum rounded-full px-1.5 text-[11px]', issues.length ? 'bg-flare-soft text-flare' : 'bg-needle-soft text-needle')}>{issues.length}</span>
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={panel === 'publish'}
            onClick={() => setPanel('publish')}
            className={cn('flex h-8 items-center gap-1.5 px-3 text-[12.5px] text-muted', panel === 'publish' && 'text-bark shadow-[inset_0_-2px_0_var(--needle)]')}
          >
            Publish log
            {started ? <span className={cn('size-1.5 rounded-full', publish.state === 'failed' ? 'bg-flare' : publish.state === 'done' ? 'bg-needle' : 'animate-pulse-dot bg-resin-fill')} /> : null}
          </button>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto" role="tabpanel">
          {panel === 'problems' ? (
            issues.length === 0 ? (
              <p className="px-4 py-3 text-[12.5px] text-needle">No problems. Review the disclosures, then publish.</p>
            ) : (
              <ul className="py-1">
                {issues.map((i) => (
                  <li key={i.path + i.message}>
                    <button
                      type="button"
                      onClick={() => onFocusProblem(i.path)}
                      className="flex w-full items-start gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-frost"
                    >
                      <TriangleAlert size={12} aria-hidden className="mt-[3px] shrink-0 text-flare" />
                      <span className="min-w-0 flex-1">
                        <span className="text-bark">{i.message}</span>{' '}
                        <span className="mono-cond whitespace-nowrap text-[10.5px] text-faint">
                          {SECTIONS.find((s) => s.id === sectionForPath(i.path))?.label.toLowerCase()} {i.path}
                        </span>
                      </span>
                      <ChevronRight size={12} aria-hidden className="mt-[3px] shrink-0 text-faint" />
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : started ? (
            <div className="p-2">
              <TxLog runner={publish} title="Publishing" compact controls />
            </div>
          ) : (
            <p className="px-4 py-3 text-[12.5px] text-muted">Publishing runs here step by step: pin manifest, create market (terms freeze), approve the exact collateral, split, then add liquidity on the DEX.</p>
          )}
        </div>
      </div>
    </div>
  )
}
