/**
 * useApiEvidence recovery: empty files are refused before a commit; a seal whose commit confirmation was lost (a reload
 * while the wallet prompt was open) is reconciled with Pine's read model by its commitment and never committed twice;
 * seals written by another tab show without a reload.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { computeEvidenceCommitment, encodeEvidenceManifest, type Address, type Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { getBrowserStorage } from '../src/internal/storage'
import {
  __clearSessionArtifacts,
  newEvidenceSalt,
  prepareEvidence,
  readSeal,
  sealStorageKey,
  uploadEvidence,
  useApiEvidence,
  writeSeal,
  type EvidenceComposition,
  type EvidenceSeal,
} from '../src/api/evidence'
import { ACCOUNT, CLAIM_DOC_SHA, COMMIT, MARKET, NOW, NOW_S, OTHER, PINE, REVEAL_DEADLINE } from './api-write-chain'
import { FakePine, json, noSleep, wrapper } from './api-write-support'
import type { PineWriteApi } from '@pine/data'

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const CTX = { chainId: 100, market: MARKET, submitter: ACCOUNT, claim: { claimDocumentSha256: CLAIM_DOC_SHA, commit: COMMIT } }
const COMMIT_PLAN = '11111111-2222-4333-8444-555555555555'
const MINED_TX = `0x${'cd'.repeat(32)}`

function composition(artifacts: EvidenceComposition['artifacts'] = []): EvidenceComposition {
  return {
    title: 'Arbitration allocation funds a reporter deposit',
    violatedRequirement: 'Each reporter deposit principal comes only from reporter funds.',
    summary: 'A crash between journal steps makes the reporter reuse the arbitration allocation.',
    expectedBehavior: 'Deposit principal comes from reporter funds.',
    actualBehavior: 'Deposit principal comes from the arbitration allocation.',
    reproduction: { environment: 'Node 24, simulated chains', setup: 'yarn install --immutable', command: 'yarn test reporter' },
    artifacts,
  }
}

interface Indexed {
  commitment: string
  submitter?: Address
  registry?: Address
}

interface FakeState {
  indexed: Indexed[]
  /** Holds evidence list responses until it resolves. */
  listGate?: Promise<void>
}

function backend(state: FakeState): FakePine {
  return new FakePine()
    .on('POST', /^\/api\/v1\/evidence\/plans\/commit$/, () => json(500, { error: { code: 'INTERNAL', message: 'no commit plan expected', requestId: 'req-1' } }))
    .on('GET', /^\/api\/v1\/markets\/([^/]+)\/evidence$/, async () => {
      if (state.listGate) await state.listGate
      return json(200, {
        market: MARKET,
        evidenceDeadline: NOW_S + 3600,
        revealDeadline: REVEAL_DEADLINE,
        items: state.indexed.map((i, n) => ({
          registry: i.registry ?? PINE.evidenceRegistry,
          submissionId: String(7 + n),
          market: MARKET,
          submitter: i.submitter ?? ACCOUNT,
          status: 'committed',
          commitment: i.commitment,
          contentSha256: null,
          committedAt: NOW_S - 30,
          committedTxHash: MINED_TX,
        })),
        nextCursor: null,
      })
    })
}

/** A seal of `composition()` whose commit was started (a plan was issued) but whose confirmation this browser never saw. */
async function startedSeal(patch: Partial<EvidenceSeal> = {}): Promise<EvidenceSeal> {
  const r = await prepareEvidence(composition(), CTX)
  if (!r.ok) throw new Error('prepare failed')
  const salt = newEvidenceSalt()
  const commitment = computeEvidenceCommitment({ chainId: 100, registry: PINE.evidenceRegistry, market: MARKET, submitter: ACCOUNT, contentSha256: r.prepared.contentSha256, salt })
  const seal: EvidenceSeal = {
    v: 1,
    chainId: 100,
    registry: PINE.evidenceRegistry,
    market: MARKET,
    submitter: ACCOUNT,
    contentSha256: r.prepared.contentSha256,
    salt,
    commitment,
    manifest: r.prepared.manifest,
    createdAt: new Date(NOW).toISOString(),
    commitPlanId: COMMIT_PLAN,
    ...patch,
  }
  writeSeal(getBrowserStorage(), seal)
  return seal
}

