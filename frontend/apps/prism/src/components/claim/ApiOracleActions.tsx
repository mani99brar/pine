'use client'

import { useState } from 'react'
import { formatUnits } from 'viem'
import type { Address, ClaimDetail } from '@pine/core'
import { explorerAddressUrl, formatAmount, formatDate } from '@pine/core'
import type { OracleActionStatus } from '@pine/data'
import { useApiOracle } from '@pine/react'
import { Gavel } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { HashChip } from '@/components/ui/interactive'
import { apiDetailFactsOf, isoOfUnix } from '@/lib/claims'
import { cn } from '@/lib/cn'
import { ApiSessionGate, PlanControls, PlanProgress, WriteErrorNotice, parseAmountWei } from './ApiActionKit'

type DueAction = OracleActionStatus['dueActions'][number]

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const UINT = /^(?:0|[1-9][0-9]{0,77})$/

const ACTION_TEXT: Record<DueAction['action'], { title: string; detail: string; button?: string }> = {
  answer: { title: 'Answer the question', detail: 'Post Yes, No or Invalid on Reality.eth with a bond. A wrong answer can lose its bond to a correct challenger.' },
  fund_bounty: { title: 'Add an answer bounty', detail: 'xDAI paid to whoever gives the final answer. It is not a reward for evidence and is not refundable.' },
  request_arbitration_on_ethereum: { title: 'Request Kleros arbitration', detail: 'Arbitration is requested and paid in ETH on Ethereum mainnet. Pine prepares no mainnet transaction.' },
  handle_notified_request: { title: 'Relay the arbitration request', detail: 'Tells Reality.eth on Gnosis that arbitration was requested on Ethereum, so the answer cannot finalize meanwhile.', button: 'Relay the request' },
  handle_rejected_request: { title: 'Relay the rejected request', detail: 'Tells Reality.eth that the arbitration request was rejected on Ethereum, so answering can continue.', button: 'Relay the rejection' },
  report_arbitration_answer: { title: 'Report the arbitrator’s answer', detail: 'Reports the Kleros ruling to Reality.eth so the question can finalize.', button: 'Report the ruling' },
  reopen_question: { title: 'Reopen the question', detail: 'The final answer was “answered too soon”. Reopening creates a new question that can be answered again.', button: 'Reopen the question' },
  resolve_market: { title: 'Resolve the market', detail: 'Reports the final answer to the Seer market, after which winning outcome tokens can be redeemed.', button: 'Resolve the market' },
  claim_winnings: { title: 'Claim Reality.eth winnings', detail: 'Credits bonds and bounties owed to correct answerers to their Reality.eth balance.', button: 'Claim winnings' },
  withdraw: { title: 'Withdraw your Reality.eth balance', detail: 'Moves your Reality.eth balance to your wallet.', button: 'Withdraw' },
}

function isKnownAction(action: string): action is DueAction['action'] {
  return Object.prototype.hasOwnProperty.call(ACTION_TEXT, action)
}

function xdai(wei: bigint | string | null | undefined, maxDecimals = 6): string {
  if (wei === null || wei === undefined) return '—'
  if (typeof wei === 'string' && !UINT.test(wei)) return '—'
  return formatAmount(formatUnits(BigInt(wei), 18), { maxDecimals })
}

