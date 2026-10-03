'use client'

import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatDate, nextBond, REALITY_ANSWER_LABEL, shortHash, explorerTxUrl } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { Scale } from 'lucide-react'
import { countdown } from '@/lib/claims'
import { useNowMs } from '@/lib/hooks'
import { cn } from '@/lib/cn'

const answerColor = (a?: string) => (a === 'yes' ? 'var(--ha)' : a === 'no' ? 'var(--moon)' : a === 'invalid' ? 'var(--frost)' : 'var(--na)')

/**
 * From deadline to final answer: Reality.eth answers with escalating bonds (fixed 3.5-day timeout),
 * then Kleros arbitration on Ethereum, paid in ETH.
 */
export function OraclePanel({ claim }: { claim: ClaimDetail }) {
  const now = useNowMs()
  const o = claim.oracle
  const chain = getChainOrDefault(claim.chainId)
  const arb = chain.arbitration
  const spec = claim.manifest.claim.oracle
  const bondToken = o?.bondToken ?? spec.bondToken
  const minBond = o?.minBond ?? spec.minBond
  const history = o?.history ?? []
  const maxBond = Math.max(Number(minBond) || 1, ...history.map((h) => Number(h.bond) || 0))

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Lens 1: Reality.eth */}
      <section className="glass cut-lg p-5 lg:col-span-2" aria-labelledby="reality-title">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 id="reality-title" className="t-h4">
            Reality.eth answers
          </h3>
          {o?.realityUrl && (
            <a href={o.realityUrl} target="_blank" rel="noopener noreferrer nofollow" className="link text-[0.84375rem] text-lumen-2">
              Open the question on Reality.eth
            </a>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.75rem] text-lumen-3">Opens</dt>
            <dd className="mt-0.5 text-[0.875rem] text-lumen">{formatDate(o?.openingTime ?? spec.openingTime, 'short')}</dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.75rem] text-lumen-3">Timeout per answer</dt>
            <dd className="mt-0.5 text-[0.875rem] text-lumen">3.5 days, fixed</dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.75rem] text-lumen-3">Minimum bond</dt>
            <dd className="tnum mt-0.5 text-[0.875rem] text-lumen">
              {formatAmount(minBond)} {bondToken}
            </dd>
          </div>
          <div className="cut-sm border border-edge bg-void px-3 py-2.5">
            <dt className="text-[0.75rem] text-lumen-3">Current answer</dt>
            <dd className="mt-0.5 text-[0.875rem] font-semibold" style={{ color: o?.currentAnswer ? answerColor(o.currentAnswer) : undefined }}>
              {o?.currentAnswer ? REALITY_ANSWER_LABEL[o.currentAnswer] : 'None yet'}
            </dd>
          </div>
        </dl>

        {o?.currentAnswer && !o.isFinalized && o.finalizesAt && (
          <p className="mt-4 text-[0.9375rem] text-lumen-2">
            Final in <span className="tnum font-semibold text-lumen">{now ? countdown(o.finalizesAt, now) : formatDate(o.finalizesAt, 'utc')}</span> unless someone challenges with at least{' '}
            <span className="tnum font-semibold text-lumen">
              {formatAmount(nextBond(o.currentBond, minBond))} {bondToken}
            </span>
            .
          </p>
        )}
        {o?.isFinalized && (
          <p className="mt-4 text-[0.9375rem] text-lumen-2">
            Finalized{o.finalAnswer ? ` as ${REALITY_ANSWER_LABEL[o.finalAnswer]}` : ''}. {o.finalAnswer === 'too_soon' ? COPY.answeredTooSoon : ''}
          </p>
        )}

        <h4 className="mt-6 text-[0.875rem] font-semibold text-lumen">Bond ladder</h4>
        {history.length === 0 ? (
          <p className="mt-2 text-[0.875rem] text-lumen-3">No answers posted. {claim.status === 'open' ? 'Answers are accepted once the oracle opens after the evidence deadline.' : COPY.unanswered}</p>
        ) : (
          <ol className="mt-3 grid gap-2">
            {history.map((h, i) => (
              <li key={`${h.txHash}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <div className="h-2 overflow-hidden rounded-full bg-void">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(6, ((Number(h.bond) || 0) / maxBond) * 100)}%`, background: answerColor(h.answer), opacity: h.answer === 'no' ? 0.7 : 0.95 }} />
                  </div>
                  <p className="mt-1 text-[0.8125rem] text-lumen-3">
                    <span className="font-semibold" style={{ color: answerColor(h.answer) }}>
                      {REALITY_ANSWER_LABEL[h.answer]}
                    </span>{' '}
                    by <span className="t-code">{shortHash(h.answerer)}</span>, {formatDate(h.at, 'short')}{' '}
                    <a className="link" href={explorerTxUrl(o?.chainId ?? claim.chainId, h.txHash)} target="_blank" rel="noopener noreferrer nofollow">
                      transaction
                    </a>
                  </p>
                </div>
                <p className="tnum text-right text-[0.9375rem] text-lumen">
                  {formatAmount(h.bond)} <span className="text-lumen-3">{bondToken}</span>
                </p>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-4 text-[0.78rem] text-lumen-3">{COPY.oracleActors}</p>
      </section>

      {/* Lens 2: Kleros */}
      <section className={cn('glass cut-lg p-5', o?.arbitration.requested && 'border-[rgba(255,107,131,0.35)]')} aria-labelledby="kleros-title">
        <h3 id="kleros-title" className="t-h4 flex items-center gap-2">
          <Scale size={16} aria-hidden className="text-ca" /> Kleros arbitration
        </h3>
        <p className="mt-2 text-[0.875rem] text-lumen-2">
          {o?.arbitration.requested
            ? o.arbitration.status === 'ruled'
              ? `Ruled${o.arbitration.ruling ? `: ${REALITY_ANSWER_LABEL[o.arbitration.ruling]}` : ''}.`
              : o.arbitration.status === 'appeal_period'
                ? 'A ruling was given and the appeal period is running.'
                : 'Jurors are reviewing the evidence.'
            : 'Not requested. Anyone can request it while an answer is pending, by paying the fee.'}
        </p>
        <dl className="mt-4 grid gap-2 text-[0.84375rem]">
          <div className="flex justify-between gap-3">
            <dt className="text-lumen-3">Fee (paid by the requester)</dt>
            <dd className="tnum text-right text-lumen">
              {o?.arbitration.requested ? o.arbitration.cost : `about ${arb.feeEstimate}`} {arb.feeCurrency} on Ethereum
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-lumen-3">First ruling</dt>
            <dd className="text-right text-lumen">about {arb.typicalRulingDays} days</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-lumen-3">Each appeal</dt>
            <dd className="text-right text-lumen">about {arb.typicalAppealDays} more days</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-lumen-3">Court</dt>
            <dd className="text-right text-lumen">
              {o?.arbitration.court ?? arb.courtName}, {arb.jurors} jurors
            </dd>
          </div>
          {o?.arbitration.disputeId && (
            <div className="flex justify-between gap-3">
              <dt className="text-lumen-3">Dispute</dt>
              <dd className="tnum text-right text-lumen">#{o.arbitration.disputeId}</dd>
            </div>
          )}
          {o?.arbitration.appealDeadline && (
            <div className="flex justify-between gap-3">
              <dt className="text-lumen-3">Appeal deadline</dt>
              <dd className="tnum text-right text-na">{now ? countdown(o.arbitration.appealDeadline, now) : formatDate(o.arbitration.appealDeadline, 'utc')}</dd>
            </div>
          )}
        </dl>
        {o?.arbitration.klerosUrl && (
          <a href={o.arbitration.klerosUrl} target="_blank" rel="noopener noreferrer nofollow" className="btn btn-glass btn-sm mt-4">
            Open the case on Kleros
          </a>
        )}
        <p className="mt-4 text-[0.78rem] text-lumen-3">{COPY.arbitrationOnEthereum} {arb.bridgeDelayNote ?? ''}</p>
      </section>
    </div>
  )
}
