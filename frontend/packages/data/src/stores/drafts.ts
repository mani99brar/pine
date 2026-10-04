import type { ClaimDraft } from '@pine/core'
import { readPineEnv } from '../env'
import { fixtures } from '../mock/fixtures'
import { clone, hasLocalStorage, readStorage, removeStorage, writeStorage } from '../internal/util'
import { RestClient, type TokenGetter } from '../rest/http'
import { draftFromWire, draftToWire, type WireDraft } from '../rest/wire'
import type { DraftSaveResult, DraftStore, PineEnv } from '../types'

export const DRAFT_KEY_PREFIX = 'pine:drafts:'
const INDEX_KEY = 'pine:drafts:index'
const SEEDED_KEY = 'pine:drafts:seeded'

/** A draft whose market exists: its create_market step confirmed, or its market address recorded. */
function isSealed(d: ClaimDraft | null): boolean {
  return Boolean(d?.publication?.marketAddress || d?.publication?.steps?.some((s) => s.id === 'create_market' && s.status === 'confirmed'))
}

/**
 * A save never unseals a draft. Once the stored draft's market exists, its terms stay as stored, and its publication keeps
 * every confirmed step, the market, claim and manifest it recorded and its Pine publication, whatever an older copy of
 * the draft (another tab's) holds. Later progress in `next` (more confirmed steps) is kept.
 */
function keepSeal(stored: ClaimDraft | null, next: ClaimDraft): ClaimDraft {
  if (!stored || !isSealed(stored)) return next
  const was = stored.publication ?? { steps: [] }
  const now = next.publication ?? { steps: [] }
  const ids = [...new Set([...was.steps.map((s) => s.id), ...now.steps.map((s) => s.id)])]
  const steps = ids.flatMap((id) => {
    const old = was.steps.find((s) => s.id === id)
    const step = now.steps.find((s) => s.id === id)
    if (old?.status === 'confirmed' || !step) return old ? [old] : []
    return [step]
  })
  const backend = was.backend?.publicationId && now.backend?.publicationId !== was.backend.publicationId ? was.backend : (now.backend ?? was.backend)
  return {
    ...next,
    source: stored.source,
    spec: stored.spec,
    publication: {
      ...now,
      steps,
      manifestUri: was.manifestUri ?? now.manifestUri,
      manifestHash: was.manifestHash ?? now.manifestHash,
      marketAddress: was.marketAddress ?? now.marketAddress,
      claimId: was.claimId ?? now.claimId,
      ...(backend ? { backend } : {}),
    },
  }
}

/** The next revision (`updatedAt`) after `stored`: now, or 1 ms after the stored one when the clock has not moved past it. */
function nextRevision(stored: ClaimDraft | null): string {
  const now = Date.now()
  const prev = stored ? Date.parse(stored.updatedAt) : Number.NaN
  return new Date(Number.isFinite(prev) && prev >= now ? prev + 1 : now).toISOString()
}

