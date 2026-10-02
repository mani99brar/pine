'use client'

import Link from 'next/link'
import { formatAmount } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { COPY } from '@pine/core/copy'
import { usePublishClaim, useWallet, type ClaimComposer } from '@pine/react'
import { ArrowLeft, Flag, RotateCw, Wallet } from 'lucide-react'
import { TxSteps } from '@/components/tx/TxSteps'
import { DemoFailToggle } from '@/components/tx/DemoFailToggle'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Note } from '@/components/ui/primitives'
import { TensionBar } from '@/components/glyphs/TensionBar'
import { StageHeader } from './shared'

export function StagePublish({ c, acknowledged }: { c: ClaimComposer; acknowledged: boolean }) {
  const pub = usePublishClaim(c.draft.id)
  const wallet = useWallet()
  const symbol = getChainOrDefault(c.fundingInput.chainId).collateral.symbol
  const done = pub.state === 'done'
  const started = pub.steps.some((s) => s.status !== 'idle')

  if (done) {
    return (
      <div>
        <div className="rounded-[var(--radius-tile)] border-2 border-ink bg-sheet p-6 sm:p-8">
          <p className="inline-flex items-center gap-2 rounded-full bg-ink px-3 py-1 text-[0.8rem] font-[650] text-on-ink">
            <Flag size={13} aria-hidden /> Published
          </p>
          <h2 className="t-display-l mt-4 max-w-[18ch]">Your claim is on the board.</h2>
          <p className="mt-3 max-w-[60ch] text-ink-2">
            The market is open for evidence until the deadline. Investigators and agents can find it on the board, in the API and in the feed. {COPY.noMergeAuthority}
          </p>
          <TensionBar yes={c.fundingInput.initialYesPrice} size="lg" settleDelay={100} className="mt-8 max-w-[40rem]" />
          <div className="mt-8 flex flex-wrap gap-3">
            {pub.claimId && <ButtonLink href={`/claims/${pub.claimId}`}>Watch it live</ButtonLink>}
            <ButtonLink href="/board" variant="secondary">
              See the board
            </ButtonLink>
            <ButtonLink href="/compose" variant="ghost">
              Put another claim on the board
            </ButtonLink>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <StageHeader stage="publish">
        Each step asks your wallet for exactly one action. Progress is saved after every step, so you can close this tab and finish later from Drafts.
      </StageHeader>

      {!acknowledged && !started && (
        <Note tone="caution" className="mb-6" title="Risks not acknowledged">
          Go back to review and acknowledge the risks first.{' '}
          <button type="button" className="font-[650] underline" onClick={() => c.setStage('review')}>
            Back to review
          </button>
        </Note>
      )}

      {pub.frozen && (
        <Note className="mb-6" title="Market created: terms are frozen">
          {COPY.frozenTerms} The remaining steps only fund the market.
        </Note>
      )}

      {!started && pub.blockers.length > 0 && (
        <div className="mb-6 rounded-[3px] border-l-[3px] border-lumen bg-lumen-wash px-4 py-3" role="status">
          <p className="text-[0.88rem] font-[700]">Before you can publish</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[0.86rem] text-ink-2">
            {pub.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5 sm:p-6" aria-labelledby="pub-steps">
          <h3 id="pub-steps" className="t-h3 mb-5">
            Publication steps
          </h3>
          {pub.steps.length > 0 ? <TxSteps runner={pub} chainId={c.fundingInput.chainId} /> : <p className="text-ink-2">The steps appear once the claim is complete.</p>}
          {pub.error && (
            <p role="alert" className="untrusted mt-5 rounded-[3px] bg-flare-wash px-3 py-2 text-[0.86rem] text-flare-ink [white-space:normal]">
              {pub.error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            {!wallet.isConnected ? (
              <Button onClick={() => wallet.connect()} icon={<Wallet size={16} aria-hidden />}>
                {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
              </Button>
            ) : pub.state === 'failed' ? (
              <Button onClick={() => void pub.retry()} icon={<RotateCw size={15} aria-hidden />}>
                Retry from the failed step
              </Button>
            ) : (
              <Button
                onClick={() => void pub.start()}
                loading={pub.state === 'running'}
                disabled={!acknowledged || (!pub.ready && !started) || pub.state === 'running' || !!pub.awaitingManual}
              >
                {started ? 'Continue publishing' : 'Publish'}
              </Button>
            )}
            <DemoFailToggle />
            {!pub.frozen && started && (
              <Button variant="ghost" onClick={() => c.setStage('review')} icon={<ArrowLeft size={15} aria-hidden />}>
                Edit before the market exists
              </Button>
            )}
          </div>
        </section>

        <aside className="grid content-start gap-5">
          <section className="rounded-[var(--radius-tile)] border border-line bg-sheet p-5" aria-labelledby="pub-limit">
            <h3 id="pub-limit" className="t-h3">
              Spending limit
            </h3>
            {(() => {
              const plan = c.funding
              const limit = Number(c.fundingInput.spendingLimit) || 0
              const need = Number(plan?.totals.maxSpend ?? 0)
              const collateralSpent = Number(pub.spent) || 0
              const gasSpent = pub.steps
                .filter((s) => s.status === 'confirmed' && s.estimatedCost && s.estimatedCost.currency !== symbol)
                .reduce((sum, s) => sum + (Number(s.estimatedCost!.amount) || 0), 0)
              const gasSymbol = getChainOrDefault(c.fundingInput.chainId).nativeSymbol
              return (
                <>
                  <p className="mt-2 text-[0.9rem] text-ink-2">
                    This plan needs up to <span className="t-figure text-[1.2rem] text-ink">{formatAmount(need, { maxDecimals: 2 })}</span> {symbol} of your{' '}
                    <span className="t-figure text-[1.2rem] text-ink">{formatAmount(limit, { maxDecimals: 2 })}</span> {symbol} limit.
                  </p>
                  <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-fog-2" role="img" aria-label={`${Math.round((need / Math.max(1e-9, limit)) * 100)}% of the spending limit`}>
                    <div className={plan?.withinLimit === false ? 'h-full hatch-yes' : 'h-full bg-ink'} style={{ width: `${Math.min(100, (need / Math.max(1e-9, limit)) * 100)}%` }} />
                  </div>
                  <p className="mt-3 text-[0.8rem] text-ink-3">
                    Spent so far: <span className="t-figure text-[0.95rem] text-ink-2">{formatAmount(collateralSpent, { maxDecimals: 2 })}</span> {symbol} into the market and about{' '}
                    <span className="t-figure text-[0.95rem] text-ink-2">{formatAmount(gasSpent, { maxDecimals: 4 })}</span> {gasSymbol} in gas. {COPY.spendingLimit}
                  </p>
                </>
              )
            })()}
          </section>
          <Note tone="boundary" title="What freezes, and when">
            {COPY.frozenTerms} If a step fails after that, the market already exists: you finish funding from here or from Drafts, and nothing about the question changes.
          </Note>
          <p className="text-[0.84rem] text-ink-2">
            Interrupted? Everything is saved.{' '}
            <Link href="/drafts" className="font-[620] underline underline-offset-2">
              Drafts and publications
            </Link>
          </p>
        </aside>
      </div>
    </div>
  )
}
