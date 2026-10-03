'use client'

import Link from 'next/link'
import { formatAmount, formatClaimNumber } from '@pine/core'
import { CHAINS } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { useEffect, useRef } from 'react'
import { useClaim, useDemoWallet, usePublishClaim, useWallet } from '@pine/react'
import { Lock, Wallet } from 'lucide-react'
import { Button, ButtonLink } from '@/components/ui/button'
import { Notice } from '@/components/ui/notice'
import { MarginNote } from '@/components/ui/field'
import { TxSteps } from '@/components/tx/tx-steps'
import { useAcknowledgements } from '@/lib/ack'
import { planSignature, riskItems } from '../risk'
import { useWizard } from '../context'

function FiledNumber({ claimId }: { claimId?: string }) {
  const q = useClaim(claimId)
  if (q.data) return <>{formatClaimNumber(q.data.number)}</>
  return <>Filed</>
}

export function PublishStep() {
  const { composer, draftId, issues, goTo } = useWizard()
  const publish = usePublishClaim(draftId)
  const wallet = useWallet()
  const demo = useDemoWallet()
  const plan = composer.funding
  const bond = { minBond: composer.spec.oracle?.minBond, token: composer.spec.oracle?.bondToken }
  const ack = useAcknowledgements(draftId, planSignature(plan))
  const acked = plan ? riskItems(plan, bond).every((r) => ack.has(r.id)) : false
  const chainId = composer.fundingInput.chainId
  const chain = CHAINS[chainId]
  const sym = plan?.collateral.symbol ?? chain?.collateral.symbol ?? ''
  const started = publish.steps.some((s) => s.status !== 'idle')
  const reviewDone = issues.length === 0 && acked
  const doneRef = useRef<HTMLDivElement>(null)
  const isDone = publish.state === 'done'
  useEffect(() => {
    if (isDone) doneRef.current?.scrollIntoView({ block: 'center' })
  }, [isDone])

  if (publish.state === 'done') {
    return (
      <div ref={doneRef} className="py-6 text-center">
        <div className="mx-auto inline-block -rotate-2 border-4 border-violet px-8 py-5 motion-safe:animate-stamp">
          <p className="text-sm font-bold text-violet">Entered on the docket</p>
          <p className="mt-1 text-4xl font-[800] tracking-tight text-violet tabular">
            <FiledNumber claimId={publish.claimId} />
          </p>
        </div>
        <h3 className="mt-8 text-2xl">Your claim is filed</h3>
        <p className="mx-auto mt-2 max-w-[44ch] text-lg text-graphite">
          The evidence window is open. Investigators can now find it on the docket, in the agent API and in the feed.
          {demo.enabled ? ' In demo mode it exists only in this browser.' : ''}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {publish.claimId ? <ButtonLink href={`/claims/${publish.claimId}`}>Open the case file</ButtonLink> : null}
          <ButtonLink href="/my-docket" variant="secondary">
            Go to my docket
          </ButtonLink>
        </div>
        <p className="mx-auto mt-6 max-w-[56ch] text-sm text-graphite">{COPY.noMergeAuthority}</p>
      </div>
    )
  }

  return (
    <>
      {!reviewDone && !started ? (
        <Notice
          tone="warning"
          title="Finish the review first"
          action={
            <Button size="sm" variant="secondary" onClick={() => goTo('review')}>
              Back to review
            </Button>
          }
        >
          {issues.length > 0
            ? `${issues.length} thing${issues.length === 1 ? '' : 's'} still need fixing.`
            : 'Tick every risk acknowledgement on the review step. They hold the real numbers you are about to spend.'}
        </Notice>
      ) : null}

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-6">
          <div className="border border-rule">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-bold">Wallet</p>
                <p className="text-[15px] text-graphite">
                  {wallet.isConnected && wallet.address ? (
                    <>
                      <code className="font-mono text-[13px] break-all text-ink">{wallet.address}</code>
                      {wallet.isDemo ? ' (simulated)' : ''}
                    </>
                  ) : (
                    'Not connected'
                  )}
                </p>
              </div>
              {!wallet.isConnected ? (
                <Button icon={<Wallet aria-hidden />} onClick={() => wallet.connect()}>
                  Connect wallet
                </Button>
              ) : wallet.chainId !== chainId ? (
                <Button variant="secondary" onClick={() => void wallet.switchChain(chainId)}>
                  Switch to {chain?.name ?? `chain ${chainId}`}
                </Button>
              ) : (
                <span className="text-sm font-bold">On {chain?.name}</span>
              )}
            </div>
            {plan ? (
              <div className="border-t border-rule px-4 py-3 text-[15px]">
                This filing may spend up to <strong>{formatAmount(plan.totals.maxSpend, { symbol: sym, maxDecimals: 4 })}</strong> of your{' '}
                <strong>{formatAmount(plan.input.spendingLimit, { symbol: sym })}</strong> limit.{' '}
                {wallet.balance ? (
                  <span className="text-graphite">
                    The wallet holds {formatAmount(wallet.balance.amount, { symbol: wallet.balance.symbol, maxDecimals: 2 })}.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {publish.blockers.length > 0 && !started ? (
            <Notice tone="critical" title="Publishing cannot start yet">
              <ul className="list-disc space-y-1 pl-5">
                {publish.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div>
            <h3 className="text-xl">Filing steps</h3>
            <p className="mt-1 text-[15px] text-graphite">
              Each transaction asks your wallet to sign. If one fails or you close the page, come back here and continue from the first
              unfinished step.
            </p>
            <TxSteps
              className="mt-4"
              runner={publish}
              startLabel="Sign and file"
              doneLabel="Filed"
              chainId={chainId}
              spendingLimit={plan?.input.spendingLimit}
              symbol={sym}
              disabled={!reviewDone || (!wallet.isConnected && !started)}
              disabledReason={!wallet.isConnected ? 'Connect a wallet to sign the filing transactions.' : undefined}
            />
          </div>

          {publish.frozen ? (
            <p className="flex items-start gap-2 text-[15px]">
              <Lock aria-hidden className="mt-1 size-4 shrink-0" /> The market exists, so the terms are frozen. The remaining steps only add
              funding. You can also finish them later from your docket.
            </p>
          ) : null}

          {demo.enabled ? (
            <div className="border border-dashed border-wheat-line bg-flag-wash px-4 py-3 text-[15px]">
              <p className="font-bold">Reviewer control</p>
              <p className="mt-0.5">
                {demo.pendingFailure
                  ? 'The next simulated transaction will be rejected.'
                  : 'See how a filing recovers when a step fails.'}{' '}
                {!demo.pendingFailure ? (
                  <button type="button" className="link font-bold" onClick={() => demo.failNext()}>
                    Make the next transaction fail
                  </button>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>
        <aside className="space-y-5">
          <MarginNote title="Exact approvals only">
            <p>{COPY.exactApproval}</p>
          </MarginNote>
          <MarginNote title="Adding liquidity happens on the DEX">
            <p>
              Like Seer&rsquo;s own interface, Pine sends you to the DEX to add liquidity to each outcome pool. Come back and mark the step
              done when you have.
            </p>
          </MarginNote>
          <MarginNote title="Leaving halfway is safe">
            <p>
              Progress is saved after every step. Unfinished filings appear under <Link href="/filings" className="link">Drafts and filings</Link>.
            </p>
          </MarginNote>
        </aside>
      </div>
    </>
  )
}