function sameDraft(a: ClaimDraft | null, b: ClaimDraft | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Server-side / no-storage fallback shared by every LocalDraftStore in this runtime. */
const memoryDrafts = new Map<string, ClaimDraft>()
let memorySeeded = false

/**
 * Drafts in localStorage (`pine:drafts:<id>` plus an index) with an in-memory fallback when
 * storage is unavailable (server, private mode) or a write fails (quota): such drafts survive for the
 * session only. Optionally seeded once with demo drafts.
 */
export class LocalDraftStore implements DraftStore {
  private readonly useStorage: boolean
  /** Per draft, the version this store (this tab) last read or wrote: what `saveIfUnchanged` expects to find stored. */
  private readonly seen = new Map<string, ClaimDraft | null>()

  constructor(opts: { seed?: ClaimDraft[]; storage?: boolean } = {}) {
    this.useStorage = (opts.storage ?? true) && hasLocalStorage()
    if (opts.seed && opts.seed.length > 0) this.seedOnce(opts.seed)
  }

  private seedOnce(seed: ClaimDraft[]): void {
    if (this.useStorage) {
      if (readStorage<boolean>(SEEDED_KEY)) return
      for (const d of seed) if (!readStorage<ClaimDraft>(DRAFT_KEY_PREFIX + d.id)) this.write(d)
      writeStorage(SEEDED_KEY, true)
    } else if (!memorySeeded) {
      for (const d of seed) if (!memoryDrafts.has(d.id)) memoryDrafts.set(d.id, clone(d))
      memorySeeded = true
    }
  }

  private ids(): string[] {
    if (!this.useStorage) return [...memoryDrafts.keys()]
    const stored = readStorage<unknown>(INDEX_KEY)
    const ids = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []
    // drafts that could not be persisted (quota) live in memory for this session
    return [...new Set([...memoryDrafts.keys(), ...ids])]
  }

  private read(id: string): ClaimDraft | null {
    const mem = memoryDrafts.get(id)
    if (mem || !this.useStorage) return mem ?? null
    const d = readStorage<ClaimDraft>(DRAFT_KEY_PREFIX + id)
    return d && typeof d === 'object' && typeof d.id === 'string' && typeof d.owner === 'string' ? d : null
  }

  /** Persists to localStorage; when storage is full or blocked, keeps the draft in memory instead. */
  private write(d: ClaimDraft): void {
    if (!this.useStorage) {
      memoryDrafts.set(d.id, clone(d))
      return
    }
    const ids = readStorage<unknown>(INDEX_KEY)
    const index = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
    const ok =
      writeStorage(DRAFT_KEY_PREFIX + d.id, d) && (index.includes(d.id) || writeStorage(INDEX_KEY, [d.id, ...index]))
    if (ok) memoryDrafts.delete(d.id)
    else memoryDrafts.set(d.id, clone(d))
  }

  async list(owner: string): Promise<ClaimDraft[]> {
    const o = owner.toLowerCase()
    return this.ids()
      .map((id) => this.read(id))
      .filter((d): d is ClaimDraft => !!d && d.owner.toLowerCase() === o)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((d) => clone(d))
  }

  async get(id: string): Promise<ClaimDraft | null> {
    const d = this.read(id)
    // A draft deleted since it was read stays expected: a save after the deletion is a conflict, not a new draft.
    if (d || !this.seen.has(id)) this.seen.set(id, d ? clone(d) : null)
    return d ? clone(d) : null
  }

  async save(draft: ClaimDraft): Promise<ClaimDraft> {
    const stored = this.read(draft.id)
    const saved: ClaimDraft = { ...keepSeal(stored, clone(draft)), updatedAt: nextRevision(stored) }
    this.write(saved)
    this.seen.set(saved.id, clone(saved))
    return clone(saved)
  }

  async saveIfUnchanged(draft: ClaimDraft): Promise<DraftSaveResult> {
    const stored = this.read(draft.id)
    const base = this.seen.get(draft.id) ?? null
    if (!sameDraft(stored, base)) {
      // A draft deleted elsewhere stays a conflict until the caller saves it again on purpose (`save`).
      if (stored) this.seen.set(draft.id, clone(stored))
      return { ok: false, current: stored ? clone(stored) : null, base: base ? clone(base) : null }
    }
    return { ok: true, draft: await this.save(draft) }
  }

  async remove(id: string): Promise<void> {
    this.seen.delete(id)
    memoryDrafts.delete(id)
    if (!this.useStorage) return
    removeStorage(DRAFT_KEY_PREFIX + id)
    const stored = readStorage<unknown>(INDEX_KEY)
    if (Array.isArray(stored)) writeStorage(INDEX_KEY, stored.filter((x) => x !== id))
  }
}

/** Drafts via the REST write API: GET/PUT/DELETE /drafts/{id}, GET /drafts?owner= (bearer auth). */
export class RestDraftStore implements DraftStore {
  private readonly client: RestClient
  /** Per draft, the `updatedAt` this store last read or wrote (null: none stored). */
  private readonly seen = new Map<string, string | null>()
  constructor(opts: { baseUrl: string; getToken?: TokenGetter; fetch?: typeof fetch }) {
    this.client = new RestClient(opts)
  }

  async list(owner: string): Promise<ClaimDraft[]> {
    const r = await this.client.request<{ items: WireDraft[] }>('GET', '/drafts', { query: { owner }, auth: true })
    return (r?.items ?? []).map(draftFromWire)
  }

  private async fetchOne(id: string): Promise<ClaimDraft | null> {
    const r = await this.client.request<WireDraft>('GET', `/drafts/${encodeURIComponent(id)}`, { auth: true, nullOn404: true })
    return r ? draftFromWire(r) : null
  }

  async get(id: string): Promise<ClaimDraft | null> {
    const d = await this.fetchOne(id)
    if (d || !this.seen.has(id)) this.seen.set(id, d ? d.updatedAt : null)
    return d
  }

  async save(draft: ClaimDraft): Promise<ClaimDraft> {
    const body = draftToWire({ ...draft, updatedAt: new Date().toISOString() })
    const r = await this.client.request<WireDraft>('PUT', `/drafts/${encodeURIComponent(draft.id)}`, { body, auth: true })
    const saved = r ? draftFromWire(r) : { ...draft, updatedAt: body.updated_at }
    this.seen.set(saved.id, saved.updatedAt)
    return saved
  }

  /**
   * Compares the server's `updatedAt` with the one last seen, then saves. The server is not asked to compare, so a
   * write from elsewhere between the read and the PUT still wins. It keeps no copy of the version it saw (`base: null`).
   */
  async saveIfUnchanged(draft: ClaimDraft): Promise<DraftSaveResult> {
    const stored = await this.fetchOne(draft.id)
    const expected = this.seen.get(draft.id) ?? null
    if ((stored?.updatedAt ?? null) !== expected) {
      if (stored) this.seen.set(draft.id, stored.updatedAt)
      return { ok: false, current: stored, base: null }
    }
    return { ok: true, draft: await this.save(draft) }
  }

  async remove(id: string): Promise<void> {
    await this.client.request('DELETE', `/drafts/${encodeURIComponent(id)}`, { auth: true, nullOn404: true })
    this.seen.delete(id)
  }
}

/**
 * `rest` with an API URL → RestDraftStore; otherwise local (browser: localStorage; server: memory).
 * In mock mode the local store is seeded once with the demo user's fixture drafts.
 */
export function createDraftStore(
  env: PineEnv = readPineEnv(),
  opts: { getToken?: TokenGetter; fetch?: typeof fetch; seed?: ClaimDraft[] } = {},
): DraftStore {
  if (env.dataSource === 'rest' && env.apiUrl) return new RestDraftStore({ baseUrl: env.apiUrl, getToken: opts.getToken, fetch: opts.fetch })
  return new LocalDraftStore({ seed: opts.seed ?? (env.dataSource === 'mock' ? fixtures.drafts : undefined) })
}
