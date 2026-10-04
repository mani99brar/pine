/**
 * A machine hydrated before its steps are known (an api plan is verified again after a reload, so its steps arrive a
 * tick later): once they arrive, the runner state follows the persisted step statuses instead of staying 'idle'.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Address, TxStep, TxStepStatus } from '@pine/core'
import { createMemoryStorage } from '../src/internal/storage'
import { TxMachine, txStorageKey, type TxExecutor } from '../src/tx/machine'

const TO: Address = '0x1111111111111111111111111111111111111111'
const NOW = new Date('2026-10-04T12:00:00.000Z')

const steps: TxStep[] = [
  { id: 'plan:split', label: 'Split', description: '', kind: 'transaction', request: { chainId: 100, to: TO, data: '0x01', value: '0' } },
  { id: 'plan:approve', label: 'Approve', description: '', kind: 'transaction', request: { chainId: 100, to: TO, data: '0x02', value: '0' } },
]

function persisted(statuses: Record<string, { status: TxStepStatus; error?: string; txHash?: string }>, completedAt?: string) {
  const storage = createMemoryStorage()
  storage.setItem(txStorageKey('late'), JSON.stringify({ v: 1, steps: statuses, completedAt, updatedAt: NOW.toISOString() }))
  return storage
}

function machine(storage: ReturnType<typeof createMemoryStorage>, onDone = vi.fn()) {
  const execute = vi.fn()
  const executor: TxExecutor = { kind: 'live', execute, checkPending: async () => ({ status: 'pending' }) }
  const m = new TxMachine('late', [], { storage, executor, locks: null, onDone, now: () => NOW })
  return { m, execute, onDone }
}

describe('TxMachine: steps that arrive after hydration', () => {
  it('a failed step makes the runner failed (Try again stays available after a reload)', async () => {
    const { m, execute } = machine(persisted({ 'plan:split': { status: 'failed', error: 'User rejected the request.' } }))
    await m.hydrate()
    expect(m.getSnapshot().state).toBe('idle')
    m.setSteps(steps)
    expect(m.getSnapshot().state).toBe('failed')
    expect(m.getSnapshot().steps[0]?.error).toBe('User rejected the request.')
    expect(execute).not.toHaveBeenCalled()
  })

  it('some steps confirmed and the rest idle makes the runner paused, and nothing is sent until start()', async () => {
    const { m, execute } = machine(persisted({ 'plan:split': { status: 'confirmed', txHash: `0x${'ab'.repeat(32)}` } }))
    await m.hydrate()
    m.setSteps(steps)
    expect(m.getSnapshot().state).toBe('paused')
    expect(m.getSnapshot().current?.id).toBe('plan:approve')
    expect(execute).not.toHaveBeenCalled()
  })

  it('every step confirmed makes the runner done', async () => {
    const { m, onDone } = machine(
      persisted({ 'plan:split': { status: 'confirmed' }, 'plan:approve': { status: 'confirmed' } }, NOW.toISOString()),
    )
    await m.hydrate()
    m.setSteps(steps)
    expect(m.getSnapshot().state).toBe('done')
    // It had already finished before the reload: not finished a second time.
    expect(onDone).not.toHaveBeenCalled()
  })

  it('stays idle when nothing was persisted', async () => {
    const { m } = machine(createMemoryStorage())
    await m.hydrate()
    m.setSteps(steps)
    expect(m.getSnapshot().state).toBe('idle')
  })
})
