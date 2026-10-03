import { canonicalJson, hashJson, type ClaimManifest, type Hex } from '@pine/core'
import { readPineEnv } from '../env'
import { fakeCid, hasLocalStorage, readStorage, removeStorage, writeStorage } from '../internal/util'
import { PineDataError, type ManifestStorage, type PineEnv } from '../types'

/**
 * Contract of the app's `/api/ipfs` route (implemented by @pine/server, see docs/frontend/STATUS.md 18:58Z):
 *
 *   POST /api/ipfs?name=<file.json>   Content-Type: application/json
 *   body: the JSON value to pin (sent as canonical JSON text)
 *   200 → { uri: "ipfs://<cid>[/path]", cid, hash (keccak256 of canonicalJson(value)), gatewayUrl, size, pinned, mock }
 *
 * The server pins the canonical JSON bytes. The client recomputes `hashJson(value)` and rejects a
 * response whose `hash` differs (PineDataError 'bad_response').
 */
export interface IpfsUploadResponse {
  uri?: string
  cid?: string
  hash?: string
  gatewayUrl?: string
  size?: number
  pinned?: boolean
  mock?: boolean
}

export interface ManifestStorageOptions {
  fetch?: typeof fetch
  /** Base of the app's API routes in the browser (default: same origin, `/api/ipfs`). */
  apiBase?: string
  /** Server-side bearer token for PINE_IPFS_UPLOAD_URL (default: process.env.PINE_IPFS_UPLOAD_TOKEN). */
  uploadToken?: string
}

/** Turn `ipfs://<cid>/<path>`, `/ipfs/<cid>/<path>` or a bare CID into a gateway URL. http(s) URLs pass through. */
export function ipfsToGatewayUrl(uri: string, gateway: string): string {
  const g = gateway.replace(/\/+$/, '')
  if (/^https?:\/\//i.test(uri)) return uri
  if (uri.startsWith('ipfs://')) return `${g}/ipfs/${uri.slice('ipfs://'.length).replace(/^ipfs\//, '')}`
  if (uri.startsWith('/ipfs/')) return `${g}${uri}`
  return `${g}/ipfs/${uri}`
}

/** Extract the CID from `ipfs://<cid>/…`, `/ipfs/<cid>/…` or a gateway URL. */
export function cidFromUri(uri: string): string | undefined {
  const m = /(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]+)/.exec(uri)
  if (m) return m[1]
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(uri) ? uri : undefined
}

/** Tolerant parser for pinning-service responses. */
export function parseUploadResponse(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  const direct = [b.cid, b.IpfsHash, b.Hash, b.hash_cid].find((v) => typeof v === 'string') as string | undefined
  if (direct) return cidFromUri(direct) ?? direct
  if (typeof b.uri === 'string') return cidFromUri(b.uri)
  if (Array.isArray(b.cids) && typeof b.cids[0] === 'string') return cidFromUri(b.cids[0])
  if (b.data && typeof b.data === 'object') return parseUploadResponse(b.data)
  return undefined
}

function assertManifest(value: unknown, uri: string): ClaimManifest {
  const m = value as Partial<ClaimManifest> | null
  if (!m || typeof m !== 'object' || m.manifestVersion !== '1' || typeof m.claimId !== 'string' || !m.question || !m.claim) {
    throw new PineDataError(`Content at ${uri} is not a Pine claim manifest`, 'bad_response')
  }
  return m as ClaimManifest
}

// ---------------------------------------------------------------------------
// IPFS
// ---------------------------------------------------------------------------

export class IpfsManifestStorage implements ManifestStorage {
  readonly kind = 'ipfs' as const
  private readonly fetcher: typeof fetch

  constructor(
    private readonly env: Pick<PineEnv, 'ipfsGateway' | 'ipfsUploadUrl'>,
    private readonly opts: ManifestStorageOptions = {},
  ) {
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
  }

  gatewayUrl(uri: string): string {
    return ipfsToGatewayUrl(uri, this.env.ipfsGateway)
  }

