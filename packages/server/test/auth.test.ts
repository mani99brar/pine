import { afterEach, describe, expect, it, vi } from 'vitest'
import { encode } from 'next-auth/jwt'
import type { Account, Profile, Session, User } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import { createAuth, pineAuthConfig, readAccessToken } from '../src/auth'
import { DEV_AUTH_SECRET, PineConfigError, readServerEnv } from '../src/env'
import { createGitHubHandler } from '../src/github'
import { req } from './helpers'

afterEach(() => {
  vi.unstubAllEnvs()
})

type JwtCb = (p: { token: JWT; account?: Account | null; profile?: Profile; user?: User }) => Promise<JWT>
type SessionCb = (p: { session: Session; token: JWT }) => Promise<Session>

describe('createAuth', () => {
  it('mock mode without GitHub: demo provider only, dev secret with a warning', () => {
    vi.stubEnv('AUTH_SECRET', '')
    vi.stubEnv('AUTH_GITHUB_ID', '')
    vi.stubEnv('AUTH_GITHUB_SECRET', '')
    const env = readServerEnv()
    expect(env.authSecret).toBe(DEV_AUTH_SECRET)
    expect(env.usingDevSecret).toBe(true)
    const auth = createAuth({ appName: 'Pine Test' })
    expect(auth.providers).toEqual({ github: false, demo: true })
    expect(typeof auth.handlers.GET).toBe('function')
    expect(typeof auth.handlers.POST).toBe('function')
    expect(typeof auth.auth.pine.getAccessToken).toBe('function')
    // createGitHubHandler accepts the real `auth`.
    expect(typeof createGitHubHandler(auth.auth).GET).toBe('function')
  })

  it('GitHub provider with read:user when configured; demo still available in mock mode', () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-test-secret-test-secret-123')
    vi.stubEnv('AUTH_GITHUB_ID', 'gh-id')
    vi.stubEnv('AUTH_GITHUB_SECRET', 'gh-secret')
    const config = pineAuthConfig(readServerEnv())
    const providers = config.providers.map((p) => (typeof p === 'function' ? p() : p)) as {
      id: string
      authorization?: { params?: { scope?: string } }
      options?: { id?: string; authorization?: { params?: { scope?: string } } }
    }[]
    const github = providers.find((p) => p.id === 'github')
    expect(github).toBeDefined()
    expect(github?.options?.authorization?.params?.scope).toBe('read:user')
    // Credentials() keeps the custom id in `options` until Auth.js merges it.
    expect(providers.some((p) => (p.options?.id ?? p.id) === 'demo')).toBe(true)
    expect(config.session?.strategy).toBe('jwt')
    expect(config.trustHost).toBe(true)
  })

  it('throws in production outside mock mode without AUTH_SECRET', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_SECRET', '')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'rest')
    vi.stubEnv('NEXT_PUBLIC_PINE_API_URL', 'https://api.example')
    expect(() => readServerEnv()).toThrow(PineConfigError)
  })

  it('keeps the GitHub token in the JWT and out of the session', async () => {
    vi.stubEnv('AUTH_SECRET', 'test-secret-test-secret-test-secret-123')
    const config = pineAuthConfig(readServerEnv())
    const jwt = config.callbacks?.jwt as unknown as JwtCb
    const session = config.callbacks?.session as unknown as SessionCb
    const token = await jwt({
      token: { name: 'Octo Cat' },
      account: { provider: 'github', type: 'oauth', providerAccountId: '1', access_token: 'gho_secret', scope: 'read:user' } as Account,
      profile: { id: 1, login: 'octocat', avatar_url: 'https://a/1', html_url: 'https://github.com/octocat' } as unknown as Profile,
    })
    expect(token.accessToken).toBe('gho_secret')
    expect(token.scopes).toEqual(['read:user'])
    const s = await session({ session: { expires: '2030-01-01T00:00:00Z', user: { name: 'Octo Cat' } } as Session, token })
    expect(JSON.stringify(s)).not.toContain('gho_secret')
    expect(s.user).toMatchObject({ login: 'octocat', scopes: ['read:user'], demo: false, provider: 'github' })

    const demoToken = await jwt({ token: {}, account: { provider: 'demo', type: 'credentials', providerAccountId: 'x' } as Account })
    const demoSession = await session({ session: { expires: '2030-01-01T00:00:00Z', user: {} } as Session, token: demoToken })
    expect(demoSession.user).toMatchObject({ login: 'mara-okafor', demo: true, provider: 'demo' })
  })

  it('readAccessToken decrypts the session cookie server-side', async () => {
    const secret = 'test-secret-test-secret-test-secret-123'
    const jwt = await encode({ token: { accessToken: 'gho_abc', login: 'octocat' }, secret, salt: 'authjs.session-token' })
    const token = await readAccessToken(req('/api/github/viewer', { headers: { cookie: `authjs.session-token=${jwt}` } }), secret)
    expect(token).toBe('gho_abc')
    expect(await readAccessToken(req('/api/github/viewer'), secret)).toBeNull()
    expect(await readAccessToken(req('/x', { headers: { cookie: `authjs.session-token=${jwt}` } }), 'wrong-secret-wrong-secret-wrong')).toBeNull()
  })
})
