'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDetail, Evidence } from '@pine/core'
import { explorerAddressUrl, explorerTxUrl, formatAmount, formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useEvidence } from '@pine/react'
import { FileWarning, Lock, ShieldAlert } from 'lucide-react'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { Expandable, HashChip } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { ButtonLink } from '@/components/ui/Button'
import { cn } from '@/lib/cn'

const KIND: Record<Evidence['kind'], { label: string; color: string }> = {
  counterexample: { label: 'Counterexample', color: 'var(--ha)' },
  rebuttal: { label: 'Rebuttal', color: 'var(--moon)' },
  clarification: { label: 'Clarification', color: 'var(--hb)' },
  commitment: { label: 'Commitment (hash only)', color: 'var(--ca)' },
}

function bytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} kB`
  return `${n} B`
}

function EvidenceItem({ e }: { e: Evidence }) {
  const [raw, setRaw] = useState(false)
  const k = KIND[e.kind]
  return (
    <li className="glass cut-lg relative overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: k.color, boxShadow: `0 0 18px ${k.color}` }} />
      <div className="p-5 pl-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tag" style={{ color: k.color, borderColor: `color-mix(in oklab, ${k.color} 40%, transparent)` }}>
            {k.label}
          </span>
          <span className={cn('tag', e.timely ? '' : 'border-[rgba(255,182,72,0.5)] text-na')}>{e.timely ? 'Filed before the deadline' : 'Filed after the deadline: does not count'}</span>
          <span className="text-[0.8125rem] text-lumen-3">{formatDate(e.submittedAt, 'utc')}</span>
        </div>
        {/* Title is untrusted text: rendered as a text node, never as markup. */}
        <h4 className="untrusted mt-3 font-sans text-[1.0625rem] font-semibold leading-snug text-lumen [font-variation-settings:normal]">{e.title}</h4>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem] text-lumen-3">
          <span>
            By{' '}
            <a className="t-code link text-lumen-2" href={explorerAddressUrl(e.chainId, e.submitter)} target="_blank" rel="noopener noreferrer nofollow">
              {shortHash(e.submitter)}
            </a>
          </span>
          <a className="link" href={explorerTxUrl(e.chainId, e.txHash)} target="_blank" rel="noopener noreferrer nofollow">
            Transaction on {e.chainId === 1 ? 'Ethereum' : `chain ${e.chainId}`}, block {formatAmount(e.blockNumber, { maxDecimals: 0 })}
          </a>
        </p>

        {e.kind === 'commitment' && e.commitment ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[0.875rem] text-lumen-2">
            <Lock size={15} aria-hidden className="text-ca" />
            {e.commitment.revealed ? `Revealed ${e.commitment.revealedAt ? formatDate(e.commitment.revealedAt, 'utc') : ''}` : 'Not revealed yet. Only the hash of the package is on-chain.'}
            <HashChip value={e.commitment.hash} label="Commitment" />
          </div>
        ) : null}

        {e.summary && (
          <div className="mt-4 max-w-[82ch]">
            <Expandable collapsedHeight={150} label="Show the full submission">
              {raw ? <pre className="t-code untrusted cut-sm border border-edge bg-void p-3 text-lumen-2">{e.summary}</pre> : <SafeMarkdown>{e.summary}</SafeMarkdown>}
            </Expandable>
            <button type="button" className="link mt-1 text-[0.78rem] text-lumen-3" onClick={() => setRaw((v) => !v)} aria-pressed={raw}>
              {raw ? 'Show formatted (sanitized)' : 'Show raw text'}
            </button>
          </div>
        )}

        {e.reproduction && (
          <div className="cut-md well mt-4 max-w-[82ch] p-4">
            <p className="text-[0.8125rem] font-semibold text-lumen">Reproduction (do not run outside an isolated environment)</p>
            <dl className="mt-3 grid gap-3 text-[0.84375rem]">
              {(
                [
                  ['Command', e.reproduction.command, true],
                  ['Environment', e.reproduction.environment, false],
                  ['Expected', e.reproduction.expected, false],
                  ['Actual', e.reproduction.actual, false],
                ] as const
              ).map(([label, value, mono]) =>
                value ? (
                  <div key={label} className="grid gap-1 sm:grid-cols-[7rem_1fr]">
                    <dt className="text-lumen-3">{label}</dt>
                    <dd className={cn('untrusted min-w-0 text-lumen-2', mono && 't-code')}>{value}</dd>
                  </div>
                ) : null,
              )}
              {e.reproduction.steps && e.reproduction.steps.length > 0 && (
                <div className="grid gap-1 sm:grid-cols-[7rem_1fr]">
                  <dt className="text-lumen-3">Steps</dt>
                  <dd className="min-w-0">
                    <ol className="list-decimal pl-5 text-lumen-2">
                      {e.reproduction.steps.map((s, i) => (
                        <li key={i} className="untrusted">
                          {s}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        {e.attachments.length > 0 && (
          <div className="mt-4">
            <p className="text-[0.8125rem] font-semibold text-lumen">Attachments (listed, not opened)</p>
            <ul className="mt-2 grid gap-2">
              {e.attachments.map((a, i) => (
                <li key={i} className="cut-sm flex flex-wrap items-center gap-x-3 gap-y-1 border border-edge bg-void px-3 py-2 text-[0.8125rem]">
                  <FileWarning size={14} aria-hidden className="text-lumen-3" />
                  <span className="untrusted min-w-0 flex-1 text-lumen-2">{a.name}</span>
                  <span className="text-lumen-3">{a.mime}</span>
                  <span className="tnum text-lumen-3">{bytes(a.size)}</span>
                  <HashChip value={a.hash} label="Hash" />
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-4 flex items-start gap-2 text-[0.78rem] text-lumen-3">
          <ShieldAlert size={13} aria-hidden className="mt-0.5 shrink-0" /> {COPY.untrustedContent}
        </p>
      </div>
    </li>
  )
}

export function EvidenceFeed({ claim }: { claim: ClaimDetail }) {
  const q = useEvidence(claim.id)
  const items = q.data ?? claim.evidence
  const sorted = [...items].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt))
  const canSubmit = claim.status === 'open' || claim.status === 'awaiting_answer' || claim.status === 'answer_proposed' || claim.status === 'disputed' || claim.status === 'arbitration'
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[60ch] text-[0.9375rem] text-lumen-2">
          Evidence is filed on Ethereum through the Kleros arbitration contract. The block timestamp is the proof of timeliness. {COPY.evidenceIsNotPayment}
        </p>
        {canSubmit && (
          <ButtonLink href={`/claims/${claim.id}/evidence`} variant={claim.status === 'open' ? 'light' : 'glass'}>
            Submit evidence
          </ButtonLink>
        )}
      </div>
      {q.isError && !items.length ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading && !items.length ? (
        <LoadingBlock lines={4} />
      ) : sorted.length === 0 ? (
        <EmptyState title="No evidence yet">
          {claim.status === 'open' ? (
            <>
              Nobody has filed a counterexample. Anyone can, until the deadline.{' '}
              <Link className="link" href={`/claims/${claim.id}/evidence`}>
                Submit evidence
              </Link>
            </>
          ) : (
            'No evidence was filed for this claim.'
          )}
        </EmptyState>
      ) : (
        <ol className="grid gap-4">
          {sorted.map((e) => (
            <EvidenceItem key={e.id} e={e} />
          ))}
        </ol>
      )}
    </div>
  )
}
