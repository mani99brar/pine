import { keccak256, stringToBytes } from 'viem'
import type { ActivityItem, Address, ClaimDetail, Evidence, Hex } from '@pine/core'
import type { PineDataProvider } from '@pine/data'
import { getChainOrDefault } from '@pine/core/chains'
import type { SerializedReceipt } from '../tx/live-executor'

/** Demo write paths of MockDataProvider (duck-typed so REST/Envio providers are unaffected). */
export interface DemoWritableProvider {
  addClaim(detail: ClaimDetail): void
  addEvidence(claimId: string, e: Evidence): void
  recordActivity(a: ActivityItem): void
  updateClaim?(id: string, patch: Partial<ClaimDetail>): void
}

export function demoWriter(data: PineDataProvider): DemoWritableProvider | null {
  const d = data as unknown as Partial<DemoWritableProvider>
  return typeof d.addClaim === 'function' && typeof d.addEvidence === 'function' && typeof d.recordActivity === 'function'
    ? (d as DemoWritableProvider)
    : null
}

/**
 * Chain where ERC-1497 evidence is submitted and Kleros arbitration is requested/paid.
 * Seer markets on Gnosis/Optimism/Base use a home proxy whose foreign proxy lives on Ethereum (1);
 * Ethereum markets use the L1 arbitrator directly; Sepolia stays on Sepolia
 * (docs/research/seer-integration.md, summary table).
 */
export function arbitrationChainId(marketChainId: number): number {
  return getChainOrDefault(marketChainId).arbitration.chainId
}

const NEW_MARKET_TOPIC: Hex = keccak256(stringToBytes('NewMarket(address,string,address,bytes32,bytes32,bytes32[])'))

/** Extracts the new market address from a create_market receipt (topics[1] of the NewMarket log). */
export function marketFromReceipt(result: unknown): Address | undefined {
  const r = result as Partial<SerializedReceipt> | undefined
  const log = r?.logs?.find((l) => l.topics[0]?.toLowerCase() === NEW_MARKET_TOPIC)
  const topic = log?.topics[1]
  if (!topic || topic.length !== 66) return undefined
  return `0x${topic.slice(26)}` as Address
}

export async function allocateDemoNumber(data: PineDataProvider): Promise<number> {
  const withNext = data as PineDataProvider & { nextClaimNumber?: () => number }
  if (typeof withNext.nextClaimNumber === 'function') {
    try {
      return withNext.nextClaimNumber()
    } catch {
      // fall through
    }
  }
  try {
    const page = await data.listClaims({ sort: 'newest', limit: 100 })
    const max = page.items.reduce((m, c) => Math.max(m, c.number), 0)
    return Math.max(max, page.total ?? 0) + 1
  } catch {
    return Math.floor(Date.now() / 1000) % 10_000
  }
}
