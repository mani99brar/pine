/**
 * `next-auth/react` for the static build, backed by the local demo session store (src/api/session.ts).
 * Only the demo identity exists: GitHub OAuth needs a server, so `signIn('github')` also signs in as demo
 * (the UI never offers it, because NEXT_PUBLIC_PINE_GITHUB_OAUTH is unset).
 */
import { createContext, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { demoSession, sessionStore, type DemoSession } from '../api/session'

export type Session = DemoSession

export type SessionStatus = 'authenticated' | 'unauthenticated' | 'loading'

export interface SessionContextValue {
  data: Session | null
  status: SessionStatus
  update: (data?: unknown) => Promise<Session | null>
}

/** next-auth's context object. The static build never reads it (useSession uses the demo store); @pine/react only
 * provides it in api mode, which this build never uses. */
export const SessionContext = createContext<SessionContextValue | undefined>(undefined)

export function SessionProvider({ children }: { children: ReactNode; session?: unknown; basePath?: string; refetchInterval?: number; refetchOnWindowFocus?: boolean }) {
  return <>{children}</>
}

const serverSnapshot = () => null

export function useSession(_options?: { required?: boolean; onUnauthenticated?: () => void }): SessionContextValue {
  const data = useSyncExternalStore(sessionStore.subscribe, sessionStore.get, serverSnapshot)
  const update = useCallback(async () => sessionStore.get(), [])
  return useMemo(() => ({ data, status: data ? 'authenticated' : 'unauthenticated', update }), [data, update])
}

export async function getSession(): Promise<Session | null> {
  return sessionStore.get()
}

export async function getCsrfToken(): Promise<string> {
  return 'static-preview'
}

export async function getProviders() {
  return { demo: { id: 'demo', name: 'Demo sign-in', type: 'credentials', signinUrl: '', callbackUrl: '' } }
}

export async function signIn(_provider?: string, _options?: { redirectTo?: string; redirect?: boolean; callbackUrl?: string }) {
  sessionStore.set(demoSession())
  return { ok: true, status: 200, error: undefined, url: null, code: undefined }
}

export async function signOut(_options?: { redirectTo?: string; redirect?: boolean; callbackUrl?: string }) {
  sessionStore.set(null)
  return { url: '' }
}
