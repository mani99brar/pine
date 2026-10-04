/** api mode: identity belongs to the Pine backend, so Auth.js must be inert (no providers, no forgeable secret). */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEV_AUTH_SECRET, demoAllowed, readServerEnv } from '../src/env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('api mode server env', () => {
  it('starts in production without AUTH_SECRET and never uses the public development secret', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    vi.stubEnv('AUTH_SECRET', '')
    const a = readServerEnv()
    const b = readServerEnv()
    expect(a.authSecret).not.toBe(DEV_AUTH_SECRET)
    expect(a.authSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(a.usingDevSecret).toBe(false)
    // A fresh random secret per read: nothing signed with it can be predicted.
    expect(a.authSecret).not.toBe(b.authSecret)
  })

  it('offers neither demo sign-in nor Auth.js GitHub sign-in, even with GitHub OAuth variables set', () => {
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    vi.stubEnv('AUTH_GITHUB_ID', 'id')
    vi.stubEnv('AUTH_GITHUB_SECRET', 'secret')
    const env = readServerEnv()
    expect(env.githubOAuthConfigured).toBe(false)
    expect(demoAllowed(env)).toBe(false)
    expect(demoAllowed({ ...env, production: false })).toBe(false)
  })

  it('keeps the production AUTH_SECRET requirement of the other live modes', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'envio')
    vi.stubEnv('NEXT_PUBLIC_ENVIO_GRAPHQL_URL', 'https://indexer.example/v1/graphql')
    vi.stubEnv('AUTH_SECRET', '')
    expect(() => readServerEnv()).toThrow(/AUTH_SECRET is required/)
  })
})
