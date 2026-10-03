/** useApiEvidence against a fake backend: sealed commit (salt stays local, nothing uploaded), reveal, direct publish. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { computeEvidenceCommitment, encodeEvidenceManifest, sha256Hex, type Address, type EvidenceManifest, type Hex32 } from '@pine/core/pine-shared'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'
import { getBrowserStorage } from '../src/internal/storage'
import { __clearSessionArtifacts, newEvidenceSalt, prepareEvidence, readSeal, useApiEvidence, type EvidenceComposition } from '../src/api/evidence'
import { ACCOUNT, CLAIM_DOC_SHA, COMMIT, EVIDENCE_DEADLINE, MARKET, NOW, NOW_S, OTHER, PINE, REVEAL_DEADLINE, wirePlan } from './api-write-chain'
import { apiError, FakePine, iso, json, noSleep, wrapper, type RecordedRequest } from './api-write-support'

vi.mock('wagmi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wagmi')>()
  const chain = await import('./api-write-chain')
  return { ...actual, usePublicClient: () => chain.fakeReader }
})

const ARTIFACT_TEXT = '1) start the bot with config/example.json\n2) the reporter deposit draws 5 xDAI from the arbitration allocation\n'
const COMMIT_PLAN = '11111111-2222-4333-8444-555555555555'
const PUBLISH_PLAN = '66666666-7777-4888-9999-aaaaaaaaaaaa'

function composition(): EvidenceComposition {
  return {
    title: 'Arbitration allocation funds a reporter deposit',
    violatedRequirement: 'Each reporter deposit principal comes only from reporter funds.',
    summary: 'A crash between journal steps makes the reporter reuse the arbitration allocation.',
    expectedBehavior: 'Deposit principal comes from reporter funds.',
    actualBehavior: 'Deposit principal comes from the arbitration allocation.',
    reproduction: { environment: 'Node 24, simulated chains', setup: 'yarn install --immutable', command: 'yarn test reporter' },
    artifacts: [{ file: new File([ARTIFACT_TEXT], 'my-secret-notes.txt', { type: 'text/plain' }), description: 'Steps' }],
  }
}

interface FakeState {
  commitments: string[]
  tamperCommitment?: Hex32
  commitFailures: Response[]
  manifests: unknown[]
}

function planView(id: string, kind: string, route: string, wire: ReturnType<typeof wirePlan>, state = 'planned') {
  return {
    plan: wire,
    planState: {
      id,
      kind,
      route,
      market: MARKET,
      account: ACCOUNT,
      state,
      expiresAt: EVIDENCE_DEADLINE - 60,
      expiresAtIso: iso(EVIDENCE_DEADLINE - 60),
      offerExpired: false,
      steps: wire.steps.map((s) => ({ id: s.id, allowlistId: s.allowlistId, state: state === 'confirmed' ? 'confirmed' : 'pending', transactions: [] })),
      createdAt: iso(NOW_S),
      updatedAt: iso(NOW_S),
    },
    details: { evidenceDeadline: EVIDENCE_DEADLINE, operator: 'block.timestamp < evidenceDeadline' },
  }
}

function backend(state: FakeState): FakePine {
  const plans = new Map<string, ReturnType<typeof planView>>()
  return new FakePine()
    .on('POST', /^\/api\/v1\/evidence\/plans\/commit$/, (req) => {
      const failure = state.commitFailures.shift()
      if (failure) return failure
      const { commitment } = req.json as { market: Address; commitment: Hex32 }
      state.commitments.push(commitment)
      const wire = wirePlan(COMMIT_PLAN, ACCOUNT, [{ id: 'commit', allowlistId: 'evidenceRegistry.commitEvidence', args: [MARKET, state.tamperCommitment ?? commitment] }])
      const view = planView(COMMIT_PLAN, 'evidence_commit', 'evidence.commit', wire)
      plans.set(COMMIT_PLAN, view)
      return json(201, view)
    })
    .on('POST', /^\/api\/v1\/evidence\/plans\/publish$/, (req) => {
      const { contentSha256 } = req.json as { contentSha256: Hex32 }
      const wire = wirePlan(PUBLISH_PLAN, ACCOUNT, [{ id: 'publish', allowlistId: 'evidenceRegistry.publishEvidence', args: [MARKET, contentSha256] }])
      const view = planView(PUBLISH_PLAN, 'evidence_publish', 'evidence.publish', wire)
      plans.set(PUBLISH_PLAN, view)
      return json(201, view)
    })
    .on('POST', /^\/api\/v1\/markets\/plans\/([^/]+)\/submitted$/, (_req, m) => {
      const view = plans.get(m[1] ?? '')
      return view ? json(200, { ...view, planState: { ...view.planState, state: 'submitted' } }) : apiError(404, 'NOT_FOUND', 'Plan not found')
    })
    .on('GET', /^\/api\/v1\/markets\/plans\/([^/]+)$/, (_req, m) => {
      const view = plans.get(m[1] ?? '')
      return view ? json(200, { ...view, planState: { ...view.planState, state: 'confirmed' } }) : apiError(404, 'NOT_FOUND', 'Plan not found')
    })
    .on('GET', /^\/api\/v1\/markets\/([^/]+)\/evidence$/, () =>
      json(200, {
        market: MARKET,
        evidenceDeadline: EVIDENCE_DEADLINE,
        revealDeadline: REVEAL_DEADLINE,
        items: state.commitments.map((commitment, i) => ({
          registry: PINE.evidenceRegistry,
          submissionId: String(7 + i),
          market: MARKET,
          submitter: ACCOUNT,
          status: 'committed',
          commitment,
          contentSha256: null,
          committedAt: NOW_S,
          committedTxHash: `0x${'ab'.repeat(32)}`,
        })),
        nextCursor: null,
      }),
    )
    .on('POST', /^\/api\/v1\/evidence\/artifacts$/, (req) => {
      const file = req.form?.find((f) => f.name === 'file')
      const bytes = new TextEncoder().encode(file?.value ?? '')
      return json(201, { sha256: sha256Hex(bytes), cid: 'bafkreiexample', size: bytes.byteLength })
    })
    .on('POST', /^\/api\/v1\/evidence\/manifests$/, (req) => {
      state.manifests.push(req.json)
      const encoded = encodeEvidenceManifest(req.json as EvidenceManifest)
      return json(201, { sha256: encoded.sha256, cid: 'bafkreimanifest', size: encoded.bytes.byteLength })
    })
    .on('POST', /^\/api\/v1\/evidence\/reveal-template$/, (req) => {
      const body = req.json as { submissionId: string; contentSha256: Hex32 }
      const commitment = state.commitments[Number(body.submissionId) - 7] ?? `0x${'00'.repeat(32)}`
      return json(200, {
        template: {
          chainId: 100,
          registry: PINE.evidenceRegistry,
          function: 'revealEvidence(uint256,bytes32,bytes32)',
          submissionId: body.submissionId,
          contentSha256: body.contentSha256,
          commitment,
          market: MARKET,
          account: ACCOUNT,
          revealDeadline: REVEAL_DEADLINE,
          revealDeadlineIso: iso(REVEAL_DEADLINE),
          operator: 'block.timestamp < revealDeadline',
          expiresAt: REVEAL_DEADLINE - 60,
          expiresAtIso: iso(REVEAL_DEADLINE - 60),
        },
        warnings: [],
        instructions: ['Never send the salt to Pine or any other server.'],
        contentTrust: 'untrusted',
      })
    })
}

function render() {
  return renderHook(() => ({ ev: useApiEvidence(MARKET, { now: () => NOW, sleep: noSleep, pollIntervalMs: 1 }), wallet: useWallet() }), { wrapper })
}

async function ready(result: ReturnType<typeof render>['result']) {
  act(() => result.current.wallet.connect())
  await waitFor(() => expect(result.current.ev.claim?.claimDocumentSha256).toBe(CLAIM_DOC_SHA))
  await act(async () => {
    expect(await result.current.ev.prepare(composition())).not.toBeNull()
  })
}

const allText = (requests: RecordedRequest[]) => requests.map((r) => `${r.path}?${r.query.toString()} ${r.text}`).join('\n')

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
  state = { commitments: [], commitFailures: [], manifests: [] }
  fake = backend(state)
  vi.stubGlobal('fetch', fake.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('prepareEvidence', () => {
  const ctx = { chainId: 100, market: MARKET, submitter: ACCOUNT, claim: { claimDocumentSha256: CLAIM_DOC_SHA, commit: COMMIT } }

  it('builds the canonical manifest locally, bound to the submitter and the on-chain claim', async () => {
    const r = await prepareEvidence(composition(), ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const bytes = new TextEncoder().encode(ARTIFACT_TEXT)
    expect(r.prepared.manifest).toMatchObject({
      submitter: ACCOUNT,
      claim: { chainId: 100, market: MARKET, claimDocumentSha256: CLAIM_DOC_SHA, commit: COMMIT },
      artifacts: [{ name: 'my-secret-notes.txt', sha256: sha256Hex(bytes), size: bytes.byteLength, mediaType: 'text/plain', locators: [], description: 'Steps' }],
    })
    expect(r.prepared.contentSha256).toBe(encodeEvidenceManifest(r.prepared.manifest).sha256)
  })

  it('SEC-EVID-01 refuses oversized files, unaccepted media types, bad names and missing text before anything is sent', async () => {
    const big = new File([new Uint8Array(262_145)], 'big.bin', { type: 'application/zip' })
    const html = new File(['<script>'], 'x.html', { type: 'text/html' })
    const r = await prepareEvidence(
      { ...composition(), title: ' ', artifacts: [{ file: big }, { file: html }, { file: new File(['x'], 'a/b.txt', { type: 'text/plain' }) }] },
      ctx,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.map((e) => e.field)).toEqual(['artifacts.0.size', 'artifacts.1.mediaType', 'artifacts.2.name', 'title'])
  })

  it('draws a fresh, nonzero 32-byte salt from the CSPRNG', () => {
    const a = newEvidenceSalt()
    expect(a).toMatch(/^0x[0-9a-f]{64}$/)
    expect(newEvidenceSalt()).not.toBe(a)
    let calls = 0
    const zeroThenOnes = (b: Uint8Array) => (calls++ === 0 ? b : b.fill(1))
    expect(newEvidenceSalt(zeroThenOnes)).toBe(`0x${'01'.repeat(32)}`)
  })
})

describe('useApiEvidence', () => {
  it('SEC-EVID-13 commits sealed evidence without uploading it, and the salt never reaches Pine', async () => {
    const { result } = render()
    await ready(result)
    const sha = result.current.ev.prepared?.contentSha256 as Hex32
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))

    const seal = readSeal(getBrowserStorage(), MARKET, sha, ACCOUNT)
    expect(seal).not.toBeNull()
    const salt = seal?.salt ?? '0x'
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
    // Nothing of the sealed evidence was uploaded before the reveal.
    expect(fake.of(/^\/api\/v1\/evidence\/(artifacts|manifests)$/)).toEqual([])
    // The commit request carries exactly the locally computed commitment, with an idempotency key.
    const commitment = computeEvidenceCommitment({ chainId: 100, registry: PINE.evidenceRegistry, market: MARKET, submitter: ACCOUNT, contentSha256: sha, salt })
    const [commitReq] = fake.of(/\/evidence\/plans\/commit$/)
    expect(commitReq?.text).toBe(JSON.stringify({ market: MARKET, commitment }))
    expect(commitReq?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    // The mined commit is reported with its step id and hash, exactly.
    const step = result.current.ev.runner.runner.steps[0]
    expect(fake.of(/\/markets\/plans\/[^/]+\/submitted$/).map((r) => r.text)).toEqual([JSON.stringify({ stepId: 'commit', txHash: step?.txHash?.toLowerCase() })])
    // No request Pine received contains the salt.
    expect(allText(fake.requests)).not.toContain(salt.slice(2))
    expect(result.current.ev.seals[0]).toMatchObject({ state: 'committed', revealDeadline: REVEAL_DEADLINE, revealOpen: true })
    await waitFor(() => expect(result.current.ev.planState?.state).toBe('confirmed'))
  })

  it('reveals in one step: uploads then, finds the submission, checks the template and builds the reveal locally', async () => {
    const { result } = render()
    await ready(result)
    const prepared = result.current.ev.prepared
    const sha = prepared?.contentSha256 as Hex32
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
    const salt = readSeal(getBrowserStorage(), MARKET, sha, ACCOUNT)?.salt ?? '0x'

    await act(async () => {
      void result.current.ev.reveal(sha)
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('revealed'))

    // The artifact is uploaded with its digest and a neutral file name; the manifest exactly as prepared.
    const [upload] = fake.of(/^\/api\/v1\/evidence\/artifacts$/)
    const artifactSha = sha256Hex(new TextEncoder().encode(ARTIFACT_TEXT))
    expect(upload?.form).toEqual([
      { name: 'expectedSha256', value: artifactSha },
      { name: 'file', value: ARTIFACT_TEXT, type: 'text/plain', filename: 'artifact' },
    ])
    expect(upload?.headers['content-type']).toBeUndefined()
    expect(state.manifests).toEqual([prepared?.manifest])
    expect(fake.of(/\/reveal-template$/).map((r) => r.text)).toEqual([JSON.stringify({ submissionId: '7', contentSha256: sha })])
    // The reveal transaction (built here) carries the salt; Pine never saw it and gets no report for it.
    expect(result.current.ev.runner.plan?.steps[0]?.allowlistId).toBe('evidenceRegistry.revealEvidence')
    expect(result.current.ev.runner.plan?.steps[0]?.args).toEqual([7n, sha, salt])
    expect(fake.of(/\/submitted$/)).toHaveLength(1)
    expect(allText(fake.requests)).not.toContain(salt.slice(2))
  })

  it('asks for the committed files again after a reload before revealing', async () => {
    const { result } = render()
    await ready(result)
    const sha = result.current.ev.prepared?.contentSha256 as Hex32
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
    __clearSessionArtifacts()
    await act(async () => {
      void result.current.ev.reveal(sha)
    })
    expect(result.current.ev.error?.message).toMatch(/Attach the committed files again to reveal: my-secret-notes\.txt/)
    expect(fake.of(/\/reveal-template$/)).toEqual([])
    await act(async () => {
      void result.current.ev.reveal(sha, { files: [new File([ARTIFACT_TEXT], 'renamed.txt', { type: 'text/plain' })] })
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('revealed'))
  })

  it('refuses a commit plan for another commitment before any wallet prompt', async () => {
    state.tamperCommitment = `0x${'42'.repeat(32)}` as Hex32
    const { result } = render()
    await ready(result)
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.error?.code).toBe('PLAN_REJECTED'))
    expect(result.current.ev.error?.message).toMatch(/commitment differs/)
    expect(result.current.ev.runner.runner.steps).toEqual([])
    expect(fake.of(/\/submitted$/)).toEqual([])
  })

  it('SEC-TX-08 reuses the idempotency key (and the same salt) when a commit plan request is retried', async () => {
    state.commitFailures = [apiError(503, 'NOT_READY', 'Chain data is behind; try again shortly', { retryAfter: 1 }), apiError(500, 'INTERNAL', 'boom'), apiError(500, 'INTERNAL', 'boom')]
    const { result } = render()
    await ready(result)
    await act(async () => {
      void result.current.ev.commit()
    })
    // NOT_READY was retried automatically after Retry-After; the INTERNAL failure stops the run.
    await waitFor(() => expect(result.current.ev.error?.code).toBe('INTERNAL'))
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.error?.code).toBe('INTERNAL'))
    await act(async () => {
      void result.current.ev.commit()
    })
    await waitFor(() => expect(result.current.ev.seals[0]?.state).toBe('committed'))
    const attempts = fake.of(/\/evidence\/plans\/commit$/)
    expect(attempts).toHaveLength(4)
    expect(new Set(attempts.map((r) => r.headers['idempotency-key'])).size).toBe(1)
    expect(new Set(attempts.map((r) => r.text)).size).toBe(1)
  })

  it('publishes direct evidence: uploads first, then a publish plan for exactly that digest', async () => {
    const { result } = render()
    await ready(result)
    const sha = result.current.ev.prepared?.contentSha256 as Hex32
    await act(async () => {
      void result.current.ev.publish()
    })
    await waitFor(() => expect(result.current.ev.runner.runner.state).toBe('done'))
    const order = fake.requests.map((r) => `${r.method} ${r.path}`)
    expect(order.slice(0, 3)).toEqual(['POST /api/v1/evidence/artifacts', 'POST /api/v1/evidence/manifests', 'POST /api/v1/evidence/plans/publish'])
    expect(fake.of(/\/evidence\/plans\/publish$/)[0]?.text).toBe(JSON.stringify({ market: MARKET, contentSha256: sha }))
    const step = result.current.ev.runner.runner.steps[0]
    expect(fake.of(/\/submitted$/).map((r) => r.text)).toEqual([JSON.stringify({ stepId: 'publish', txHash: step?.txHash?.toLowerCase() })])
  })

  it('never commits for another wallet’s seal and refuses when the evidence window closed', async () => {
    const { result } = render()
    await ready(result)
    expect(readSeal(getBrowserStorage(), MARKET, result.current.ev.prepared?.contentSha256 as Hex32, OTHER)).toBeNull()
    const late = renderHook(() => ({ ev: useApiEvidence(MARKET, { now: () => new Date((EVIDENCE_DEADLINE - 30) * 1000), sleep: noSleep }), wallet: useWallet() }), { wrapper })
    await ready(late.result)
    await act(async () => {
      void late.result.current.ev.commit()
    })
    expect(late.result.current.ev.error?.message).toMatch(/window has closed/)
    expect(fake.of(/\/evidence\/plans\/commit$/)).toEqual([])
  })
})