/** The mainnet arbitration request: instructions only (the backend never plans Ethereum transactions). */
function MainnetArbitration({ action, questionId }: { action: DueAction; questionId: string | null }) {
  const d = action.details
  const proxy = typeof d.foreignProxy === 'string' && ADDRESS.test(d.foreignProxy) ? (d.foreignProxy.toLowerCase() as Address) : null
  const chainId = typeof d.chainId === 'number' ? d.chainId : 1
  const maxPrevious = typeof d.maxPrevious === 'string' && UINT.test(d.maxPrevious) ? d.maxPrevious : null
  const finalizesAt = typeof d.finalizesAt === 'number' && Number.isInteger(d.finalizesAt) && d.finalizesAt > 0 ? isoOfUnix(d.finalizesAt) : null
  return (
    <div className="mt-2 grid gap-2 text-[0.84375rem] text-lumen-2">
      <p>
        On Ethereum, call <span className="t-code text-lumen">requestArbitration(questionId, maxPrevious)</span> on the Kleros proxy and pay the dispute fee it quotes (getDisputeFee). Whoever requests arbitration pays the fee.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {proxy && <HashChip value={proxy} label="Kleros proxy" href={explorerAddressUrl(chainId, proxy)} />}
        {(action.questionId ?? questionId) && <HashChip value={action.questionId ?? questionId ?? ''} label="Question" />}
        {maxPrevious && (
          <span className="cut-sm border border-edge bg-void px-2.5 py-1 text-[0.78rem] text-lumen-3">
            maxPrevious <span className="t-code text-lumen">{maxPrevious}</span> wei
          </span>
        )}
      </div>
      {finalizesAt && <p className="text-lumen-3">Request it well before the answer finalizes at {formatDate(finalizesAt, 'utc')}: the bridge to Gnosis takes about 30 minutes.</p>}
    </div>
  )
}

function AnswerForm({ minimumBondWei, busy, onAnswer }: { minimumBondWei: bigint | null; busy: boolean; onAnswer: (outcome: 'yes' | 'no' | 'invalid', bondWei: bigint) => void }) {
  const [outcome, setOutcome] = useState<'yes' | 'no' | 'invalid' | null>(null)
  const [bond, setBond] = useState('')
  const bondWei = parseAmountWei(bond)
  const tooLow = bondWei !== null && minimumBondWei !== null && bondWei < minimumBondWei
  const ready = outcome !== null && bondWei !== null && !tooLow && minimumBondWei !== null
  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && outcome && bondWei !== null) onAnswer(outcome, bondWei)
      }}
    >
      <fieldset>
        <legend className="label">Your answer</legend>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['yes', 'Yes: counterexample demonstrated'],
              ['no', 'No: no qualifying counterexample'],
              ['invalid', 'Invalid'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className={cn('chip cursor-pointer', outcome === v && 'border-[rgba(255,236,220,0.5)] text-lumen')}>
              <input type="radio" name="oracle-answer" value={v} checked={outcome === v} onChange={() => setOutcome(v)} className="facet-check" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="oracle-bond" className="label">
          Bond in xDAI
        </label>
        <input id="oracle-bond" className="field tnum w-48" inputMode="decimal" value={bond} onChange={(e) => setBond(e.target.value)} aria-invalid={bond !== '' && (bondWei === null || tooLow)} aria-describedby="oracle-bond-help" />
        <p id="oracle-bond-help" className="help mt-1">
          At least <span className="tnum font-semibold text-lumen">{minimumBondWei !== null ? xdai(minimumBondWei) : '—'} xDAI</span>: the claim&apos;s minimum bond or twice the current bond, whichever is higher. You send exactly the bond you enter.
        </p>
        {bond !== '' && bondWei === null && <p className="mt-1 text-[0.8125rem] text-ha">Enter an amount like 12.5.</p>}
        {tooLow && <p className="mt-1 text-[0.8125rem] text-ha">The bond is below the minimum.</p>}
      </div>
      <div>
        <Button type="submit" size="sm" disabled={!ready || busy} loading={busy}>
          {bondWei !== null && ready ? `Answer with a ${xdai(bondWei)} xDAI bond` : 'Answer'}
        </Button>
      </div>
    </form>
  )
}

/**
 * Oracle actions of a backend claim (useApiOracle): what is due now for anyone (and for this wallet), each run as a
 * verified Pine plan. Pine never answers, bonds or relays on its own.
 */
