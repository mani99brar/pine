'use client'

import { formatAmount } from '@pine/core'
import { COPY } from '@pine/core/copy'
import type { ClaimComposer } from '@pine/react'
import { Notice } from '@/components/ui/primitives'
import { StageHeader, StageIssues, StageNav, type StepNav } from '../shared'

// Funding in api mode: liquidity is its own plan (a YES ladder) that Pine builds only for a claim that exists, so it
// comes after publication and publishing never depends on it.

const STEPS = [
  ['Publish the claim', 'One transaction from your wallet to Pine’s claim registry, with no value and no token approval. It creates the market and seals the terms.'],
  [
    'Optionally add liquidity',
    'Once the claim is confirmed, choose a budget and a YES price range. Pine computes the ladder and its maximum loss; you acknowledge that loss before any wallet prompt, and approvals stay within your spending limit.',
  ],
  ['Withdraw later', 'Your liquidity position stays in your wallet. You can withdraw it from the claim page at any time.'],
] as const

export function ApiStageFunding({ c, nav }: { c: ClaimComposer; nav: StepNav }) {
  const limit = c.fundingInput.spendingLimit
  return (
    <div>
      <StageHeader step="funding">
        Liquidity lets the market trade. {COPY.liquidityIsNotBounty} With Pine it is a separate, optional step after the claim is confirmed: publishing never
        depends on it.
      </StageHeader>
      <ol className="grid gap-3" aria-label="How liquidity works">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="cut-lg well flex gap-3.5 p-4">
            <span aria-hidden className="cut-sm inline-flex h-7 w-7 shrink-0 items-center justify-center border border-edge-strong text-[0.8125rem] font-semibold text-lumen-2">
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-lumen">{title}</p>
              <p className="mt-0.5 text-[0.875rem] leading-[1.55] text-lumen-2">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Notice tone="boundary" className="mt-6" title="Your spending limit">
        Liquidity steps are checked against your spending limit, <span className="tnum font-semibold text-lumen">{formatAmount(limit, { maxDecimals: 2 })}</span> xDAI
        unless you change it when you add liquidity. The ladder approves exactly the YES amount it needs, never an unlimited allowance.
      </Notice>
      <StageIssues c={c} step="funding" className="mt-6" />
      <StageNav nav={nav} />
    </div>
  )
}
