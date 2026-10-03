import { getAddress } from 'viem'
import { shortHash } from '@pine/core'

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
