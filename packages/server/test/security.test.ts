/** Security regressions for @pine/server: auth/demo gating, SIWE binding, CSRF, body limits, caching, errors. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createSiweMessage } from 'viem/siwe'
import { createDataProvider, readPineEnv, PineDataError, type PineDataProvider } from '@pine/data'
import { pineAuthConfig } from '../src/auth'
import { demoAllowed, readServerEnv } from '../src/env'
import { createAccountHandler, verifySiwe } from '../src/siwe'
import { createAgentHandler, llmsTxtHandler } from '../src/agent'
import { createGitHubHandler, mapGitHubError } from '../src/github'
import { createIpfsHandler } from '../src/ipfs'
import { cookieHeader, ctx, req, signedIn } from './helpers'

const wallet = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const noRpc = () => undefined

afterEach(() => {
  vi.unstubAllEnvs()
})

function siweMessage(nonce: string, domain: string, over: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  const now = new Date()
  return createSiweMessage({
    domain,
    address: wallet.address,
    statement: 'Link this wallet to your Pine account.',
    uri: `https://${domain}`,
    version: '1',
    chainId: 100,
    nonce,
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
    ...over,
  })
}

/** A body stream with no Content-Length (chunked), larger than `bytes`. */
function streamingBody(bytes: number): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent > bytes) return controller.close()
      const chunk = new Uint8Array(4096).fill(0x61)
      sent += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
}

describe('security: demo sign-in in production', () => {
  it('is disabled in production rest mode without GitHub OAuth (one shared REST account for every visitor)', () => {
    expect(demoAllowed({ dataSource: 'rest', githubOAuthConfigured: false, demoWallet: false, production: true })).toBe(false)
    expect(demoAllowed({ dataSource: 'rest', githubOAuthConfigured: false, demoWallet: false, production: false })).toBe(true)
    expect(demoAllowed({ dataSource: 'envio', githubOAuthConfigured: false, demoWallet: false, production: true })).toBe(true)
    expect(demoAllowed({ dataSource: 'mock', githubOAuthConfigured: true, demoWallet: true, production: true })).toBe(true)
    expect(demoAllowed({ dataSource: 'rest', githubOAuthConfigured: true, demoWallet: false })).toBe(false)
  })

  it('pineAuthConfig registers no demo provider and the demo wallet route is refused', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', 'test-secret-test-secret-test-secret-123')
    vi.stubEnv('AUTH_GITHUB_ID', '')
    vi.stubEnv('AUTH_GITHUB_SECRET', '')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'rest')
    vi.stubEnv('NEXT_PUBLIC_PINE_API_URL', 'https://api.example/v1')
    const config = pineAuthConfig(readServerEnv())
    const ids = config.providers.map((p) => {
      const v = (typeof p === 'function' ? p() : p) as { id?: string; options?: { id?: string } }
      return v.options?.id ?? v.id
    })
    expect(ids).not.toContain('demo')

    const handler = createAccountHandler(signedIn())
    const res = await handler.POST(
      req('/api/account/wallets/demo', { method: 'POST', headers: { origin: 'http://localhost:3001' }, body: '{}' }),
      ctx(['wallets', 'demo']),
    )
    expect(res.status).toBe(403)
  })
})

