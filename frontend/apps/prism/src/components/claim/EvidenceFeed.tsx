'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDetail, Evidence } from '@pine/core'
import { explorerAddressUrl, explorerTxUrl, formatAmount, formatDate, shortHash } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import type { ApiEvidenceFacts } from '@pine/data'
import { useEvidence } from '@pine/react'
import { AlertTriangle, Download, FileWarning, Lock, ShieldAlert } from 'lucide-react'
import { SafeMarkdown } from '@/components/ui/SafeMarkdown'
import { Expandable, HashChip } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { ButtonLink } from '@/components/ui/Button'
import { apiEvidenceFactsOf, apiFactsOf, isoOfUnix, userContentUrl } from '@/lib/claims'
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

const API_STATUS: Record<ApiEvidenceFacts['status'], { label: string; color: string }> = {
  committed: { label: 'Sealed commitment', color: 'var(--ca)' },
  revealed: { label: 'Revealed evidence', color: 'var(--ha)' },
  published: { label: 'Published evidence', color: 'var(--ha)' },
}

const MANIFEST_TAG: Partial<Record<ApiEvidenceFacts['manifest'], string>> = {
  withheld: 'Withheld by moderation',
  unavailable: 'Not stored by Pine',
  unreadable: 'Unreadable manifest',
}

/** Timeliness under the frozen operators: recorded before the evidence deadline, disclosed before the reveal deadline. */
function apiTimeliness(api: ApiEvidenceFacts, revealDeadline: string | null): { text: string; late: boolean }[] {
  const t = api.timeliness
  const out = [
    t.recordedBeforeEvidenceDeadline ? { text: 'Recorded before the evidence deadline', late: false } : { text: 'Recorded after the evidence deadline: does not count', late: true },
  ]
  if (api.status === 'committed') {
    if (t.recordedBeforeEvidenceDeadline) out.push({ text: revealDeadline ? `Not revealed yet: counts only if revealed before ${formatDate(revealDeadline, 'utc')}` : 'Not revealed yet', late: false })
  } else if (api.status === 'revealed' && t.disclosedBeforeRevealDeadline !== null) {
    out.push(t.disclosedBeforeRevealDeadline ? { text: 'Revealed before the reveal deadline', late: false } : { text: 'Revealed after the reveal deadline: does not count', late: true })
  }
  return out
}

function DownloadLink({ href, children }: { href: string; children: React.ReactNode }) {
  // A link only: the file is served as an attachment from Pine's user-content domain and never fetched by this page.
  return (
    <a className="link inline-flex items-center gap-1.5 text-lumen-2" href={href} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" download>
      <Download size={13} aria-hidden /> {children}
    </a>
  )
}