/** One macrotask per poll, so a poll that finds nothing yet does not starve the test's own timers. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function render() {
  return renderHook(() => ({ ev: useApiEvidence(MARKET, { now: () => NOW, sleep: tick, pollIntervalMs: 1 }), wallet: useWallet() }), { wrapper })
}

async function connect(result: ReturnType<typeof render>['result']) {
  act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.ev.claim?.claimDocumentSha256).toBe(CLAIM_DOC_SHA))
}

let state: FakeState
let fake: FakePine

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  __clearSessionArtifacts()
  demoWalletStore.reset()
  state = { indexed: [] }
  fake = backend(state)
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('empty files', () => {
  it('SEC-EVID-01 refuses an empty (0-byte) file before anything is committed', async () => {
    const r = await prepareEvidence(composition([{ file: new File([], 'empty.txt', { type: 'text/plain' }) }]), CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([{ field: 'artifacts.0.size', message: expect.stringMatching(/empty/) }])
  })

  it('names an empty artifact of an earlier seal instead of uploading it', async () => {
    const r = await prepareEvidence(composition(), CTX)
    if (!r.ok) throw new Error('prepare failed')
    const manifest = { ...r.prepared.manifest, artifacts: [{ name: 'empty.txt', sha256: `0x${'e3'.repeat(32)}` as Hex32, size: 0, mediaType: 'text/plain', locators: [], description: '' }] }
    const uploadArtifact = vi.fn()
    const client = { uploadArtifact, storeManifest: vi.fn() } as unknown as PineWriteApi
    await expect(uploadEvidence(client, manifest, r.prepared.contentSha256)).rejects.toThrow(/empty\.txt.*empty|empty.*empty\.txt/)
    expect(uploadArtifact).not.toHaveBeenCalled()
  })
})

describe('a seal committed with an empty file', () => {
  it('says the empty file can never be uploaded, uploads nothing, and offers the reveal without files', async () => {
    const r = await prepareEvidence(composition(), CTX)
    if (!r.ok) throw new Error('prepare failed')
    const manifest = { ...r.prepared.manifest, artifacts: [{ name: 'empty.txt', sha256: `0x${'e3'.repeat(32)}` as Hex32, size: 0, mediaType: 'text/plain', locators: [], description: '' }] }
    const contentSha256 = encodeEvidenceManifest(manifest).sha256
    const salt = newEvidenceSalt()
    const commitment = computeEvidenceCommitment({ chainId: 100, registry: PINE.evidenceRegistry, market: MARKET, submitter: ACCOUNT, contentSha256, salt })
    const committedAt = new Date(NOW).toISOString()
    writeSeal(getBrowserStorage(), { v: 1, chainId: 100, registry: PINE.evidenceRegistry, market: MARKET, submitter: ACCOUNT, contentSha256, salt, commitment, manifest, createdAt: committedAt, committedAt, submissionId: '7' })
    const { result } = render()
    await connect(result)
    expect(result.current.ev.seals[0]?.missingArtifacts.map((a) => a.name)).toEqual(['empty.txt'])
    await act(async () => {
      await result.current.ev.reveal(contentSha256)
    })
    expect(result.current.ev.error?.message).toMatch(/does not store empty files, so empty\.txt cannot be uploaded/)
    expect(fake.of(/^\/api\/v1\/evidence\/(artifacts|manifests|reveal-template)$/)).toEqual([])
  })
})

describe('a commit whose confirmation this browser never saw', () => {
  it('is committed once Pine indexed its commitment, and its reveal is offered', async () => {
    const seal = await startedSeal()
    state.indexed = [{ commitment: seal.commitment }]
    const { result } = render()
    await connect(result)
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
    expect(result.current.ev.seals[0]).toMatchObject({ submissionId: '7', revealOpen: true, commitTxHash: MINED_TX })
    expect(readSeal(getBrowserStorage(), MARKET, seal.contentSha256, ACCOUNT)?.committedAt).toBe(new Date((NOW_S - 30) * 1000).toISOString())
    expect(fake.of(/\/evidence\/plans\/commit$/)).toEqual([])
  })

  it('is followed until Pine indexes it', async () => {
    const seal = await startedSeal()
    const { result } = render()
    await connect(result)
    await waitFor(() => expect(fake.of(/\/evidence$/).length).toBeGreaterThan(1))
    expect(result.current.ev.seals[0]?.state).toBe('committing')
    state.indexed = [{ commitment: seal.commitment }]
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
  })

  it('stays unconfirmed when only another wallet or another registry has that commitment', async () => {
    const seal = await startedSeal()
    state.indexed = [
      { commitment: seal.commitment, submitter: OTHER },
      { commitment: seal.commitment, registry: `0x${'99'.repeat(20)}` as Address },
    ]
    const { result } = render()
    await connect(result)
    await waitFor(() => expect(fake.of(/\/evidence$/).length).toBeGreaterThan(1))
    expect(result.current.ev.seals[0]?.state).toBe('committing')
    expect(result.current.ev.seals[0]?.submissionId).toBeUndefined()
  })

  it('SEC-TX-08 committing the same evidence again adopts the indexed submission instead of sending a second commit', async () => {
    const seal = await startedSeal()
    state.indexed = [{ commitment: seal.commitment }]
    let release: () => void = () => undefined
    state.listGate = new Promise<void>((r) => (release = r))
    const { result } = render()
    await connect(result)
    await act(async () => {
      expect(await result.current.ev.prepare(composition())).not.toBeNull()
    })
    expect(result.current.ev.prepared?.contentSha256).toBe(seal.contentSha256)
    let done: Promise<void> = Promise.resolve()
    act(() => {
      done = result.current.ev.commit()
    })
    await act(async () => {
      release()
      await done
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
    expect(result.current.ev.error?.message).toMatch(/already committed/)
    expect(fake.of(/\/evidence\/plans\/commit$/)).toEqual([])
    expect(result.current.ev.runner.runner.steps.every((s) => !s.txHash)).toBe(true)
  })
})

describe('seals of another tab', () => {
  it('show without a reload, and so does their reveal', async () => {
    const { result } = render()
    await connect(result)
    expect(result.current.ev.seals).toEqual([])
    // Another tab commits: it writes the seal, and this tab hears a 'storage' event.
    const seal = await startedSeal({ committedAt: new Date(NOW).toISOString(), submissionId: '7' })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: sealStorageKey(MARKET, seal.contentSha256, ACCOUNT) }))
    })
    expect(result.current.ev.seals[0]?.state).toBe('committed')
    writeSeal(getBrowserStorage(), { ...seal, committedAt: new Date(NOW).toISOString(), submissionId: '7', revealTxHash: MINED_TX as `0x${string}`, revealedAt: new Date(NOW).toISOString() })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: sealStorageKey(MARKET, seal.contentSha256, ACCOUNT) }))
    })
    expect(result.current.ev.seals[0]?.state).toBe('revealed')
  })
})
