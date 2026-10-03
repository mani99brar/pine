import type { Session } from 'next-auth'
import { DEMO_GITHUB_USER } from '@pine/data'
import type { PineAuthLike } from '../src/session'

export const BASE = 'http://localhost:3001'

export function ctx(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

export function req(path: string, init?: RequestInit): Request {
  return new Request(`${BASE}${path}`, init)
}

export function signedIn(user: Partial<Session['user']> = {}): PineAuthLike {
  const session = {
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: {
      name: DEMO_GITHUB_USER.name,
      email: null,
      image: DEMO_GITHUB_USER.avatarUrl,
      login: DEMO_GITHUB_USER.login,
      githubId: DEMO_GITHUB_USER.id,
      avatarUrl: DEMO_GITHUB_USER.avatarUrl,
      htmlUrl: DEMO_GITHUB_USER.htmlUrl,
      scopes: [],
      demo: true,
      provider: 'demo',
      ...user,
    },
  } as unknown as Session
  return async () => session
}

export const signedOut: PineAuthLike = async () => null

/** Collects Set-Cookie values into a Cookie request header. */
export function cookieHeader(...responses: Response[]): string {
  const jar = new Map<string, string>()
  for (const r of responses) {
    const all = r.headers.getSetCookie()
    for (const c of all) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i)
      const value = pair!.slice(i + 1)
      if (/Max-Age=0/.test(c)) jar.delete(name)
      else jar.set(name, value)
    }
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}
