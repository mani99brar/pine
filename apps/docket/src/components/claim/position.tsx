'use client'

import type { ClaimDetail } from '@pine/core'
import { formatAmount, formatPrice } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { usePortfolio, useRedeem, useWallet } from '@pine/react'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DefinitionList, Skeleton } from '@/components/ui/layout'
import { Notice } from '@/components/ui/notice'
import { TxSteps } from '@/components/tx/tx-steps'

export function PositionSection({ claim }: { claim: ClaimDetail }) {
  const wallet = useWallet()
  const portfolio = usePortfolio(wallet.address)
  const sym = claim.collateralSymbol
  const positions = portfolio.data?.positions.filter((p) => p.claimId === claim.id) ?? []
  const lps = portfolio.data?.liquidity.filter((p) => p.claimId === claim.id) ?? []
  const decided = claim.status === 'resolved' || claim.status === 'settled'

  return (
    <div className="space-y-8">
      {claim.funding ? (
        <div>
          <h3 className="text-xl">What the filer committed</h3>
          <DefinitionList
            className="mt-3"
            items={[
              {
                term: 'Liquidity deposited',
                value: formatAmount(claim.funding.liquidity, { symbol: sym }),
                note: 'Capital at risk. It subsidizes informed trading; it is not a bounty.',
              },
              { term: 'Spending limit', value: formatAmount(claim.funding.spendingLimit, { symbol: sym }) },
              {
                term: 'Can be withdrawn',
                value: claim.funding.withdrawable ? 'Yes, at any time' : 'No',
                note: claim.funding.withdrawable
                  ? 'Nothing in the protocol locks it for the investigation period. Withdrawing reduces depth for investigators.'
                  : undefined,
              },
            ]}
          />
        </div>
      ) : null}

      <div>
        <h3 className="text-xl">Your position</h3>
        {!wallet.isConnected ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border border-dashed border-rule-strong bg-sheet px-5 py-4">
            <p className="text-graphite">Connect a wallet to see any outcome tokens or liquidity you hold in this market.</p>
            <Button variant="secondary" icon={<Wallet aria-hidden />} onClick={() => wallet.connect()}>
              Connect wallet
            </Button>
          </div>
        ) : portfolio.isLoading ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-1/3" />
          </div>
        ) : positions.length === 0 && lps.length === 0 ? (
          <p className="mt-2 text-graphite">This wallet holds no outcome tokens or liquidity in this market.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {positions.length > 0 ? (
              <div className="overflow-x-auto border border-rule bg-sheet">
                <table className="w-full min-w-[32rem] text-left text-[15px]">
                  <caption className="sr-only">Outcome tokens held</caption>
                  <thead className="border-b border-rule bg-bond text-sm text-graphite">
                    <tr>
                      <th scope="col" className="px-4 py-2">Outcome</th>
                      <th scope="col" className="px-4 py-2 text-right">Tokens</th>
                      <th scope="col" className="px-4 py-2 text-right">Mark price</th>
                      <th scope="col" className="px-4 py-2 text-right">Value</th>
                      <th scope="col" className="px-4 py-2 text-right">Redeemable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule tabular">
                    {positions.map((p, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2.5 font-bold capitalize">{p.outcome}</td>
                        <td className="px-4 py-2.5 text-right">{formatAmount(p.balance, { maxDecimals: 2 })}</td>
                        <td className="px-4 py-2.5 text-right">{formatPrice(p.markPrice)}</td>
                        <td className="px-4 py-2.5 text-right">{formatAmount(p.value, { symbol: sym, maxDecimals: 2 })}</td>
                        <td className="px-4 py-2.5 text-right">
                          {p.redeemable ? formatAmount(p.redeemableAmount ?? p.value, { symbol: sym, maxDecimals: 2 }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {lps.length > 0 ? (
              <ul className="divide-y divide-rule border-y border-rule">
                {lps.map((l) => (
                  <li key={l.tokenId} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-[15px]">
                    <span>
                      <strong>Liquidity in the {l.outcome === 'yes' ? 'Yes' : 'No'} pool</strong>
                      {l.inRange ? '' : ', out of range'}
                    </span>
                    <span className="text-graphite">
                      Deposited {formatAmount(l.deposited, { symbol: sym, maxDecimals: 2 })}, now worth{' '}
                      <strong className="text-ink">{formatAmount(l.currentValue, { symbol: sym, maxDecimals: 2 })}</strong>, fees earned{' '}
                      {formatAmount(l.feesEarned, { symbol: sym, maxDecimals: 2 })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {decided ? <RedeemPanel claim={claim} /> : null}
          </div>
        )}
        {claim.outcome === 'invalid' ? (
          <p className="mt-3 text-sm text-graphite">
            {COPY.invalidIsNotRefund}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function RedeemPanel({ claim }: { claim: ClaimDetail }) {
  const { runner, redeemable } = useRedeem(claim.id)
  const has = Number(redeemable) > 0
  if (!has && runner.state !== 'done') {
    return <Notice tone="neutral">Nothing left to redeem from this wallet.</Notice>
  }
  return (
    <div className="border border-rule bg-sheet p-5">
      <h4 className="text-lg font-bold">Redeem {formatAmount(redeemable, { symbol: claim.collateralSymbol, maxDecimals: 4 })}</h4>
      <p className="mt-1 text-[15px] text-graphite measure">
        Redeeming burns your winning outcome tokens and returns collateral according to the market&rsquo;s native payout rules.
      </p>
      <div className="mt-4">
        <TxSteps runner={runner} startLabel="Redeem" doneLabel="Redeemed" />
      </div>
    </div>
  )
}
