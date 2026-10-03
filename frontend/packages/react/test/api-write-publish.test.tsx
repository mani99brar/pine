/** useApiPublish against a fake backend: draft sync, verified preview, createClaim checks before the wallet, status. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ClaimDraft, Hex } from '@pine/core'
import { encodeClaimDocument, type ClaimDocument } from '@pine/core/pine-shared'
import type { DraftInput } from '@pine/data'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners, getTxMachine } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { useApiPublish } from '../src/api/publish'
import { toDraftInput } from '../src/api/draft-input'
import { apiDeadlineForDays } from '../src/composer/api-rules'
import { ACCOUNT, chainClaims, claimStruct, COMMIT, createClaimParams, documentFor, MARKET, NOW, NOW_S, OTHER, previewFor, resetChain, wirePlan } from './api-write-chain'
import { apiError, FakePine, iso, json, noSleep, wrapper } from './api-write-support'

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const DRAFT_ID = 'dapipub0001'
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

interface BackendState {
  revision: number
  input: DraftInput | null
  doc: ClaimDocument | null
  publication: 'none' | 'planned' | 'submitted' | 'confirmed'
  tamperPlan?: (params: ReturnType<typeof createClaimParams>) => ReturnType<typeof createClaimParams>
  tamperPreview?: (preview: ReturnType<typeof previewFor>) => unknown
  publishError?: Response
  /** Who ClaimRegistry records as the created market's creator (the backend's report is checked against it). */
  onChainCreator?: string
}

function backend(state: BackendState): FakePine {
  const fake = new FakePine()
  const view = (s: BackendState['publication'], txs: { txHash: string; status: string; reason: null }[] = []) => {
    const sha = state.doc ? encodeClaimDocument(state.doc).sha256 : `0x${'00'.repeat(32)}`
    return {
      id: PUBLICATION,
      state: s,
      previewId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      draftId: BACKEND_DRAFT,
      documentSha256: sha,
      creator: ACCOUNT,
      planId: PLAN,
      market: s === 'confirmed' ? MARKET : null,
      planExpiresAt: NOW_S + 86_400,
      planExpiresAtIso: iso(NOW_S + 86_400),
      planExpired: false,
      failureReason: null,
      transactions: txs,
      createdAt: iso(NOW_S),
      updatedAt: iso(NOW_S),
    }
  }
  const draftView = () => ({ id: BACKEND_DRAFT, revision: state.revision, input: state.input, valid: true, issues: [], createdAt: iso(NOW_S), updatedAt: iso(NOW_S) })
  return fake
    .on('POST', /^\/api\/v1\/drafts$/, (req) => {
      state.input = req.json as DraftInput
      state.revision = 1
      return json(201, { draft: draftView() })
    })
    .on('PUT', /^\/api\/v1\/drafts\/([^/]+)$/, (req) => {
      const body = req.json as { input: DraftInput; expectedRevision?: number }
      if (body.expectedRevision !== undefined && body.expectedRevision !== state.revision) return apiError(409, 'CONFLICT', 'The draft was changed concurrently; reload it and try again')
      state.input = body.input
      state.revision += 1
      return json(200, { draft: draftView() })
    })
    .on('POST', /^\/api\/v1\/drafts\/([^/]+)\/preview$/, () => {
      if (!state.input) return apiError(404, 'NOT_FOUND', 'Draft not found')
      state.doc = documentFor(state.input, ACCOUNT, NOW_S)
      const preview = previewFor(state.doc, { now: NOW_S, draftRevision: state.revision })
      return json(201, state.tamperPreview ? state.tamperPreview(preview) : preview)
    })
    .on('POST', /^\/api\/v1\/publications$/, () => {
      if (state.publishError) return state.publishError
      if (!state.doc) return apiError(404, 'NOT_FOUND', 'Preview not found')
      state.publication = 'planned'
      const sha = encodeClaimDocument(state.doc).sha256
      const params = createClaimParams(state.doc, sha)
      const plan = wirePlan(PLAN, ACCOUNT, [{ id: 'create', allowlistId: 'claimRegistry.createClaim', args: [state.tamperPlan ? state.tamperPlan(params) : params] }])
      return json(200, { publication: view('planned'), planExpired: false, plan })
    })
    .on('POST', /^\/api\/v1\/publications\/([^/]+)\/submitted$/, (req) => {
      state.publication = 'submitted'
      return json(200, { publication: view('submitted', [{ txHash: (req.json as { txHash: string }).txHash, status: 'unknown', reason: null }]) })
    })
    .on('GET', /^\/api\/v1\/publications\/([^/]+)$/, () => {
      if (state.publication === 'submitted' && state.doc) {
        state.publication = 'confirmed'
        // The chain now has the claim: ClaimRegistry records the document digest and creator for MARKET.
        chainClaims.set(MARKET, claimStruct({ claimDocumentSha256: encodeClaimDocument(state.doc).sha256, creator: state.onChainCreator ?? ACCOUNT }))
      }
      return json(200, { publication: view(state.publication === 'none' ? 'planned' : state.publication) })
    })
}

