import { describe, expect, it, vi } from 'vitest'
import { buildPublishSteps, buildQuestion, getPolicy } from '@pine/core'
import type { Address, Hex, TxStep, TxStepId } from '@pine/core'
import { createMemoryStorage, type KeyValueStorage } from '../src/internal/storage'
import { createDemoExecutor, DEMO_REJECTION_MESSAGE } from '../src/tx/demo-executor'
import { TxMachine, txStorageKey, type PendingCheck, type StepProgress, type TxExecutor } from '../src/tx/machine'
import { createDefaultDraft, deriveComposer } from '../src/composer/defaults'

const TO: Address = '0x1111111111111111111111111111111111111111'

function fakeWallet() {
  let failNext: TxStepId | 'any' | null = null
  let chainId: number | undefined = 100
  const spent: { amount: string; kind: string }[] = []
  return {
    failNext(id?: TxStepId) {
      failNext = id ?? 'any'
    },
    consumeFailure(id: TxStepId) {
      if (failNext === 'any' || failNext === id) {
        failNext = null
        return true
      }
      return false
    },
    recordSpend(amount: string, kind: 'collateral' | 'native') {
      spent.push({ amount, kind })
    },
    switchChain(id: number) {
      chainId = id
    },
    currentChainId() {
      return chainId
    },
    spent,
    get chainId() {
      return chainId
    },
  }
}

const FAST = { signatureMs: 0, pendingMs: [0, 0] as [number, number], offchainMs: 0, switchMs: 0, resumeAfterMs: 0 }

function plan(): TxStep[] {
  return [
    { id: 'upload_manifest', label: 'Pin manifest', description: '', kind: 'offchain', estimatedCost: { amount: '0', currency: 'sDAI' } },
    {
      id: 'create_market',
      label: 'Create market',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: TO, data: '0x01', value: '0' },
      estimatedCost: { amount: '0.004', currency: 'xDAI' },
      freezesTerms: true,
    },
    {
      id: 'approve_collateral',
      label: 'Approve exactly 25 sDAI',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: TO, data: '0x02', value: '0' },
      estimatedCost: { amount: '0.0002', currency: 'xDAI' },
    },
    {
      id: 'split_position',
      label: 'Split 25 sDAI',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: TO, data: '0x03', value: '0' },
      estimatedCost: { amount: '25', currency: 'sDAI' },
    },
    {
      id: 'add_liquidity_no',
      label: 'Optional extra',
      description: '',
      kind: 'transaction',
      request: { chainId: 100, to: TO, data: '0x04', value: '0' },
      estimatedCost: { amount: '0.0003', currency: 'xDAI' },
      optional: true,
    },
  ]
}

function machine(storage: KeyValueStorage, wallet = fakeWallet(), extra: Partial<ConstructorParameters<typeof TxMachine>[2]> = {}, steps = plan()) {
  return new TxMachine('publish:test', steps, {
    storage,
    executor: createDemoExecutor({ wallet, collateralSymbol: 'sDAI', delays: FAST }),
    limitCurrency: 'sDAI',
    spendingLimit: '50',
    ...extra,
  })
}

