/**
 * useApiPlanRunner after a reload: a stored plan's progress is shown with the runner state it had (failed, paused), it
 * can be resumed, and resuming verifies the stored plan again before anything reaches the wallet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { useApiPlanRunner, type ApiPlanSpec, type CreatedPlan } from '../src/api/use-plan-runner'
import { ACCOUNT, MARKET, NOW, OTHER, resetChain, wirePlan } from './api-write-chain'
import { wrapper } from './api-write-support'

/** The wallet: records every step sent; rejects or never answers the prompt of a chosen step (a reload follows). */
const wallet = vi.hoisted(() => {
  const state = { sent: [] as string[], rejectAt: null as string | null, hangAt: null as string | null }
  const executor = {
    kind: 'live' as const,
    async execute(step: { id: string }, progress: { onAwaitingSignature(): void; onSubmitted(hash: `0x${string}`): void }) {
      progress.onAwaitingSignature()
      if (state.rejectAt === step.id) {
        state.rejectAt = null
        throw new Error('User rejected the request.')
      }
      if (state.hangAt === step.id) {
        state.hangAt = null
        return new Promise<never>(() => undefined)
      }
      state.sent.push(step.id)
      const hash = `0x${state.sent.length.toString(16).padStart(64, '0')}` as `0x${string}`
      progress.onSubmitted(hash)
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
const LIMITS = { maxTotalValueWei: 0n, maxApprovalAmount: 0n }
const commit = (id: string, byte: string) => ({ id, allowlistId: 'evidenceRegistry.commitEvidence' as const, args: [MARKET, `0x${byte.repeat(32)}` as Hex32] })
const twoStepWire = (planId: string, account = ACCOUNT) => wirePlan(planId, account, [commit('first', '41'), commit('second', '42')])

let created: number
let reports: string[]

function spec(): ApiPlanSpec {
  return {
    key: 'k',
    async create(): Promise<CreatedPlan> {
      created += 1
      return { wire: twoStepWire('plan-k'), planId: 'plan-k', expiresAt: NOW.getTime() + HOUR }
    },
    async submitted(planId, stepId, txHash) {
      reports.push(`${planId}:${stepId}:${txHash.slice(-2)}`)
    },
    markets: [MARKET],
    limits: LIMITS,
    now: () => NOW.getTime(),
  }
}

function render() {
  return renderHook(() => ({ runner: useApiPlanRunner(spec()), wallet: useWallet() }), { wrapper })
}

async function connected(result: { current: { wallet: ReturnType<typeof useWallet> } }) {
  act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.wallet.address?.toLowerCase()).toBe(ACCOUNT))
}

/** A page reload: the in-memory machines and the hook are gone, storage stays. */
async function reload(unmount: () => void) {
  unmount()
  __resetTxRunners()
  const next = render()
  await connected(next.result)
  await waitFor(() => expect(next.result.current.runner.plan?.planId).toBe('plan-k'))
  return next
}

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  resetChain()
  wallet.state.sent = []
  wallet.state.rejectAt = null
  wallet.state.hangAt = null
  created = 0
  reports = []
})

afterEach(() => {
  cleanup()
})

describe('useApiPlanRunner: a stored plan after a reload', () => {
  it('keeps a step rejected in the wallet failed, so it can be tried again or started over', async () => {
    const first = render()
    await connected(first.result)
    wallet.state.rejectAt = 'plan:first'
    await act(async () => {
      await first.result.current.runner.run()
    })
    expect(first.result.current.runner.runner.state).toBe('failed')

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(result.current.runner.runner.state).toBe('failed'))
    expect(result.current.runner.runner.steps[0]?.error).toBe('User rejected the request.')
    expect(result.current.runner.canResume).toBe(false)

    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.runner.state).toBe('done')
    expect(wallet.state.sent).toEqual(['plan:first', 'plan:second'])
    expect(created).toBe(1)
  })

  it('offers to continue a plan reloaded while a later step waited in the wallet, and continues it without planning again', async () => {
    const first = render()
    await connected(first.result)
    wallet.state.hangAt = 'plan:second'
    act(() => {
      void first.result.current.runner.run()
    })
    await waitFor(() => expect(first.result.current.runner.runner.steps[1]?.status).toBe('awaiting_signature'))

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(result.current.runner.runner.state).toBe('paused'))
    expect(result.current.runner.runner.steps.map((s) => s.status)).toEqual(['confirmed', 'idle'])
    expect(result.current.runner.canResume).toBe(true)

    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.runner.state).toBe('done')
    expect(result.current.runner.canResume).toBe(false)
    expect(wallet.state.sent).toEqual(['plan:first', 'plan:second'])
    expect(reports).toEqual(['plan-k:first:01', 'plan-k:second:02'])
    expect(created).toBe(1)
  })

  it('offers to continue a stored plan whose only prompt was interrupted by the reload', async () => {
    const first = render()
    await connected(first.result)
    wallet.state.hangAt = 'plan:first'
    act(() => {
      void first.result.current.runner.run()
    })
    await waitFor(() => expect(first.result.current.runner.runner.steps[0]?.status).toBe('awaiting_signature'))

    const { result } = await reload(first.unmount)
    expect(result.current.runner.runner.state).toBe('idle')
    expect(result.current.runner.canResume).toBe(true)
  })

  it('SEC-TX-08 Continue verifies the stored plan again and sends nothing when it no longer verifies', async () => {
    const first = render()
    await connected(first.result)
    wallet.state.hangAt = 'plan:second'
    act(() => {
      void first.result.current.runner.run()
    })
    await waitFor(() => expect(first.result.current.runner.runner.steps[1]?.status).toBe('awaiting_signature'))

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(result.current.runner.canResume).toBe(true))
    // The stored plan is replaced after it was shown (another script, a tampered store): it now names another wallet.
    const stored = JSON.parse(localStorage.getItem('pine:apiplan:k') ?? 'null') as Record<string, unknown>
    localStorage.setItem('pine:apiplan:k', JSON.stringify({ ...stored, wire: twoStepWire('plan-k', OTHER) }))

    await act(async () => {
      await result.current.runner.run()
    })
    expect(result.current.runner.phase).toBe('error')
    expect(wallet.state.sent).toEqual(['plan:first'])
    expect(result.current.runner.runner.steps[1]?.status).toBe('idle')
  })
})
