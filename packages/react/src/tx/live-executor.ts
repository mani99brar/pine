import type { Config } from 'wagmi'
import {
  getAccount,
  getTransactionReceipt,
  sendTransaction,
  switchChain,
  waitForTransactionReceipt,
} from 'wagmi/actions'
import type { Hex, TxStep } from '@pine/core'
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
      const account = getAccount(config)
      if (!account.address) throw new Error('Connect a wallet to continue.')
      if (account.chainId !== req.chainId) {
        await switchChain(config, { chainId: req.chainId })
      }
      progress.onAwaitingSignature()
      const hash = await sendTransaction(config, {
        to: req.to,
        data: req.data,
        value: BigInt(req.value || '0'),
        chainId: req.chainId,
      })
      progress.onSubmitted(hash)
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: req.chainId, timeout })
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain. Nothing was changed by this step.')
      return { txHash: hash, result: serializeReceipt(receipt) }
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
        const receipt = await waitForTransactionReceipt(config, { hash: txHash, chainId, timeout: 90_000 })
        return receipt.status === 'success'
          ? { status: 'confirmed', result: serializeReceipt(receipt) }
          : { status: 'failed', error: 'The transaction reverted on-chain.' }
      } catch (e) {
        const msg = errorMessage(e)
        if (/timed? ?out|not be found|not found/i.test(msg)) return { status: 'pending' }
        return { status: 'failed', error: msg }
      }
    },
  }
}