describe('TxMachine', () => {
  it('runs every step to done, persisting progress and fake tx hashes', async () => {
    const storage = createMemoryStorage()
    const onDone = vi.fn()
    const m = machine(storage, fakeWallet(), { onDone })
    await m.hydrate()
    expect(m.getSnapshot().state).toBe('idle')
    await m.start()
    const s = m.getSnapshot()
    expect(s.state).toBe('done')
    expect(s.steps.every((x) => x.status === 'confirmed')).toBe(true)
    expect(s.steps.find((x) => x.id === 'create_market')?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(s.spent).toBe('25')
    expect(onDone).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(storage.getItem(txStorageKey('publish:test')) ?? '{}')
    expect(persisted.steps.split_position.status).toBe('confirmed')
    expect(persisted.completedAt).toBeTruthy()
  })

  it('failNext → failed → retry → done', async () => {
    const storage = createMemoryStorage()
    const wallet = fakeWallet()
    const m = machine(storage, wallet)
    wallet.failNext('approve_collateral')
    await m.start()
    let s = m.getSnapshot()
    expect(s.state).toBe('failed')
    const failed = s.steps.find((x) => x.status === 'failed')
    expect(failed?.id).toBe('approve_collateral')
    expect(failed?.error).toBe(DEMO_REJECTION_MESSAGE)
    // Earlier steps stay confirmed (terms frozen after create_market).
    expect(s.steps.find((x) => x.id === 'create_market')?.status).toBe('confirmed')
    expect(s.current?.id).toBe('approve_collateral')
    await m.retry()
    s = m.getSnapshot()
    expect(s.state).toBe('done')
    expect(s.steps.every((x) => x.status === 'confirmed')).toBe(true)
  })

  it('blocks start when the plan exceeds the spending limit', async () => {
    const storage = createMemoryStorage()
    const execute = vi.fn()
    const m = new TxMachine('limit', plan(), {
      storage,
      executor: { kind: 'demo', execute, checkPending: async () => ({ status: 'pending' }) },
      spendingLimit: '20',
      limitCurrency: 'sDAI',
    })
    await m.start()
    const s = m.getSnapshot()
    expect(s.state).toBe('idle')
    expect(s.error).toMatch(/spending limit/i)
    expect(s.error).toContain('25')
    expect(s.limit).toEqual({ limit: '20', required: '25', currency: 'sDAI', within: false })
    expect(execute).not.toHaveBeenCalled()
    // Raising the limit clears the block.
    m.setOptions({ spendingLimit: '30', limitCurrency: 'sDAI' })
    expect(m.getSnapshot().error).toBeUndefined()
    expect(m.getSnapshot().limit?.within).toBe(true)
  })

  it('counts a collateral deposit toward the limit even when the fee is in the native token', async () => {
    const storage = createMemoryStorage()
    const execute = vi.fn()
    const steps = plan().map((st) =>
      st.id === 'split_position'
        ? { ...st, estimatedCost: { amount: '0.0004', currency: 'xDAI' }, collateralCost: { amount: '25', currency: 'sDAI' } }
        : st,
    )
    const m = new TxMachine('limit-collateral', steps, {
      storage,
      executor: { kind: 'demo', execute, checkPending: async () => ({ status: 'pending' }) },
      spendingLimit: '20',
      limitCurrency: 'sDAI',
    })
    await m.start()
    expect(m.getSnapshot().limit).toEqual({ limit: '20', required: '25', currency: 'sDAI', within: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it('skips an optional failed step and finishes', async () => {
    const storage = createMemoryStorage()
    const wallet = fakeWallet()
    const m = machine(storage, wallet)
    wallet.failNext('add_liquidity_no')
    await m.start()
    expect(m.getSnapshot().state).toBe('failed')
    m.skip('create_market') // required: refused
    expect(m.getSnapshot().error).toMatch(/required/)
    m.skip('add_liquidity_no')
    const s = m.getSnapshot()
    expect(s.steps.find((x) => x.id === 'add_liquidity_no')?.status).toBe('skipped')
    expect(s.state).toBe('done')
  })

  it('resumes after a reload: re-checks the pending tx and pauses at the first incomplete step', async () => {
    const storage = createMemoryStorage()
    // An executor that submits create_market and then "crashes" (never resolves), like a closed tab.
    const hang: TxExecutor = {
      kind: 'demo',
      async execute(step: TxStep, progress: StepProgress) {
        if (step.kind === 'offchain') return {}
        progress.onAwaitingSignature()
        progress.onSubmitted(`0x${'ab'.repeat(32)}` as Hex)
        return new Promise(() => {})
      },
      async checkPending(): Promise<PendingCheck> {
        return { status: 'pending' }
      },
    }
    const first = new TxMachine('publish:reload', plan(), { storage, executor: hang, spendingLimit: '50', limitCurrency: 'sDAI' })
    void first.start()
    await vi.waitFor(() => expect(first.getSnapshot().steps[1]?.status).toBe('pending'))
    const persisted = JSON.parse(storage.getItem(txStorageKey('publish:reload')) ?? '{}')
    expect(persisted.steps.create_market).toMatchObject({ status: 'pending', txHash: `0x${'ab'.repeat(32)}` })

    // "Reload": a brand-new machine over the same storage, demo executor (pending older than 0ms → confirmed).
    const onConfirmed = vi.fn()
    const second = new TxMachine('publish:reload', plan(), {
      storage,
      executor: createDemoExecutor({ wallet: fakeWallet(), delays: FAST }),
      spendingLimit: '50',
      limitCurrency: 'sDAI',
      onConfirmed,
    })
    await second.hydrate()
    let s = second.getSnapshot()
    expect(s.steps.map((x) => x.status)).toEqual(['confirmed', 'confirmed', 'idle', 'idle', 'idle'])
    expect(s.state).toBe('paused')
    expect(s.current?.id).toBe('approve_collateral')
    expect(onConfirmed).toHaveBeenCalledWith(expect.objectContaining({ id: 'create_market' }), expect.anything())
    await second.start()
    s = second.getSnapshot()
    expect(s.state).toBe('done')
  })

  it('a step interrupted while awaiting a signature returns to idle on reload', async () => {
    const storage = createMemoryStorage()
    storage.setItem(
      txStorageKey('sig'),
      JSON.stringify({
        v: 1,
        steps: { upload_manifest: { status: 'confirmed' }, create_market: { status: 'awaiting_signature', startedAt: '2026-10-03T00:00:00Z' } },
        updatedAt: '2026-10-03T00:00:00Z',
      }),
    )
    const m = new TxMachine('sig', plan(), {
      storage,
      executor: createDemoExecutor({ wallet: fakeWallet(), delays: FAST }),
    })
    await m.hydrate()
    const s = m.getSnapshot()
    expect(s.steps[1]?.status).toBe('idle')
    expect(s.state).toBe('paused')
  })

  it('a step that would exceed the remaining limit is blocked before its prompt', async () => {
    const storage = createMemoryStorage()
    const steps = plan()
    const m = machine(storage, fakeWallet(), { spendingLimit: '30' }, steps)
    // Plan is within the limit (25 ≤ 30) …
    expect(m.getSnapshot().limit?.within).toBe(true)
    // … but the split step grows to 40 after a re-prepare (e.g. amounts changed): blocked.
    m.setOptions({
      spendingLimit: '30',
      limitCurrency: 'sDAI',
      prepare: (s) => (s.id === 'split_position' ? { ...s, estimatedCost: { amount: '40', currency: 'sDAI' } } : s),
    })
    await m.start()
    const s = m.getSnapshot()
    expect(s.state).toBe('failed')
    expect(s.steps.find((x) => x.id === 'split_position')?.error).toMatch(/above your limit/)
  })

  it('runs offchain handlers and passes results to prepare', async () => {
    const storage = createMemoryStorage()
    const upload = vi.fn(async () => ({ result: { uri: 'ipfs://bafyexample' } }))
    const seen: string[] = []
    const m = machine(storage, fakeWallet(), {
      handlers: { upload_manifest: upload },
      prepare: (s, results) => {
        if (s.id === 'create_market') seen.push((results.upload_manifest as { uri: string }).uri)
        return s
      },
    })
    await m.start()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['ipfs://bafyexample'])
    expect(m.getSnapshot().results.upload_manifest).toEqual({ uri: 'ipfs://bafyexample' })
  })

  it('pauses at manual DEX liquidity steps from core and continues on confirmManual', async () => {
    const policy = getPolicy('BOT-001')
    if (!policy) throw new Error('BOT-001 missing')
    const draft = createDefaultDraft({ id: 'dmanual', owner: 'tester', chainId: 100, now: new Date('2026-10-03T10:00:00Z') })
    const derived = deriveComposer(
      {
        ...draft,
        source: {
          provider: 'github',
          owner: 'kleros',
          repo: 'gateway-balancer-bot',
          commit: { sha: 'a'.repeat(40), message: 'fix', author: 'dev', committedAt: '2026-10-01T00:00:00Z', htmlUrl: 'https://github.com/x' },
        },
        spec: { ...draft.spec, policyId: 'BOT-001', violation: 'reporter deposits can consume the gas reserve' },
      },
      { now: new Date('2026-10-03T10:00:00Z') },
    )
    expect(derived.question).toBeDefined()
    const question = derived.question ?? buildQuestion({ spec: derived.spec, source: draft.source!, policy })
    const steps = buildPublishSteps({
      chainId: 100,
      manifestUri: 'ipfs://pending',
      manifestHash: derived.manifestHash as Hex,
      question,
      oracle: derived.spec.oracle,
      funding: derived.fundingInput,
      creator: TO,
      allowPlaceholderAddresses: true,
    })
    const ids = steps.map((s) => s.id)
    expect(ids).toContain('add_liquidity_yes')
    const storage = createMemoryStorage()
    const m = new TxMachine('publish:manual', steps, {
      storage,
      executor: createDemoExecutor({ wallet: fakeWallet(), collateralSymbol: 'sDAI', delays: FAST }),
      spendingLimit: derived.fundingInput.spendingLimit,
      limitCurrency: 'sDAI',
      handlers: { upload_manifest: async () => ({ result: { uri: 'ipfs://x' } }) },
      manualUrl: () => 'https://app.seer.pm/markets/100/0xabc',
    })
    await m.start()
    let s = m.getSnapshot()
    expect(s.state).toBe('paused')
    expect(s.awaitingManual).toBe('add_liquidity_yes')
    const manual = s.steps.find((x) => x.id === 'add_liquidity_yes')
    expect(manual?.manual).toBe(true)
    expect(manual?.status).toBe('awaiting_signature')
    expect(manual?.actionUrl).toContain('seer.pm')

    // Survives a reload while waiting.
    const reloaded = new TxMachine('publish:manual', steps, {
      storage,
      executor: createDemoExecutor({ wallet: fakeWallet(), delays: FAST }),
    })
    await reloaded.hydrate()
    expect(reloaded.getSnapshot().awaitingManual).toBe('add_liquidity_yes')

    await reloaded.confirmManual('add_liquidity_yes', `0x${'cd'.repeat(32)}` as Hex)
    s = reloaded.getSnapshot()
    // add_liquidity_no is manual too (optional): skip it.
    expect(s.awaitingManual).toBe('add_liquidity_no')
    reloaded.skip('add_liquidity_no')
    expect(reloaded.getSnapshot().state).toBe('done')
    expect(reloaded.getSnapshot().steps.find((x) => x.id === 'add_liquidity_yes')?.txHash).toBe(`0x${'cd'.repeat(32)}`)
  })

  it('rejects an invalid tx hash for a manual step', async () => {
    const steps: TxStep[] = [{ id: 'add_liquidity_yes', label: 'Add Yes liquidity', description: '', kind: 'transaction' }]
    const m = new TxMachine('manual-bad', steps, { storage: createMemoryStorage(), executor: createDemoExecutor({ wallet: fakeWallet(), delays: FAST }) })
    await m.start()
    await m.confirmManual('add_liquidity_yes', '0x123' as Hex)
    expect(m.getSnapshot().error).toMatch(/transaction hash/)
    expect(m.getSnapshot().state).toBe('paused')
  })

  it('demo executor simulates the switch to the evidence chain', async () => {
    const wallet = fakeWallet()
    const steps: TxStep[] = [
      {
        id: 'submit_evidence',
        label: 'Submit evidence on Ethereum',
        description: '',
        kind: 'transaction',
        request: { chainId: 1, to: TO, data: '0x', value: '0' },
      },
    ]
    const m = new TxMachine('ev', steps, { storage: createMemoryStorage(), executor: createDemoExecutor({ wallet, delays: FAST }) })
    expect(wallet.chainId).toBe(100)
    await m.start()
    expect(m.getSnapshot().state).toBe('done')
    expect(wallet.chainId).toBe(1)
  })
})
