/**
 * useApiPlanRunner / usePlanAction with a scripted wallet executor: an action's stored plan survives switching to other
 * actions, nothing is sent after a plan's offer expired, and a run that continues after the hook moved on reports to
 * its own plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Hex } from '@pine/core'
import type { Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { useApiPlanRunner, type ApiPlanSpec, type CreatedPlan } from '../src/api/use-plan-runner'
import { usePlanAction } from '../src/api/publish-plan'
import { ACCOUNT, MARKET, NOW, resetChain, wirePlan } from './api-write-chain'
import { wrapper } from './api-write-support'

/** The wallet: records every step sent; can reject the next prompt or hold a sent transaction until released. */
const wallet = vi.hoisted(() => {
  const state = {
    sent: [] as string[],
    rejectNext: false,
    hold: false,
    release: null as (() => void) | null,
  }
  const executor = {
    kind: 'live' as const,
    async execute(step: { id: string }, progress: { onAwaitingSignature(): void; onSubmitted(hash: `0x${string}`): void }) {
      progress.onAwaitingSignature()
      if (state.rejectNext) {
        state.rejectNext = false
        throw new Error('User rejected the request.')
      }
      state.sent.push(step.id)
      const hash = `0x${state.sent.length.toString(16).padStart(64, '0')}` as `0x${string}`
      progress.onSubmitted(hash)
      if (state.hold) await new Promise<void>((resolve) => (state.release = resolve))
      return { txHash: hash }
    },
    async checkPending() {
      return { status: 'pending' as const }
    },
  }
  return { state, executor }
})

vi.mock('../src/tx/demo-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tx/demo-executor')>()
  return { ...actual, createDemoExecutor: () => wallet.executor }
})

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const HOUR = 3_600_000
const commitWire = (planId: string) => wirePlan(planId, ACCOUNT, [{ id: 'commit', allowlistId: 'evidenceRegistry.commitEvidence', args: [MARKET, `0x${'42'.repeat(32)}` as Hex32] }])
const LIMITS = { maxTotalValueWei: 0n, maxApprovalAmount: 0n }

let clock: number
let created: string[]
let reports: string[]
let finished: string[]

/** A plan action whose backend plan is `plan-<key>`, offered for an hour unless `expiresAt` says otherwise. */
function specFor(key: string, opts: { expiresAt?: number | null } = {}) {
  return {
    async create(): Promise<CreatedPlan> {
      created.push(key)
      const expiresAt = opts.expiresAt === null ? undefined : (opts.expiresAt ?? NOW.getTime() + HOUR)
      return { wire: commitWire(`plan-${key}`), planId: `plan-${key}`, expiresAt }
    },
    async submitted(planId: string, stepId: string, txHash: Hex) {
      reports.push(`${key} → ${planId}:${stepId}:${txHash.slice(-2)}`)
    },
    onDone() {
      finished.push(key)
    },
    markets: [MARKET],
    limits: LIMITS,
    now: () => clock,
  }
}

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  resetChain()
  wallet.state.sent = []
  wallet.state.rejectNext = false
  wallet.state.hold = false
  wallet.state.release = null
  clock = NOW.getTime()
  created = []
  reports = []
  finished = []
})

afterEach(() => {
  cleanup()
})

async function connected<T extends { wallet: ReturnType<typeof useWallet> }>(result: { current: T }) {
  act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.wallet.address?.toLowerCase()).toBe(ACCOUNT))
}