export function ApiOracleActions({ claim }: { claim: ClaimDetail }) {
  const market = (claim.marketAddress ?? claim.id) as Address
  const oracle = useApiOracle(market)
  const facts = apiDetailFactsOf(claim)
  const [bounty, setBounty] = useState('')
  // The account-aware status once loaded, else the claim page's anonymous view; unknown action names are not shown.
  const due: DueAction[] = oracle.status
    ? oracle.dueActions
    : (facts?.oracle.dueActions ?? []).flatMap((d) => (isKnownAction(d.action) ? [{ action: d.action, questionId: d.questionId, planRoute: d.planRoute, details: d.details }] : []))
  const unique = due.filter((d, i) => due.findIndex((x) => x.action === d.action) === i)
  const busy = oracle.busy
  const run = (fn: () => Promise<void>) => () => void fn()
  const handlers: Partial<Record<DueAction['action'], () => Promise<void>>> = {
    handle_notified_request: oracle.handleNotifiedRequest,
    handle_rejected_request: oracle.handleRejectedRequest,
    report_arbitration_answer: oracle.reportArbitrationAnswer,
    reopen_question: oracle.reopen,
    resolve_market: oracle.resolve,
    claim_winnings: oracle.claimWinnings,
    withdraw: oracle.withdraw,
  }
  const bountyWei = parseAmountWei(bounty)

  return (
    <section className="glass cut-lg p-5 lg:col-span-3" aria-labelledby="oracle-actions-title">
      <h3 id="oracle-actions-title" className="t-h4 flex items-center gap-2">
        <Gavel size={16} aria-hidden className="text-na" /> What anyone can do now
      </h3>
      <p className="mt-1 max-w-[70ch] text-[0.84375rem] text-lumen-3">Pine runs no keeper and never answers, bonds or relays for anyone. Every step is permissionless: whoever cares sends it from their own wallet.</p>
      {oracle.loading && !facts ? null : unique.length === 0 ? (
        <p className="mt-3 text-[0.9rem] text-lumen-2">{facts?.phase === 'evidence_open' || facts?.phase === 'reveal_open' ? 'Nothing yet: Reality.eth accepts answers from the reveal deadline.' : 'Nothing is due right now.'}</p>
      ) : (
        <ApiSessionGate purpose="act on the oracle" className="mt-4">
          <ul className="mt-4 grid gap-4">
            {unique.map((d) => {
              const text = ACTION_TEXT[d.action]
              const handler = handlers[d.action]
              return (
                <li key={d.action} className="cut-md border border-edge bg-void p-4">
                  <p className="font-semibold text-lumen">{text.title}</p>
                  <p className="mt-1 text-[0.84375rem] text-lumen-2">{text.detail}</p>
                  {d.action === 'answer' && <AnswerForm minimumBondWei={oracle.minimumBondWei} busy={busy} onAnswer={(o, w) => void oracle.submitAnswer(o, w)} />}
                  {d.action === 'fund_bounty' && (
                    <form
                      className="mt-3 flex flex-wrap items-end gap-2"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (bountyWei !== null) void oracle.fundBounty(bountyWei)
                      }}
                    >
                      <div>
                        <label htmlFor="oracle-bounty" className="label">
                          Bounty in xDAI
                        </label>
                        <input id="oracle-bounty" className="field tnum w-40" inputMode="decimal" value={bounty} onChange={(e) => setBounty(e.target.value)} aria-invalid={bounty !== '' && bountyWei === null} />
                      </div>
                      <Button type="submit" size="sm" variant="glass" disabled={bountyWei === null || busy}>
                        {bountyWei !== null ? `Add ${xdai(bountyWei)} xDAI` : 'Add bounty'}
                      </Button>
                    </form>
                  )}
                  {d.action === 'request_arbitration_on_ethereum' && <MainnetArbitration action={d} questionId={facts?.currentQuestionId ?? null} />}
                  {d.action === 'withdraw' && typeof d.details.balance === 'string' && <p className="tnum mt-1 text-[0.84375rem] text-lumen">Balance: {xdai(d.details.balance)} xDAI</p>}
                  {handler && text.button && (
                    <Button size="sm" variant="glass" className="mt-3" disabled={busy} onClick={run(handler)}>
                      {text.button}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
          <WriteErrorNotice error={oracle.error} className="mt-4" />
          <PlanProgress runner={oracle.runner} chainId={claim.chainId} className="mt-5" />
          <div className="mt-3">
            <PlanControls runner={oracle.runner} busy={busy} onRetry={() => void oracle.runner.run()} onAbandon={oracle.abandon} />
          </div>
          {oracle.planState && (
            <p className="mt-3 text-[0.84375rem] text-lumen-2" role="status">
              Pine sees this plan as {oracle.planState.state}.
            </p>
          )}
        </ApiSessionGate>
      )}
    </section>
  )
}
