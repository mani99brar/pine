import type { Evidence } from '@pine/core'
import { explorerTxUrl, formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { Clock, Lock, LockOpen, Paperclip, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { HashValue } from '@/components/ui/copy'
import { ExternalLink } from '@/components/ui/external-link'
import { SafeMarkdown } from '@/components/ui/safe-markdown'

export function exhibitLetter(i: number): string {
  // A…Z, then AA, AB…
  let n = i
  let s = ''
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

const KIND_LABEL: Record<Evidence['kind'], string> = {
  counterexample: 'Counterexample',
  rebuttal: 'Rebuttal',
  clarification: 'Clarification',
  commitment: 'Sealed commitment',
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Clamp a string for display: untrusted content can be enormous. */
function clamp(s: string | undefined, max: number): string {
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters not shown]` : s
}

export function Exhibit({ evidence: e, index, gatewayUrl }: { evidence: Evidence; index: number; gatewayUrl?: (uri: string) => string }) {
  const letter = exhibitLetter(index)
  const isCommit = e.kind === 'commitment'
  return (
    <article
      id={`exhibit-${letter.toLowerCase()}`}
      aria-labelledby={`exhibit-${letter.toLowerCase()}-title`}
      className="print-avoid-break grid border border-rule bg-sheet sm:grid-cols-[5.5rem_minmax(0,1fr)]"
      data-print="flat"
    >
      <div
        className={cn(
          'flex items-center gap-3 border-b border-rule px-4 py-3 sm:flex-col sm:items-center sm:justify-start sm:border-r sm:border-b-0 sm:px-2 sm:py-5',
          e.kind === 'counterexample' ? 'bg-red-wash' : 'bg-bond',
        )}
      >
        <span className="text-sm font-bold text-graphite">Exhibit</span>
        <span className="record-title text-[2.4rem] leading-none text-ink">{letter}</span>
      </div>

      <div className="min-w-0 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-xs border px-1.5 py-px font-bold',
              e.kind === 'counterexample' ? 'border-red-line bg-red-wash text-red' : 'border-rule bg-bond text-graphite',
            )}
          >
            {isCommit ? <Lock aria-hidden className="size-3.5" /> : null}
            {KIND_LABEL[e.kind]}
          </span>
          {e.timely ? (
            <span className="inline-flex items-center gap-1 font-bold text-ink">
              <Clock aria-hidden className="size-3.5" /> Filed before the deadline
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-xs bg-wheat px-1.5 py-px font-bold text-ochre">
              <Clock aria-hidden className="size-3.5" /> Filed after the deadline: not timely
            </span>
          )}
        </div>

        <h3 id={`exhibit-${letter.toLowerCase()}-title`} className="record-title untrusted mt-3 text-xl leading-8">
          {clamp(e.title, 240) || 'Untitled exhibit'}
        </h3>

        <p className="mt-2 text-sm text-graphite">
          Filed <time dateTime={e.submittedAt}>{formatDate(e.submittedAt, 'long')}</time> in block{' '}
          <span className="tabular">{e.blockNumber.toLocaleString('en-US')}</span> by{' '}
          <code className="font-mono text-[13px] text-ink">{shortHash(e.submitter, 4)}</code>.{' '}
          <ExternalLink href={explorerTxUrl(e.chainId, e.txHash)}>Transaction</ExternalLink>
        </p>

        <div className="mt-4 flex gap-2 border-l-4 border-wheat-line bg-flag-wash px-3 py-2 text-sm text-ink">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-ochre" />
          <p>{COPY.untrustedContent}</p>
        </div>

        {isCommit && e.commitment ? (
          <div className="mt-4 text-[15px]">
            <p className="flex items-center gap-2 font-bold">
              {e.commitment.revealed ? <LockOpen aria-hidden className="size-4" /> : <Lock aria-hidden className="size-4" />}
              {e.commitment.revealed
                ? `Revealed ${e.commitment.revealedAt ? formatDate(e.commitment.revealedAt, 'long') : ''}`
                : 'Sealed: only the hash is public until the investigator reveals it'}
            </p>
            <p className="mt-1 text-sm text-graphite">
              The commitment&rsquo;s block time proves when it was filed, without exposing the counterexample to front-running.
              Commit and reveal is a launch gate: its rules are not final.
            </p>
            <p className="mt-2 text-sm">
              Commitment hash: <HashValue value={e.commitment.hash} display={shortHash(e.commitment.hash, 10)} label="commitment hash" />
            </p>
          </div>
        ) : null}

        {e.summary ? (
          <div className="mt-4 max-h-[26rem] overflow-y-auto border-y border-rule py-3 pr-2 measure" tabIndex={0} aria-label={`Exhibit ${letter} explanation`}>
            <SafeMarkdown>{clamp(e.summary, 6000)}</SafeMarkdown>
          </div>
        ) : null}

        {e.reproduction ? (
          <div className="mt-5">
            <h4 className="text-base font-bold">Reproduction, as submitted</h4>
            <dl className="mt-2 divide-y divide-rule border-y border-rule text-[15px]">
              <div className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
                <dt className="font-bold text-graphite">Command</dt>
                <dd className="min-w-0">
                  <pre tabIndex={0} className="untrusted max-h-48 overflow-y-auto bg-bond px-3 py-2 font-mono text-[13.5px] leading-6 whitespace-pre-wrap">
                    {clamp(e.reproduction.command, 2000)}
                  </pre>
                </dd>
              </div>
              {(['environment', 'expected', 'actual'] as const).map((k) => (
                <div key={k} className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="font-bold text-graphite">{k === 'expected' ? 'Expected behavior' : k === 'actual' ? 'Actual behavior' : 'Environment'}</dt>
                  <dd className="untrusted min-w-0 whitespace-pre-wrap">{clamp(e.reproduction?.[k], 2000)}</dd>
                </div>
              ))}
              {e.reproduction.steps && e.reproduction.steps.length > 0 ? (
                <div className="grid gap-1 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
                  <dt className="font-bold text-graphite">Steps</dt>
                  <dd className="min-w-0">
                    <ol className="list-decimal space-y-1 pl-5">
                      {e.reproduction.steps.slice(0, 30).map((s, i) => (
                        <li key={i} className="untrusted">
                          {clamp(s, 600)}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

        {e.attachments.length > 0 ? (
          <div className="mt-5">
            <h4 className="flex items-center gap-1.5 text-base font-bold">
              <Paperclip aria-hidden className="size-4" /> Attachments
            </h4>
            <ul className="mt-2 divide-y divide-rule border-y border-rule text-[15px]">
              {e.attachments.slice(0, 20).map((a, i) => (
                <li key={`${a.hash}-${i}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <span className="untrusted min-w-0">
                    {gatewayUrl ? (
                      <ExternalLink href={gatewayUrl(a.uri)}>{clamp(a.name, 120)}</ExternalLink>
                    ) : (
                      clamp(a.name, 120)
                    )}
                    <span className="ml-2 text-sm text-graphite">
                      {clamp(a.mime, 60)}, {formatBytes(a.size)}
                    </span>
                  </span>
                  <HashValue value={a.hash} display={shortHash(a.hash, 6)} label="attachment hash" className="text-sm" />
                </li>
              ))}
            </ul>
            <p className="mt-1 text-sm text-graphite">Open attachments only in an isolated environment.</p>
          </div>
        ) : null}

        <p className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-graphite">
          <span>
            Content hash <HashValue value={e.contentHash} display={shortHash(e.contentHash, 6)} label="content hash" />
          </span>
          <span className="untrusted">
            Stored at <code className="font-mono text-[13px]">{clamp(e.uri, 90)}</code>
          </span>
        </p>
      </div>
    </article>
  )
}
