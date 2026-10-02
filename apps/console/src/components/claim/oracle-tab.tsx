'use client'

import type { ClaimDetail, RealityAnswer } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { explorerAddressUrl, explorerTxUrl, formatAmount, formatDate, formatDuration, shortHash, timeRemaining } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { cn } from '@/lib/cn'
import { Callout } from '@/components/ui/callout'
import { DataList } from '@/components/ui/pane'
import { EmptyState } from '@/components/ui/empty-state'
import { ExternalLink } from '@/components/ui/external-link'
import { HashChip } from '@/components/ui/hash-chip'

const ANSWER: Record<RealityAnswer, { label: string; cls: string }> = {
  yes: { label: 'Yes (counterexample demonstrated)', cls: 'text-flare' },
  no: { label: 'No (no qualifying counterexample)', cls: 'text-slate' },
  invalid: { label: 'Invalid', cls: 'text-violet' },
  too_soon: { label: 'Answered too soon', cls: 'text-resin' },
}

export function AnswerText({ a }: { a: RealityAnswer }) {
  return <span className={cn('font-medium', ANSWER[a].cls)}>{ANSWER[a].label}</span>
}

export function OracleTab({ claim, now }: { claim: ClaimDetail; now: Date }) {
  const o = claim.oracle
  if (!o) return <EmptyState title="No oracle question yet">The Reality.eth question is created together with the market.</EmptyState>
  const chain = getChainOrDefault(o.chainId)
  const opening = timeRemaining(o.openingTime, now)
  const fin = o.finalizesAt ? timeRemaining(o.finalizesAt, now) : undefined
  const arb = o.arbitration
  const nextBond = o.currentBond ? (Number(o.currentBond) * 2).toString() : o.minBond
  return (
    <div className="divide-y divide-line">
      <section className="grid gap-px bg-line sm:grid-cols-3" aria-label="Oracle status">
        <div className="bg-surface px-4 py-3">
          <p className="text-[12.5px] text-muted">Current answer</p>
          <p className="mt-0.5 text-[15px]">{o.currentAnswer ? <AnswerText a={o.currentAnswer} /> : <span className="text-muted">None posted</span>}</p>
          {o.currentBond ? <p className="tnum text-xs text-muted">bond {formatAmount(o.currentBond, { symbol: o.bondToken })}</p> : null}
        </div>
        <div className="bg-surface px-4 py-3">
          <p className="text-[12.5px] text-muted">{o.isFinalized ? 'Finalized' : fin ? 'Finalizes if unchallenged' : 'Accepts answers'}</p>
          <p className="tnum mt-0.5 text-[15px] font-medium">
            {o.isFinalized ? (
              o.finalAnswer ? <AnswerText a={o.finalAnswer} /> : 'Yes'
            ) : fin ? (
              fin.past ? 'Timeout elapsed' : `in ${fin.label}`
            ) : opening.past ? (
              'Now open'
            ) : (
              `in ${opening.label}`
            )}
          </p>
          <p className="tnum text-xs text-muted">{formatDate(o.finalizesAt ?? o.openingTime, 'utc')}</p>
        </div>
        <div className="bg-surface px-4 py-3">
          <p className="text-[12.5px] text-muted">Arbitration</p>
          <p className="mt-0.5 text-[15px] font-medium">
            {arb.status === 'not_requested' ? 'Not requested' : arb.status === 'pending' ? 'Pending ruling' : arb.status === 'appeal_period' ? 'Appeal period' : 'Ruled'}
          </p>
          <p className="tnum text-xs text-muted">
            fee {formatAmount(arb.cost && Number(arb.cost) > 0 ? arb.cost : chain.arbitration.feeEstimate, { symbol: chain.arbitration.feeCurrency, maxDecimals: 4 })} on Ethereum
          </p>
        </div>
      </section>

      <section aria-labelledby="rq-h">
        <h2 id="rq-h" className="px-4 pt-4 text-[15px] font-semibold sm:px-6">
          Reality.eth question
        </h2>
        <DataList
          className="mt-2"
          rows={[
            {
              label: 'Question id',
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <HashChip value={o.realityQuestionId} head={10} tail={6} />
                  <ExternalLink href={o.realityUrl}>Open on Reality.eth</ExternalLink>
                </span>
              ),
            },
            { label: 'Opening time', value: <span className="tnum">{formatDate(o.openingTime, 'utc')}</span>, hint: 'Answers before this time revert. It is on or after the evidence deadline.' },
            {
              label: 'Answer timeout',
              value: <span className="tnum">{formatDuration(o.timeoutSeconds * 1000)} ({o.timeoutSeconds.toLocaleString('en-US')} s)</span>,
              hint: "Fixed by Seer's official market factory. Each new answer restarts it.",
            },
            { label: 'Minimum bond', value: <span className="tnum">{formatAmount(o.minBond, { symbol: o.bondToken })}</span>, hint: `Bonds are paid in ${chain.nativeSymbol}, the chain's native token. Each new answer must at least double the previous bond.` },
            { label: 'Next answer needs', value: <span className="tnum">{formatAmount(nextBond, { symbol: o.bondToken })}</span> },
            { label: 'Template', value: <span className="mono-cond text-[12px]">{o.templateId} (single select)</span> },
          ]}
        />
      </section>

      <section aria-labelledby="hist-h" className="px-4 py-4 sm:px-6">
        <h2 id="hist-h" className="text-[15px] font-semibold">
          Answer history
        </h2>
        {o.history.length === 0 ? (
          <p className="mt-2 text-[13px] text-muted">
            {opening.past ? 'No answer posted yet. Anyone can post one with the minimum bond.' : `Answers open in ${opening.label}.`}
          </p>
        ) : (
          <div className="scrollbar-thin mt-2 relative overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="stretch-cond border-b border-line text-left text-[12px] text-muted">
                  <th className="py-1.5 font-medium">Answer</th>
                  <th className="py-1.5 text-right font-medium">Bond</th>
                  <th className="py-1.5 pl-4 font-medium">Answerer</th>
                  <th className="py-1.5 font-medium">Posted (UTC)</th>
                  <th className="py-1.5 font-medium">
                    <span className="sr-only">Transaction</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {o.history.map((h, i) => (
                  <tr key={h.txHash + i} className="border-b border-line last:border-0">
                    <td className="py-2">
                      <AnswerText a={h.answer} />
                    </td>
                    <td className="tnum py-2 text-right">{formatAmount(h.bond, { symbol: o.bondToken })}</td>
                    <td className="py-2 pl-4">
                      <ExternalLink href={explorerAddressUrl(o.chainId, h.answerer)} className="mono-cond text-[11.5px]" icon={false}>
                        {shortHash(h.answerer)}
                      </ExternalLink>
                    </td>
                    <td className="tnum py-2">{formatDate(h.at, 'utc')}</td>
                    <td className="py-2 text-right">
                      <ExternalLink href={explorerTxUrl(o.chainId, h.txHash)} className="text-[12px]">
                        tx
                      </ExternalLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="arb-h">
        <h2 id="arb-h" className="px-4 pt-4 text-[15px] font-semibold sm:px-6">
          Kleros arbitration
        </h2>
        <DataList
          className="mt-2"
          rows={[
            {
              label: 'Where it runs',
              value: `${chain.arbitration.courtName} on Ethereum mainnet, via the ${chain.arbitration.requestContractName}`,
              hint:
                o.chainId !== chain.arbitration.chainId
                  ? `This market is on ${chain.name}, but arbitration is always requested and paid on Ethereum. A bridge relays the ruling back.${chain.arbitration.bridgeDelayNote ? ` ${chain.arbitration.bridgeDelayNote}` : ''}`
                  : undefined,
            },
            {
              label: 'Arbitration fee',
              value: (
                <span className="tnum">
                  {formatAmount(arb.cost && Number(arb.cost) > 0 ? arb.cost : chain.arbitration.feeEstimate, { symbol: chain.arbitration.feeCurrency, maxDecimals: 4 })}
                </span>
              ),
              hint: `Paid in ${chain.arbitration.feeCurrency} by whoever requests arbitration (${chain.arbitration.jurors} jurors). Not part of your spending limit unless you budget for it.`,
            },
            {
              label: 'Typical duration',
              value: `About ${chain.arbitration.typicalRulingDays} days to a first ruling, plus about ${chain.arbitration.typicalAppealDays} days per appeal round`,
              hint: 'Arbitration can take far longer than the evidence window.',
            },
            ...(arb.requested
              ? [
                  { label: 'Requested', value: <span className="tnum">{arb.requestedAt ? formatDate(arb.requestedAt, 'utc') : 'yes'}</span>, hint: arb.requester ? `by ${shortHash(arb.requester)}` : undefined },
                  { label: 'Dispute', value: arb.disputeId ? <span className="mono-cond text-[12px]">#{arb.disputeId}</span> : 'Being created', hint: arb.court },
                  ...(arb.ruling ? [{ label: 'Ruling', value: <AnswerText a={arb.ruling} /> }] : []),
                  ...(arb.appealDeadline
                    ? [{ label: 'Appeal deadline', value: <span className="tnum">{formatDate(arb.appealDeadline, 'utc')}</span> }]
                    : []),
                  ...(arb.klerosUrl ? [{ label: 'Case', value: <ExternalLink href={arb.klerosUrl}>Open on Kleros</ExternalLink> }] : []),
                ]
              : []),
          ]}
        />
      </section>
      <div className="space-y-2 px-4 py-4 sm:px-6">
        <Callout tone="info" title="Who acts here">
          {COPY.oracleActors} Pine never posts answers for you.
        </Callout>
        {claim.outcome === 'invalid' || o.currentAnswer === 'invalid' ? <Callout tone="warning">{COPY.invalidIsNotRefund}</Callout> : null}
      </div>
    </div>
  )
}
