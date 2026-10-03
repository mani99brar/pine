import type { Config } from 'wagmi'
import {
  getAccount,
  getBytecode,
  getTransaction,
  getTransactionReceipt,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
} from 'wagmi/actions'
import type { Hex, TxStep } from '@pine/core'
import { isPlaceholderAddress } from '@pine/core/chains'
import { errorMessage } from '../internal/util'
import type { PendingCheck, StepOutcome, StepProgress, TxExecutor } from './machine'

/** JSON-safe subset of a receipt, persisted with step progress (used e.g. to find the new market address). */
export interface SerializedReceipt {
  blockNumber: string
  status: 'success' | 'reverted'
  contractAddress?: string | null
  logs: { address: string; topics: string[]; data: string }[]
}

function serializeReceipt(r: {
  blockNumber: bigint
  status: 'success' | 'reverted'
  contractAddress?: string | null
  logs: readonly { address: string; topics: readonly string[]; data: string }[]
}): SerializedReceipt {
  return {
    blockNumber: r.blockNumber.toString(),
    status: r.status,
    contractAddress: r.contractAddress ?? null,
    logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
  }
}

type ReplacementReason = 'cancelled' | 'replaced' | 'repriced'

/**
 * viem resolves `waitForTransactionReceipt` with the receipt of a replacement transaction whatever the
 * reason. Only a speed-up ('repriced': same target, value and calldata) did what the step intended; a
 * cancel or a different replacement must not mark the step confirmed (e.g. "market created").
 */
function replacementError(reason: ReplacementReason): Error {
  return new Error(
    reason === 'cancelled'
      ? 'The transaction was cancelled in your wallet. Nothing was done by this step.'
      : 'The transaction was replaced in your wallet by a different transaction. This step was not completed.',
  )
}

/** Real wallet executor: wagmi `sendTransaction` + `waitForTransactionReceipt`. */
export function createLiveExecutor(config: Config, opts?: { receiptTimeoutMs?: number }): TxExecutor {
  const timeout = opts?.receiptTimeoutMs ?? 10 * 60_000
  return {
    kind: 'live',
    async execute(step: TxStep, progress: StepProgress): Promise<StepOutcome> {
      if (step.kind === 'offchain') {
        throw new Error(`"${step.label}" needs an offchain handler; none was provided.`)
      }
      if (step.kind === 'signature') {
        throw new Error(`"${step.label}" needs a signature handler; none was provided.`)
      }
      const req = step.request
      if (!req) throw new Error(`"${step.label}" has no transaction request. Contract addresses may be unverified for this chain.`)
      // Never broadcast to a placeholder: a call to an address without code "succeeds" and would mark the
      // step confirmed (e.g. terms frozen without a market).
      if (isPlaceholderAddress(req.to)) {
        throw new Error(`"${step.label}" targets a placeholder address. Nothing was sent.`)
      }
      const account = getAccount(config)
      if (!account.address) throw new Error('Connect a wallet to continue.')
      if (account.chainId !== req.chainId) {
        await switchChain(config, { chainId: req.chainId })
        if (getAccount(config).chainId !== req.chainId) {
          throw new Error(`Switch your wallet to chain ${req.chainId} to continue. Nothing was sent.`)
        }
      }
      if (req.data && req.data !== '0x') {
        const code = await getBytecode(config, { address: req.to, chainId: req.chainId })
        if (!code || code === '0x') {
          throw new Error(`No contract is deployed at ${req.to} on chain ${req.chainId}. Nothing was sent.`)
        }
      }
      progress.onAwaitingSignature()
      const hash = await sendTransaction(config, {
        to: req.to,
        data: req.data,
        value: BigInt(req.value || '0'),
        chainId: req.chainId,
      })
      progress.onSubmitted(hash)
      let replaced: ReplacementReason | undefined
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: req.chainId,
        timeout,
        onReplaced: (r) => {
          replaced = r.reason
        },
      })
      if (replaced && replaced !== 'repriced') throw replacementError(replaced)
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain. Nothing was changed by this step.')
      return { txHash: (receipt.transactionHash as Hex | undefined) ?? hash, result: serializeReceipt(receipt) }
    },
    async checkPending(step: TxStep, txHash: Hex): Promise<PendingCheck> {
      const chainId = step.request?.chainId
      try {
        const receipt = await getTransactionReceipt(config, { hash: txHash, chainId })
        return receipt.status === 'success'
          ? { status: 'confirmed', result: serializeReceipt(receipt) }
          : { status: 'failed', error: 'The transaction reverted on-chain.' }
      } catch {
        // Not mined yet (or not found on this RPC): wait a bounded time.
      }
      try {
        let replaced: ReplacementReason | undefined
        const receipt = await waitForTransactionReceipt(config, {
          hash: txHash,
          chainId,
          timeout: 90_000,
          onReplaced: (r) => {
            replaced = r.reason
          },
        })
        if (replaced && replaced !== 'repriced') return { status: 'failed', error: replacementError(replaced).message }
        return receipt.status === 'success'
          ? { status: 'confirmed', result: serializeReceipt(receipt) }
          : { status: 'failed', error: 'The transaction reverted on-chain.' }
      } catch (e) {
        const msg = errorMessage(e)
        if (!/timed? ?out|not be found|not found/i.test(msg)) return { status: 'failed', error: msg }
      }
      // Still no receipt. If the node knows the transaction it is pending, and a new one must not be sent;
      // if it does not, it was dropped or replaced, and sending a new one is safe.
      try {
        await getTransaction(config, { hash: txHash, chainId })
        return { status: 'pending' }
      } catch (e) {
        const msg = errorMessage(e)
        if (/not be found|not found/i.test(msg)) {
          const where = chainId !== undefined ? ` on chain ${chainId}` : ''
          return { status: 'failed', error: `Transaction ${txHash} was not found${where}; it was dropped or replaced.` }
        }
        return { status: 'pending' }
      }
    },
  }
}
