import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { getPolicy } from '@pine/core'
import type { ClaimDraft, SourceRef, TxStep } from '@pine/core'
import { getMockDataProvider } from '@pine/data'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { useClaim, useClaims, usePolicies } from '../src/queries'
import { useDemoWallet, useWallet, demoWalletStore } from '../src/wallet'
import { useTxRunner, __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useDrafts } from '../src/composer/drafts'
import { usePublishClaim } from '../src/actions/publish'
import { useSubmitEvidence } from '../src/actions/evidence'
import { useHotkeys } from '../src/misc'

const FAST = { signatureMs: 1, pendingMs: [1, 2] as [number, number], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 }

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'mock', demoWallet: true }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

const SOURCE: SourceRef = {
  provider: 'github',
  owner: 'kleros',
  repo: 'gateway-balancer-bot',
  commit: {
    sha: 'c84e3dd7c01a2be9db29c372ed0006b55bf59ec0',
    message: 'Separate reporter deposit funding',
    author: 'dev',
    committedAt: '2026-10-02T09:00:00Z',
    htmlUrl: 'https://github.com/kleros/gateway-balancer-bot/commit/c84e3dd7c01a2be9db29c372ed0006b55bf59ec0',
  },
}

function completeSpec(d: ClaimDraft): ClaimDraft {
  const parameters: Record<string, string | string[] | boolean> = {}
  for (const p of getPolicy('BOT-001')?.parameters ?? []) {
    if (!p.required) continue
    const first = p.options?.[0]?.value ?? 'value'
    parameters[p.key] =
      p.kind === 'list' ? ['example'] : p.kind === 'multiselect' ? [first] : p.kind === 'boolean' ? true : p.kind === 'select' ? first : 'Example value for this parameter.'
  }
  return {
    ...d,
    source: SOURCE,
    spec: {
      ...d.spec,
      policyId: 'BOT-001',
      title: 'Reporter deposits never draw on the gas reserve',
      requirement: 'Reporter-deposit principal must not be funded from arbitration allocations or the operator gas reserve.',
      violation: 'reporter-deposit principal funded from the operator gas reserve',
      scope: { inScope: ['src/funding'], outOfScope: ['UI'] },
      parameters,
      faultModel: 'process crash between plan and submit',
      assumptions: ['Gas price below 50 gwei'],
      exclusions: ['Live transfers'],
      environment: {
        ...d.spec.environment!,
        runtime: 'node 22.14.0',
        reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts',
        setupSteps: ['pnpm install --frozen-lockfile'],
      },
    },
  }
}

beforeAll(() => {
  setDemoTxDelays(FAST)
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
})

afterEach(() => {
  cleanup()
})

describe('providers + queries', () => {
  it('usePine data flows through query hooks (mock)', async () => {
    const { result } = renderHook(() => ({ claims: useClaims({ status: 'open' }), claim: useClaim('pine-0009'), policies: usePolicies() }), { wrapper })
    await waitFor(() => expect(result.current.claims.data?.items.length).toBeGreaterThan(0))
    await waitFor(() => expect(result.current.claim.data?.id).toBe('pine-0009'))
    await waitFor(() => expect(result.current.policies.data?.length).toBe(3))
  })
})

describe('demo wallet', () => {
  it('connects the simulated wallet with a balance', async () => {
    const { result } = renderHook(() => ({ wallet: useWallet(), demo: useDemoWallet() }), { wrapper })
    expect(result.current.wallet.isConnected).toBe(false)
    expect(result.current.wallet.isDemo).toBe(true)
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.wallet.isConnected).toBe(true))
    expect(result.current.wallet.address).toMatch(/^0xDE30/i)
    expect(result.current.wallet.balance).toEqual({ amount: '1250', symbol: 'sDAI' })
    expect(result.current.demo.enabled).toBe(true)
  })
})