function EvidenceItem({ e, claim }: { e: Evidence; claim: ClaimDetail }) {
  const [raw, setRaw] = useState(false)
  const api = apiEvidenceFactsOf(e)
  const claimApi = apiFactsOf(claim)
  const k = api ? API_STATUS[api.status] : KIND[e.kind]
  const chain = getChainOrDefault(e.chainId)
  const revealDeadline = claimApi ? isoOfUnix(claimApi.revealDeadline) : null
  const timeliness = api ? apiTimeliness(api, revealDeadline) : [{ text: e.timely ? 'Filed before the deadline' : 'Filed after the deadline: does not count', late: !e.timely }]
  const manifestTag = api ? MANIFEST_TAG[api.manifest] : undefined
  const manifestUrl = api && api.stored && (api.manifest === 'shown' || api.manifest === 'unreadable') ? userContentUrl(claim, e.contentHash) : null
  const attribution = api?.attribution
  return (
    <li className="glass cut-lg relative overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: k.color, boxShadow: `0 0 18px ${k.color}` }} />
      <div className="p-5 pl-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tag" style={{ color: k.color, borderColor: `color-mix(in oklab, ${k.color} 40%, transparent)` }}>
            {k.label}
          </span>
          {manifestTag && <span className="tag text-lumen-2">{manifestTag}</span>}
          {timeliness.map((t) => (
            <span key={t.text} className={cn('tag', t.late && 'border-[rgba(255,182,72,0.5)] text-na')}>
              {t.text}
            </span>
          ))}
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
            {api ? 'Recorded' : 'Transaction'} on {chain.name}, block {formatAmount(e.blockNumber, { maxDecimals: 0 })}
          </a>
          {api?.revealedAt && <span>revealed {formatDate(api.revealedAt, 'utc')}</span>}
        </p>
        {attribution && (!attribution.submitterMatches || !attribution.claimMatches) && (
          <p className="mt-2 flex items-start gap-2 text-[0.84375rem] text-na">
            <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
            {!attribution.submitterMatches && !attribution.claimMatches
              ? 'The manifest names another submitter and another claim.'
              : !attribution.submitterMatches
                ? 'The manifest names a different submitter than the wallet that recorded it.'
                : 'The manifest names a different claim than this market.'}
          </p>
        )}

        {api && e.kind === 'commitment' && e.commitment ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[0.875rem] text-lumen-2">
            <Lock size={15} aria-hidden className="text-ca" />
            <HashChip value={e.commitment.hash} label="Commitment" />
          </div>
        ) : e.kind === 'commitment' && e.commitment ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-[0.875rem] text-lumen-2">
            <Lock size={15} aria-hidden className="text-ca" />
            {e.commitment.revealed ? `Revealed ${e.commitment.revealedAt ? formatDate(e.commitment.revealedAt, 'utc') : ''}` : 'Not revealed yet. Only the hash of the package is on-chain.'}
            <HashChip value={e.commitment.hash} label="Commitment" />
          </div>
        ) : null}

        {api && api.manifest !== 'shown' ? (
          // Pine's own explanation of why there is no content to show (not the submitter's text).
          e.summary && <p className="mt-3 max-w-[82ch] text-[0.9375rem] text-lumen-2">{e.summary}</p>
        ) : e.summary && (
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
              {e.attachments.map((a, i) => {
                const href = api ? userContentUrl(claim, a.hash) : null
                return (
                  <li key={i} className="cut-sm flex flex-wrap items-center gap-x-3 gap-y-1 border border-edge bg-void px-3 py-2 text-[0.8125rem]">
                    <FileWarning size={14} aria-hidden className="text-lumen-3" />
                    <span className="untrusted min-w-0 flex-1 text-lumen-2">{a.name}</span>
                    <span className="text-lumen-3">{a.mime}</span>
                    <span className="tnum text-lumen-3">{bytes(a.size)}</span>
                    <HashChip value={a.hash} label="Hash" />
                    {href && <DownloadLink href={href}>Download</DownloadLink>}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {api && api.manifest !== 'sealed' && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.8125rem]">
            <HashChip value={e.contentHash} label="Content" />
            {manifestUrl && <DownloadLink href={manifestUrl}>Download the evidence manifest</DownloadLink>}
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
  const api = apiFactsOf(claim)
  // Backend claims: new evidence only while the evidence window is open; sealed evidence is revealed until the reveal
  // deadline (from the evidence page, where this browser keeps the salts).
  const canSubmit = api
    ? api.phase === 'evidence_open' && !api.hidden
    : claim.status === 'open' || claim.status === 'awaiting_answer' || claim.status === 'answer_proposed' || claim.status === 'disputed' || claim.status === 'arbitration'
  const canReveal = api ? (api.phase === 'evidence_open' || api.phase === 'reveal_open') && !api.hidden : false
  const open = api ? api.phase === 'evidence_open' : claim.status === 'open'
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[64ch] text-[0.9375rem] text-lumen-2">
          {api ? (
            <>
              Evidence is recorded in Pine&apos;s evidence registry on Gnosis, sealed (a hash now, the content at the reveal) or published at once. The block timestamp is the proof of timeliness. {COPY.evidenceIsNotPayment}
            </>
          ) : (
            <>Evidence is filed on Ethereum through the Kleros arbitration contract. The block timestamp is the proof of timeliness. {COPY.evidenceIsNotPayment}</>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {canSubmit && (
            <ButtonLink href={`/claims/${claim.id}/evidence`} variant={open ? 'light' : 'glass'}>
              Submit evidence
            </ButtonLink>
          )}
          {canReveal && !canSubmit && (
            <ButtonLink href={`/claims/${claim.id}/evidence#sealed`} variant="light">
              Reveal sealed evidence
            </ButtonLink>
          )}
        </div>
      </div>
      {q.isError && !items.length ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isLoading && !items.length ? (
        <LoadingBlock lines={4} />
      ) : sorted.length === 0 ? (
        <EmptyState title="No evidence yet">
          {open ? (
            <>
              {api ? 'Nobody has recorded evidence. Anyone can commit or publish it until the evidence deadline.' : 'Nobody has filed a counterexample. Anyone can, until the deadline.'}{' '}
              <Link className="link" href={`/claims/${claim.id}/evidence`}>
                Submit evidence
              </Link>
            </>
          ) : (
            'No evidence was recorded for this claim.'
          )}
        </EmptyState>
      ) : (
        <ol className="grid gap-4">
          {sorted.map((e) => (
            <EvidenceItem key={e.id} e={e} claim={claim} />
          ))}
        </ol>
      )}
    </div>
  )
}