describe('usePlanAction: switching actions', () => {
  it('SEC-TX-08 never removes the stored plan or progress of the action being switched to', async () => {
    const { result, rerender } = renderHook(({ k }: { k: string }) => ({ action: usePlanAction({ key: k, idleKey: 'idle', ...specFor(k) }), wallet: useWallet() }), {
      wrapper,
      initialProps: { k: 'a' },
    })
    await connected(result)
    await act(async () => {
      await result.current.action.runWhenReady('a')
    })
    expect(result.current.action.runner.runner.state).toBe('done')

    rerender({ k: 'b' })
    await act(async () => {
      await result.current.action.runWhenReady('b')
    })
    expect(result.current.action.runner.runner.state).toBe('done')
    const storedA = localStorage.getItem('pine:apiplan:a')
    const progressA = localStorage.getItem('pine:tx:api:a')

    // Back to the first action: its plan is shown again from storage, untouched.
    rerender({ k: 'a' })
    await waitFor(() => expect(result.current.action.runner.plan?.planId).toBe('plan-a'))
    expect(localStorage.getItem('pine:apiplan:a')).toBe(storedA)
    expect(localStorage.getItem('pine:tx:api:a')).toBe(progressA)
    await act(async () => {
      await result.current.action.runWhenReady('a')
    })
    // Neither planned nor sent a second time.
    expect(created).toEqual(['a', 'b'])
    expect(wallet.state.sent).toHaveLength(2)
    expect(reports).toEqual(['a → plan-a:commit:01', 'b → plan-b:commit:02'])
  })

  it('SEC-TX-08 keeps the idempotency key and plan of an action whose wallet prompt was rejected, and resumes it', async () => {
    const { result, rerender } = renderHook(({ k }: { k: string }) => ({ action: usePlanAction({ key: k, idleKey: 'idle', ...specFor(k) }), wallet: useWallet() }), {
      wrapper,
      initialProps: { k: 'a' },
    })
    await connected(result)
    wallet.state.rejectNext = true
    await act(async () => {
      await result.current.action.runWhenReady('a')
    })
    expect(result.current.action.runner.runner.state).toBe('failed')
    const storedA = localStorage.getItem('pine:apiplan:a')

    rerender({ k: 'b' })
    await act(async () => {
      await result.current.action.runWhenReady('b')
    })
    rerender({ k: 'a' })
    await act(async () => {
      await result.current.action.runWhenReady('a')
    })
    await waitFor(() => expect(result.current.action.runner.runner.state).toBe('done'))
    expect(JSON.parse(localStorage.getItem('pine:apiplan:a') ?? 'null')).toEqual(JSON.parse(storedA ?? 'null'))
    expect(created).toEqual(['a', 'b'])
  })
})

describe('useApiPlanRunner: offer expiry', () => {
  function render(spec: ApiPlanSpec) {
    return renderHook(() => ({ runner: useApiPlanRunner(spec), wallet: useWallet() }), { wrapper })
  }

  it('SEC-TX-08 sends nothing from a stored plan once its offer expired, whether resumed with run(), start() or retry()', async () => {
    const { result } = render({ key: 'k', ...specFor('k', { expiresAt: NOW.getTime() + 60_000 }) })
    await connected(result)
    wallet.state.rejectNext = true
    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.runner.state).toBe('failed')
    expect(result.current.runner.expiresAt).toBe(NOW.getTime() + 60_000)

    clock = NOW.getTime() + 60_000
    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.phase).toBe('error')
    expect(result.current.runner.error).toMatch(/offer has expired/)
    for (const resume of [() => result.current.runner.runner.start(), () => result.current.runner.runner.retry()]) {
      await act(async () => {
        await resume()
      })
      expect(result.current.runner.runner.steps[0]?.error).toMatch(/offer has expired/)
    }
    expect(wallet.state.sent).toEqual([])
    expect(reports).toEqual([])
    expect(created).toEqual(['k'])
  })

  it('still follows an expired plan whose steps were all sent', async () => {
    const { result } = render({ key: 'k', ...specFor('k', { expiresAt: NOW.getTime() + 60_000 }) })
    await connected(result)
    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.runner.state).toBe('done')
    clock = NOW.getTime() + HOUR
    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.error).toBeNull()
    expect(result.current.runner.runner.state).toBe('done')
    expect(wallet.state.sent).toHaveLength(1)
  })

  it('SEC-TX-08 never runs a plan that does not say when its offer ends', async () => {
    const { result } = render({ key: 'k', ...specFor('k', { expiresAt: null }) })
    await connected(result)
    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.error).toMatch(/does not say when its offer ends/)
    expect(wallet.state.sent).toEqual([])
  })
})

describe('callbacks stay with their own key', () => {
  it('SEC-TX-08 a run that confirms after the hook moved on reports to its own plan and finishes its own action', async () => {
    // The second action has a stored plan of its own (an earlier visit), which must not receive the first one's report.
    localStorage.setItem('pine:apiplan:b', JSON.stringify({ idempotencyKey: 'key-b', wire: commitWire('plan-b'), planId: 'plan-b', expiresAt: NOW.getTime() + HOUR }))
    const { result, rerender } = renderHook(({ k }: { k: string }) => ({ runner: useApiPlanRunner({ key: k, ...specFor(k) }), wallet: useWallet() }), {
      wrapper,
      initialProps: { k: 'a' },
    })
    await connected(result)
    wallet.state.hold = true
    act(() => {
      void result.current.runner.run()
    })
    await waitFor(() => expect(wallet.state.sent).toEqual(['plan:commit']))

    rerender({ k: 'b' }) // e.g. the wallet switched, or another action was opened, while a's transaction is pending
    await waitFor(() => expect(result.current.runner.plan?.planId).toBe('plan-b'))
    await act(async () => {
      wallet.state.release?.()
    })
    await waitFor(() => expect(finished).toEqual(['a']))
    expect(reports).toEqual(['a → plan-a:commit:01'])
  })
})
