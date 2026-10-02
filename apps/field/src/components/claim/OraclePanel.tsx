'use client'

import type { ClaimDetail, OracleAnswerEntry, RealityAnswer } from '@pine/core'
import { REALITY_ANSWER_LABEL, explorerAddressUrl, explorerTxUrl, formatAmount, formatDate, formatDuration, shortHash } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { Gavel, Scale } from 'lucide-react'
import { TimeRing } from '@/components/glyphs/TimeRing'
import { ExternalLink, HashChip } from '@/components/ui/interactive'
import { KV, Note } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

function answerFill(a: RealityAnswer): string {
  return a === 'yes' ? 'hatch-yes' : a === 'no' ? 'bg-cobalt' : a === 'invalid' ? 'hatch-invalid' : 'bg-sheet shadow-[inset_0_0_0_1.5px_var(--ink)]'
}

function answerText(a: RealityAnswer): string {
  if (a === 'yes') return `Yes: ${COPY.outcome.yes}`
  if (a === 'no') return `No: ${COPY.outcome.no}`
  if (a === 'invalid') return 'Invalid'
  return REALITY_ANSWER_LABEL.too_soon
}

/**
 * Bond ladder: each answer is a step, its height the bond on a doubling (log2) scale. Reading left to
 * right shows how the dispute escalated, then the arbitration step if one was requested.
 */
export function BondLadder({
  history,
  minBond,
  token,
  arbitration,
  next,
}: {
  history: OracleAnswerEntry[]
  minBond: string
  token: string
  arbitration?: { requested: boolean; cost: string; currency: string }
  /** The minimum bond for the next challenge, drawn as a dashed ghost step */
  next?: string
}) {
  const min = Math.max(Number(minBond) || 1, 1e-9)
  const levels = history.map((h) => Math.max(0, Math.log2(Math.max(Number(h.bond), min) / min)))
  const nextLevel = next ? Math.max(0, Math.log2(Math.max(Number(next), min) / min)) : undefined
  const top = Math.max(3, ...levels.map((l) => l + 1), nextLevel !== undefined ? nextLevel + 1 : 0)
  const H = 150
  return (
    <figure aria-label="Bond escalation">
      <div className="flex items-end gap-1.5 relative overflow-x-auto pb-1" style={{ minHeight: H + 64 }}>
        {history.map((h, i) => {
          const hh = Math.round(((levels[i]! + 1) / top) * H)
          return (
            <div key={`${h.txHash}-${i}`} className="flex w-[clamp(4.5rem,18%,7.5rem)] shrink-0 flex-col items-stretch">
              <p className="t-figure mb-1 text-center text-[1rem]">
                {formatAmount(h.bond, { maxDecimals: 3 })}
                <span className="ml-1 font-sans text-[0.7rem] font-[500] text-ink-3">{token}</span>
              </p>
              <div className={cn('relative rounded-t-[2px] border-t-[3px] border-ink', answerFill(h.answer))} style={{ height: hh }} />
              <p className="mt-1.5 text-center text-[0.75rem] font-[650] leading-tight">{h.answer === 'too_soon' ? 'Too soon' : REALITY_ANSWER_LABEL[h.answer]}</p>
              <p className="text-center text-[0.7rem] text-ink-3">{i === 0 ? 'first answer' : `challenge ${i}`}</p>
            </div>
          )
        })}
        {next && nextLevel !== undefined && !arbitration?.requested && (
          <div className="flex w-[clamp(4.5rem,18%,7.5rem)] shrink-0 flex-col items-stretch" aria-hidden>
            <p className="t-figure mb-1 text-center text-[1rem] text-ink-3">
              ≥{formatAmount(next, { maxDecimals: 3 })}
              <span className="ml-1 font-sans text-[0.7rem] font-[500]">{token}</span>
            </p>
            <div className="rounded-t-[2px] border-[1.5px] border-dashed border-ink-3" style={{ height: Math.round(((nextLevel + 1) / top) * H) }} />
            <p className="mt-1.5 text-center text-[0.75rem] font-[650] leading-tight text-ink-3">Next challenge</p>
            <p className="text-center text-[0.7rem] text-ink-3">any other answer</p>
          </div>
        )}
        {arbitration?.requested && (
          <div className="flex w-[clamp(4.5rem,18%,7.5rem)] shrink-0 flex-col items-stretch">
            <p className="t-figure mb-1 text-center text-[1rem]">
              {arbitration.cost}
              <span className="ml-1 font-sans text-[0.7rem] font-[500] text-ink-3">{arbitration.currency}</span>
            </p>
            <div className="flex items-center justify-center rounded-t-[2px] border-[1.5px] border-dashed border-ink bg-fog-2" style={{ height: H }}>
              <Scale size={22} aria-hidden />
            </div>
            <p className="mt-1.5 text-center text-[0.75rem] font-[650] leading-tight">Kleros</p>
            <p className="text-center text-[0.7rem] text-ink-3">arbitration fee</p>
          </div>
        )}
      </div>
      <figcaption className="sr-only">
        {history.map((h, i) => `${i === 0 ? 'First answer' : `Challenge ${i}`}: ${answerText(h.answer)} with a ${h.bond} ${token} bond.`).join(' ')}
      </figcaption>
    </figure>
  )
}

