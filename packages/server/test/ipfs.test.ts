import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, stringToBytes } from 'viem'
import { canonicalJson, hashJson } from '@pine/core'
import { createIpfsHandler, extractCidPath, rawCidV1 } from '../src/ipfs'
import { req, signedOut } from './helpers'

function post(body: string, headers: Record<string, string> = { 'content-type': 'application/json' }, path = '/api/ipfs') {
  return req(path, { method: 'POST', headers, body })
}

describe('/api/ipfs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('mock mode returns a deterministic CIDv1 and the keccak256 of the canonical bytes', async () => {
    vi.stubEnv('PINE_IPFS_UPLOAD_URL', '')
    const { POST } = createIpfsHandler()
    const a = await POST(post(JSON.stringify({ b: 1, a: [1, 2] })))
    const b = await POST(post('{"a":[1,2],"b":1}'))
    expect(a.status).toBe(200)
    const ra = (await a.json()) as { uri: string; cid: string; hash: string; gatewayUrl: string; mock: boolean; size: number }
    const rb = (await b.json()) as { cid: string; hash: string }
    expect(ra.cid).toBe(rb.cid)
    expect(ra.cid).toMatch(/^bafkrei[a-z2-7]+$/)
    expect(ra.uri).toBe(`ipfs://${ra.cid}`)
    expect(ra.hash).toBe(keccak256(stringToBytes('{"a":[1,2],"b":1}')))
    expect(ra.hash).toBe(hashJson({ a: [1, 2], b: 1 }))
    expect(ra.size).toBe(canonicalJson({ a: [1, 2], b: 1 }).length)
    expect(ra.mock).toBe(true)
    expect(ra.gatewayUrl).toContain(`/ipfs/${ra.cid}`)
  })

  it('rawCidV1 matches a known vector (empty input)', async () => {
    expect(await rawCidV1(new Uint8Array())).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku')
  })

  it('enforces JSON content-type, valid JSON and the size limit', async () => {
    const { POST } = createIpfsHandler({ maxBytes: 64 })
    expect((await POST(post('{}', { 'content-type': 'text/plain' }))).status).toBe(415)
    expect((await POST(post('{not json'))).status).toBe(400)
    expect((await POST(post(''))).status).toBe(400)
    expect((await POST(post(JSON.stringify({ x: 'y'.repeat(100) })))).status).toBe(413)
    expect((await POST(post('{}', { 'content-type': 'application/json', 'content-length': '999999' }))).status).toBe(413)
  })

  it('live mode forwards a multipart upload with the token and parses Kleros-style responses', async () => {
    vi.stubEnv('PINE_IPFS_UPLOAD_URL', 'https://pin.example/upload')
    vi.stubEnv('PINE_IPFS_UPLOAD_TOKEN', 'secret-token')
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token')
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify({ cids: ['/ipfs/QmTestCid123/claim.manifest.json'] }), { status: 200 })
    })
    const { POST } = createIpfsHandler({ fetch: fetchMock as unknown as typeof fetch })
    const res = await POST(post('{"a":1}', { 'content-type': 'application/json' }, '/api/ipfs?name=claim.manifest.json'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { uri: string; cid: string; pinned: boolean; hash: string }
    expect(body).toMatchObject({ uri: 'ipfs://QmTestCid123/claim.manifest.json', cid: 'QmTestCid123', pinned: true, hash: hashJson({ a: 1 }) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('live uploads require a session when auth is provided', async () => {
    vi.stubEnv('PINE_IPFS_UPLOAD_URL', 'https://pin.example/upload')
    const { POST } = createIpfsHandler({ auth: signedOut })
    expect((await POST(post('{"a":1}'))).status).toBe(401)
  })

  it('extractCidPath understands common pinning responses', () => {
    expect(extractCidPath({ IpfsHash: 'QmA' })).toBe('QmA')
    expect(extractCidPath({ Hash: 'QmB' })).toBe('QmB')
    expect(extractCidPath({ cid: 'ipfs://bafyC' })).toBe('bafyC')
    expect(extractCidPath({ value: { cid: 'bafyD' } })).toBe('bafyD')
    expect(extractCidPath({ nope: 1 })).toBeUndefined()
  })
})