describe('security: SIWE domain binding', () => {
  async function nonceFor(handler: ReturnType<typeof createAccountHandler>, headers: Record<string, string> = {}) {
    const res = await handler.GET(req('/api/account/nonce', { headers }), ctx(['nonce']))
    const { nonce } = (await res.json()) as { nonce: string }
    return { nonce, cookie: cookieHeader(res) }
  }

  it('with AUTH_URL set, a forged X-Forwarded-Host cannot make a signature for another site acceptable', async () => {
    vi.stubEnv('AUTH_URL', 'https://pine.example')
    const handler = createAccountHandler(signedIn(), { publicClientFor: noRpc })
    const { nonce, cookie } = await nonceFor(handler)
    // The victim signed this on evil.example (their wallet sees a matching domain, so no warning).
    const msg = siweMessage(nonce, 'evil.example')
    const res = await handler.POST(
      req('/api/account/siwe/verify', {
        method: 'POST',
        headers: { cookie, 'x-forwarded-host': 'evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg, signature: await wallet.signMessage({ message: msg }) }),
      }),
      ctx(['siwe', 'verify']),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('domain_mismatch')

    // A message for the canonical host is accepted.
    const again = await nonceFor(handler)
    const good = siweMessage(again.nonce, 'pine.example')
    const ok = await handler.POST(
      req('/api/account/siwe/verify', {
        method: 'POST',
        headers: { cookie: again.cookie, origin: 'https://pine.example', 'content-type': 'application/json' },
        body: JSON.stringify({ message: good, signature: await wallet.signMessage({ message: good }) }),
      }),
      ctx(['siwe', 'verify']),
    )
    expect(ok.status).toBe(200)
  })

  it('rejects a message whose URI is on another host, or that has no issued-at time', async () => {
    const base = { signature: '', expectedDomain: 'pine.example', expectedNonce: 'abcdef12345678', publicClientFor: noRpc }
    const otherUri = siweMessage('abcdef12345678', 'pine.example', { uri: 'https://evil.example/login' })
    const r1 = await verifySiwe({ ...base, message: otherUri, signature: await wallet.signMessage({ message: otherUri }) })
    expect(r1).toMatchObject({ ok: false, code: 'domain_mismatch' })

    const noIssued = siweMessage('abcdef12345678', 'pine.example', { issuedAt: undefined })
    const withoutIssuedAt = noIssued
      .split(String.fromCharCode(10))
      .filter((l) => !l.startsWith('Issued At:'))
      .join(String.fromCharCode(10))
    const r2 = await verifySiwe({ ...base, message: withoutIssuedAt, signature: await wallet.signMessage({ message: withoutIssuedAt }) })
    expect(r2).toMatchObject({ ok: false, code: 'bad_message' })
  })
})

describe('security: CSRF on state-changing account routes', () => {
  const body = JSON.stringify({ defaultSpendingLimit: '1000' })

  it('rejects requests the browser marks cross-site or same-site even without an Origin header', async () => {
    const handler = createAccountHandler(signedIn())
    for (const site of ['cross-site', 'same-site']) {
      const res = await handler.PATCH(
        req('/api/account/preferences', { method: 'PATCH', headers: { 'sec-fetch-site': site }, body }),
        ctx(['preferences']),
      )
      expect(res.status, site).toBe(403)
    }
    const del = await handler.DELETE(req('/api/account/me', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } }), ctx(['me']))
    expect(del.status).toBe(403)
    const nullOrigin = await handler.PATCH(req('/api/account/preferences', { method: 'PATCH', headers: { origin: 'null' }, body }), ctx(['preferences']))
    expect(nullOrigin.status).toBe(403)
  })

  it('accepts same-origin browser requests', async () => {
    const handler = createAccountHandler(signedIn())
    const res = await handler.PATCH(
      req('/api/account/preferences', { method: 'PATCH', headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3001' }, body }),
      ctx(['preferences']),
    )
    expect(res.status).toBe(200)
  })
})

describe('security: request body limits', () => {
  it('account routes refuse an oversized chunked body without buffering it', async () => {
    const handler = createAccountHandler(signedIn())
    const res = await handler.PATCH(
      new Request('http://localhost:3001/api/account/preferences', {
        method: 'PATCH',
        headers: { origin: 'http://localhost:3001' },
        body: streamingBody(200_000),
        duplex: 'half',
      } as RequestInit),
      ctx(['preferences']),
    )
    expect(res.status).toBe(413)
  })

  it('/api/ipfs refuses an oversized chunked body (no Content-Length)', async () => {
    vi.stubEnv('PINE_IPFS_UPLOAD_URL', '')
    const { POST } = createIpfsHandler({ maxBytes: 1024 })
    const res = await POST(
      new Request('http://localhost:3001/api/ipfs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: streamingBody(10_000),
        duplex: 'half',
      } as RequestInit),
    )
    expect(res.status).toBe(413)
  })

  it('/api/ipfs rejects a malformed CID from the pinning service (it would end up in the market name)', async () => {
    vi.stubEnv('PINE_IPFS_UPLOAD_URL', 'https://pin.example/upload')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cid: 'QmAbc" injected — Terms: x' }), { status: 200 }))
    const { POST } = createIpfsHandler({ fetch: fetchMock as unknown as typeof fetch })
    const res = await POST(req('/api/ipfs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }))
    expect(res.status).toBe(502)
  })
})

