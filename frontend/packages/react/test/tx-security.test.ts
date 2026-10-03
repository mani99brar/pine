/** Security regressions for the tx runner: double-submit (two clicks, retries, two tabs) and the spending limit. */
import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex, TxStep, TxStepId } from '@pine/core'
import { createMemoryStorage } from '../src/internal/storage'
import { TX_IN_OTHER_TAB, TxMachine, txStorageKey, type PendingCheck, type StepProgress, type TxExecutor, type TxLockManager } from '../src/tx/machine'

const TO: Address = '0x1111111111111111111111111111111111111111'
const HASH = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex

function plan(): TxStep[] {
  return [
    { id: 'upload_manifest', label: 'Pin manifest', description: '', kind: 'offchain' },
    { id: 'create_market', label: 'Create market', description: '', kind: 'transaction', request: { chainId: 100, to: TO, data: '0x01', value: '0' } },
    { id: 'approve_collateral', label: 'Approve', description: '', kind: 'transaction', request: { chainId: 100, to: TO, data: '0x02', value: '0' } },
    {
      id: 'split_position',
      label: 'Split 25 sDAI',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: TO, data: '0x03', value: '0' },
      estimatedCost: { amount: '0.0004', currency: 'xDAI' },
      collateralCost: { amount: '25', currency: 'sDAI' },
    },
  ]
}

/** Scriptable executor: counts sends per step; `behave` decides what each send does. */
function scripted(behave: (id: TxStepId, n: number, progress: StepProgress) => Promise<{ txHash?: Hex }> = async () => ({})) {
  const sends: Record<string, number> = {}
  let pending: (id: TxStepId) => PendingCheck = () => ({ status: 'pending' })
  const executor: TxExecutor = {
    kind: 'live',
    async execute(step, progress) {
      sends[step.id] = (sends[step.id] ?? 0) + 1
      if (step.kind === 'offchain') return {}
      progress.onAwaitingSignature()
      return behave(step.id, sends[step.id]!, progress)
    },
    async checkPending(step) {
      return pending(step.id)
    },
  }
  return {
    executor,
    sends,
    setPending(fn: (id: TxStepId) => PendingCheck) {
      pending = fn
    },
  }
}

function fakeLocks(): TxLockManager {
  const held = new Set<string>()
  return {
    async request(name, _opts, cb) {
      if (held.has(name)) return cb(null)
      held.add(name)
      try {
        return await cb({ name })
      } finally {
        held.delete(name)
      }
    },
  }
}

