/** Two tabs on one draft: each tab is its own PineProviders (query cache and draft store) over the same localStorage. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ClaimDraft } from '@pine/core'
import { DRAFT_KEY_PREFIX, LocalDraftStore } from '@pine/data'
import { createPineQueryClient, PineProviders } from '../src/providers'
import { useClaimComposer } from '../src/composer/use-claim-composer'
import { useDrafts } from '../src/composer/drafts'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'mock', demoWallet: true }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

const ID = 'd-two-tabs'
const MARKET = '0x00000000000000000000000000000000000000aa'
const TITLE = 'Keeper retry budget survives a restart'

const seed: ClaimDraft = {
  id: ID,
  owner: 'local',
  createdAt: '2026-10-04T11:00:00.000Z',
  updatedAt: '2026-10-04T11:00:00.000Z',
  stage: 'claim',
  spec: { policyId: 'BOT-001', title: TITLE, requirement: 'The retry budget is persisted.', violation: 'the budget resets' },
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const stored = (): ClaimDraft | null => {
  const raw = window.localStorage.getItem(DRAFT_KEY_PREFIX + ID)
  return raw ? (JSON.parse(raw) as ClaimDraft) : null
}
/** What the browser fires in the other tabs after a write to localStorage. */
const storageEvent = (newValue: string | null) =>
  act(() => void window.dispatchEvent(new StorageEvent('storage', { key: DRAFT_KEY_PREFIX + ID, newValue, storageArea: window.localStorage })))

async function openTab() {
  const tab = renderHook(() => ({ composer: useClaimComposer(ID), drafts: useDrafts() }), { wrapper })
  await advance(50)
  expect(tab.result.current.composer.draft.spec.title).toBe(TITLE)
  return tab
}