/** The hook's clock (tests move it forward explicitly). */
let clock = NOW
const HOUR_MS = 3_600_000

function render() {
  return renderHook(
    () => ({
      composer: useClaimComposer(DRAFT_ID),
      publish: useApiPublish(DRAFT_ID, { now: () => clock, sleep: noSleep, pollIntervalMs: 1 }),
      wallet: useWallet(),
    }),
    { wrapper },
  )
}

async function composeAndConnect(result: ReturnType<typeof render>['result']) {
  await waitFor(() => expect(result.current.composer.draft.id).toBe(DRAFT_ID))
  act(() => result.current.composer.update((d) => completeDraft(d)))
  act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.wallet.address).toBeDefined())
}

let state: BackendState
let fake: FakePine

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  clock = NOW
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  resetChain()
  state = { revision: 0, input: null, doc: null, publication: 'none' }
  fake = backend(state)
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useApiPublish', () => {
  it('mirrors the draft, verifies the preview, publishes the checked createClaim plan and follows it to the market', async () => {
    const { result } = render()
    await composeAndConnect(result)

    await act(async () => {
      expect(await result.current.publish.saveDraft()).toBe(true)
    })
    const [created] = fake.of(/^\/api\/v1\/drafts$/, 'POST')
    const expected = toDraftInput(result.current.composer.draft, { now: NOW })
    expect(expected.ok && created?.json).toEqual(expected.ok ? expected.input : null)
    expect(created?.headers).toMatchObject({ 'x-pine-csrf': '1', 'content-type': 'application/json' })
    expect(created?.headers['idempotency-key']).toBeUndefined()
    await waitFor(() => expect(result.current.publish.backend).toEqual({ draftId: BACKEND_DRAFT, revision: 1 }))

    await act(async () => {
      expect(await result.current.publish.requestPreview({ liveSystemImpactNone: true })).toBe(true)
    })
    // The preview re-saves the draft (fresh evidence window) at the known revision, then sends exactly the attestation.
    expect(fake.of(/^\/api\/v1\/drafts\/[^/]+$/, 'PUT')[0]?.json).toEqual({ input: expected.ok ? expected.input : null, expectedRevision: 1 })
    expect(fake.of(/\/preview$/, 'POST')[0]?.text).toBe('{"attestLiveSystemImpactNone":true}')
    await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
    expect(result.current.publish.verifyIssues).toEqual([])
    expect(result.current.publish.preview?.document.claim.title).toBe('Reporter deposits never draw on the gas reserve')

    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.status).toBe('confirmed'))
    const sha = result.current.publish.preview?.documentSha256 ?? ''
    expect(fake.of(/^\/api\/v1\/publications$/, 'POST')[0]?.json).toEqual({ previewId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', documentSha256: sha })

    // The mined createClaim is reported with its hash only (no step id).
    const step = result.current.publish.runner.runner.steps[0]
    expect(step?.status).toBe('confirmed')
    const reported = fake.of(/\/publications\/[^/]+\/submitted$/, 'POST')
    expect(reported).toHaveLength(1)
    expect(reported[0]?.text).toBe(JSON.stringify({ txHash: step?.txHash?.toLowerCase() }))

    expect(result.current.publish.market).toBe(MARKET)
    await waitFor(() => expect(result.current.composer.draft.publication?.marketAddress).toBe(MARKET))
    expect(result.current.composer.draft.publication?.steps).toEqual([expect.objectContaining({ id: 'create_market', status: 'confirmed', txHash: step?.txHash?.toLowerCase() })])
    expect(result.current.composer.frozen).toBe(true)
  })

  it('accepts the created market only when ClaimRegistry on the user’s RPC records this document and creator for it', async () => {
    state.onChainCreator = OTHER
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      await result.current.publish.requestPreview({ liveSystemImpactNone: true })
    })
    await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.error?.message).toMatch(/ClaimRegistry does not record/))
    expect(result.current.publish.market).toBeNull()
    expect(result.current.composer.draft.publication?.marketAddress).toBeUndefined()
  })

  it('SEC-TX-02 refuses a createClaim plan whose arguments differ from the preview before any wallet prompt', async () => {
    state.tamperPlan = (params) => ({ ...params, minBond: 1n })
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      await result.current.publish.requestPreview({ liveSystemImpactNone: true })
    })
    await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.publish.error?.message).toMatch(/createClaim minBond differs/)
    expect(result.current.publish.error?.message).toMatch(/nothing was sent to your wallet/)
    // Nothing reached the runner: no steps, no signature request, no report.
    expect(result.current.publish.runner.plan).toBeNull()
    expect(result.current.publish.runner.runner.steps).toEqual([])
    const machine = getTxMachine(`api:api-publish:${DRAFT_ID}:${ACCOUNT}:${result.current.publish.preview?.documentSha256}`)
    expect(machine?.getSnapshot().steps.some((s) => s.status !== 'idle' || s.txHash) ?? false).toBe(false)
    expect(fake.of(/\/submitted$/)).toEqual([])
  })

  it('SEC-CLAIM-04 shows a tampered preview as blocked and never asks Pine for a publication', async () => {
    state.tamperPreview = (p) => ({ ...p, document: { ...(p.document as ClaimDocument), claim: { ...(p.document as ClaimDocument).claim, violation: 'nothing at all' } } })
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      await result.current.publish.requestPreview({ liveSystemImpactNone: true })
    })
    await waitFor(() => expect(result.current.publish.status).toBe('blocked'))
    expect(result.current.publish.verifyIssues.map((i) => i.code)).toEqual(expect.arrayContaining(['digest_mismatch', 'field_mismatch']))
    await act(async () => {
      await result.current.publish.publish()
    })
    expect(result.current.publish.error?.action).toBe('repreview')
    expect(fake.of(/^\/api\/v1\/publications/)).toEqual([])
  })

  it('never requests a preview without the explicit live-system attestation', async () => {
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      expect(await result.current.publish.requestPreview({} as { liveSystemImpactNone: true })).toBe(false)
    })
    expect(fake.of(/\/preview$/)).toEqual([])
    // Reading the session (draft owner) is the only request allowed; nothing is written or previewed.
    expect(fake.requests.filter((r) => r.path !== '/api/v1/auth/session')).toEqual([])
  })

  it('reports invalid drafts as field errors and sends nothing', async () => {
    const { result } = render()
    await composeAndConnect(result)
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, title: 'Bad "title"' } })))
    await waitFor(() => expect(result.current.publish.status).toBe('invalid'))
    expect(result.current.publish.fieldErrors).toEqual([expect.objectContaining({ field: 'title', composerPath: 'spec.title' })])
    await act(async () => {
      expect(await result.current.publish.saveDraft()).toBe(false)
    })
    expect(fake.requests.filter((r) => r.path !== '/api/v1/auth/session')).toEqual([])
  })

  it('turns an expired publication offer into a request for a new preview', async () => {
    state.publishError = apiError(409, 'CONFLICT', 'plan offer expired; create a new preview')
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      await result.current.publish.requestPreview({ liveSystemImpactNone: true })
    })
    await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
    await act(async () => {
      await result.current.publish.publish()
    })
    await waitFor(() => expect(result.current.publish.error?.action).toBe('repreview'))
    expect(result.current.publish.error?.message).toMatch(/expired\. Request a new preview/)
  })

  it('maps backend validation issues to composer fields', async () => {
    fake.on('POST', /^\/api\/v1\/drafts$/, () =>
      apiError(400, 'VALIDATION_FAILED', 'Policy parameters are invalid', { issues: [{ path: ['policyParameters', 'startingStates'], message: 'Required' }] }),
    )
    const { result } = render()
    await composeAndConnect(result)
    await act(async () => {
      expect(await result.current.publish.saveDraft()).toBe(false)
    })
    expect(result.current.publish.error?.action).toBe('fix_input')
    expect(result.current.publish.fieldErrors).toEqual([{ field: 'policyParameters.startingStates', composerPath: 'spec.parameters.startingStates', message: 'Required' }])
  })

  it('drops Pine’s validation issues once the claim they were reported for is edited, so it can be saved again', async () => {
    const issue = { path: ['policyParameters', 'simulatedAdapters'], message: 'Too big: expected array to have <=1 items' }
    fake.on('POST', /^\/api\/v1\/drafts$/, (req) => {
      const adapters = (req.json as DraftInput).policyParameters.simulatedAdapters
      if (Array.isArray(adapters) && adapters.length > 1) return apiError(400, 'VALIDATION_FAILED', 'Policy parameters are invalid', { issues: [issue] })
      state.input = req.json as DraftInput
      state.revision = 1
      return json(201, { draft: { id: BACKEND_DRAFT, revision: 1, input: state.input, valid: true, issues: [], createdAt: iso(NOW_S), updatedAt: iso(NOW_S) } })
    })
    const setAdapters = (result: ReturnType<typeof render>['result'], adapters: string[]) =>
      act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, parameters: { ...d.spec.parameters, simulatedAdapters: adapters } } })))
    const { result } = render()
    await composeAndConnect(result)
    setAdapters(result, ['lifi', 'across'])
    await act(async () => {
      expect(await result.current.publish.saveDraft()).toBe(false)
    })
    const refused = { field: 'policyParameters.simulatedAdapters', composerPath: 'spec.parameters.simulatedAdapters', message: issue.message }
    expect(result.current.publish.fieldErrors).toEqual([refused])
    expect(result.current.publish.error?.code).toBe('VALIDATION_FAILED')
    expect(result.current.publish.status).toBe('invalid')

    // The user fixes the field: Pine's issue and error no longer apply, so nothing blocks saving again.
    setAdapters(result, ['lifi'])
    await waitFor(() => expect(result.current.publish.fieldErrors).toEqual([]))
    expect(result.current.publish.error).toBeNull()
    expect(result.current.publish.status).toBe('idle')
    // The exact refused terms again: the refusal holds again.
    setAdapters(result, ['lifi', 'across'])
    await waitFor(() => expect(result.current.publish.fieldErrors).toEqual([refused]))
    setAdapters(result, ['lifi'])
    await act(async () => {
      expect(await result.current.publish.saveDraft()).toBe(true)
    })
    expect(result.current.publish.fieldErrors).toEqual([])
    expect(result.current.publish.status).toBe('saved')
  })
})

