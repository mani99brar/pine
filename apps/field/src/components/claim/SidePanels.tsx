'use client'

import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatDate, formatPrice, nextStep } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { usePortfolio, useRedeem, useWallet } from '@pine/react'
import { ArrowRightLeft, Coins, Footprints } from 'lucide-react'
import { useNowMs } from '@/lib/now'
import { Button } from '@/components/ui/Button'
import { Note } from '@/components/ui/primitives'
import { OutcomeSwatch } from '@/components/glyphs/Status'
import { TxSteps } from '@/components/tx/TxSteps'

const ACTOR: Record<string, string> = {
  anyone: 'Anyone',
  investigators: 'Investigators',
  answerers: 'Answerers',
  creator: 'The creator',
  arbitrator: 'Kleros jurors',
  holders: 'Token holders',
}

export function NextStepCard({ claim }: { claim: ClaimDetail }) {
  const now = useNowMs()
  const step = nextStep(claim, now === null ? new Date(claim.createdAt) : new Date(now))
  return (
    <section aria-labelledby="next-title" className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet p-5">
      <p className="flex items-center gap-2 text-[0.8rem] font-[650] text-ink-2">
        <Footprints size={15} aria-hidden /> What happens next
      </p>
      <h2 id="next-title" className="t-h3 mt-2">
        {step.title}
      </h2>
      <p className="mt-1.5 text-[0.9rem] text-ink-2">{step.detail}</p>
      <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-ink-3">
        <span>
          Who: <span className="font-[600] text-ink-2">{ACTOR[step.actor] ?? step.actor}</span>
        </span>
        {step.at && (
          <span>
            When: <span className="font-[600] text-ink-2">{formatDate(step.at, 'long')}</span>
          </span>
        )}
      </p>
    </section>
  )
}

/** The connected wallet's outcome and LP positions in this claim, with redemption when resolved. */
export function PositionPanel({ claim }: { claim: ClaimDetail }) {
  const wallet = useWallet()
  const portfolio = usePortfolio(wallet.address)
  const redeem = useRedeem(claim.id)
  const positions = (portfolio.data?.positions ?? []).filter((p) => p.claimId === claim.id)
  const lps = (portfolio.data?.liquidity ?? []).filter((p) => p.claimId === claim.id)
  const resolved = claim.status === 'resolved'
  const symbol = claim.collateralSymbol

  return (
    <section id="position" aria-labelledby="pos-title" className="scroll-mt-24 rounded-[var(--radius-tile)] border border-line bg-sheet p-5">
      <h2 id="pos-title" className="t-h3 flex items-center gap-2">
        <Coins size={17} aria-hidden /> Your position
      </h2>
      {!wallet.isConnected ? (
        <div className="mt-2">
          <p className="text-[0.88rem] text-ink-2">Connect a wallet to see outcome tokens and liquidity you hold in this market.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => wallet.connect()}>
            {wallet.isDemo ? 'Connect demo wallet' : 'Connect wallet'}
          </Button>
        </div>
      ) : portfolio.isLoading ? (
        <div className="mt-3 grid gap-2">
          <span className="skeleton h-5 w-full" />
          <span className="skeleton h-5 w-2/3" />
        </div>
      ) : positions.length === 0 && lps.length === 0 ? (
        <p className="mt-2 text-[0.88rem] text-ink-2">This wallet holds nothing in this market.</p>
      ) : (
        <>
          {positions.length > 0 && (
            <ul className="mt-3 divide-y divide-line">
              {positions.map((p) => (
                <li key={p.outcome} className="flex items-center justify-between gap-3 py-2 text-[0.88rem]">
                  <span className="inline-flex items-center gap-2">
                    <OutcomeSwatch outcome={p.outcome} />
                    <span className="font-[620]">{p.outcome === 'yes' ? 'Yes' : p.outcome === 'no' ? 'No' : 'Invalid result'}</span>
                    <span className="text-ink-3">
                      {formatAmount(p.balance, { maxDecimals: 2 })} tokens{p.avgPrice !== undefined ? ` at ${formatPrice(p.avgPrice)}` : ''}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="t-figure text-[1.05rem]">{formatAmount(p.value, { maxDecimals: 2 })}</span>{' '}
                    <span className="text-[0.75rem] text-ink-3">{symbol}</span>
                    {p.redeemable && redeem.runner.state !== 'done' && <span className="block text-[0.72rem] font-[650] text-ink">redeemable</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {lps.length > 0 && (
            <div className="mt-3">
              <p className="text-[0.78rem] font-[650] text-ink-3">Liquidity positions</p>
              <ul className="mt-1 divide-y divide-line">
                {lps.map((l) => (
                  <li key={l.tokenId} className="flex items-center justify-between gap-3 py-2 text-[0.86rem]">
                    <span className="inline-flex items-center gap-2">
                      <OutcomeSwatch outcome={l.outcome} />
                      {l.outcome === 'yes' ? 'Yes' : 'No'} pool
                      <span className={l.inRange ? 'text-ink-3' : 'font-[650] text-lumen-ink'}>{l.inRange ? 'in range' : 'out of range'}</span>
                    </span>
                    <span className="t-figure text-[1rem]">
                      {formatAmount(l.currentValue, { maxDecimals: 2 })} <span className="font-sans text-[0.72rem] font-[450] text-ink-3">{symbol}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[0.75rem] text-ink-3">Withdraw on the DEX at any time. {COPY.liquidityIsNotBounty.split('.')[0]}.</p>
            </div>
          )}
        </>
      )}

      {resolved && wallet.isConnected && (
        <div className="mt-4 border-t border-line pt-4">
          {Number(redeem.redeemable) > 0 ? (
            <>
              <p className="text-[0.88rem]">
                <span className="t-figure text-[1.35rem]">{formatAmount(redeem.redeemable, { maxDecimals: 2 })}</span> {symbol} redeemable
              </p>
              {redeem.runner.steps.length > 0 && redeem.runner.state !== 'idle' && <TxSteps runner={redeem.runner} className="mt-3" />}
              <Button
                className="mt-3 w-full"
                onClick={() => void (redeem.runner.state === 'failed' ? redeem.runner.retry() : redeem.runner.start())}
                loading={redeem.runner.state === 'running'}
                disabled={redeem.blockers.length > 0 || redeem.runner.state === 'done'}
                icon={<ArrowRightLeft size={15} aria-hidden />}
              >
                {redeem.runner.state === 'failed' ? 'Retry redemption' : 'Redeem'}
              </Button>
              {redeem.blockers.length > 0 && <p className="mt-2 text-[0.8rem] text-ink-2">{redeem.blockers[0]}</p>}
              {redeem.runner.error && (
                <p role="alert" className="untrusted mt-2 rounded-[3px] bg-flare-wash px-2.5 py-1.5 text-[0.82rem] text-flare-ink [white-space:normal]">
                  {redeem.runner.error}
                </p>
              )}
            </>
          ) : redeem.runner.state === 'done' ? (
            <p className="text-[0.88rem] font-[620]">Redeemed. The collateral is in your wallet.</p>
          ) : (
            <p className="text-[0.86rem] text-ink-2">Nothing left to redeem for this wallet.</p>
          )}
          {claim.outcome === 'invalid' && <Note className="mt-3">{COPY.invalidIsNotRefund} Only Invalid-result tokens redeem; Yes and No pay nothing.</Note>}
        </div>
      )}
      <p className="mt-4 text-[0.78rem] text-ink-3">
        <Link href="/dashboard" className="underline underline-offset-2">
          All positions on your dashboard
        </Link>
      </p>
    </section>
  )
}