describe('useTxRunner (demo)', () => {
  const steps: TxStep[] = [
    { id: 'approve_collateral', label: 'Approve', description: '', kind: 'transaction', request: { chainId: 100, to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' } },
    {
      id: 'split_position',
      label: 'Split',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: '0x1111111111111111111111111111111111111111', data: '0x', value: '0' },
      estimatedCost: { amount: '10', currency: 'sDAI' },
    },
  ]

  it('failNext → failed → retry → done, persisted across a simulated reload', async () => {
    const first = renderHook(() => ({ runner: useTxRunner('hook-test', steps, { spendingLimit: '50' }), demo: useDemoWallet() }), { wrapper })
    await waitFor(() => expect(first.result.current.runner.hydrated).toBe(true))
    act(() => first.result.current.demo.failNext('split_position'))
    await act(async () => {
      await first.result.current.runner.start()
    })
    expect(first.result.current.runner.state).toBe('failed')
    expect(first.result.current.runner.steps[1]?.error).toBe('User rejected the request.')
    first.unmount()

    // Simulated reload: in-memory machines dropped, localStorage kept.
    __resetTxRunners()
    const second = renderHook(() => useTxRunner('hook-test', steps, { spendingLimit: '50' }), { wrapper })
    await waitFor(() => expect(second.result.current.hydrated).toBe(true))
    expect(second.result.current.steps.map((s) => s.status)).toEqual(['confirmed', 'failed'])
    expect(second.result.current.state).toBe('failed')
    await act(async () => {
      await second.result.current.retry()
    })
    expect(second.result.current.state).toBe('done')
    expect(second.result.current.spent).toBe('10')
  })

  it('spending limit blocks start', async () => {
    const { result } = renderHook(() => useTxRunner('hook-limit', steps, { spendingLimit: '5' }), { wrapper })
    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toMatch(/spending limit/)
  })
})

describe('composer → publish (demo)', () => {
  it('derives live, autosaves, publishes through manual liquidity steps and adds the claim', async () => {
    const id = 'dhooktest01'
    const { result } = renderHook(
      () => ({ composer: useClaimComposer(id), publish: usePublishClaim(id), wallet: useWallet(), drafts: useDrafts() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.composer.draft.id).toBe(id))
    expect(result.current.composer.question).toBeUndefined()
    expect(result.current.publish.blockers.length).toBeGreaterThan(0)

    act(() => result.current.composer.update((d) => completeSpec(d)))
    await waitFor(() => expect(result.current.composer.question?.text).toContain('reporter-deposit principal'))
    const firstHash = result.current.composer.manifestHash
    act(() => result.current.composer.update({ spec: { violation: 'reporter deposits drawn from arbitration allocations' } }))
    await waitFor(() => expect(result.current.composer.question?.text).toContain('arbitration allocations'))
    expect(result.current.composer.manifestHash).not.toBe(firstHash)

    // Autosave (600ms debounce) persists to the DraftStore.
    await waitFor(() => expect(result.current.composer.lastSavedAt).toBeDefined(), { timeout: 3000 })
    await waitFor(() => expect(result.current.drafts.drafts.some((d) => d.id === id)).toBe(true))

    expect(result.current.composer.validation.issues).toEqual([])
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.publish.blockers).toEqual([]))
    const reviewedHash = result.current.composer.manifestHash

    await act(async () => {
      await result.current.publish.start()
    })
    await waitFor(() => expect(result.current.publish.awaitingManual).toBe('add_liquidity_yes'), { timeout: 5000 })
    expect(result.current.publish.frozen).toBe(true)
    expect(result.current.publish.manifestHash).toBe(reviewedHash)
    expect(result.current.publish.manifestUri).toMatch(/^ipfs:\/\//)
    expect(result.current.publish.marketAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    const manual = result.current.publish.steps.find((s) => s.id === 'add_liquidity_yes')
    expect(manual?.manual).toBe(true)
    expect(manual?.actionUrl).toContain(result.current.publish.marketAddress!)

    // Terms are frozen: spec edits are ignored now.
    act(() => result.current.composer.update({ spec: { violation: 'something else' } }))
    expect(result.current.composer.question?.text).toContain('arbitration allocations')

    await act(async () => {
      await result.current.publish.confirmManual('add_liquidity_yes')
    })
    await waitFor(() => expect(result.current.publish.awaitingManual).toBe('add_liquidity_no'))
    act(() => result.current.publish.skip('add_liquidity_no'))
    await waitFor(() => expect(result.current.publish.state).toBe('done'))
    await waitFor(() => expect(result.current.publish.claimId).toBeDefined())

    const claimId = result.current.publish.claimId!
    const detail = await getMockDataProvider().getClaim(claimId)
    expect(detail?.manifestHash).toBe(reviewedHash)
    expect(detail?.status).toBe('open')
    expect(detail?.source.commitSha).toBe(SOURCE.commit.sha)
    // Recovery data mirrored into the draft.
    const draft = result.current.drafts.drafts.find((d) => d.id === id)
    expect(draft?.publication?.steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')).toBe(true)
  })
})

describe('useSubmitEvidence (demo)', () => {
  it('uploads, switches to the arbitration chain and records the evidence', async () => {
    const { result } = renderHook(() => ({ ev: useSubmitEvidence('pine-0009'), wallet: useWallet(), claim: useClaim('pine-0009') }), { wrapper })
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.ev.blockers).toEqual([]))
    expect(result.current.ev.chainId).toBe(1)
    const before = result.current.claim.data?.evidence.length ?? 0
    await act(async () => {
      await result.current.ev.submit({
        claimId: 'pine-0009',
        kind: 'counterexample',
        title: 'Reporter deposit drawn from gas reserve after restart',
        summary: 'Restarting between plan and submit funds the deposit from the reserve.',
        reproduction: {
          command: 'pnpm vitest run test/repro.spec.ts',
          environment: 'node 22',
          expected: 'deposit funded from reporter allocation',
          actual: 'deposit funded from gas reserve',
        },
        attachments: [],
        mode: 'direct',
      })
    })
    expect(result.current.ev.runner.state).toBe('done')
    expect(result.current.wallet.chainId).toBe(1)
    const evidence = await getMockDataProvider().listEvidence('pine-0009')
    expect(evidence.length).toBe(before + 1)
    expect(evidence.some((e) => e.title === 'Reporter deposit drawn from gas reserve after restart')).toBe(true)
  })
})

describe('useHotkeys', () => {
  it('handles mod+k, sequences and ignores plain keys in inputs', () => {
    const calls: string[] = []
    renderHook(() =>
      useHotkeys({
        'mod+k': () => calls.push('palette'),
        'g d': () => calls.push('dashboard'),
        '?': () => calls.push('help'),
        j: () => calls.push('next'),
      }),
    )
    const fire = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
    fire('k', { ctrlKey: true })
    fire('g')
    fire('d')
    fire('?', { shiftKey: true })
    fire('j')
    const input = document.createElement('input')
    document.body.appendChild(input)
    fire('j', {}, input)
    fire('k', { ctrlKey: true }, input)
    input.remove()
    expect(calls).toEqual(['palette', 'dashboard', 'help', 'next', 'palette'])
  })
})
