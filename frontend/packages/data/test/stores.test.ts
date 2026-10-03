import { canonicalJson, hashJson, type ClaimDraft } from '@pine/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cidFromUri,
  createAccountStore,
  createDraftStore,
  createManifestStorage,
  DEMO_GITHUB_USER,
  DEMO_WALLET_ADDRESS,
  IpfsManifestStorage,
  ipfsToGatewayUrl,
  LocalAccountStore,
  LocalDraftStore,
  MockManifestStorage,
  PineDataError,
  readPineEnv,
  RestAccountStore,
  RestDraftStore,
} from '../src'
import { fixtures } from '../src/mock/fixtures'

const mockEnv = { ...readPineEnv(), dataSource: 'mock' as const }
const ipfsEnv = { ...readPineEnv(), dataSource: 'envio' as const, envioGraphqlUrl: 'https://x/graphql', ipfsGateway: 'https://gw.example' }

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

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

describe('ManifestStorage', () => {
  it('converts ipfs URIs to gateway URLs and extracts CIDs', () => {
    expect(ipfsToGatewayUrl('ipfs://bafkreiabc/manifest.json', 'https://cdn.kleros.link/')).toBe('https://cdn.kleros.link/ipfs/bafkreiabc/manifest.json')
    expect(ipfsToGatewayUrl('/ipfs/QmX', 'https://gw')).toBe('https://gw/ipfs/QmX')
    expect(ipfsToGatewayUrl('https://example.com/x.json', 'https://gw')).toBe('https://example.com/x.json')
    expect(cidFromUri('ipfs://bafkreiabc/x.json')).toBe('bafkreiabc')
    expect(cidFromUri('https://gw/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a')).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
  })

  it('mock: deterministic CIDs, round-trips values and resolves fixture manifests', async () => {
    const s = createManifestStorage(mockEnv)
    expect(s.kind).toBe('mock')
    const value = { b: 1, a: [1, 2, { c: 'x' }] }
    const r1 = await s.putJson(value, 'x.json')
    const r2 = await s.putJson({ a: [1, 2, { c: 'x' }], b: 1 })
    expect(r1.cid).toBe(r2.cid)
    expect(r1.hash).toBe(hashJson(value))
    expect(r1.uri).toBe(`ipfs://${r1.cid}`)
    expect(await s.getJson(r1.uri)).toEqual(value)
    const claim = fixtures.claims[0]!
    expect(hashJson(await s.getManifest(claim.manifestUri))).toBe(claim.manifestHash)
    await expect(s.getJson('ipfs://bafkreidoesnotexist')).rejects.toMatchObject({ code: 'not_found' })
    await expect(s.getManifest(r1.uri)).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('ipfs (browser): POSTs canonical JSON to /api/ipfs?name= and verifies the returned hash', async () => {
    installFakeWindow()
    const value = { z: 1, a: 'two' }
    const calls: { url: string; init?: RequestInit }[] = []
    const good = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ uri: 'ipfs://bafkreigood/manifest.json', cid: 'bafkreigood', hash: hashJson(value), gatewayUrl: 'https://cdn.kleros.link/ipfs/bafkreigood/manifest.json', size: 17, pinned: true, mock: false }))
    }) as typeof fetch
    const s = createManifestStorage(ipfsEnv, { fetch: good })
    expect(s.kind).toBe('ipfs')
    const r = await s.putJson(value, 'manifest.json')
    expect(calls[0]!.url).toBe('/api/ipfs?name=manifest.json')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe(canonicalJson(value))
    expect(r).toEqual({ uri: 'ipfs://bafkreigood/manifest.json', cid: 'bafkreigood', hash: hashJson(value), gatewayUrl: 'https://cdn.kleros.link/ipfs/bafkreigood/manifest.json' })

    const tampered = (async () => new Response(JSON.stringify({ cid: 'bafkreibad', hash: `0x${'0'.repeat(64)}` }))) as typeof fetch
    await expect(new IpfsManifestStorage(ipfsEnv, { fetch: tampered }).putJson(value)).rejects.toMatchObject({ code: 'bad_response' })
    const down = (async () => new Response('no', { status: 503 })) as typeof fetch
    await expect(new IpfsManifestStorage(ipfsEnv, { fetch: down }).putJson(value)).rejects.toMatchObject({ code: 'network' })
  })

  it('ipfs (server): uploads multipart to PINE_IPFS_UPLOAD_URL with the bearer token', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const pin = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(url), init }
      return new Response(JSON.stringify({ IpfsHash: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' }))
    }) as typeof fetch
    const s = new IpfsManifestStorage({ ...ipfsEnv, ipfsUploadUrl: 'https://pin.example/upload' }, { fetch: pin, uploadToken: 'secret' })
    const r = await s.putJson({ a: 1 }, 'a.json')
    expect(seen?.url).toBe('https://pin.example/upload')
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret')
    expect(seen?.init?.body).toBeInstanceOf(FormData)
    expect(r.cid).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
    expect(r.gatewayUrl).toBe('https://gw.example/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
  })

  it('ipfs: reads manifests through the gateway and validates shape', async () => {
    const manifest = fixtures.claims[0]!.manifest
    const gw = (async (url: RequestInfo | URL) => {
      const u = String(url)
      if (u.endsWith('/ipfs/bafkreimanifest')) return new Response(JSON.stringify(manifest))
      if (u.endsWith('/ipfs/bafkreinotjson')) return new Response('<html>')
      return new Response('nf', { status: 404 })
    }) as typeof fetch
    const s = new IpfsManifestStorage(ipfsEnv, { fetch: gw })
    expect(hashJson(await s.getManifest('ipfs://bafkreimanifest'))).toBe(fixtures.claims[0]!.manifestHash)
    await expect(s.getJson('ipfs://bafkreinotjson')).rejects.toMatchObject({ code: 'bad_response' })
    await expect(s.getJson('ipfs://bafkreimissing')).rejects.toMatchObject({ code: 'not_found' })
  })
})

