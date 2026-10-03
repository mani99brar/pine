/**
 * Demo session for the static build. Replaces Auth.js: "demo sign-in" signs in as DEMO_GITHUB_USER with
 * the same session shape `@pine/server/auth` produces, persisted in localStorage (guarded) so it survives
 * a reload. Signing out clears it.
 */
import { DEMO_GITHUB_USER } from '@pine/data'
import { readLocal, removeLocal, writeLocal } from './storage'

export interface PineSessionUser {
  name: string | null
  email: string | null
  image: string | null
  login: string
  githubId: number
  avatarUrl: string
  htmlUrl: string
  scopes: string[]
  demo: boolean
  provider: 'github' | 'demo'
}

export interface DemoSession {
  user: PineSessionUser
  expires: string
}

const KEY = 'pine-prism-share:session'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

let current: DemoSession | null | undefined
const listeners = new Set<() => void>()

function load(): DemoSession | null {
  const s = readLocal<DemoSession>(KEY)
  if (!s || typeof s !== 'object' || !s.user?.login || !s.expires) return null
  if (Date.parse(s.expires) <= Date.now()) {
    removeLocal(KEY)
    return null
  }
  return s
}

export const sessionStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  get(): DemoSession | null {
    if (current === undefined) current = load()
    return current
  },
  set(next: DemoSession | null): void {
    current = next
    if (next) writeLocal(KEY, next)
    else removeLocal(KEY)
    listeners.forEach((l) => l())
  },
}

/** The session the demo Credentials provider creates (see pineAuthConfig in @pine/server/auth). */
export function demoSession(): DemoSession {
  return {
    user: {
      name: DEMO_GITHUB_USER.name ?? DEMO_GITHUB_USER.login,
      email: null,
      image: DEMO_GITHUB_USER.avatarUrl,
      login: DEMO_GITHUB_USER.login,
      githubId: DEMO_GITHUB_USER.id,
      avatarUrl: DEMO_GITHUB_USER.avatarUrl,
      htmlUrl: DEMO_GITHUB_USER.htmlUrl,
      scopes: [],
      demo: true,
      provider: 'demo',
    },
    expires: new Date(Date.now() + MAX_AGE_MS).toISOString(),
  }
}

/** `auth()` for the in-browser route handlers. */
export async function auth(): Promise<DemoSession | null> {
  return sessionStore.get()
}

// Keep tabs in sync, like the Auth.js session broadcast.
if (typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return
      current = load()
      listeners.forEach((l) => l())
    })
  } catch {
    /* ignore */
  }
}
