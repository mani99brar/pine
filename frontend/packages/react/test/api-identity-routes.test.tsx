// @vitest-environment node
/**
 * The Prism app's own route handlers in `api` mode: every /api/* path belongs to the Pine backend (the edge proxy routes
 * them there), so the app's handlers answer 404 without running; llms.txt describes the backend's agent endpoints.
 */
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nextAuth = vi.hoisted(() => ({
  auth: vi.fn(async () => null),
  handlers: {
    GET: vi.fn(async () => new Response('auth.js', { status: 200 })),
    POST: vi.fn(async () => new Response('auth.js', { status: 200 })),
  },
}))
vi.mock('@/auth', () => nextAuth)
vi.mock('@/lib/site', () => ({ APP_NAME: 'Pine Prism', siteUrl: () => 'https://app.pine.example' }))

type Handler = (req: Request, ctx?: { params: Promise<{ path?: string[] }> }) => Promise<Response>

/** Loads an app route module (outside this package's TypeScript program, so by path). */
async function route(rel: string): Promise<Record<string, Handler | undefined>> {
  const file = fileURLToPath(new URL(`../../../apps/prism/src/app/${rel}`, import.meta.url))
  return (await import(/* @vite-ignore */ file)) as Record<string, Handler | undefined>
}

async function call(rel: string, method: string, path: string): Promise<Response> {
  const handler = (await route(rel))[method]
  if (!handler) throw new Error(`${rel} exports no ${method}`)
  const segments = path.split('/').filter(Boolean).slice(2)
  const init: RequestInit = method === 'GET' || method === 'OPTIONS' ? { method } : { method, headers: { 'content-type': 'application/json' }, body: '{}' }
  return handler(new Request(`https://app.pine.example${path}`, init), { params: Promise.resolve({ path: segments }) })
}

const APP_API: [file: string, method: string, path: string][] = [
  ['api/agent/[...path]/route.ts', 'GET', '/api/agent/v1/claims'],
  ['api/agent/[...path]/route.ts', 'OPTIONS', '/api/agent/v1/claims'],
  ['api/account/[...path]/route.ts', 'GET', '/api/account/me'],
  ['api/account/[...path]/route.ts', 'POST', '/api/account/siwe/verify'],
  ['api/account/[...path]/route.ts', 'PATCH', '/api/account/preferences'],
  ['api/account/[...path]/route.ts', 'DELETE', '/api/account/me'],
  ['api/auth/[...nextauth]/route.ts', 'GET', '/api/auth/session'],
  ['api/auth/[...nextauth]/route.ts', 'POST', '/api/auth/callback/demo'],
  ['api/github/[...path]/route.ts', 'GET', '/api/github/viewer'],
  ['api/ipfs/route.ts', 'POST', '/api/ipfs'],
  ['.well-known/pine.json/route.ts', 'GET', '/.well-known/pine.json'],
]

beforeEach(() => {
  nextAuth.auth.mockClear()
  nextAuth.handlers.GET.mockClear()
  nextAuth.handlers.POST.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the app’s own handlers in api mode', () => {
  it('SEC-AUTH-16 answer 404 and never run: no second sign-in, account, GitHub token or upload surface beside the backend', async () => {
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    for (const [file, method, path] of APP_API) {
      const res = await call(file, method, path)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
    }
    // Auth.js and the session getter the account, GitHub and IPFS handlers start with were never reached.
    expect(nextAuth.auth).not.toHaveBeenCalled()
    expect(nextAuth.handlers.GET).not.toHaveBeenCalled()
    expect(nextAuth.handlers.POST).not.toHaveBeenCalled()
  })

  it('llms.txt and llms-full.txt describe the backend’s agent endpoints, not the app’s', async () => {
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    for (const file of ['llms.txt/route.ts', 'llms-full.txt/route.ts']) {
      const res = await call(file, 'GET', `/${file.split('/')[0]}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      const text = await res.text()
      for (const endpoint of ['/api/v1/agents/claims', '/api/v1/agents/claims/{market}', '/api/v1/policies', '/api/v1/schemas/claim-document.json', '/api/openapi.json', '/.well-known/pine.json']) {
        expect(text, `${file} names ${endpoint}`).toContain(`https://app.pine.example${endpoint}`)
      }
      expect(text).not.toContain('/api/agent/')
      expect(text).toContain('untrusted')
    }
  })
})

describe('the app’s own handlers outside api mode', () => {
  it('still run in demo mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'mock')
    const index = await call('api/agent/[...path]/route.ts', 'GET', '/api/agent/v1')
    expect(index.status).toBe(200)
    expect(((await index.json()) as { version?: string }).version).toBe('v1')
    const viewer = await call('api/github/[...path]/route.ts', 'GET', '/api/github/viewer')
    expect(viewer.status).toBe(200)
    expect(nextAuth.auth).toHaveBeenCalled()
    await call('api/auth/[...nextauth]/route.ts', 'GET', '/api/auth/session')
    expect(nextAuth.handlers.GET).toHaveBeenCalledTimes(1)
    const llms = await call('llms.txt/route.ts', 'GET', '/llms.txt')
    expect(await llms.text()).toContain('/api/agent/v1')
  })
})
