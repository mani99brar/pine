/** Live executor regressions (wagmi actions mocked): placeholder targets, chain switching, replaced transactions. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from 'wagmi'
import type { Hex, TxStep } from '@pine/core'

const actions = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getBytecode: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  sendTransaction: vi.fn(),
  switchChain: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}))
vi.mock('wagmi/actions', () => actions)

import { createLiveExecutor } from '../src/tx/live-executor'

const config = {} as Config
const TO = '0x1111111111111111111111111111111111111111' as const
const H1 = `0x${'11'.repeat(32)}` as Hex
const H2 = `0x${'22'.repeat(32)}` as Hex
const progress = { onAwaitingSignature: vi.fn(), onSubmitted: vi.fn() }

function step(over: Partial<TxStep> = {}): TxStep {
  return { id: 'create_market', label: 'Create market', description: '', kind: 'transaction', request: { chainId: 100, to: TO, data: '0xabcdef', value: '0' }, ...over }
}

const receipt = (hash: Hex, status: 'success' | 'reverted' = 'success') => ({ transactionHash: hash, blockNumber: 1n, status, logs: [] })

beforeEach(() => {
  for (const f of Object.values(actions)) f.mockReset()
  progress.onAwaitingSignature.mockReset()
  progress.onSubmitted.mockReset()
  actions.getAccount.mockReturnValue({ address: TO, chainId: 100 })
  actions.getBytecode.mockResolvedValue('0x6080')
  actions.sendTransaction.mockResolvedValue(H1)
  actions.waitForTransactionReceipt.mockResolvedValue(receipt(H1))
})

describe('live executor: never sends to placeholders or non-contracts', () => {
  it('refuses the zero address before any wallet prompt', async () => {
    const ex = createLiveExecutor(config)
    await expect(ex.execute(step({ request: { chainId: 100, to: '0x0000000000000000000000000000000000000000', data: '0x01', value: '0' } }), progress)).rejects.toThrow(/placeholder/)
    expect(actions.sendTransaction).not.toHaveBeenCalled()
    expect(progress.onAwaitingSignature).not.toHaveBeenCalled()
  })

  it('refuses a call to an address without contract code on the target chain', async () => {
    actions.getBytecode.mockResolvedValue(undefined)
    const ex = createLiveExecutor(config)
    await expect(ex.execute(step(), progress)).rejects.toThrow(/No contract is deployed/)
    expect(actions.sendTransaction).not.toHaveBeenCalled()
  })

  it('switches chain first and refuses to send when the wallet did not switch', async () => {
    actions.getAccount.mockReturnValue({ address: TO, chainId: 1 })
    actions.switchChain.mockResolvedValue(undefined)
    const ex = createLiveExecutor(config)
    await expect(ex.execute(step(), progress)).rejects.toThrow(/Switch your wallet to chain 100/)
    expect(actions.switchChain).toHaveBeenCalledWith(config, { chainId: 100 })
    expect(actions.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('live executor: replaced transactions', () => {
  it('a transaction cancelled in the wallet is not reported as confirmed', async () => {
    actions.waitForTransactionReceipt.mockImplementation(async (_c: Config, p: { onReplaced?: (r: { reason: string }) => void }) => {
      p.onReplaced?.({ reason: 'cancelled' })
      return receipt(H2) // viem resolves with the cancel transaction's (successful) receipt
    })
    const ex = createLiveExecutor(config)
    await expect(ex.execute(step(), progress)).rejects.toThrow(/cancelled/)
  })

  it('a different replacement transaction is not reported as confirmed', async () => {
    actions.waitForTransactionReceipt.mockImplementation(async (_c: Config, p: { onReplaced?: (r: { reason: string }) => void }) => {
      p.onReplaced?.({ reason: 'replaced' })
      return receipt(H2)
    })
    await expect(createLiveExecutor(config).execute(step(), progress)).rejects.toThrow(/replaced/)
  })

  it('a sped-up (repriced) transaction confirms with the replacement hash', async () => {
    actions.waitForTransactionReceipt.mockImplementation(async (_c: Config, p: { onReplaced?: (r: { reason: string }) => void }) => {
      p.onReplaced?.({ reason: 'repriced' })
      return receipt(H2)
    })
    const out = await createLiveExecutor(config).execute(step(), progress)
    expect(out.txHash).toBe(H2)
  })
})

describe('live executor: checkPending', () => {
  it('reports pending while the node still knows the transaction, and failed once it was dropped', async () => {
    actions.getTransactionReceipt.mockRejectedValue(new Error('Transaction receipt could not be found'))
    actions.waitForTransactionReceipt.mockRejectedValue(new Error('Timed out while waiting for transaction'))
    actions.getTransaction.mockResolvedValue({ hash: H1 })
    const ex = createLiveExecutor(config)
    expect(await ex.checkPending(step(), H1, undefined)).toEqual({ status: 'pending' })

    actions.getTransaction.mockRejectedValue(new Error('Transaction with hash could not be found'))
    const dropped = await ex.checkPending(step(), H1, undefined)
    expect(dropped.status).toBe('failed')
  })

  it('a cancelled earlier transaction is failed, not confirmed', async () => {
    actions.getTransactionReceipt.mockRejectedValue(new Error('not found'))
    actions.waitForTransactionReceipt.mockImplementation(async (_c: Config, p: { onReplaced?: (r: { reason: string }) => void }) => {
      p.onReplaced?.({ reason: 'cancelled' })
      return receipt(H2)
    })
    expect((await createLiveExecutor(config).checkPending(step(), H1, undefined)).status).toBe('failed')
  })
})