const draft = (id: string, owner = 'someone'): ClaimDraft => ({
  id,
  owner,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  stage: 'source',
  spec: { title: `Draft ${id}`, parameters: { CHAIN_PAIR: 'gnosis↔arbitrum' } },
})

describe('DraftStore', () => {
  it('local (memory fallback on the server): save / get / list / remove round-trip', async () => {
    const s = new LocalDraftStore()
    const saved = await s.save(draft('d-mem-1', 'Alice'))
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(Date.parse('2026-10-01T00:00:00Z'))
    await s.save(draft('d-mem-2', 'alice'))
    await s.save(draft('d-mem-3', 'bob'))
    expect((await s.list('ALICE')).map((d) => d.id).sort()).toEqual(['d-mem-1', 'd-mem-2'])
    expect((await s.get('d-mem-1'))?.spec.parameters).toEqual({ CHAIN_PAIR: 'gnosis↔arbitrum' })
    await s.remove('d-mem-1')
    expect(await s.get('d-mem-1')).toBeNull()
    expect((await s.list('alice')).map((d) => d.id)).toEqual(['d-mem-2'])
  })

  it('local (browser): persists under pine:drafts:* and seeds demo drafts once in mock mode', async () => {
    const store = installFakeWindow()
    const s = createDraftStore(mockEnv)
    const demo = await s.list(DEMO_GITHUB_USER.login)
    expect(demo.map((d) => d.id).sort()).toEqual(fixtures.drafts.map((d) => d.id).sort())
    await s.remove(fixtures.drafts[0]!.id)
    await s.save(draft('d-browser', DEMO_GITHUB_USER.login))
    expect([...store.keys()].every((k) => k.startsWith('pine:drafts:'))).toBe(true)
    const again = createDraftStore(mockEnv) // a reload: removed seed stays removed
    const ids = (await again.list(DEMO_GITHUB_USER.login)).map((d) => d.id)
    expect(ids).toContain('d-browser')
    expect(ids).not.toContain(fixtures.drafts[0]!.id)
  })

  it('local (browser): falls back to memory when storage is full, without losing the draft', async () => {
    const store = installFakeWindow()
    const ls = (globalThis as unknown as { window: { localStorage: { setItem: (k: string, v: string) => void } } }).window.localStorage
    ls.setItem = (k: string, v: string) => {
      if (k.startsWith('pine:drafts:d-big')) throw new DOMException('quota', 'QuotaExceededError')
      store.set(k, v)
    }
    const s = new LocalDraftStore()
    await s.save(draft('d-big-1', 'quota-user'))
    await s.save(draft('d-small', 'quota-user'))
    expect((await s.list('quota-user')).map((d) => d.id).sort()).toEqual(['d-big-1', 'd-small'])
    expect(store.has('pine:drafts:d-big-1')).toBe(false)
    expect(store.has('pine:drafts:d-small')).toBe(true)
    await s.remove('d-big-1')
    expect(await s.get('d-big-1')).toBeNull()
  })

  it('rest: GET/PUT/DELETE /drafts with bearer auth and wire mapping', async () => {
    const calls: { method: string; url: string; auth?: string; body?: unknown }[] = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method: init?.method ?? 'GET', url: String(url), auth: headers.Authorization, body })
      if (init?.method === 'PUT') return new Response(JSON.stringify(body))
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (String(url).includes('/drafts?')) return new Response(JSON.stringify({ items: [{ id: 'd1', owner: 'alice', created_at: 'x', updated_at: 'y', stage: 'claim', spec: { title: 'T' }, source: null, funding: null, publication: null }] }))
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no draft' } }), { status: 404 })
    }) as typeof fetch
    const s = createDraftStore({ ...readPineEnv(), dataSource: 'rest', apiUrl: 'https://api.test/v1' }, { fetch: fetcher, getToken: async () => 'tok' })
    expect(s).toBeInstanceOf(RestDraftStore)
    const list = await s.list('alice')
    expect(list[0]).toEqual({ id: 'd1', owner: 'alice', createdAt: 'x', updatedAt: 'y', stage: 'claim', spec: { title: 'T' } })
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://api.test/v1/drafts?owner=alice', auth: 'Bearer tok' })
    const saved = await s.save(draft('d2', 'alice'))
    expect(calls[1]!.method).toBe('PUT')
    expect((calls[1]!.body as Record<string, unknown>).created_at).toBe('2026-10-01T00:00:00Z')
    expect(saved.spec.parameters).toEqual({ CHAIN_PAIR: 'gnosis↔arbitrum' })
    expect(await s.get('missing')).toBeNull()
    await s.remove('d2')
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/drafts/d2' })
  })
})

