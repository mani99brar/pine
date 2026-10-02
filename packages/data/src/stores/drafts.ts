import type { ClaimDraft } from '@pine/core'
import { readPineEnv } from '../env'
import { fixtures } from '../mock/fixtures'
import { clone, hasLocalStorage, readStorage, removeStorage, writeStorage } from '../internal/util'
import { RestClient, type TokenGetter } from '../rest/http'
import { draftFromWire, draftToWire, type WireDraft } from '../rest/wire'
import type { DraftStore, PineEnv } from '../types'

export const DRAFT_KEY_PREFIX = 'pine:drafts:'
const INDEX_KEY = 'pine:drafts:index'
const SEEDED_KEY = 'pine:drafts:seeded'

/** Server-side / no-storage fallback shared by every LocalDraftStore in this runtime. */
const memoryDrafts = new Map<string, ClaimDraft>()
let memorySeeded = false

/**
 * Drafts in localStorage (`pine:drafts:<id>` plus an index) with an in-memory fallback when
 * storage is unavailable (server, private mode, quota). Optionally seeded once with demo drafts.
 */
export class LocalDraftStore implements DraftStore {
  private readonly useStorage: boolean

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
    return readStorage<string[]>(INDEX_KEY) ?? []
  }

  private read(id: string): ClaimDraft | null {
    if (!this.useStorage) return memoryDrafts.get(id) ?? null
    return readStorage<ClaimDraft>(DRAFT_KEY_PREFIX + id) ?? null
  }

  private write(d: ClaimDraft): void {
    if (!this.useStorage) {
      memoryDrafts.set(d.id, clone(d))
      return
    }
    writeStorage(DRAFT_KEY_PREFIX + d.id, d)
    const ids = this.ids()
    if (!ids.includes(d.id)) writeStorage(INDEX_KEY, [d.id, ...ids])
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
    return d ? clone(d) : null
  }

  async save(draft: ClaimDraft): Promise<ClaimDraft> {
    const saved: ClaimDraft = { ...clone(draft), updatedAt: new Date().toISOString() }
    this.write(saved)
    return clone(saved)
  }

  async remove(id: string): Promise<void> {
    if (!this.useStorage) {
      memoryDrafts.delete(id)
      return
    }
    removeStorage(DRAFT_KEY_PREFIX + id)
    writeStorage(
      INDEX_KEY,
      this.ids().filter((x) => x !== id),
    )
  }
}

/** Drafts via the REST write API: GET/PUT/DELETE /drafts/{id}, GET /drafts?owner= (bearer auth). */
export class RestDraftStore implements DraftStore {
  private readonly client: RestClient
  constructor(opts: { baseUrl: string; getToken?: TokenGetter; fetch?: typeof fetch }) {
    this.client = new RestClient(opts)
  }

  async list(owner: string): Promise<ClaimDraft[]> {
    const r = await this.client.request<{ items: WireDraft[] }>('GET', '/drafts', { query: { owner }, auth: true })
    return (r?.items ?? []).map(draftFromWire)
  }

  async get(id: string): Promise<ClaimDraft | null> {
    const r = await this.client.request<WireDraft>('GET', `/drafts/${encodeURIComponent(id)}`, { auth: true, nullOn404: true })
    return r ? draftFromWire(r) : null
  }

  async save(draft: ClaimDraft): Promise<ClaimDraft> {
    const body = draftToWire({ ...draft, updatedAt: new Date().toISOString() })
    const r = await this.client.request<WireDraft>('PUT', `/drafts/${encodeURIComponent(draft.id)}`, { body, auth: true })
    return r ? draftFromWire(r) : { ...draft, updatedAt: body.updated_at }
  }

  async remove(id: string): Promise<void> {
    await this.client.request('DELETE', `/drafts/${encodeURIComponent(id)}`, { auth: true, nullOn404: true })
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
