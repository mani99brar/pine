/**
 * useApiPublish when the createClaim transaction landed but its hash never reached the page (the user reloaded while the
 * wallet was still returning): the claim ClaimRegistry records for this creator and document is adopted, never sent
 * again; a DuplicateClaim revert that cannot be proven on chain is reported with a link, never marked published.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ClaimDraft, Hex } from '@pine/core'
import { encodeClaimDocument, type ClaimDocument } from '@pine/core/pine-shared'
import type { DraftInput } from '@pine/data'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { useApiPublish } from '../src/api/publish'
import { ACCOUNT, chainClaims, claimStruct, COMMIT, createClaimParams, documentFor, MARKET, NOW, NOW_S, previewFor, resetChain, wirePlan } from './api-write-chain'
import { apiError, FakePine, iso, json, wrapper } from './api-write-support'

const DUPLICATE_REVERT = `"Publish the claim and create its market" would fail on-chain (Execution reverted with reason: custom error 0x05e2858b: 000000000000000000000000${MARKET.slice(2)}). Nothing was sent.`

/** The wallet: counts prompts; `hang` never answers (the page reloads first), `duplicate` fails the pre-flight simulation. */
const wallet = vi.hoisted(() => {
  const state = { prompts: 0, mode: 'send' as 'send' | 'hang' | 'duplicate', duplicateMessage: '' }
  const executor = {
    kind: 'live' as const,
    async execute(step: { id: string }, progress: { onAwaitingSignature(): void; onSubmitted(hash: `0x${string}`): void }) {
      if (state.mode === 'duplicate') throw new Error(state.duplicateMessage)
      state.prompts += 1
      progress.onAwaitingSignature()
      if (state.mode === 'hang') return new Promise<never>(() => undefined)
      const hash = `0x${state.prompts.toString(16).padStart(64, '0')}` as `0x${string}`
      progress.onSubmitted(hash)
      return { txHash: hash }
    },
    async checkPending() {
      return { status: 'pending' as const }
    },
  }
  return { state, executor }
})

/** ClaimRegistry.marketOf(creator, digest) on the user's RPC; `fails` makes that read fail (the RPC is down). */
const registry = vi.hoisted(() => ({ marketOf: new Map<string, string>(), fails: false }))

vi.mock('../src/tx/demo-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tx/demo-executor')>()
  return { ...actual, createDemoExecutor: () => wallet.executor }
})

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  const reader = {
    async readContract(args: { address: string; functionName: string; args: readonly unknown[] }) {
      if (args.functionName === 'marketOf') {
        if (args.address.toLowerCase() !== chain.PINE.claimRegistry) throw new Error('read from the wrong registry')
        if (registry.fails) throw new Error('RPC unavailable')
        return registry.marketOf.get(`${String(args.args[0]).toLowerCase()}:${String(args.args[1]).toLowerCase()}`) ?? '0x0000000000000000000000000000000000000000'
      }
      return chain.fakeReader.readContract(args as Parameters<typeof chain.fakeReader.readContract>[0])
    },
  }
  return { ...actual, usePublicClient: () => reader }
})

const DRAFT_ID = 'dapiadopt01'
const BACKEND_DRAFT = '0b6a8f1e-3a55-4c1e-9d55-6f4e1a2b3c4d'
const PUBLICATION = '5f0c2a8e-1b2c-4d3e-8f90-a1b2c3d4e5f6'
const PLAN = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const HASH = `0x${'ee'.repeat(32)}` as Hex