describe('security: agent API caching and errors', () => {
  const data = createDataProvider(readPineEnv({ dataSource: 'mock' }))

  it('publicly cached responses vary on Accept (JSON vs Markdown) and on forwarded host when URLs come from the request', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_PINE_SITE_URL', '')
    const agent = createAgentHandler({ appName: 'Pine Test', data })
    const res = await agent.GET(req('/api/agent/v1/claims/pine-0009', { headers: { 'x-forwarded-host': 'evil.example' } }), ctx(['v1', 'claims', 'pine-0009']))
    expect(res.headers.get('cache-control')).toMatch(/^public/)
    const vary = res.headers.get('vary') ?? ''
    expect(vary).toMatch(/Accept/)
    expect(vary).toMatch(/X-Forwarded-Host/)

    const llms = await llmsTxtHandler({ appName: 'Pine Test', data }).GET(req('/llms.txt'))
    expect(llms.headers.get('vary')).toMatch(/X-Forwarded-Host/)

    const configured = createAgentHandler({ appName: 'Pine Test', data, siteUrl: 'https://pine.example' })
    const md = await configured.GET(req('/api/agent/v1/claims/pine-0009', { headers: { accept: 'text/markdown' } }), ctx(['v1', 'claims', 'pine-0009']))
    expect(md.headers.get('content-type')).toMatch(/markdown/)
    expect(md.headers.get('vary')).toBe('Accept')
  })

  it('does not leak unexpected upstream exception messages', async () => {
    const broken = {
      ...data,
      listClaims: async () => {
        throw new TypeError('connect ECONNREFUSED 10.0.0.12:5432 (internal-db)')
      },
    } as unknown as PineDataProvider
    const agent = createAgentHandler({ appName: 'Pine Test', data: broken, siteUrl: 'https://pine.example' })
    const res = await agent.GET(req('/api/agent/v1/claims'), ctx(['v1', 'claims']))
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain('10.0.0.12')
    expect(text).toContain('Data source request failed.')

    const known = {
      ...data,
      listClaims: async () => {
        throw new PineDataError('Envio indexer rate limit reached; retry shortly', 'rate_limited')
      },
    } as unknown as PineDataProvider
    const res2 = await createAgentHandler({ appName: 'Pine Test', data: known, siteUrl: 'https://pine.example' }).GET(req('/api/agent/v1/claims'), ctx(['v1', 'claims']))
    expect(await res2.text()).toContain('rate limit')
  })
})

describe('security: GitHub proxy', () => {
  it('rejects dot-segment repository names', async () => {
    const gh = createGitHubHandler(signedIn(), { mode: 'mock' })
    for (const repo of ['..', '.']) {
      const res = await gh.GET(req(`/api/github/repos/kleros/${repo}/commits`), ctx(['repos', 'kleros', repo, 'commits']))
      expect(res.status, repo).toBe(400)
    }
  })

  it('maps unexpected errors to a generic message', async () => {
    const res = mapGitHubError(new Error('getaddrinfo ENOTFOUND ghe.internal.corp'))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('internal.corp')
  })
})

describe('security: signed account cookie', () => {
  it('stays under the 4096-byte browser cookie limit at its largest (10 wallets, longest email)', async () => {
    const { accountCookie, freshStored, linkWallet } = await import('../src/account-store')
    let stored = freshStored('a-very-long-github-login-name-39-chars', 11155111)
    for (let i = 0; i < 25; i++) {
      stored = linkWallet(stored, {
        address: `0x${i.toString(16).padStart(40, 'f')}` as `0x${string}`,
        chainId: 11155111,
        verifiedAt: '2026-10-03T12:00:00Z',
        label: 'Demo wallet (simulated signature)',
      })
    }
    stored = {
      ...stored,
      preferences: {
        ...stored.preferences,
        defaultSpendingLimit: '1'.repeat(21) + '.' + '1'.repeat(18),
        notificationEmail: `${'x'.repeat(64)}@${'y'.repeat(185)}.com`,
        displayCurrency: 'collateral',
      },
    }
    expect(stored.wallets).toHaveLength(10)
    const cookie = await accountCookie(req('/'), stored, 'secret')
    const nameValue = cookie.split(';')[0]!
    expect(nameValue.length).toBeLessThan(4096)
  })
})
