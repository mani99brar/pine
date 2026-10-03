/**
 * Auth.js (next-auth v5) configuration for Pine apps.
 *
 *   // src/auth.ts
 *   import { createAuth } from '@pine/server/auth'
 *   export const { handlers, auth, signIn, signOut } = createAuth({ appName: 'Pine Prism' })
 *
 * - GitHub provider with scope `read:user` (public repositories only) when AUTH_GITHUB_ID/SECRET are set.
 * - "demo" Credentials provider signing in as DEMO_GITHUB_USER when GitHub is not configured, and
 *   always in mock mode.
 * - JWT sessions (no database). The GitHub access token is kept in the encrypted JWT only; it is never
 *   copied into the session that the browser can read. Server handlers read it with
 *   `auth.pine.getAccessToken(req)`.
 * - AUTH_SECRET missing: deterministic dev secret + warning in dev/mock; throws in production unless
 *   mock mode without GitHub OAuth.
 */
import NextAuth, { type NextAuthConfig, type NextAuthResult } from 'next-auth'
import GitHub from 'next-auth/providers/github'
import Credentials from 'next-auth/providers/credentials'
import { getToken } from 'next-auth/jwt'
import { DEMO_GITHUB_USER } from '@pine/data'
import { demoAllowed, readServerEnv, type ServerEnv } from './env'
import type { PineAuthExtras, PineSessionUser } from './session'
import './next-auth-augment'

export type { PineSessionUser, PineAuthExtras, SessionGetter, PineAuthLike } from './session'

export interface CreateAuthOptions {
  appName: string
  /** Custom sign-in page path (optional; Auth.js default page otherwise). */
  signInPage?: string
}

export type PineAuth = Omit<NextAuthResult, 'auth'> & {
  auth: NextAuthResult['auth'] & { pine: PineAuthExtras }
  /** Which providers are enabled (for sign-in UIs). */
  providers: { github: boolean; demo: boolean }
}

const SESSION_COOKIE = 'authjs.session-token'
const SECURE_SESSION_COOKIE = '__Secure-authjs.session-token'

interface GitHubProfileLike {
  id?: number | string
  login?: string
  name?: string | null
  avatar_url?: string
  html_url?: string
}

/** The Auth.js config used by createAuth (exported for tests and custom setups). */
export function pineAuthConfig(env: ServerEnv, opts: Pick<CreateAuthOptions, 'signInPage'> = {}): NextAuthConfig {
  const githubEnabled = env.githubOAuthConfigured
  const demoEnabled = demoAllowed(env)

  const providers: NextAuthConfig['providers'] = []
  if (githubEnabled) {
    providers.push(
      GitHub({
        clientId: env.githubClientId,
        clientSecret: env.githubClientSecret,
        // Minimal scope: public profile only. Pine reads public repositories, so no repo scope.
        authorization: { params: { scope: 'read:user' } },
      }),
    )
  }
  if (demoEnabled) {
    providers.push(
      Credentials({
        id: 'demo',
        name: 'Demo sign-in',
        credentials: {},
        async authorize() {
          return {
            id: String(DEMO_GITHUB_USER.id),
            name: DEMO_GITHUB_USER.name ?? DEMO_GITHUB_USER.login,
            email: null,
            image: DEMO_GITHUB_USER.avatarUrl,
          }
        },
      }),
    )
  }

  const config: NextAuthConfig = {
    providers,
    secret: env.authSecret,
    trustHost: true,
    session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
    ...(opts.signInPage ? { pages: { signIn: opts.signInPage } } : {}),
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account?.provider === 'github') {
          const p = (profile ?? {}) as GitHubProfileLike
          token.accessToken = account.access_token
          token.scopes = (account.scope ?? '').split(/[\s,]+/).filter(Boolean)
          token.login = p.login ?? token.name ?? 'unknown'
          token.githubId = Number(p.id ?? 0)
          token.avatarUrl = p.avatar_url ?? token.picture ?? ''
          token.htmlUrl = p.html_url ?? `https://github.com/${p.login ?? ''}`
          token.demo = false
          token.provider = 'github'
        } else if (account?.provider === 'demo') {
          token.accessToken = undefined
          token.scopes = []
          token.login = DEMO_GITHUB_USER.login
          token.githubId = DEMO_GITHUB_USER.id
          token.avatarUrl = DEMO_GITHUB_USER.avatarUrl
          token.htmlUrl = DEMO_GITHUB_USER.htmlUrl
          token.demo = true
          token.provider = 'demo'
        }
        return token
      },
      async session({ session, token }) {
        // Expose identity only. Never copy token.accessToken into the session.
        const user: PineSessionUser = {
          name: session.user?.name ?? (token.name as string | null | undefined) ?? null,
          email: session.user?.email ?? null,
          image: session.user?.image ?? (token.avatarUrl as string | undefined) ?? null,
          login: (token.login as string | undefined) ?? 'unknown',
          githubId: (token.githubId as number | undefined) ?? 0,
          avatarUrl: (token.avatarUrl as string | undefined) ?? '',
          htmlUrl: (token.htmlUrl as string | undefined) ?? '',
          scopes: (token.scopes as string[] | undefined) ?? [],
          demo: Boolean(token.demo),
          provider: (token.provider as 'github' | 'demo' | undefined) ?? 'demo',
        }
        return { ...session, user: { ...session.user, ...user } } as typeof session
      },
    },
  }
  return config
}

/** Reads the GitHub access token from the encrypted session JWT (server only). */
export async function readAccessToken(req: Request, secret: string): Promise<string | null> {
  for (const cookieName of [SECURE_SESSION_COOKIE, SESSION_COOKIE]) {
    try {
      const token = await getToken({
        req,
        secret,
        cookieName,
        salt: cookieName,
        secureCookie: cookieName === SECURE_SESSION_COOKIE,
      })
      const at = token?.accessToken
      if (typeof at === 'string' && at.length > 0) return at
      if (token) return null
    } catch {
      // try next cookie name
    }
  }
  return null
}

export function createAuth(opts: CreateAuthOptions): PineAuth {
  const env = readServerEnv()
  const githubEnabled = env.githubOAuthConfigured
  const demoEnabled = demoAllowed(env)
  const config = pineAuthConfig(env, opts)
  const result = NextAuth(config)

  const extras: PineAuthExtras = {
    getAccessToken: (req: Request) => readAccessToken(req, env.authSecret),
  }

  const auth = Object.assign(result.auth, { pine: extras })
  void opts.appName
  return { ...result, auth, providers: { github: githubEnabled, demo: demoEnabled } }
}
