/**
 * JSON pinning endpoint: `src/app/api/ipfs/route.ts`
 *
 *   import { auth } from '@/auth'
 *   import { createIpfsHandler } from '@pine/server/ipfs'
 *   export const { POST } = createIpfsHandler({ auth })
 *
 * Request:  POST /api/ipfs[?name=claim.manifest.json]
 *           Content-Type: application/json, body = the JSON value to pin (≤ 1 MB)
 * Response: { uri: "ipfs://<cid>[/<name>]", cid, hash, gatewayUrl, size, pinned, mock }
 *           `hash` = keccak256(canonical JSON) — the same hash Pine uses for manifests.
 *
 * The server pins the canonical JSON bytes, so anyone can re-hash the IPFS content and compare.
 * Mock mode (no PINE_IPFS_UPLOAD_URL): nothing is uploaded; the CID is the real CIDv1 (raw, sha2-256)
 * of the canonical bytes, so it is deterministic. Live mode: forwards a multipart `file` upload to
 * PINE_IPFS_UPLOAD_URL with `Authorization: Bearer PINE_IPFS_UPLOAD_TOKEN` and understands common
 * response shapes (Kleros `cids`, Pinata `IpfsHash`, Kubo `Hash`, `{ cid }`).
 */
import { keccak256 } from 'viem'
import { canonicalJson } from '@pine/core'
import { readServerEnv } from './env'
import { errorResponse, json, PRIVATE_NO_STORE } from './http'
import { getSessionUser, type SessionGetter } from './session'

export const IPFS_MAX_BYTES = 1_048_576

export interface IpfsHandlerOptions {
  /** When given, live uploads require a signed-in session (abuse control). */
  auth?: SessionGetter
  /** Require a session even in mock mode. Default: only in live mode when `auth` is provided. */
  requireSession?: boolean
  maxBytes?: number
  /** Inject fetch (tests). */
  fetch?: typeof fetch
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** CIDv1 (raw codec 0x55, sha2-256) of the bytes, base32 multibase ("bafkrei…"). */
export async function rawCidV1(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
  const prefixed = new Uint8Array(4 + digest.length)
  prefixed.set([0x01, 0x55, 0x12, 0x20], 0)
  prefixed.set(digest, 4)
  return `b${base32(prefixed)}`
}

function sanitizeName(name: string | null): string | undefined {
  if (!name) return undefined
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : undefined
}

/** Extracts `<cid>[/<path>]` from common pinning-service responses. */
export function extractCidPath(body: unknown): string | undefined {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return undefined
  const candidates: unknown[] = [
    Array.isArray(b.cids) ? b.cids[0] : undefined,
    b.cid,
    b.IpfsHash,
    b.Hash,
    (b.value as Record<string, unknown> | undefined)?.cid,
    (b.data as Record<string, unknown> | undefined)?.cid,
    Array.isArray(b.data) ? (b.data[0] as Record<string, unknown> | undefined)?.hash : undefined,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c.replace(/^ipfs:\/\//, '').replace(/^\/?ipfs\//, '')
    }
    if (c && typeof c === 'object' && typeof (c as { '/': unknown })['/'] === 'string') return (c as { '/': string })['/']
  }
  return undefined
}

export function createIpfsHandler(opts: IpfsHandlerOptions = {}) {
  const maxBytes = opts.maxBytes ?? IPFS_MAX_BYTES
  const doFetch = opts.fetch ?? fetch

  async function POST(req: Request): Promise<Response> {
    const env = readServerEnv()
    const live = Boolean(env.ipfsUploadUrl)
    const mustSignIn = opts.requireSession ?? (live && Boolean(opts.auth))
    if (mustSignIn) {
      const user = opts.auth ? await getSessionUser(opts.auth, req) : null
      if (!user) return errorResponse(401, 'unauthorized', 'Sign in to upload to IPFS.')
    }

    const ct = (req.headers.get('content-type') ?? '').toLowerCase()
    if (!ct.startsWith('application/json')) {
      return errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json.')
    }
    const declared = Number(req.headers.get('content-length') ?? '0')
    if (declared > maxBytes) return errorResponse(413, 'too_large', `Body exceeds ${maxBytes} bytes.`)

    const raw = new Uint8Array(await req.arrayBuffer())
    if (raw.byteLength > maxBytes) return errorResponse(413, 'too_large', `Body exceeds ${maxBytes} bytes.`)
    if (raw.byteLength === 0) return errorResponse(400, 'bad_request', 'Empty body.')

    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return errorResponse(400, 'bad_request', 'Body is not valid JSON.')
    }

    let canonical: string
    try {
      canonical = canonicalJson(value)
    } catch (e) {
      return errorResponse(400, 'bad_request', `JSON cannot be canonicalized: ${e instanceof Error ? e.message : String(e)}`)
    }
    const bytes = new TextEncoder().encode(canonical)
    // keccak256 of exactly the bytes that are pinned (== hashJson(value)), so clients can verify.
    const hash = keccak256(bytes)
    const name = sanitizeName(new URL(req.url).searchParams.get('name'))

    if (!live) {
      const cid = await rawCidV1(bytes)
      return json(
        {
          uri: `ipfs://${cid}`,
          cid,
          hash,
          gatewayUrl: `${env.ipfsGateway}/ipfs/${cid}`,
          size: bytes.byteLength,
          pinned: false,
          mock: true,
        },
        { cache: PRIVATE_NO_STORE },
      )
    }

    try {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'application/json' }), name ?? 'data.json')
      const headers: Record<string, string> = {}
      if (env.ipfsUploadToken) headers.authorization = `Bearer ${env.ipfsUploadToken}`
      const upstream = await doFetch(env.ipfsUploadUrl as string, { method: 'POST', body: form, headers })
      if (!upstream.ok) {
        return errorResponse(502, 'upstream_error', `Pinning service responded ${upstream.status}.`)
      }
      const body = (await upstream.json().catch(() => null)) as unknown
      const cidPath = extractCidPath(body)
      if (!cidPath) return errorResponse(502, 'upstream_error', 'Pinning service response did not include a CID.')
      const cid = cidPath.split('/')[0] as string
      return json(
        {
          uri: `ipfs://${cidPath}`,
          cid,
          hash,
          gatewayUrl: `${env.ipfsGateway}/ipfs/${cidPath}`,
          size: bytes.byteLength,
          pinned: true,
          mock: false,
        },
        { cache: PRIVATE_NO_STORE },
      )
    } catch (e) {
      return errorResponse(502, 'upstream_error', e instanceof Error ? e.message : 'Upload failed.')
    }
  }

  return { POST }
}