  async putJson(value: unknown, name = 'data.json'): Promise<{ uri: string; cid: string; hash: Hex; gatewayUrl: string }> {
    const content = canonicalJson(value)
    const hash = hashJson(value)
    const isBrowser = typeof window !== 'undefined'
    let res: Response
    try {
      if (!isBrowser && this.env.ipfsUploadUrl) {
        // Server-side: multipart upload of the canonical bytes to the configured pinning endpoint.
        const form = new FormData()
        form.append('file', new Blob([content], { type: 'application/json' }), name)
        const token = this.opts.uploadToken ?? readServerToken()
        res = await this.fetcher(this.env.ipfsUploadUrl, {
          method: 'POST',
          body: form,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
      } else {
        const base = (this.opts.apiBase ?? '').replace(/\/+$/, '')
        res = await this.fetcher(`${base}/api/ipfs?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content,
        })
      }
    } catch (err) {
      throw new PineDataError('Could not reach the IPFS upload endpoint', 'network', err)
    }
    if (!res.ok) {
      throw new PineDataError(`IPFS upload failed (${res.status})`, res.status === 401 || res.status === 403 ? 'unauthorized' : 'network', { status: res.status })
    }
    let body: IpfsUploadResponse
    try {
      body = (await res.json()) as IpfsUploadResponse
    } catch (err) {
      throw new PineDataError('IPFS upload returned an unreadable response', 'bad_response', err)
    }
    if (typeof body?.hash === 'string' && body.hash.toLowerCase() !== hash.toLowerCase()) {
      throw new PineDataError(`IPFS upload hash mismatch: expected ${hash}, got ${body.hash}`, 'bad_response')
    }
    const cid = parseUploadResponse(body)
    if (!cid) throw new PineDataError('IPFS upload response did not include a CID', 'bad_response')
    const uri = typeof body.uri === 'string' && body.uri.startsWith('ipfs://') ? body.uri : `ipfs://${cid}`
    return { uri, cid, hash, gatewayUrl: typeof body.gatewayUrl === 'string' ? body.gatewayUrl : this.gatewayUrl(uri) }
  }

  async getJson<T = unknown>(uri: string): Promise<T> {
    const url = this.gatewayUrl(uri)
    let res: Response
    try {
      res = await this.fetcher(url, { headers: { Accept: 'application/json' } })
    } catch (err) {
      throw new PineDataError(`Could not fetch ${uri} from the IPFS gateway`, 'network', err)
    }
    if (res.status === 404) throw new PineDataError(`${uri} was not found on the IPFS gateway`, 'not_found')
    if (!res.ok) throw new PineDataError(`IPFS gateway error ${res.status} for ${uri}`, 'network', { status: res.status })
    try {
      return (await res.json()) as T
    } catch (err) {
      throw new PineDataError(`${uri} is not valid JSON`, 'bad_response', err)
    }
  }

  async getManifest(uri: string): Promise<ClaimManifest> {
    return assertManifest(await this.getJson(uri), uri)
  }
}

function readServerToken(): string | undefined {
  try {
    return process.env.PINE_IPFS_UPLOAD_TOKEN || undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

const MOCK_IPFS_PREFIX = 'pine:mock:ipfs:'
const MOCK_IPFS_INDEX = 'pine:mock:ipfs-index'
/** Demo uploads kept in localStorage; older ones are evicted so drafts never lose space to them. */
const MOCK_IPFS_MAX = 40
const memory = new Map<string, unknown>()

function persistMockUpload(cid: string, value: unknown): void {
  const stored = readStorage<unknown>(MOCK_IPFS_INDEX)
  const index = (Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : []).filter((c) => c !== cid)
  index.push(cid)
  while (index.length > MOCK_IPFS_MAX) {
    const old = index.shift()
    if (old) removeStorage(`${MOCK_IPFS_PREFIX}${old}`)
  }
  if (writeStorage(`${MOCK_IPFS_PREFIX}${cid}`, value)) writeStorage(MOCK_IPFS_INDEX, index)
}
let seeded: Promise<void> | undefined

/** Deterministic fake CIDs (derived from the keccak hash); content kept in memory/localStorage. */
export class MockManifestStorage implements ManifestStorage {
  readonly kind = 'mock' as const
  constructor(private readonly env: Pick<PineEnv, 'ipfsGateway'>) {}

  gatewayUrl(uri: string): string {
    return ipfsToGatewayUrl(uri, this.env.ipfsGateway)
  }

  async putJson(value: unknown, _name?: string): Promise<{ uri: string; cid: string; hash: Hex; gatewayUrl: string }> {
    const hash = hashJson(value)
    const cid = fakeCid(hash)
    const stored = JSON.parse(canonicalJson(value)) as unknown
    memory.set(cid, stored)
    if (hasLocalStorage()) persistMockUpload(cid, stored)
    const uri = `ipfs://${cid}`
    return { uri, cid, hash, gatewayUrl: this.gatewayUrl(uri) }
  }

  async getJson<T = unknown>(uri: string): Promise<T> {
    await seedFixtureManifests()
    const cid = cidFromUri(uri)
    if (!cid) throw new PineDataError(`Not an IPFS URI: ${uri}`, 'bad_response')
    const v = memory.get(cid) ?? readStorage<unknown>(`${MOCK_IPFS_PREFIX}${cid}`)
    if (v === undefined) throw new PineDataError(`${uri} is not in demo storage`, 'not_found')
    return JSON.parse(JSON.stringify(v)) as T
  }

  async getManifest(uri: string): Promise<ClaimManifest> {
    return assertManifest(await this.getJson(uri), uri)
  }
}

/** Fixture manifests are resolvable from mock storage too (lazy import keeps fixtures out of non-mock bundles' hot path). */
function seedFixtureManifests(): Promise<void> {
  seeded ??= import('../mock/fixtures').then(({ fixtures }) => {
    for (const c of fixtures.claims) {
      const cid = cidFromUri(c.manifestUri)
      if (cid && !memory.has(cid)) memory.set(cid, c.manifest)
    }
  })
  return seeded
}

/**
 * `mock` data source → MockManifestStorage; otherwise IPFS: uploads go to `/api/ipfs` in the browser
 * or to PINE_IPFS_UPLOAD_URL server-side; reads go through `env.ipfsGateway`.
 */
export function createManifestStorage(env: PineEnv = readPineEnv(), opts: ManifestStorageOptions = {}): ManifestStorage {
  if (env.dataSource === 'mock') return new MockManifestStorage(env)
  return new IpfsManifestStorage(env, opts)
}
