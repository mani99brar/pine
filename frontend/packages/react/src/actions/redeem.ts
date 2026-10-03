'use client'

import { useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { parseUnits } from 'viem'
import { buildRedeemTx } from '@pine/core'
import type { DecimalString, OutcomePosition, TxStep } from '@pine/core'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { useClaim, usePortfolio } from '../queries'
import { useWallet } from '../wallet'
import { isoNow, sumDecimals, fakeHash } from '../internal/util'
import { useTxRunner, type TxRunner } from '../tx/use-tx-runner'
import { demoWriter } from './shared'

const OUTCOME_LABEL: Record<OutcomePosition['outcome'], RegExp> = {
  yes: /^yes$/i,
  no: /^no$/i,
  invalid: /invalid/i,
}

/**
 * Redeems the connected wallet's resolved positions in a claim's market (Seer Router
 * `redeemPositions`). Payouts follow Seer's native rules, including for invalid outcomes.
 */
export function useRedeem(claimId: string): {
  runner: TxRunner
  redeemable: DecimalString
  // Additive
  positions: OutcomePosition[]
  blockers: string[]
} {
  const { data, demo } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const claim = useClaim(claimId).data ?? undefined
  const portfolio = usePortfolio(wallet.address).data

  const positions = useMemo(
    () => (portfolio?.positions ?? []).filter((p) => p.claimId === claimId && p.redeemable),
    [portfolio, claimId],
  )
  const redeemable = useMemo(
    () => sumDecimals(positions.map((p) => p.redeemableAmount ?? p.value)),
    [positions],
  )

  const { steps, buildError } = useMemo(() => {
    const market = claim?.market
    if (!market || positions.length === 0) return { steps: [] as TxStep[], buildError: undefined }
    try {
      const outcomeIndexes: number[] = []
      const amounts: bigint[] = []
      for (const p of positions) {
        const idx =
          market.outcomes.find((o) => OUTCOME_LABEL[p.outcome].test(o.label))?.index ??
          (p.outcome === 'yes' ? 0 : p.outcome === 'no' ? 1 : 2)
        outcomeIndexes.push(idx)
        amounts.push(parseUnits(p.balance, market.collateral.decimals))
      }
      return {
        steps: [buildRedeemTx({ chainId: market.chainId, market: market.address, outcomeIndexes, amounts, allowPlaceholderAddresses: demo })],
        buildError: undefined,
      }
    } catch (e) {
      return { steps: [] as TxStep[], buildError: e instanceof Error ? e.message : String(e) }
    }
  }, [claim, positions, demo])

  const onDone = useCallback(async () => {
    const writer = demoWriter(data)
    if (writer && claim && wallet.address) {
      writer.recordActivity({
        id: `${claimId}-redeem-${Date.now()}`,
        type: 'redeemed',
        claimId,
        claimNumber: claim.number,
        claimTitle: claim.title,
        actor: wallet.address,
        at: isoNow(),
        txHash: fakeHash('redeem', claimId, Date.now()),
        chainId: claim.chainId,
        amount: redeemable,
        token: claim.collateralSymbol,
        summary: `Redeemed ${redeemable} ${claim.collateralSymbol}`,
        status: 'confirmed',
      })
    }
    await qc.invalidateQueries({ queryKey: pineKeys.portfolio(wallet.address) })
    await qc.invalidateQueries({ queryKey: ['pine', 'activity'] })
  }, [data, claim, claimId, wallet.address, redeemable, qc])

  const runner = useTxRunner(`redeem:${claimId}:${wallet.address?.toLowerCase() ?? 'none'}`, steps, { onDone })

  const blockers = useMemo(() => {
    const out: string[] = []
    if (!wallet.isConnected) out.push('Connect a wallet to redeem.')
    else if (positions.length === 0) out.push('Nothing to redeem for this wallet.')
    if (buildError) out.push(buildError)
    if (!demo && steps.some((s) => !s.request)) out.push('Router or collateral address is unverified for this chain.')
    return out
  }, [wallet.isConnected, positions.length, buildError, demo, steps])

  return {
    runner,
    redeemable: runner.state === 'done' ? '0' : redeemable,
    positions,
    blockers,
  }
}
