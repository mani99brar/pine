import type { ClaimDraft } from '@pine/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAFT_KEY_PREFIX, LocalDraftStore } from '../src'

// Two LocalDraftStores over one localStorage are two tabs of the same browser.
function installFakeWindow() {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: () => {},
  }
  return store
}

const MARKET = '0x00000000000000000000000000000000000000aa'

const draft = (id: string): ClaimDraft => ({
  id,
  owner: 'alice',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  stage: 'claim',
  spec: { title: 'Keeper retry budget survives a restart', requirement: 'The retry budget is persisted.' },
})

function sealed(d: ClaimDraft): ClaimDraft {
  return {
    ...d,
    stage: 'publish',
    publication: {
      steps: [
        { id: 'create_market', status: 'confirmed', txHash: `0x${'1'.repeat(64)}` },
        { id: 'add_liquidity_yes', status: 'pending' },
      ],
      marketAddress: MARKET,
      claimId: 'claim-1',
      manifestUri: 'ipfs://bafkreimanifest',
      backend: { draftId: 'b-1', revision: 2, previewId: 'p-1', publicationId: 'pub-1' },
    },
  }
}

let raw: Map<string, string>

beforeEach(() => {
  raw = installFakeWindow()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('LocalDraftStore: tabs saving the same draft', () => {
  it('[13] refuses a save over a version another tab saved, and hands back the stored draft', async () => {
    const seed = new LocalDraftStore()
    await seed.save(draft('d-two-tabs'))
    const a = new LocalDraftStore()
    const b = new LocalDraftStore()
    const loadedA = await a.get('d-two-tabs')
    const loadedB = await b.get('d-two-tabs')
    if (!loadedA || !loadedB) throw new Error('not stored')

    const savedA = await a.saveIfUnchanged({ ...loadedA, spec: { ...loadedA.spec, title: 'TITLE FROM TAB A' } })
    expect(savedA.ok).toBe(true)

    const savedB = await b.saveIfUnchanged({ ...loadedB, spec: { ...loadedB.spec, requirement: 'REQUIREMENT FROM TAB B' } })
    expect(savedB.ok).toBe(false)
    if (savedB.ok) return
    expect(savedB.current?.spec.title).toBe('TITLE FROM TAB A')
    expect(savedB.base?.spec.title).toBe('Keeper retry budget survives a restart')
    // Nothing of tab B was written.
    expect((await new LocalDraftStore().get('d-two-tabs'))?.spec).toEqual({ ...loadedA.spec, title: 'TITLE FROM TAB A' })

    // Tab B adopts the stored draft and saves its edit on top of it.
    const current = savedB.current
    if (!current) throw new Error('deleted')
    const again = await b.saveIfUnchanged({ ...current, spec: { ...current.spec, requirement: 'REQUIREMENT FROM TAB B' } })
    expect(again.ok).toBe(true)
    expect((await new LocalDraftStore().get('d-two-tabs'))?.spec).toMatchObject({ title: 'TITLE FROM TAB A', requirement: 'REQUIREMENT FROM TAB B' })
  })

  it('[13] moves the revision forward on every save, even within one millisecond', async () => {
    const s = new LocalDraftStore()
    const first = await s.save(draft('d-rev'))
    const second = await s.save(first)
    const third = await s.save(second)
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt))
    expect(Date.parse(third.updatedAt)).toBeGreaterThan(Date.parse(second.updatedAt))
  })

  it('[13] a tab’s own save (the publish hook) is not a conflict for its next conditional save', async () => {
    const s = new LocalDraftStore()
    const loaded = await s.save(draft('d-own'))
    await s.save({ ...loaded, publication: { steps: [{ id: 'create_market', status: 'pending' }] } })
    const next = await s.saveIfUnchanged({ ...loaded, spec: { ...loaded.spec, title: 'Edited' } })
    expect(next.ok).toBe(true)
  })

  it('[13] creates a new draft only while no other tab stored one under its id', async () => {
    const a = new LocalDraftStore()
    const b = new LocalDraftStore()
    expect(await a.get('d-new')).toBeNull()
    expect(await b.get('d-new')).toBeNull()
    expect((await a.saveIfUnchanged(draft('d-new'))).ok).toBe(true)
    const refused = await b.saveIfUnchanged({ ...draft('d-new'), stage: 'policy' })
    expect(refused).toMatchObject({ ok: false, base: null })
  })

  it('[14] never recreates a draft another tab deleted, until the tab saves it again on purpose', async () => {
    const a = new LocalDraftStore()
    const b = new LocalDraftStore()
    const loaded = await a.save(draft('d-deleted'))
    await b.remove('d-deleted')

    const edit = { ...loaded, stage: 'policy' as const }
    expect(await a.saveIfUnchanged(edit)).toMatchObject({ ok: false, current: null })
    // Reading it again (a refetch) does not make the deletion forgotten.
    expect(await a.get('d-deleted')).toBeNull()
    expect(await a.saveIfUnchanged(edit)).toMatchObject({ ok: false, current: null })
    expect(raw.has(DRAFT_KEY_PREFIX + 'd-deleted')).toBe(false)

    // Keeping it is an explicit save.
    await a.save(edit)
    expect((await b.get('d-deleted'))?.stage).toBe('policy')
  })

  it('SEC-TX-08 [11] a stale copy never unseals a stored draft: market, confirmed steps, Pine publication and terms stay', async () => {
    const a = new LocalDraftStore()
    const b = new LocalDraftStore()
    const loaded = await a.save(draft('d-sealed'))
    const stale = await b.get('d-sealed')
    if (!stale) throw new Error('not stored')
    await a.save(sealed(loaded))

    // Tab B still holds the draft from before the publication: no steps, an older Pine draft, edited terms.
    await b.save({
      ...stale,
      spec: { ...stale.spec, requirement: 'EDITED AFTER SEALING' },
      publication: { steps: [], backend: { draftId: 'b-1', revision: 3 } },
    })

    const stored = await new LocalDraftStore().get('d-sealed')
    expect(stored?.spec).toEqual(loaded.spec)
    expect(stored?.publication?.marketAddress).toBe(MARKET)
    expect(stored?.publication?.claimId).toBe('claim-1')
    expect(stored?.publication?.manifestUri).toBe('ipfs://bafkreimanifest')
    expect(stored?.publication?.backend?.publicationId).toBe('pub-1')
    expect(stored?.publication?.steps.find((s) => s.id === 'create_market')?.status).toBe('confirmed')
  })

  it('SEC-TX-08 [11] keeps later publication progress saved over a sealed draft', async () => {
    const s = new LocalDraftStore()
    const saved = await s.save(sealed(draft('d-progress')))
    await s.save({
      ...saved,
      publication: {
        ...saved.publication,
        steps: [
          { id: 'create_market', status: 'confirmed' },
          { id: 'add_liquidity_yes', status: 'confirmed' },
        ],
      },
    })
    const stored = await s.get('d-progress')
    expect(stored?.publication?.steps.map((x) => [x.id, x.status])).toEqual([
      ['create_market', 'confirmed'],
      ['add_liquidity_yes', 'confirmed'],
    ])
    // The confirmed create_market step keeps its recorded transaction.
    expect(stored?.publication?.steps[0]?.txHash).toBe(`0x${'1'.repeat(64)}`)
  })
})
