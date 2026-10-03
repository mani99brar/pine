import type { Session } from 'next-auth'

/** Shape of `session.user` produced by `createAuth` (the GitHub access token is never in the session). */
export interface PineSessionUser {
  name?: string | null
  email?: string | null
  image?: string | null
  login: string
  githubId: number
  avatarUrl: string
  htmlUrl: string
  scopes: string[]
  demo: boolean
  provider: 'github' | 'demo'
}

/** `auth()` from createAuth, or any function returning the current session (tests). */
export type SessionGetter = () => Promise<Session | null>

/** Server-only extras attached to the `auth` function returned by createAuth. */
export interface PineAuthExtras {
  /** Decrypts the session JWT and returns the GitHub OAuth access token (server only). */
  getAccessToken(req: Request): Promise<string | null>
}

export type PineAuthLike = SessionGetter & { pine?: PineAuthExtras }

export async function getSessionUser(auth: SessionGetter, req?: Request): Promise<PineSessionUser | null> {
  let session: Session | null = null
  try {
    session = await auth()
  } catch {
    // auth() outside a request scope (tests) or misconfiguration: treat as signed out.
    session = null
  }
  void req
  const user = session?.user as Partial<PineSessionUser> | undefined
  if (!user?.login) return null
  return {
    name: user.name ?? null,
    email: user.email ?? null,
    image: user.image ?? null,
    login: user.login,
    githubId: user.githubId ?? 0,
    avatarUrl: user.avatarUrl ?? user.image ?? '',
    htmlUrl: user.htmlUrl ?? `https://github.com/${user.login}`,
    scopes: user.scopes ?? [],
    demo: Boolean(user.demo),
    provider: user.provider ?? (user.demo ? 'demo' : 'github'),
  }
}
