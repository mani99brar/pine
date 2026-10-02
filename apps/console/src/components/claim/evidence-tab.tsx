'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChevronRight, FileUp, Paperclip, ShieldAlert } from 'lucide-react'
import type { ClaimDetail, Evidence } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { explorerAddressUrl, explorerTxUrl, formatDate, shortHash } from '@pine/core'
import { useEvidence, usePine } from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { CodeBlock } from '@/components/ui/code-block'
import { EmptyState } from '@/components/ui/empty-state'
import { ExternalLink } from '@/components/ui/external-link'
import { HashChip } from '@/components/ui/hash-chip'
import { PlainText } from '@/components/ui/safe-markdown'
import { SkeletonRows } from '@/components/ui/skeleton'

const KIND_LABEL: Record<Evidence['kind'], string> = {
  counterexample: 'Counterexample',
  rebuttal: 'Rebuttal',
  clarification: 'Clarification',
  commitment: 'Commitment',
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function EvidenceItem({ e, defaultOpen }: { e: Evidence; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(!!defaultOpen)
  const { storage } = usePine()
  const bodyId = React.useId()
  return (
    <article className="min-w-0 border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left hover:bg-frost sm:px-6"
      >
        <ChevronRight size={14} aria-hidden className={cn('mt-1 shrink-0 text-faint transition-transform', open && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                'stretch-cond rounded-chip border px-1.5 text-[11.5px] font-medium',
                e.kind === 'counterexample' && 'border-flare/40 text-flare',
                e.kind === 'rebuttal' && 'border-slate/40 text-slate',
                e.kind === 'clarification' && 'border-line-strong text-muted',
                e.kind === 'commitment' && 'border-violet/40 text-violet',
              )}
            >
              {KIND_LABEL[e.kind]}
            </span>
            {e.timely ? (
              <span className="text-[11.5px] text-muted">timely</span>
            ) : (
              <span className="rounded-chip bg-resin-soft px-1.5 text-[11.5px] font-medium text-resin" title={COPY.lateEvidence}>
                late: after deadline
              </span>
            )}
            {e.commitment ? (
              <span className="text-[11.5px] text-muted">{e.commitment.revealed ? 'revealed' : 'awaiting reveal'}</span>
            ) : null}
          </div>
          <h3 className="wrap-anywhere mt-1 line-clamp-2 text-[14px] font-medium leading-snug">{e.title}</h3>
          <p className="mt-0.5 text-[12px] text-muted">
            <span className="mono-cond text-[11px]">{shortHash(e.submitter)}</span>
            <span className="mx-1.5 text-faint">/</span>
            block {e.blockNumber.toLocaleString('en-US')}
            <span className="mx-1.5 text-faint">/</span>
            <span className="tnum">{formatDate(e.submittedAt, 'utc')}</span>
          </p>
        </div>
      </button>
      {open ? (
        <div id={bodyId} className="space-y-4 px-4 pb-5 pl-11 sm:px-6 sm:pl-[52px]">
          <div className="min-w-0 overflow-hidden rounded-ctl border border-dashed border-line-strong">
            <p className="flex items-center gap-1.5 border-b border-dashed border-line-strong bg-sunken px-3 py-1 text-[11.5px] text-muted">
              <ShieldAlert size={12} aria-hidden /> Submitted text, shown as plain text
            </p>
            <div className="max-h-[360px] overflow-y-auto px-3 py-2.5">
              <PlainText className="text-[13.5px] leading-[1.6]">{e.summary}</PlainText>
            </div>
          </div>
          {e.reproduction ? (
            <div className="space-y-3">
              <CodeBlock code={e.reproduction.command} label="Reproduction command (run only in an isolated sandbox)" prompt />
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0 rounded-ctl border border-line px-3 py-2">
                  <p className="stretch-cond text-[12px] text-muted">Expected</p>
                  <PlainText className="mono-cond mt-0.5 text-[12px]">{e.reproduction.expected}</PlainText>
                </div>
                <div className="min-w-0 rounded-ctl border border-flare/30 bg-flare-soft/40 px-3 py-2">
                  <p className="stretch-cond text-[12px] text-muted">Actual</p>
                  <PlainText className="mono-cond mt-0.5 text-[12px]">{e.reproduction.actual}</PlainText>
                </div>
              </div>
              <p className="text-[12.5px] text-muted">
                Environment: <span className="mono-cond wrap-anywhere text-[11.5px] text-bark">{e.reproduction.environment}</span>
              </p>
              {e.reproduction.steps?.length ? (
                <ol className="list-decimal space-y-1 pl-5 text-[13px]">
                  {e.reproduction.steps.map((s, i) => (
                    <li key={i}>
                      <PlainText>{s}</PlainText>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
          {e.attachments.length ? (
            <ul className="divide-y divide-line rounded-ctl border border-line">
              {e.attachments.map((a) => (
                <li key={a.hash} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]">
                  <Paperclip size={13} aria-hidden className="shrink-0 text-faint" />
                  <span className="wrap-anywhere min-w-0 flex-1">{a.name}</span>
                  <span className="text-muted">
                    {a.mime}, {fmtSize(a.size)}
                  </span>
                  <HashChip value={a.hash} label="sha" />
                  <ExternalLink href={storage.gatewayUrl(a.uri)}>Open</ExternalLink>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <HashChip label="content" value={e.contentHash} />
            {e.commitment ? <HashChip label="commitment" value={e.commitment.hash} /> : null}
            <ExternalLink href={explorerTxUrl(e.chainId, e.txHash)} className="text-[12.5px]">
              Submission tx
            </ExternalLink>
            <ExternalLink href={explorerAddressUrl(e.chainId, e.submitter)} className="text-[12.5px]">
              Submitter
            </ExternalLink>
            <ExternalLink href={storage.gatewayUrl(e.uri)} className="text-[12.5px]">
              Evidence package
            </ExternalLink>
          </div>
        </div>
      ) : null}
    </article>
  )
}

export function EvidenceTab({ claim }: { claim: ClaimDetail }) {
  const q = useEvidence(claim.id)
  const items = q.data ?? claim.evidence
  const open = claim.status === 'open'
  const sorted = [...items].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))
  const firstCounter = sorted.find((e) => e.kind === 'counterexample')?.id
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <p className="min-w-0 flex-1 text-[13px] text-muted">
          {items.length} submission{items.length === 1 ? '' : 's'}, ordered by block time. Timeliness is judged by block timestamp against the evidence deadline.
        </p>
        {open ? (
          <Button asChild variant="primary" size="sm" kbd="e">
            <Link href={`/claims/${claim.id}/evidence/new`}>
              <FileUp size={13} aria-hidden /> Submit evidence
            </Link>
          </Button>
        ) : (
          <span className="text-[12.5px] text-muted">Evidence window closed. {COPY.lateEvidence}</span>
        )}
      </div>
      <div className="px-4 pt-3 sm:px-6">
        <Callout tone="warning">{COPY.untrustedContent}</Callout>
      </div>
      {q.isLoading && !items.length ? (
        <SkeletonRows rows={3} />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No evidence submitted yet"
          action={
            open ? (
              <Button asChild variant="secondary">
                <Link href={`/claims/${claim.id}/evidence/new`}>Submit the first counterexample</Link>
              </Button>
            ) : undefined
          }
        >
          {open
            ? 'Investigators submit counterexamples through the evidence channel before the deadline. Copy the agent brief to brief an automated investigator.'
            : 'Nothing was submitted before the deadline.'}
        </EmptyState>
      ) : (
        <div className="mt-3 border-t border-line">
          {sorted.map((e) => (
            <EvidenceItem key={e.id} e={e} defaultOpen={e.id === firstCounter} />
          ))}
        </div>
      )}
      <p className="px-4 py-4 text-xs text-muted sm:px-6">{COPY.evidenceIsNotPayment}</p>
    </div>
  )
}