/** Another tab (or the publish flow there) writes the draft. */
async function writeElsewhere(change: (d: ClaimDraft) => ClaimDraft) {
  const other = new LocalDraftStore()
  const current = await other.get(ID)
  if (!current) throw new Error('not stored')
  await other.save(change(current))
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
  window.localStorage.clear()
  await new LocalDraftStore().save(seed)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('composer: the same draft in two tabs', () => {
  it('[13] does not save over another tab’s newer save: it keeps both edits and says the draft changed', async () => {
    const a = await openTab()
    const b = await openTab()

    act(() => a.result.current.composer.update({ spec: { title: 'TITLE FROM TAB A' } }))
    await advance(700)
    expect(stored()?.spec.title).toBe('TITLE FROM TAB A')

    // Tab B missed the storage event: its autosave finds the newer version.
    act(() => b.result.current.composer.update({ spec: { requirement: 'REQUIREMENT FROM TAB B' } }))
    await advance(700)
    expect(b.result.current.composer.conflict).toEqual({ kind: 'changed', editsDropped: false })
    expect(b.result.current.composer.draft.spec).toMatchObject({ title: 'TITLE FROM TAB A', requirement: 'REQUIREMENT FROM TAB B' })

    await advance(700)
    expect(stored()?.spec).toMatchObject({ title: 'TITLE FROM TAB A', requirement: 'REQUIREMENT FROM TAB B' })

    act(() => b.result.current.composer.dismissConflict())
    expect(b.result.current.composer.conflict).toBeUndefined()
  })

  it('[13] takes the other tab’s value for a field both tabs changed, and says an edit was not kept', async () => {
    const b = await openTab()
    await writeElsewhere((d) => ({ ...d, spec: { ...d.spec, title: 'TITLE FROM TAB A' } }))
    act(() => b.result.current.composer.update({ spec: { title: 'TITLE FROM TAB B' } }))
    await advance(700)
    expect(b.result.current.composer.conflict).toEqual({ kind: 'changed', editsDropped: true })
    expect(b.result.current.composer.draft.spec.title).toBe('TITLE FROM TAB A')
    await advance(700)
    expect(stored()?.spec.title).toBe('TITLE FROM TAB A')
  })

  it('[13] picks up another tab’s save from the storage event', async () => {
    const b = await openTab()
    await writeElsewhere((d) => ({ ...d, spec: { ...d.spec, title: 'TITLE FROM TAB A' } }))
    await storageEvent(window.localStorage.getItem(DRAFT_KEY_PREFIX + ID))
    await advance(10)
    expect(b.result.current.composer.draft.spec.title).toBe('TITLE FROM TAB A')
    expect(b.result.current.composer.conflict?.kind).toBe('changed')
  })

  it('SEC-TX-08 [11] a stale tab never unseals the draft another tab published, nor makes it deletable', async () => {
    const b = await openTab()
    await writeElsewhere((d) => ({
      ...d,
      stage: 'publish',
      publication: {
        steps: [{ id: 'create_market', status: 'confirmed' }],
        marketAddress: MARKET,
        claimId: 'claim-1',
        backend: { draftId: 'b-1', revision: 2, publicationId: 'pub-1' },
      },
    }))

    // Tab B edits the terms it still shows as editable; its autosave finds the sealed draft.
    act(() => b.result.current.composer.update({ spec: { requirement: 'EDITED AFTER SEALING' } }))
    await advance(1_500)
    expect(b.result.current.composer.conflict).toEqual({ kind: 'changed', editsDropped: true })
    expect(b.result.current.composer.frozen).toBe(true)
    expect(b.result.current.composer.draft.spec.requirement).toBe(seed.spec.requirement)

    // Further edits of the terms are ignored, and the stored draft keeps its publication record.
    act(() => b.result.current.composer.update({ spec: { requirement: 'EDITED AGAIN' } }))
    await advance(1_500)
    const after = stored()
    expect(after?.spec).toEqual(seed.spec)
    expect(after?.publication?.marketAddress).toBe(MARKET)
    expect(after?.publication?.backend?.publicationId).toBe('pub-1')
    expect(after?.publication?.steps).toEqual([{ id: 'create_market', status: 'confirmed' }])

    await act(async () => {
      await expect(b.result.current.drafts.remove(ID)).rejects.toThrow('cannot be deleted')
    })
    expect(stored()).not.toBeNull()
  })

  it('SEC-TX-08 [11] a tab told by the storage event that the draft was sealed shows it sealed', async () => {
    const b = await openTab()
    await writeElsewhere((d) => ({ ...d, publication: { steps: [{ id: 'create_market', status: 'confirmed' }], marketAddress: MARKET } }))
    await storageEvent(window.localStorage.getItem(DRAFT_KEY_PREFIX + ID))
    await advance(10)
    expect(b.result.current.composer.frozen).toBe(true)
    expect(b.result.current.composer.conflict).toEqual({ kind: 'changed', editsDropped: false })
  })

  it('[14] never recreates a draft deleted in another tab; the user can let it go', async () => {
    const a = await openTab()
    const other = renderHook(() => useDrafts(), { wrapper })
    await advance(50)
    await act(async () => {
      await other.result.current.remove(ID)
    })
    expect(stored()).toBeNull()

    await storageEvent(null)
    await advance(10)
    expect(a.result.current.composer.conflict).toEqual({ kind: 'deleted', editsDropped: false })

    act(() => a.result.current.composer.update({ spec: { policyId: 'BOT-002' } }))
    await advance(1_500)
    expect(stored()).toBeNull()

    await act(async () => {
      await a.result.current.composer.resolveDeleted(false)
    })
    expect(a.result.current.composer.conflict).toBeUndefined()
    act(() => a.result.current.composer.update({ spec: { title: 'Still typing' } }))
    await advance(1_500)
    a.unmount()
    await advance(10)
    expect(stored()).toBeNull()
  })

  it('[14] a missed deletion is found by the autosave, and the user can keep the draft', async () => {
    const a = await openTab()
    await new LocalDraftStore().remove(ID)

    act(() => a.result.current.composer.update({ spec: { title: 'Edited after the deletion' } }))
    await advance(700)
    expect(a.result.current.composer.conflict).toEqual({ kind: 'deleted', editsDropped: false })
    expect(stored()).toBeNull()

    await act(async () => {
      await a.result.current.composer.resolveDeleted(true)
    })
    expect(a.result.current.composer.conflict).toBeUndefined()
    expect(stored()?.spec.title).toBe('Edited after the deletion')
  })
})
