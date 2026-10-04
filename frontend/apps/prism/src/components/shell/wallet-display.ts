import { getAddress } from 'viem'
import { shortHash } from '@pine/core'
import { getChain } from '@pine/core/chains'

/** EIP-55 form of an address for display (anything that is not an address is returned unchanged). */
export function checksummed(address: string): string {
  try {
    return getAddress(address)
  } catch {
    return address
  }
}

/** 0x1234…abCD in EIP-55 case, the form wallets show. */
export function shortAddress(address: string): string {
  return shortHash(checksummed(address))
}

/**
 * The network a wallet reports, by name. A chain Pine has no configuration for is named by its id, never as the
 * default chain (Gnosis): a wallet on the wrong network must look like one.
 */
export function walletNetworkName(chainId: number | undefined): string {
  if (chainId === undefined) return 'Unknown network'
  return getChain(chainId)?.name ?? `Unsupported network (chain id ${chainId})`
}
