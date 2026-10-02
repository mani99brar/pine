'use client'

import { useMemo } from 'react'
import type { ClaimDetail, TxStep, TxStepId } from '@pine/core'
import { formatDate, shortHash } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { useTxRunner, useWallet } from '@pine/react'
import { Check, Lock } from 'lucide-react'
import { Notice } from '@/components/ui/notice'
import { Button } from '@/components/ui/button'
import { TxSteps } from '@/components/tx/tx-steps'

export const STEP_COPY: Record<TxStepId, { label: string; description: string; kind: TxStep['kind']; freezesTerms?: boolean; optional?: boolean }> = {
  upload_manifest: {
    label: 'Pin the manifest',
    description: 'Store the claim manifest so anyone can retrieve and hash-check it.',
    kind: 'offchain',
  },
  create_market: {
    label: 'Create the market',
    description: 'Create the Seer market and its Reality.eth question. From this point the terms cannot change.',
    kind: 'transaction',
    freezesTerms: true,
  },
  approve_collateral: {
    label: 'Approve the exact collateral amount',
    description: COPY.exactApproval,
    kind: 'transaction',
  },
  split_position: {
    label: 'Split collateral into outcome tokens',
    description: 'Turn collateral into equal sets of Yes, No and Invalid result tokens for the pools.',
    kind: 'transaction',
  },
  add_liquidity_yes: {
    label: 'Add Yes liquidity',
    description: 'Supply Yes tokens and collateral to the Yes pool on the DEX.',
    kind: 'transaction',
  },
  add_liquidity_no: {
    label: 'Add No liquidity',
    description: 'Supply No tokens and collateral to the No pool on the DEX.',
    kind: 'transaction',
    optional: true,
  },
  register_claim: {
    label: 'Register the claim',
    description: 'Index the claim so it appears on the docket and in the agent API.',
    kind: 'offchain',
  },
  upload_evidence: {
    label: 'Store the exhibit',
    description: 'Store the exhibit package so jurors and answerers can retrieve and hash-check it.',
    kind: 'offchain',
  },
  submit_evidence: {
    label: 'File the exhibit on Ethereum',
    description: 'Record the exhibit with the Kleros arbitration contract on Ethereum mainnet. The block timestamp proves when it was filed.',
    kind: 'transaction',
  },
  redeem_positions: {
    label: 'Redeem outcome tokens',
    description: 'Burn winning outcome tokens and receive collateral under the market’s native payout rules.',
    kind: 'transaction',
  },
  approve_outcome_tokens: {
    label: 'Approve the exact outcome tokens',
    description: 'Allow the router to move exactly these outcome tokens, never an unlimited amount.',
    kind: 'transaction',
  },
}

export function PublicationRecovery({ claim }: { claim: ClaimDetail }) {
  const wallet = useWallet()
  const pub = claim.publication
  const steps = useMemo(() => pub?.steps ?? [], [pub])
  const done = steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped')
  const remaining: TxStep[] = useMemo(
    () =>
      steps
        .filter((s) => s.status !== 'confirmed' && s.status !== 'skipped')
        .map((s) => ({ id: s.id, ...STEP_COPY[s.id] })),
    [steps],
  )
  const runner = useTxRunner(`docket:finish:${claim.id}`, remaining, {
    spendingLimit: claim.funding?.spendingLimit,
  })
  const marketCreated = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed') || !!claim.market
  const isCreator = !!wallet.address && wallet.address.toLowerCase() === claim.creator.toLowerCase()

  if (claim.status === 'failed') {
    return (
      <div className="space-y-4">
        <Notice tone="critical" title="This filing failed and cannot be resumed">
          {pub?.note ?? 'Check the record below for anything that reached the chain.'}
        </Notice>
        <CompletedSteps steps={steps} />
        <p className="measure">
          To try again, start a new filing. Anything already on-chain stays there. A changed claim always needs a new market.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <p className="measure">
        {done.length} of {steps.length} filing steps are confirmed.{' '}
        {marketCreated ? (
          <>
            <Lock aria-hidden className="inline size-4 -translate-y-px" /> The market exists, so the terms are frozen. Finishing only adds the
            remaining funding.
          </>
        ) : (
          'The market has not been created, so the terms can still change.'
        )}
      </p>
      <CompletedSteps steps={steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped')} />
      {!wallet.isConnected ? (
        <div className="flex flex-wrap items-center justify-between gap-4 border border-dashed border-rule-strong bg-sheet px-5 py-4">
          <p className="text-graphite">Connect the filer&rsquo;s wallet to finish filing.</p>
          <Button variant="secondary" onClick={() => wallet.connect()}>
            Connect wallet
          </Button>
        </div>
      ) : !isCreator ? (
        <Notice tone="neutral" title="Only the filer can finish this filing">
          The connected wallet ({shortHash(wallet.address ?? '', 4)}) did not file this claim. You can still read the terms and the record.
        </Notice>
      ) : (
        <div className="border border-rule bg-sheet p-5">
          <h3 className="text-lg font-bold">Finish filing</h3>
          <p className="mt-1 text-[15px] text-graphite">
            Each step asks your wallet to sign. Every amount is checked against your spending limit first.
          </p>
          <TxSteps
            className="mt-4"
            runner={runner}
            startLabel="Finish filing"
            doneLabel="Filing finished"
            chainId={claim.chainId}
            spendingLimit={claim.funding?.spendingLimit}
            symbol={claim.collateralSymbol}
          />
        </div>
      )}
    </div>
  )
}

function CompletedSteps({ steps }: { steps: NonNullable<ClaimDetail['publication']>['steps'] }) {
  if (steps.length === 0) return null
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {steps.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-[15px]">
          <span className="flex items-center gap-2">
            {s.status === 'confirmed' ? (
              <Check aria-hidden className="size-4" strokeWidth={3} />
            ) : (
              <span aria-hidden className="inline-block size-4" />
            )}
            <strong>{STEP_COPY[s.id]?.label ?? s.id}</strong>
          </span>
          <span className={s.status === 'failed' ? 'font-bold text-red' : 'text-graphite'}>
            {s.status === 'confirmed' ? 'Confirmed' : s.status === 'failed' ? `Failed${s.error ? `: ${s.error}` : ''}` : s.status}
            {s.at ? `, ${formatDate(s.at, 'long')}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