function completeDraft(d: ClaimDraft): ClaimDraft {
  return {
    ...d,
    source: {
      provider: 'github',
      owner: 'kleros',
      repo: 'kleros-v2',
      pullRequest: { number: 2101, title: 'PR', htmlUrl: 'https://github.com/kleros/kleros-v2/pull/2101', author: 'dev', state: 'open' },
      commit: { sha: COMMIT, message: 'm', author: 'dev', committedAt: '2026-10-02T09:00:00Z', htmlUrl: 'https://github.com/x' },
    },
    spec: {
      ...d.spec,
      title: 'Reporter deposits never draw on the gas reserve',
      policyId: 'BOT-001',
      policyVersion: '0.1.0',
      requirement: 'Reporter-deposit principal must not be funded from arbitration allocations.',
      violation: 'reporter-deposit principal funded from the gas reserve',
      scope: { inScope: ['src/funding'], outOfScope: [] },
      parameters: { sourceRequirement: 'Spec section 4', startingStates: 'fresh deploy', simulatedAdapters: ['lifi'] },
      faultModel: 'crash between plan and submit',
      allowedInputs: 'any configuration',
      assumptions: [],
      exclusions: [],
      environment: { runtime: 'node 22.14.0', config: {}, configHash: HASH, externalState: 'none', reproductionCommand: 'pnpm test', setupSteps: [], notes: 'none', envHash: HASH },
      regressionOnly: false,
      evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: new Date(NOW.getTime() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    },
  }
}

/** The backend: a publication stays `planned` (no hash was reported) until its reconcile job indexes the claim. */
interface BackendState {
  revision: number
  input: DraftInput | null
  doc: ClaimDocument | null
  published: boolean
  indexed: boolean
}

function backend(state: BackendState): FakePine {
  const view = (s: 'planned' | 'confirmed') => ({
    id: PUBLICATION,
    state: s,
    previewId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    draftId: BACKEND_DRAFT,
    documentSha256: state.doc ? encodeClaimDocument(state.doc).sha256 : `0x${'00'.repeat(32)}`,
    creator: ACCOUNT,
    planId: PLAN,
    market: s === 'confirmed' ? MARKET : null,
    planExpiresAt: NOW_S + 86_400,
    planExpiresAtIso: iso(NOW_S + 86_400),
    planExpired: false,
    failureReason: null,
    transactions: [],
    createdAt: iso(NOW_S),
    updatedAt: iso(NOW_S),
  })
  const draftView = () => ({ id: BACKEND_DRAFT, revision: state.revision, input: state.input, valid: true, issues: [], createdAt: iso(NOW_S), updatedAt: iso(NOW_S) })
  return new FakePine()
    .on('POST', /^\/api\/v1\/drafts$/, (req) => {
      state.input = req.json as DraftInput
      state.revision = 1
      return json(201, { draft: draftView() })
    })
    .on('PUT', /^\/api\/v1\/drafts\/([^/]+)$/, (req) => {
      state.input = (req.json as { input: DraftInput }).input
      state.revision += 1
      return json(200, { draft: draftView() })
    })
    .on('POST', /^\/api\/v1\/drafts\/([^/]+)\/preview$/, () => {
      if (!state.input) return apiError(404, 'NOT_FOUND', 'Draft not found')
      state.doc = documentFor(state.input, ACCOUNT, NOW_S)
      return json(201, previewFor(state.doc, { now: NOW_S, draftRevision: state.revision }))
    })
    .on('POST', /^\/api\/v1\/publications$/, () => {
      if (!state.doc) return apiError(404, 'NOT_FOUND', 'Preview not found')
      state.published = true
      const sha = encodeClaimDocument(state.doc).sha256
      const plan = wirePlan(PLAN, ACCOUNT, [{ id: 'create', allowlistId: 'claimRegistry.createClaim', args: [createClaimParams(state.doc, sha)] }])
      return json(200, { publication: view('planned'), planExpired: false, plan })
    })
    .on('GET', /^\/api\/v1\/publications\/([^/]+)$/, () => json(200, { publication: view(state.indexed ? 'confirmed' : 'planned') }))
}

/** A wait that yields to the event loop (a planned publication is polled until the backend indexes it). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function render() {
  return renderHook(
    () => ({
      composer: useClaimComposer(DRAFT_ID),
      publish: useApiPublish(DRAFT_ID, { now: () => NOW, sleep: tick, pollIntervalMs: 1 }),
      wallet: useWallet(),
    }),
    { wrapper },
  )
}

type Rendered = ReturnType<typeof render>

async function connect(result: Rendered['result']) {
  if (!result.current.wallet.isConnected) act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.wallet.address).toBeDefined())
}

/** Composes the draft, requests a verified preview and starts publishing; returns the previewed document digest. */
async function startPublishing(result: Rendered['result']): Promise<Hex> {
  await waitFor(() => expect(result.current.composer.draft.id).toBe(DRAFT_ID))
  act(() => result.current.composer.update((d) => completeDraft(d)))
  await connect(result)
  await act(async () => {
    expect(await result.current.publish.requestPreview({ liveSystemImpactNone: true })).toBe(true)
  })
  await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
  const sha = result.current.publish.preview?.documentSha256
  if (!sha) throw new Error('no preview')
  act(() => {
    void result.current.publish.publish()
  })
  return sha
}

/** The createClaim transaction is mined: ClaimRegistry records MARKET for (creator, digest). */
function landOnChain(sha: Hex, creator: string = ACCOUNT) {
  chainClaims.set(MARKET, claimStruct({ claimDocumentSha256: sha, creator }))
  registry.marketOf.set(`${creator}:${sha.toLowerCase()}`, MARKET)
}

async function reload(unmount: () => void): Promise<Rendered> {
  unmount()
  __resetTxRunners()
  const next = render()
  await waitFor(() => expect(next.result.current.publish.preview).not.toBeNull())
  await connect(next.result)
  return next
}

let state: BackendState
let fake: FakePine

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  resetChain()
  registry.marketOf.clear()
  registry.fails = false
  wallet.state.prompts = 0
  wallet.state.mode = 'send'
  wallet.state.duplicateMessage = DUPLICATE_REVERT
  state = { revision: 0, input: null, doc: null, published: false, indexed: false }
  fake = backend(state)
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useApiPublish: a createClaim that landed without its hash', () => {
  it('SEC-TX-08 adopts the claim ClaimRegistry records for this creator and document after a reload, and never sends again', async () => {
    wallet.state.mode = 'hang'
    const first = render()
    const sha = await startPublishing(first.result)
    await waitFor(() => expect(first.result.current.publish.runner.runner.steps[0]?.status).toBe('awaiting_signature'))
    landOnChain(sha)

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(result.current.publish.market).toBe(MARKET))
    expect(result.current.publish.status).toBe('confirming')
    await waitFor(() => expect(result.current.composer.draft.publication?.marketAddress).toBe(MARKET))
    expect(result.current.composer.draft.publication?.claimId).toBe(MARKET)

    // Publishing again sends nothing and asks Pine for no new publication.
    await act(async () => {
      await result.current.publish.publish()
    })
    expect(wallet.state.prompts).toBe(1)
    expect(fake.of(/^\/api\/v1\/publications$/, 'POST')).toHaveLength(1)

    // Pine's reconcile job confirms the publication from the indexed claim.
    state.indexed = true
    await waitFor(() => expect(result.current.publish.status).toBe('confirmed'))
    expect(result.current.publish.market).toBe(MARKET)
    expect(result.current.publish.error).toBeNull()
  })

  it('SEC-TX-08 a DuplicateClaim revert is resolved on chain: the existing claim is adopted, not reported as a failure', async () => {
    wallet.state.mode = 'hang'
    const first = render()
    const sha = await startPublishing(first.result)
    await waitFor(() => expect(first.result.current.publish.runner.runner.steps[0]?.status).toBe('awaiting_signature'))
    // The chain check after the reload fails once (RPC hiccup), so the user publishes again and the simulation reverts.
    registry.fails = true
    landOnChain(sha)
    const { result } = await reload(first.unmount)
    wallet.state.mode = 'duplicate'
    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.runner.runner.state).toBe('failed'))
    registry.fails = false
    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.market).toBe(MARKET))
    expect(result.current.publish.status).toBe('confirming')
    expect(result.current.publish.error).toBeNull()
    expect(wallet.state.prompts).toBe(1)
  })

  it('SEC-CLAIM-04 never adopts a market ClaimRegistry records for another document', async () => {
    wallet.state.mode = 'hang'
    const first = render()
    const sha = await startPublishing(first.result)
    await waitFor(() => expect(first.result.current.publish.runner.runner.steps[0]?.status).toBe('awaiting_signature'))
    // marketOf answers MARKET, but the claim stored for MARKET carries another document digest.
    landOnChain(sha)
    chainClaims.set(MARKET, claimStruct({ claimDocumentSha256: `0x${'12'.repeat(32)}`, creator: ACCOUNT }))

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(fake.of(/^\/api\/v1\/publications\/[^/]+$/, 'GET').length).toBeGreaterThan(0))
    await act(async () => {
      await tick()
    })
    expect(result.current.publish.market).toBeNull()
    expect(result.current.composer.draft.publication?.marketAddress).toBeUndefined()
  })

  it('SEC-CLAIM-04 reports a DuplicateClaim revert it cannot prove on chain as an existing claim, without marking the draft published', async () => {
    registry.fails = true
    wallet.state.mode = 'duplicate'
    const { result } = render()
    await startPublishing(result)
    await waitFor(() => expect(result.current.publish.runner.runner.state).toBe('failed'))

    await waitFor(() => expect(result.current.publish.existingMarket).toBe(MARKET))
    expect(result.current.publish.error?.message).toMatch(/already exists/)
    expect(result.current.publish.market).toBeNull()
    expect(result.current.publish.status).not.toBe('confirmed')
    expect(result.current.composer.draft.publication?.marketAddress).toBeUndefined()
    expect(wallet.state.prompts).toBe(0)
  })

  it('reports a DuplicateClaim revert whose address is cut short as an existing claim, with no link', async () => {
    registry.fails = true
    wallet.state.mode = 'duplicate'
    wallet.state.duplicateMessage = 'would fail on-chain (Execution reverted with reason: custom error 0x05e2858b: ...124ea84c). Nothing was sent.'
    const { result } = render()
    await startPublishing(result)
    await waitFor(() => expect(result.current.publish.runner.runner.state).toBe('failed'))
    expect(result.current.publish.existingMarket).toBeNull()
    expect(result.current.publish.error?.message).toMatch(/already exists/)
    expect(result.current.publish.market).toBeNull()
  })

  it('leaves a publication alone when ClaimRegistry has no claim for it', async () => {
    wallet.state.mode = 'hang'
    const first = render()
    await startPublishing(first.result)
    await waitFor(() => expect(first.result.current.publish.runner.runner.steps[0]?.status).toBe('awaiting_signature'))

    const { result } = await reload(first.unmount)
    await waitFor(() => expect(fake.of(/^\/api\/v1\/publications\/[^/]+$/, 'GET').length).toBeGreaterThan(0))
    await act(async () => {
      await tick()
    })
    expect(result.current.publish.market).toBeNull()
    expect(result.current.publish.status).toBe('reviewable')
  })
})
