/** Publish/evidence hook regressions: no placeholder references or zero-address creator, no concurrent evidence runs. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { getPolicy } from '@pine/core'
import type { ClaimDraft, EvidenceDraft, SourceRef } from '@pine/core'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners, getTxMachine } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { txStorageKey } from '../src/tx/machine'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { publishRunKey } from '../src/composer/drafts'
import { usePublishClaim } from '../src/actions/publish'
import { useSubmitEvidence } from '../src/actions/evidence'

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
      assumptions: [],
      exclusions: [],
      environment: {
        ...d.spec.environment!,
        runtime: 'node 22.14.0',
        reproductionCommand: 'pnpm vitest run test/reporter-funding.spec.ts',
        setupSteps: [],
      },
    },
  }
}

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
})

afterEach(() => {
  cleanup()
})

describe('publish: immutable references', () => {
  it('never creates the market with the placeholder manifest URI when the pin result is missing', async () => {
    const id = 'dsecpending1'
    // Progress says the manifest step is done, but its result (the URI) is gone and the draft has none.
    localStorage.setItem(
      txStorageKey(publishRunKey(id)),
      JSON.stringify({ v: 1, steps: { upload_manifest: { status: 'confirmed', updatedAt: '2026-10-03T00:00:00.000Z' } }, updatedAt: '2026-10-03T00:00:00Z' }),
    )
    const { result } = renderHook(() => ({ composer: useClaimComposer(id), publish: usePublishClaim(id), wallet: useWallet() }), { wrapper })
    await waitFor(() => expect(result.current.composer.draft.id).toBe(id))
    act(() => result.current.composer.update((d) => completeSpec(d)))
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.publish.blockers).toEqual([]))
    await act(async () => {
      await result.current.publish.start()
    })
    const create = result.current.publish.steps.find((s) => s.id === 'create_market')
    expect(create?.status).toBe('failed')
    expect(create?.error).toMatch(/not been pinned/)
    expect(result.current.publish.frozen).toBe(false)
  })

  it('never pins a manifest whose creator is the zero address', async () => {
    const id = 'dseczero0001'
    const { result } = renderHook(() => ({ composer: useClaimComposer(id), publish: usePublishClaim(id), wallet: useWallet() }), { wrapper })
    await waitFor(() => expect(result.current.composer.draft.id).toBe(id))
    act(() => result.current.composer.update((d) => completeSpec(d)))
    await waitFor(() => expect(result.current.publish.steps.length).toBeGreaterThan(0))
    // No wallet connected: the UI blocks start, but the run must refuse even if reached directly.
    expect(result.current.publish.blockers.join(' ')).toMatch(/Connect a wallet/)
    const machine = getTxMachine(publishRunKey(id))
    expect(machine).toBeDefined()
    await act(async () => {
      await machine!.start()
    })
    await waitFor(() => expect(result.current.publish.steps.find((s) => s.id === 'upload_manifest')?.status).toBe('failed'))
    expect(result.current.publish.steps.find((s) => s.id === 'upload_manifest')?.error).toMatch(/Connect the wallet/)
    expect(result.current.publish.manifestUri).toBeUndefined()
  })
})

describe('evidence: one submission at a time', () => {
  const draft: EvidenceDraft = {
    claimId: 'pine-0009',
    kind: 'counterexample',
    title: 'Reporter deposit drawn from gas reserve after restart',
    summary: 'Restarting between plan and submit funds the deposit from the reserve.',
    reproduction: { command: 'pnpm vitest run test/repro.spec.ts', environment: 'node 22', expected: 'a', actual: 'b' },
    attachments: [],
    mode: 'direct',
  }

  it('a second submit while the first is running is refused instead of swapping the package', async () => {
    // Slow simulated wallet so the first run is still in flight when the second submit arrives.
    setDemoTxDelays({ signatureMs: 150, pendingMs: [150, 150], offchainMs: 50, switchMs: 10, resumeAfterMs: 1 })
    try {
      const { result } = renderHook(() => ({ ev: useSubmitEvidence('pine-0009'), wallet: useWallet() }), { wrapper })
      act(() => result.current.wallet.connect())
      await waitFor(() => expect(result.current.ev.blockers).toEqual([]))
      const submit = result.current.ev.submit
      let first!: Promise<void>
      await act(async () => {
        first = submit(draft)
        await vi.waitFor(() => expect(getTxMachine('evidence:pine-0009')?.getSnapshot().state).toBe('running'))
        const second = await submit({ ...draft, title: 'A different package' }).catch((e: unknown) => e)
        expect(second).toBeInstanceOf(Error)
        expect((second as Error).message).toMatch(/already in progress/)
        await first
      })
      expect(getTxMachine('evidence:pine-0009')?.getSnapshot().state).toBe('done')
    } finally {
      setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
    }
  })
})
