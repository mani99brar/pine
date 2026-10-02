import type { ClaimDetail } from '@pine/core'
import { explorerTxUrl, formatAmount, formatDate, REALITY_ANSWER_LABEL, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { cn } from '@/lib/cn'
import { DefinitionList } from '@/components/ui/layout'
import { ExternalLink } from '@/components/ui/external-link'
import { Notice } from '@/components/ui/notice'
import { When } from '@/components/ui/when'
import { ARBITRATION_CURRENCY, ARBITRATION_DURATION_NOTE, formatTimeout, INVALID_TOKEN_NOTE } from '@/lib/format'

const ARB_STATUS: Record<string, string> = {
  not_requested: 'Not requested',
  pending: 'Jurors reviewing',
  appeal_period: 'Ruling given, appeal period open',
  ruled: 'Ruled',
}

export function OracleSection({ claim }: { claim: ClaimDetail }) {
  const o = claim.oracle
  const params = claim.manifest.claim.oracle
  const bondToken = o?.bondToken ?? params?.bondToken ?? 'xDAI'

  if (!o) {
    return (
      <div className="space-y-4">
        <p className="measure">
          The oracle has not been created yet, so nobody can answer. Once the market exists, the question opens for answers on Reality.eth at{' '}
          {params ? <strong>{formatDate(params.openingTime, 'long')}</strong> : 'its opening time'}.
        </p>
        <Notice tone="neutral" title="Who answers">
          {COPY.oracleActors}
        </Notice>
      </div>
    )
  }

  const opened = new Date(o.openingTime).getTime() <= Date.now()
  const arb = o.arbitration
  return (
    <div className="space-y-6">
      <DefinitionList
        items={[
          {
            term: 'Opens for answers',
            value: <When at={o.openingTime} />,
            note: opened ? 'Anyone can post an answer with a bond.' : 'Answers posted before this time are rejected by Reality.eth.',
          },
          {
            term: 'Current answer',
            value: o.currentAnswer ? (
              <strong className={cn(o.currentAnswer === 'yes' && 'text-red')}>{REALITY_ANSWER_LABEL[o.currentAnswer]}</strong>
            ) : (
              <span className="text-graphite">No answer yet</span>
            ),
            note: o.currentBond ? `Backed by a bond of ${formatAmount(o.currentBond)} ${bondToken}.` : `Minimum bond ${formatAmount(o.minBond)} ${bondToken}.`,
          },
          ...(o.finalizesAt && !o.isFinalized
            ? [
                {
                  term: 'Becomes final',
                  value: <When at={o.finalizesAt} />,
                  note: `Unless someone posts a different answer with at least double the bond, or requests arbitration. Each answer restarts a ${formatTimeout(o.timeoutSeconds)} clock.`,
                },
              ]
            : []),
          ...(o.isFinalized
            ? [
                {
                  term: 'Final answer',
                  value: <strong>{o.finalAnswer ? REALITY_ANSWER_LABEL[o.finalAnswer] : '?'}</strong>,
                  note: o.finalizesAt ? `Final since ${formatDate(o.finalizesAt, 'long')}.` : undefined,
                },
              ]
            : []),
          {
            term: 'Reality.eth question',
            value: (
              <span className="flex flex-wrap items-center gap-x-3">
                <code className="font-mono text-[14px]">{shortHash(o.realityQuestionId, 8)}</code>
                <ExternalLink href={o.realityUrl}>Open on Reality.eth</ExternalLink>
              </span>
            ),
          },
        ]}
      />

      {o.history.length > 0 ? (
        <div>
          <h3 className="text-xl">Answer history</h3>
          <p className="mt-1 text-[15px] text-graphite">
            Each new answer must at least double the previous bond. Whoever ends up on the final answer can claim the bonds of wrong answers.
          </p>
          <div className="mt-3 overflow-x-auto border border-rule bg-sheet">
            <table className="w-full min-w-[34rem] text-left text-[15px]">
              <caption className="sr-only">Answers posted on Reality.eth, oldest first</caption>
              <thead className="border-b border-rule bg-bond text-sm text-graphite">
                <tr>
                  <th scope="col" className="px-4 py-2 font-bold">#</th>
                  <th scope="col" className="px-4 py-2 font-bold">Answer</th>
                  <th scope="col" className="px-4 py-2 text-right font-bold">Bond</th>
                  <th scope="col" className="px-4 py-2 font-bold">Answerer</th>
                  <th scope="col" className="px-4 py-2 font-bold">Posted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {o.history.map((h, i) => (
                  <tr key={`${h.txHash}-${i}`}>
                    <td className="px-4 py-2.5 text-graphite tabular">{i + 1}</td>
                    <td className={cn('px-4 py-2.5 font-bold', h.answer === 'yes' && 'text-red')}>{REALITY_ANSWER_LABEL[h.answer]}</td>
                    <td className="px-4 py-2.5 text-right tabular">
                      {formatAmount(h.bond)} {bondToken}
                    </td>
                    <td className="px-4 py-2.5">
                      <code className="font-mono text-[13px]">{shortHash(h.answerer, 4)}</code>
                    </td>
                    <td className="px-4 py-2.5">
                      <ExternalLink href={explorerTxUrl(o.chainId, h.txHash)} icon={false}>
                        {formatDate(h.at, 'long')}
                      </ExternalLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div>
        <h3 className="text-xl">Arbitration</h3>
        {arb.requested ? (
          <DefinitionList
            className="mt-3"
            items={[
              { term: 'Status', value: <strong>{ARB_STATUS[arb.status] ?? arb.status}</strong> },
              ...(arb.requestedAt
                ? [{ term: 'Requested', value: formatDate(arb.requestedAt, 'long'), note: arb.requester ? `By ${shortHash(arb.requester, 4)}, who paid the fee.` : undefined }]
                : []),
              ...(arb.disputeId ? [{ term: 'Kleros dispute', value: `#${arb.disputeId}${arb.court ? `, ${arb.court}` : ''}` }] : []),
              { term: 'Arbitration fee', value: `${formatAmount(arb.cost)} ${ARBITRATION_CURRENCY}`, note: 'Paid on Ethereum mainnet by whoever requested arbitration. Not included in the filer’s spending limit.' },
              ...(arb.ruling ? [{ term: 'Ruling', value: <strong>{REALITY_ANSWER_LABEL[arb.ruling]}</strong> }] : []),
              ...(arb.appealDeadline ? [{ term: 'Appeal deadline', value: <When at={arb.appealDeadline} />, note: 'Appeals require funding by the appealing side.' }] : []),
              ...(arb.klerosUrl ? [{ term: 'Case page', value: <ExternalLink href={arb.klerosUrl}>Open on Kleros</ExternalLink> }] : []),
            ]}
          />
        ) : (
          <p className="mt-1 measure text-[15px]">
            Not requested. If an answer is disputed, anyone can escalate to Kleros by paying the arbitration fee
            {arb.cost && arb.cost !== '0' ? `, currently about ${formatAmount(arb.cost)} ${ARBITRATION_CURRENCY} on Ethereum mainnet` : ' in ETH on Ethereum mainnet'}. Jurors then rule
            on the timely exhibits, and the ruling can be appealed. {ARBITRATION_DURATION_NOTE}
          </p>
        )}
      </div>
    </div>
  )
}

export function OutcomeSection({ claim }: { claim: ClaimDetail }) {
  const decided = (claim.status === 'resolved' || claim.status === 'settled') && claim.outcome
  if (decided && claim.outcome) {
    const o = claim.outcome
    return (
      <div className="space-y-4">
        <div
          className={cn(
            'border-l-8 px-5 py-5',
            o === 'yes' && 'border-red bg-red-wash',
            o === 'no' && 'border-slate bg-mist',
            o === 'invalid' && 'hatch border-graphite',
          )}
        >
          <p className={cn('text-2xl font-[800]', o === 'yes' ? 'text-red' : 'text-slate')}>{COPY.outcome[o]}</p>
          <p className="mt-2 text-lg measure">{COPY.outcomeLong[o]}</p>
        </div>
        {o === 'yes' ? (
          <p className="measure">
            Read the exhibits above and decide for yourself what to change. {COPY.noMergeAuthority}
          </p>
        ) : null}
        {o === 'no' ? <p className="measure">{COPY.noIsNotSafety} {COPY.lateEvidence}</p> : null}
        {o === 'invalid' ? (
          <p className="measure">
            {COPY.invalidIsNotRefund}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      <p className="measure">Not decided yet. When the oracle&rsquo;s answer becomes final, this claim resolves to one of three outcomes:</p>
      <dl className="grid gap-3 md:grid-cols-3">
        {(['yes', 'no', 'invalid'] as const).map((o) => (
          <div
            key={o}
            className={cn(
              'border-l-4 bg-sheet px-4 py-3',
              o === 'yes' && 'border-red',
              o === 'no' && 'border-slate',
              o === 'invalid' && 'border-graphite',
            )}
          >
            <dt className={cn('font-bold', o === 'yes' ? 'text-red' : 'text-slate')}>{COPY.outcome[o]}</dt>
            <dd className="mt-1 text-[15px] leading-6 text-ink">{COPY.outcomeLong[o]}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-graphite measure">{INVALID_TOKEN_NOTE}</p>
    </div>
  )
}
