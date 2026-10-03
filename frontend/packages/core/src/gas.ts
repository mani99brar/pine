/**
 * Conservative gas-unit assumptions for cost estimates. These are not measurements of the deployed
 * contracts; wallets show the real figure before signing. Revisit once the Seer integration is verified.
 */
import { fromScaled, toScaled } from './decimal'
import type { DecimalString } from './types'

export const GAS_UNITS = {
  /** Seer createCategoricalMarket (2 outcomes + invalid): measured 1,654,645 on Gnosis (research §2); rounded up */
  createMarket: 1_700_000n,
  /** ERC-20 approve */
  approve: 60_000n,
  /** Router.splitPosition: transfer, CTF split, wrap three outcome tokens */
  split: 600_000n,
  /** Per pool: create + initialize pool when missing, approve outcome token, mint concentrated position */
  liquidityPerPool: 5_300_000n,
  /** Arbitration contract submitEvidence on Ethereum (event only; cost grows with URI length) */
  submitEvidence: 80_000n,
  /** Arbitration request on Ethereum (foreign proxy / Realitio_v2_1) */
  requestArbitration: 400_000n,
  /** Router.redeemPositions */
  redeem: 350_000n,
} as const

/** Native-token cost (decimal string) of `units` gas at `gasPriceGwei`. Exact bigint math. */
export function gasCost(units: bigint, gasPriceGwei: number | string, nativeDecimals = 18): DecimalString {
  const priceWei = toScaled(gasPriceGwei, 9)?.value ?? 0n
  const costWei = units * (priceWei < 0n ? 0n : priceWei)
  return fromScaled(costWei, nativeDecimals)
}