describe('tx runner: double-submit protection', () => {
  it('clicking start twice (before hydration finished) runs every step once', async () => {
    const x = scripted(async (_id, n) => ({ txHash: HASH(n) }))
    const m = new TxMachine('dbl-click', plan(), { storage: createMemoryStorage(), executor: x.executor, spendingLimit: '50', limitCurrency: 'sDAI', locks: null })
    await Promise.all([m.start(), m.start(), m.start()])
    expect(m.getSnapshot().state).toBe('done')
    expect(x.sends).toEqual({ upload_manifest: 1, create_market: 1, approve_collateral: 1, split_position: 1 })
  })

  it('retrying a step whose transaction is still pending does not send a second one', async () => {
    // The split is broadcast, then the wait times out (slow chain).
    const x = scripted(async (id, n, progress) => {
      if (id === 'split_position' && n === 1) {
        progress.onSubmitted(HASH(0xaa))
        throw new Error('Timed out while waiting for transaction receipt')
      }
      return { txHash: HASH(n) }
    })
    const m = new TxMachine('slow-split', plan(), { storage: createMemoryStorage(), executor: x.executor, spendingLimit: '30', limitCurrency: 'sDAI', locks: null })
    await m.start()
    expect(m.getSnapshot().state).toBe('failed')
    expect(x.sends.split_position).toBe(1)

    // Still pending on-chain: retry re-checks and refuses to send again (it would split 25 more sDAI,
    // past the 30 sDAI limit, because the unconfirmed first split is not counted as spent).
    x.setPending(() => ({ status: 'pending' }))
    await m.retry()
    let split = m.getSnapshot().steps.find((s) => s.id === 'split_position')
    expect(x.sends.split_position).toBe(1)
    expect(split?.status).toBe('failed')
    expect(split?.error).toMatch(/still pending/)

    // It confirms: retry adopts it without a new transaction.
    x.setPending(() => ({ status: 'confirmed', result: { ok: true } }))
    await m.retry()
    split = m.getSnapshot().steps.find((s) => s.id === 'split_position')
    expect(split?.status).toBe('confirmed')
    expect(split?.txHash).toBe(HASH(0xaa))
    expect(x.sends.split_position).toBe(1)
    expect(m.getSnapshot().state).toBe('done')
    expect(m.getSnapshot().spent).toBe('25')
  })

  it('a known-failed earlier transaction (reverted/dropped) is re-sent on retry', async () => {
    const x = scripted(async (id, n, progress) => {
      if (id === 'create_market' && n === 1) {
        progress.onSubmitted(HASH(0xbb))
        throw new Error('The transaction reverted on-chain. Nothing was changed by this step.')
      }
      return { txHash: HASH(n) }
    })
    const m = new TxMachine('reverted', plan(), { storage: createMemoryStorage(), executor: x.executor, spendingLimit: '50', limitCurrency: 'sDAI', locks: null })
    await m.start()
    expect(m.getSnapshot().state).toBe('failed')
    x.setPending(() => ({ status: 'failed', error: 'The transaction reverted on-chain.' }))
    await m.retry()
    expect(x.sends.create_market).toBe(2)
    expect(m.getSnapshot().state).toBe('done')
    expect(m.getSnapshot().steps.find((s) => s.id === 'create_market')?.txHash).toBe(HASH(2))
  })

  it('an earlier transaction that cannot be checked (RPC error) is treated as possibly pending', async () => {
    const x = scripted(async (id, n, progress) => {
      if (id === 'create_market' && n === 1) {
        progress.onSubmitted(HASH(0xcc))
        throw new Error('Timed out')
      }
      return {}
    })
    const m = new TxMachine('rpc-down', plan(), { storage: createMemoryStorage(), executor: x.executor, locks: null })
    await m.start()
    x.executor.checkPending = async () => {
      throw new Error('fetch failed')
    }
    await m.retry()
    expect(x.sends.create_market).toBe(1)
    expect(m.getSnapshot().state).toBe('failed')
  })

  it('a second tab cannot run the same plan while the first is running', async () => {
    const storage = createMemoryStorage()
    const locks = fakeLocks()
    let release!: () => void
    const blocked = new Promise<void>((r) => (release = r))
    const a = scripted(async (id) => {
      if (id === 'create_market') await blocked
      return {}
    })
    const b = scripted()
    const tabA = new TxMachine('two-tabs', plan(), { storage, executor: a.executor, locks })
    const tabB = new TxMachine('two-tabs', plan(), { storage, executor: b.executor, locks })
    const runA = tabA.start()
    await vi.waitFor(() => expect(tabA.getSnapshot().steps[1]?.status).toBe('awaiting_signature'))
    await tabB.start()
    expect(tabB.getSnapshot().error).toBe(TX_IN_OTHER_TAB)
    expect(b.sends).toEqual({})
    release()
    await runA
    expect(tabA.getSnapshot().state).toBe('done')
  })

  it('a stale tab resumes from storage instead of re-running steps another tab confirmed', async () => {
    const storage = createMemoryStorage()
    const a = scripted(async (id) => {
      if (id === 'approve_collateral') throw new Error('User rejected the request.')
      return { txHash: HASH(1) }
    })
    const b = scripted(async () => ({ txHash: HASH(2) }))
    const tabB = new TxMachine('stale', plan(), { storage, executor: b.executor, locks: null })
    await tabB.hydrate() // loaded before tab A did anything
    const tabA = new TxMachine('stale', plan(), { storage, executor: a.executor, locks: null })
    await tabA.start()
    expect(tabA.getSnapshot().steps.map((s) => s.status)).toEqual(['confirmed', 'confirmed', 'failed', 'idle'])

    // Tab B still shows everything idle; skipping or starting there must not undo or repeat tab A's work.
    expect(tabB.getSnapshot().steps[1]?.status).toBe('idle')
    await tabB.start()
    expect(b.sends.upload_manifest).toBeUndefined()
    expect(b.sends.create_market).toBeUndefined()
    expect(b.sends).toEqual({ approve_collateral: 1, split_position: 1 })
    const persisted = JSON.parse(storage.getItem(txStorageKey('stale')) ?? '{}')
    expect(persisted.steps.create_market.status).toBe('confirmed')
    expect(persisted.steps.create_market.txHash).toBe(HASH(1))
  })
})

describe('tx runner: spending limit fails closed', () => {
  it('a cost that is not a valid amount blocks start and the step', async () => {
    for (const amount of ['abc', '-30', '']) {
      const steps = plan().map((s) => (s.id === 'split_position' ? { ...s, collateralCost: { amount, currency: 'sDAI' } } : s))
      const x = scripted()
      const m = new TxMachine(`bad-cost-${amount}`, steps, { storage: createMemoryStorage(), executor: x.executor, spendingLimit: '50', limitCurrency: 'sDAI', locks: null })
      expect(m.getSnapshot().limit?.within, amount).toBe(false)
      await m.start()
      expect(m.getSnapshot().error, amount).toMatch(/not a valid amount/)
      expect(x.sends, amount).toEqual({})
    }
  })

  it('a step whose cost becomes invalid after prepare is blocked before its prompt', async () => {
    const x = scripted()
    const m = new TxMachine('bad-prepare', plan(), {
      storage: createMemoryStorage(),
      executor: x.executor,
      spendingLimit: '50',
      limitCurrency: 'sDAI',
      locks: null,
      prepare: (s) => (s.id === 'split_position' ? { ...s, collateralCost: { amount: 'NaN', currency: 'sDAI' } } : s),
    })
    await m.start()
    expect(m.getSnapshot().steps.find((s) => s.id === 'split_position')?.error).toMatch(/not a valid amount/)
    expect(x.sends.split_position).toBeUndefined()
  })
})