export function OraclePanel({ claim }: { claim: ClaimDetail }) {
  const now = useNowMs()
  const o = claim.oracle
  const chain = getChainOrDefault(claim.chainId)
  const arbCfg = chain.arbitration
  const l1 = getChainOrDefault(arbCfg.chainId)

  if (!o) {
    return (
      <Note title="No oracle question yet">
        The Reality.eth question is created together with the market. This claim has no market yet, so there is nothing to answer.
      </Note>
    )
  }

  const opened = now !== null && new Date(o.openingTime).getTime() <= now
  const last = o.history[o.history.length - 1]
  const nextBond = o.currentBond ? String(Number(o.currentBond) * 2) : o.minBond
  const timeout = o.timeoutSeconds || chain.seerQuestionTimeoutSeconds
  const arb = o.arbitration

  return (
    <div className="grid gap-8">
      {/* Current state */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-start">
        <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
          <h3 className="t-h3">Where the answer stands</h3>
          {o.isFinalized && o.finalAnswer ? (
            <p className="mt-3 flex items-center gap-3">
              <span aria-hidden className={cn('h-8 w-3 rounded-[1px]', answerFill(o.finalAnswer))} />
              <span>
                <span className="block font-[650]">Final: {answerText(o.finalAnswer)}</span>
                <span className="text-[0.86rem] text-ink-2">The answer is final and the market can resolve.</span>
              </span>
            </p>
          ) : last && o.currentAnswer ? (
            <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-5">
              {o.finalizesAt && !arb.requested ? <TimeRing start={last.at} end={o.finalizesAt} size={64} variant="challenge" /> : <span aria-hidden />}
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-[650]">
                  <span aria-hidden className={cn('h-4 w-2.5 rounded-[1px]', answerFill(o.currentAnswer))} />
                  Current answer: {answerText(o.currentAnswer)}
                </p>
                <p className="mt-1 text-[0.88rem] text-ink-2">
                  Backed by a <span className="t-figure text-[1rem] text-ink">{o.currentBond}</span> {o.bondToken} bond.
                  {arb.requested
                    ? ' Arbitration has been requested, so the answer is frozen until Kleros rules.'
                    : o.finalizesAt
                      ? ` It becomes final ${formatDate(o.finalizesAt, 'long')} unless someone challenges it.`
                      : ''}
                </p>
                {!arb.requested && (
                  <p className="mt-2 text-[0.86rem] text-ink-2">
                    To challenge, post a different answer with at least <span className="t-figure text-[1rem] text-ink">{formatAmount(nextBond, { maxDecimals: 4 })}</span> {o.bondToken} (double the current bond).
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[0.9rem] text-ink-2">
              {opened
                ? 'The question is open for answers. Nobody has answered yet. Anyone can post the first answer with at least the minimum bond.'
                : `Answers open ${formatDate(o.openingTime, 'long')}, after the evidence deadline.`}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.86rem]">
            <ExternalLink href={o.realityUrl}>Open on Reality.eth</ExternalLink>
            {claim.market && <ExternalLink href={claim.market.seerUrl}>Open on Seer</ExternalLink>}
          </div>
        </div>

        <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
          <h3 className="t-h3">Who acts, and what it costs</h3>
          <ul className="mt-3 space-y-2.5 text-[0.88rem] text-ink-2">
            <li>
              <span className="font-[650] text-ink">Answering:</span> anyone, with at least {o.minBond} {o.bondToken} as a bond. Pine does not post answers.
            </li>
            <li>
              <span className="font-[650] text-ink">Challenging:</span> anyone, by posting a different answer with double the bond. Each answer restarts a {formatDuration(timeout * 1000)} window.
            </li>
            <li>
              <span className="font-[650] text-ink">Arbitration:</span> anyone can escalate to {arbCfg.courtName} ({arbCfg.jurors} jurors) on {l1.name}. The requester pays about{' '}
              <span className="t-figure text-[1rem] text-ink">{arbCfg.feeEstimate}</span> {arbCfg.feeCurrency}. A first ruling takes about {arbCfg.typicalRulingDays} days, plus about{' '}
              {arbCfg.typicalAppealDays} days per appeal.
            </li>
          </ul>
          <p className="mt-3 text-[0.8rem] text-ink-3">{COPY.oracleActors} Fee observed {arbCfg.feeObservedAt}; it is read live before any request.</p>
        </div>
      </div>

      {/* Bond ladder */}
      <div className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="t-h3">Bond escalation</h3>
          <p className="text-[0.8rem] text-ink-3">Each challenge must at least double the bond. Heights use a doubling scale.</p>
        </div>
        {o.history.length === 0 ? (
          <p className="mt-4 text-[0.9rem] text-ink-2">No answers yet. The first answer needs at least {o.minBond} {o.bondToken}.</p>
        ) : (
          <div className="mt-5">
            <BondLadder
              history={o.history}
              minBond={o.minBond}
              token={o.bondToken}
              arbitration={{ requested: arb.requested, cost: arb.cost || arbCfg.feeEstimate, currency: arbCfg.feeCurrency }}
              next={!o.isFinalized && !arb.requested ? nextBond : undefined}
            />
          </div>
        )}
        {o.history.length > 0 && (
          <ol className="mt-5 divide-y divide-line border-t border-line text-[0.86rem]">
            {o.history.map((h, i) => (
              <li key={`${h.txHash}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                <span aria-hidden className={cn('h-3 w-3 rounded-[1px]', answerFill(h.answer))} />
                <span className="min-w-[10rem] font-[600]">{answerText(h.answer)}</span>
                <span className="t-figure text-[0.95rem]">
                  {h.bond} {o.bondToken}
                </span>
                <span className="text-ink-3">{formatDate(h.at, 'long')}</span>
                <a href={explorerAddressUrl(claim.chainId, h.answerer)} target="_blank" rel="noopener noreferrer nofollow" className="t-code text-[0.78rem] text-ink-2 underline-offset-2 hover:underline">
                  {shortHash(h.answerer)}
                </a>
                <a href={explorerTxUrl(claim.chainId, h.txHash)} target="_blank" rel="noopener noreferrer nofollow" className="ml-auto text-[0.8rem] underline underline-offset-2">
                  transaction
                </a>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Arbitration */}
      <div className={cn('rounded-[var(--radius-tile)] border bg-sheet p-5', arb.requested ? 'border-ink border-[1.5px]' : 'border-line')}>
        <div className="flex items-center gap-2">
          <Gavel size={18} aria-hidden />
          <h3 className="t-h3">Kleros arbitration</h3>
        </div>
        {arb.requested ? (
          <>
            <ArbitrationTrack status={arb.status} requestedAt={arb.requestedAt} appealDeadline={arb.appealDeadline} rulingDays={arbCfg.typicalRulingDays} appealDays={arbCfg.typicalAppealDays} />
            <KV
              className="mt-5"
              rows={[
                { k: 'Status', v: arb.status === 'pending' ? 'Jurors are reviewing evidence' : arb.status === 'appeal_period' ? 'Ruling given, appeal period open' : arb.status === 'ruled' ? 'Ruled' : 'Not requested' },
                ...(arb.ruling ? [{ k: 'Ruling', v: answerText(arb.ruling) }] : []),
                ...(arb.appealDeadline ? [{ k: 'Appeal deadline', v: formatDate(arb.appealDeadline, 'long') }] : []),
                { k: 'Court', v: `${arb.court ?? arbCfg.courtName} on ${l1.name}` },
                { k: 'Dispute', v: arb.disputeId ? `#${arb.disputeId}` : 'Being created' },
                { k: 'Fee paid by requester', v: `${arb.cost || arbCfg.feeEstimate} ${arbCfg.feeCurrency}` },
                ...(arb.requester ? [{ k: 'Requested by', v: <HashChip value={arb.requester} label="address" /> }] : []),
              ]}
            />
            {arb.klerosUrl && (
              <p className="mt-4 text-[0.88rem]">
                <ExternalLink href={arb.klerosUrl}>Follow the dispute on Kleros</ExternalLink>
              </p>
            )}
          </>
        ) : (
          <p className="mt-2 max-w-[70ch] text-[0.9rem] text-ink-2">
            Not requested. If an answer is contested, anyone can request arbitration on {l1.name} by paying about {arbCfg.feeEstimate} {arbCfg.feeCurrency}. A first ruling
            typically takes about {arbCfg.typicalRulingDays} days and each appeal about {arbCfg.typicalAppealDays} more.
            {arbCfg.bridgeDelayNote ? ` ${arbCfg.bridgeDelayNote}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}

/** A horizontal track of the arbitration timeline with typical durations. */
function ArbitrationTrack({
  status,
  requestedAt,
  appealDeadline,
  rulingDays,
  appealDays,
}: {
  status: string
  requestedAt?: string
  appealDeadline?: string
  rulingDays: number
  appealDays: number
}) {
  const stages = [
    { key: 'requested', label: 'Requested', sub: requestedAt ? formatDate(requestedAt, 'short') : '' },
    { key: 'pending', label: 'Evidence and vote', sub: `about ${rulingDays} days` },
    { key: 'appeal_period', label: 'Appeal window', sub: appealDeadline ? `until ${formatDate(appealDeadline, 'short')}` : `about ${appealDays} days per appeal` },
    { key: 'ruled', label: 'Ruling reported', sub: 'answer finalizes' },
  ]
  const idx = Math.max(0, stages.findIndex((s) => s.key === status))
  return (
    <ol className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Arbitration progress">
      {stages.map((s, i) => (
        <li key={s.key} aria-current={i === idx ? 'step' : undefined}>
          <span aria-hidden className={cn('block h-[6px] rounded-[1px]', i < idx ? 'bg-ink/70' : i === idx ? 'bg-ink shadow-[0_0_0_2px_var(--lumen)]' : 'border border-dashed border-line-strong')} />
          <p className={cn('mt-2 text-[0.86rem]', i === idx ? 'font-[700]' : 'font-[550] text-ink-2')}>{s.label}</p>
          <p className="text-[0.75rem] text-ink-3">{s.sub}</p>
        </li>
      ))}
    </ol>
  )
}