describe('useApiPublish: a preview is published only with the terms it was made from', () => {
  const EDITED = 'Reporter-deposit principal must never be funded from the gas reserve or from arbitration allocations.'

  async function previewWith(result: ReturnType<typeof render>['result'], deadline: string) {
    await composeAndConnect(result)
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline } } })))
    await act(async () => {
      expect(await result.current.publish.requestPreview({ liveSystemImpactNone: true })).toBe(true)
    })
    await waitFor(() => expect(result.current.publish.status).toBe('reviewable'))
    expect(result.current.publish.verifyIssues).toEqual([])
  }

  function editRequirement(result: ReturnType<typeof render>['result']) {
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, requirement: EDITED } })))
  }

  it('SEC-CLAIM-04 keeps a preview blocked after an edit made once the 3-day preset’s margin has passed, and publishes nothing', async () => {
    const { result } = render()
    await previewWith(result, apiDeadlineForDays(3, NOW))
    clock = new Date(NOW.getTime() + 3 * HOUR_MS)
    editRequirement(result)
    await waitFor(() => expect(result.current.publish.draft?.spec.requirement).toBe(EDITED))
    // The window drifted under the backend's 3-day minimum, so the edited draft cannot be mapped to an input: the edit
    // must still make the preview stale.
    expect(result.current.publish.fieldErrors.map((e) => e.composerPath)).toContain('spec.evidence.deadline')
    expect(result.current.publish.status).toBe('blocked')
    expect(result.current.publish.verifyIssues).toEqual([expect.objectContaining({ code: 'stale_preview', message: expect.stringMatching(/edited the claim/) })])
    await act(async () => {
      await result.current.publish.publish()
    })
    expect(result.current.publish.error?.action).toBe('repreview')
    expect(fake.of(/^\/api\/v1\/publications/)).toEqual([])
    // Nothing was saved after the preview either: the backend still holds the previewed revision.
    expect(fake.of(/^\/api\/v1\/drafts$/, 'POST')).toHaveLength(1)
    expect(fake.of(/^\/api\/v1\/drafts\//, 'PUT')).toEqual([])
  })

  it('SEC-CLAIM-04 a stale preview stays blocked when the clock moves on, the stage changes and the page reloads', async () => {
    const first = render()
    await previewWith(first.result, apiDeadlineForDays(3, NOW))
    clock = new Date(NOW.getTime() + 30 * 60_000)
    editRequirement(first.result)
    await waitFor(() => expect(first.result.current.publish.status).toBe('blocked'))
    clock = new Date(NOW.getTime() + 3 * HOUR_MS)
    act(() => first.result.current.composer.setStage('publish'))
    await waitFor(() => expect(first.result.current.publish.draft?.stage).toBe('publish'))
    expect(first.result.current.publish.status).toBe('blocked')
    await act(async () => first.result.current.composer.saveNow())
    first.unmount()

    const second = render()
    await waitFor(() => expect(second.result.current.publish.preview).not.toBeNull())
    expect(second.result.current.publish.draft?.spec.requirement).toBe(EDITED)
    expect(second.result.current.publish.status).toBe('blocked')
    expect(second.result.current.publish.verifyIssues.map((i) => i.code)).toContain('stale_preview')
  })

  it('SEC-CLAIM-04 moving the evidence deadline after the preview blocks it', async () => {
    const { result } = render()
    await previewWith(result, apiDeadlineForDays(7, NOW))
    const moved = apiDeadlineForDays(14, NOW)
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, evidence: { mechanism: 'erc1497-arbitrator-proxy', deadline: moved } } })))
    await waitFor(() => expect(result.current.publish.draft?.spec.evidence?.deadline).toBe(moved))
    // The draft itself is valid and its other terms are unchanged.
    expect(result.current.publish.fieldErrors).toEqual([])
    expect(result.current.publish.status).toBe('blocked')
    expect(result.current.publish.verifyIssues).toEqual([expect.objectContaining({ code: 'stale_preview', message: expect.stringMatching(/changed the evidence deadline/) })])
  })

  it('SEC-CLAIM-04 fails closed when the edited claim cannot be sent to Pine at all', async () => {
    const { result } = render()
    await previewWith(result, apiDeadlineForDays(7, NOW))
    act(() => result.current.composer.update((d) => ({ ...d, spec: { ...d.spec, requirement: EDITED, scope: { inScope: [], outOfScope: [] } } })))
    await waitFor(() => expect(result.current.publish.draft?.spec.requirement).toBe(EDITED))
    expect(result.current.publish.status).toBe('blocked')
    expect(result.current.publish.verifyIssues).toEqual([expect.objectContaining({ code: 'stale_preview', message: expect.stringMatching(/cannot be sent to Pine as it is \(List at least one in-scope component\.\)/) })])
  })

  it('keeps an unchanged preview publishable while only the evidence window drifts with the clock', async () => {
    const { result } = render()
    await previewWith(result, apiDeadlineForDays(3, NOW))
    clock = new Date(NOW.getTime() + 3 * HOUR_MS)
    act(() => result.current.composer.setStage('publish'))
    await waitFor(() => expect(result.current.publish.draft?.stage).toBe('publish'))
    expect(result.current.publish.fieldErrors.map((e) => e.composerPath)).toEqual(['spec.evidence.deadline'])
    expect(result.current.publish.verifyIssues).toEqual([])
    expect(result.current.publish.status).toBe('reviewable')
  })
})