describe('AccountStore', () => {
  it('local: mock mode seeds the demo account; link/unlink/primary/preferences/export/remove', async () => {
    const s = createAccountStore(mockEnv)
    expect(s).toBeInstanceOf(LocalAccountStore)
    const demo = await s.get('Mara-Okafor')
    expect(demo?.wallets.find((w) => w.primary)?.address).toBe(DEMO_WALLET_ADDRESS)

    const user = { login: 'new-user', id: 7, name: 'New User', avatarUrl: 'a', htmlUrl: 'h' }
    const created = await s.upsertFromGitHub(user, ['read:user'], false)
    expect(created.wallets).toEqual([])
    expect(created.preferences.defaultChainId).toBe(100)
    const w1 = { address: '0x1111111111111111111111111111111111111111' as const, chainId: 100, verifiedAt: '2026-10-02T00:00:00Z', primary: false }
    const w2 = { address: '0x2222222222222222222222222222222222222222' as const, chainId: 100, verifiedAt: '2026-10-02T00:00:00Z', primary: false }
    expect((await s.linkWallet('new-user', w1)).wallets[0]?.primary).toBe(true) // first wallet becomes primary
    const two = await s.linkWallet('new-user', w2)
    expect(two.wallets.filter((w) => w.primary).map((w) => w.address)).toEqual([w1.address])
    const switched = await s.setPrimaryWallet('new-user', w2.address)
    expect(switched.wallets.find((w) => w.primary)?.address).toBe(w2.address)
    const after = await s.unlinkWallet('new-user', w2.address)
    expect(after.wallets).toHaveLength(1)
    expect(after.wallets[0]?.primary).toBe(true)
    await expect(s.setPrimaryWallet('new-user', w2.address)).rejects.toBeInstanceOf(PineDataError)
    expect((await s.updatePreferences('new-user', { defaultSpendingLimit: '250' })).preferences.defaultSpendingLimit).toBe('250')
    const exported = await s.exportData('new-user')
    expect((exported.account as { github: { login: string } }).github.login).toBe('new-user')
    const refreshed = await s.upsertFromGitHub({ ...user, name: 'Renamed' }, ['read:user'], false)
    expect(refreshed.github.name).toBe('Renamed')
    expect(refreshed.wallets).toHaveLength(1)
    await s.remove('new-user')
    expect(await s.get('new-user')).toBeNull()
    await expect(s.linkWallet('ghost', w1)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rest: calls the account endpoints and maps the wire format', async () => {
    const wire = {
      id: 'acct_alice',
      github: { login: 'alice', id: 1, name: null, avatar_url: 'a', html_url: 'h', scopes: ['read:user'] },
      wallets: [{ address: '0x1111111111111111111111111111111111111111', chain_id: 100, verified_at: 't', label: null, primary: true }],
      preferences: { default_chain_id: 100, default_spending_limit: '100', notify_on_evidence: true, notify_on_answer: true, notify_on_deadline: false, notification_email: null, display_currency: 'collateral' },
      created_at: 'c',
      demo: false,
    }
    const calls: { method: string; url: string; body?: unknown }[] = []
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (init?.method === 'DELETE' && String(url).endsWith('/accounts/alice')) return new Response(null, { status: 204 })
      if (String(url).endsWith('/export')) return new Response(JSON.stringify({ format: 'pine-account-export/v1' }))
      return new Response(JSON.stringify(wire))
    }) as typeof fetch
    const s = new RestAccountStore({ baseUrl: 'https://api.test/v1', fetch: fetcher, getToken: () => 'tok' })
    const a = await s.get('alice')
    expect(a?.preferences).toEqual({ defaultChainId: 100, defaultSpendingLimit: '100', notifyOnEvidence: true, notifyOnAnswer: true, notifyOnDeadline: false, displayCurrency: 'collateral' })
    expect(a?.wallets[0]).toEqual({ address: '0x1111111111111111111111111111111111111111', chainId: 100, verifiedAt: 't', primary: true })
    await s.upsertFromGitHub({ login: 'alice', id: 1, avatarUrl: 'a', htmlUrl: 'h' }, ['read:user'], false)
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: 'https://api.test/v1/accounts/alice', body: { github: { login: 'alice', avatar_url: 'a', scopes: ['read:user'] }, demo: false } })
    await s.linkWallet('alice', { address: '0x2222222222222222222222222222222222222222', chainId: 100, verifiedAt: 't', primary: false })
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://api.test/v1/accounts/alice/wallets', body: { chain_id: 100, verified_at: 't' } })
    await s.setPrimaryWallet('alice', '0x2222222222222222222222222222222222222222')
    expect(calls.at(-1)?.url).toBe('https://api.test/v1/accounts/alice/wallets/0x2222222222222222222222222222222222222222/primary')
    await s.unlinkWallet('alice', '0x2222222222222222222222222222222222222222')
    expect(calls.at(-1)?.method).toBe('DELETE')
    await s.updatePreferences('alice', { notifyOnAnswer: false, notificationEmail: undefined })
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { notify_on_answer: false, notification_email: null } })
    expect(await s.exportData('alice')).toEqual({ format: 'pine-account-export/v1' })
    await s.remove('alice')
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.test/v1/accounts/alice' })
  })
})
