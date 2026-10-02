'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDetail, Evidence } from '@pine/core'
import { explorerTxUrl, formatAmount, formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { FileWarning, Lock, LockOpen, Paperclip, Plus } from 'lucide-react'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { CodeBlock, HashChip } from '@/components/ui/interactive'
import { Note } from '@/components/ui/primitives'
import { EmptyState } from '@/components/ui/states'
import { ButtonLink } from '@/components/ui/Button'
import { cn } from '@/lib/cn'

const KIND_LABEL: Record<Evidence['kind'], string> = {
  counterexample: 'Counterexample',
  rebuttal: 'Rebuttal',
  clarification: 'Clarification',
  commitment: 'Commitment',
}

function safeHref(uri: string): string | undefined {
  const u = uri.trim()
  if (/^https?:\/\//i.test(u)) return u
  if (/^ipfs:\/\//i.test(u)) return `https://cdn.kleros.link/ipfs/${u.slice(7)}`
  return undefined
}

const LONG = 900

export function EvidenceCard({ e, deadline }: { e: Evidence; deadline: string }) {
  const href = safeHref(e.uri)
  const [expanded, setExpanded] = useState(false)
  const long = (e.summary?.length ?? 0) > LONG
  return (
    <article className="min-w-0 rounded-[var(--radius-tile)] border border-line bg-sheet">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <span
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-[0.75rem] font-[700]',
            e.kind === 'counterexample' ? 'bg-ink text-on-ink' : e.kind === 'commitment' ? 'bg-fog-2 text-ink shadow-[inset_0_0_0_1.5px_var(--ink)]' : 'bg-fog-2 text-ink',
          )}
        >
          {e.kind === 'commitment' && (e.commitment?.revealed ? <LockOpen size={12} aria-hidden /> : <Lock size={12} aria-hidden />)}
          {KIND_LABEL[e.kind]}
        </span>
        {e.timely ? (
          <span className="text-[0.78rem] font-[600] text-ink-2">On time</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-lumen-wash px-2 py-0.5 text-[0.75rem] font-[700] text-lumen-ink">
            <FileWarning size={12} aria-hidden /> After the deadline, not timely
          </span>
        )}
        <span className="text-[0.78rem] text-ink-3">
          Block time {formatDate(e.submittedAt, 'long')}
          <span className="sr-only">, deadline {formatDate(deadline, 'long')}</span>
        </span>
        <a href={explorerTxUrl(e.chainId, e.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="ml-auto text-[0.78rem] underline underline-offset-2">
          Timestamp proof (tx {shortHash(e.txHash)})
        </a>
      </header>
      <div className="px-4 py-4">
        {/* Untrusted: titles render as plain text */}
        <h3 className="untrusted t-h3 [white-space:normal]">{e.title}</h3>
        <p className="mt-1 text-[0.78rem] text-ink-3">
          Submitted by <code className="t-code">{shortHash(e.submitter)}</code>
        </p>
        {e.summary && (
          <div className="relative mt-3">
            <div className={long && !expanded ? 'max-h-[14rem] overflow-hidden' : undefined}>
              <SafeMarkdown className="text-[0.92rem] text-ink-2">{e.summary}</SafeMarkdown>
            </div>
            {long && !expanded && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--sheet)] to-transparent" />}
            {long && (
              <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="mt-2 text-[0.84rem] font-[650] underline underline-offset-2">
                {expanded ? 'Collapse' : `Show the full text (${e.summary.length.toLocaleString('en-US')} characters)`}
              </button>
            )}
          </div>
        )}

        {e.commitment && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-[0.84rem] text-ink-2">
            {e.commitment.revealed ? `Revealed ${e.commitment.revealedAt ? formatDate(e.commitment.revealedAt, 'long') : ''}.` : 'Hash committed; the package has not been revealed yet.'}
            <HashChip value={e.commitment.hash} label="commitment" />
          </p>
        )}

        {e.reproduction && (
          <div className="mt-4 grid gap-3">
            <CodeBlock code={e.reproduction.command} label="Reproduction command (untrusted, run only in isolation)" />
            {e.reproduction.steps && e.reproduction.steps.length > 0 && (
              <ol className="list-decimal space-y-1 pl-5 text-[0.88rem] text-ink-2">
                {e.reproduction.steps.map((s, i) => (
                  <li key={i} className="untrusted [white-space:normal]">
                    {s}
                  </li>
                ))}
              </ol>
            )}
            <dl className="grid gap-3 sm:grid-cols-3">
              {(
                [
                  ['Environment', e.reproduction.environment],
                  ['Expected', e.reproduction.expected],
                  ['Actual', e.reproduction.actual],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-[3px] bg-fog-2/70 px-3 py-2">
                  <dt className="text-[0.75rem] font-[650] text-ink-3">{k}</dt>
                  <dd className="untrusted mt-0.5 max-h-48 overflow-y-auto text-[0.84rem] text-ink">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {e.attachments.length > 0 && (
          <ul className="mt-4 space-y-1.5">
            {e.attachments.map((a) => {
              const ah = safeHref(a.uri)
              return (
                <li key={a.hash + a.name} className="flex min-w-0 flex-wrap items-center gap-2 text-[0.84rem]">
                  <Paperclip size={13} aria-hidden className="shrink-0 text-ink-3" />
                  {ah ? (
                    <a href={ah} target="_blank" rel="noopener noreferrer nofollow" className="untrusted min-w-0 underline underline-offset-2">
                      {a.name}
                    </a>
                  ) : (
                    <span className="untrusted min-w-0">{a.name}</span>
                  )}
                  <span className="text-ink-3">
                    {a.mime}, {formatAmount(a.size / 1024, { maxDecimals: 1 })} KB
                  </span>
                  <HashChip value={a.hash} label="hash" />
                </li>
              )
            })}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2 text-[0.78rem] text-ink-3">
          <HashChip value={e.contentHash} label="content" />
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
              Evidence package
            </a>
          ) : (
            <span className="untrusted">{e.uri}</span>
          )}
        </div>
      </div>
    </article>
  )
}

export function EvidenceFeed({ claim, evidence }: { claim: ClaimDetail; evidence: Evidence[] }) {
  const sorted = [...evidence].sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
  const canSubmit = claim.status === 'open'
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Note tone="boundary" className="max-w-[70ch] flex-1">
          {COPY.untrustedContent}
        </Note>
        {canSubmit && (
          <ButtonLink href={`/claims/${claim.id}/evidence`} icon={<Plus size={16} aria-hidden />}>
            Submit evidence
          </ButtonLink>
        )}
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          title="No evidence submitted yet"
          body={
            canSubmit
              ? 'Nobody has filed a counterexample, rebuttal or clarification for this claim. The Investigate tab has the reproduction command and admissibility rules.'
              : 'No evidence was filed for this claim.'
          }
          action={
            canSubmit ? (
              <ButtonLink href={`/claims/${claim.id}/evidence`} icon={<Plus size={16} aria-hidden />}>
                Submit evidence
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        sorted.map((e) => <EvidenceCard key={e.id} e={e} deadline={claim.evidenceDeadline} />)
      )}
      <p className="text-[0.8rem] text-ink-3">{COPY.lateEvidence}</p>
      {!canSubmit && claim.status !== 'publishing' && claim.status !== 'failed' && (
        <p className="text-[0.8rem] text-ink-3">
          The evidence window has closed. <Link href="/board" className="underline underline-offset-2">Find an open claim</Link>.
        </p>
      )}
    </div>
  )
}
