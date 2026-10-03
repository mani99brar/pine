/**
 * Server-side configuration. Never import from client components.
 */
import { readPineEnv, type PineEnv } from '@pine/data'

export interface ServerEnv extends PineEnv {
  authSecret: string
  /** True when AUTH_SECRET was missing and the deterministic development secret is used */
  usingDevSecret: boolean
  githubClientId?: string
  githubClientSecret?: string
  ipfsUploadToken?: string
  production: boolean
}

/**
 * Deterministic development secret, used only when AUTH_SECRET is missing outside production
 * (or in production mock mode without GitHub OAuth). It is public: anything protected by it is
 * demo-only. Never used when GitHub OAuth is configured in production.
 */
export const DEV_AUTH_SECRET = 'pine-dev-secret-not-for-production-0c5b3f1e9a7d4c2b8e6f'

let warned = false

function str(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v.trim() : undefined
}

export class PineConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PineConfigError'
  }
}

export function readServerEnv(): ServerEnv {
  const env = readPineEnv()
  const githubClientId = str(process.env.AUTH_GITHUB_ID)
  const githubClientSecret = str(process.env.AUTH_GITHUB_SECRET)
  const production = process.env.NODE_ENV === 'production'
  const configured = str(process.env.AUTH_SECRET) ?? str(process.env.NEXTAUTH_SECRET)
  let authSecret = configured
  let usingDevSecret = false
  if (!authSecret) {
    const githubConfigured = Boolean(githubClientId && githubClientSecret)
    if (production && (env.dataSource !== 'mock' || githubConfigured)) {
      throw new PineConfigError(
        'AUTH_SECRET is required in production (it encrypts session cookies and GitHub tokens). Generate one with `npx auth secret` or `openssl rand -base64 33`.',
      )
    }
    authSecret = DEV_AUTH_SECRET
    usingDevSecret = true
    if (!warned) {
      warned = true
      console.warn('[pine] AUTH_SECRET is not set; using a deterministic development secret (demo/mock only).')
    }
  }
  return {
    ...env,
    githubOAuthConfigured: Boolean(githubClientId && githubClientSecret),
    authSecret,
    usingDevSecret,
    githubClientId,
    githubClientSecret,
    ipfsUploadUrl: str(process.env.PINE_IPFS_UPLOAD_URL) ?? env.ipfsUploadUrl,
    ipfsUploadToken: str(process.env.PINE_IPFS_UPLOAD_TOKEN),
    production,
  }
}

/**
 * Demo features (demo sign-in, simulated wallet linking) are available in mock mode or without GitHub OAuth,
 * except in production rest mode: there the demo identity would be one shared account in the REST backend
 * (every visitor could read and change the same drafts, wallet links and preferences).
 */
export function demoAllowed(
  env: Pick<ServerEnv, 'dataSource' | 'githubOAuthConfigured' | 'demoWallet'> & { production?: boolean },
): boolean {
  if (env.dataSource === 'mock') return true
  if (env.githubOAuthConfigured) return false
  return !(env.production && env.dataSource === 'rest')
}

/**
 * Host of the canonical app URL configured for Auth.js (AUTH_URL / NEXTAUTH_URL), or undefined. When set,
 * security checks that compare against "our host" (SIWE domain, Origin) use it instead of request headers,
 * which a direct client can forge (Host, X-Forwarded-Host) when no proxy overwrites them.
 */
export function canonicalHost(): string | undefined {
  const configured = str(process.env.AUTH_URL) ?? str(process.env.NEXTAUTH_URL)
  if (!configured) return undefined
  try {
    return new URL(configured).host
  } catch {
    return undefined
  }
}

/** True when public URLs in responses are derived from request headers (no NEXT_PUBLIC_SITE_URL). */
export function siteUrlFromRequest(): boolean {
  return !(str(process.env.NEXT_PUBLIC_SITE_URL) ?? str(process.env.NEXT_PUBLIC_PINE_SITE_URL))
}

/**
 * Public site URL: NEXT_PUBLIC_SITE_URL when set, otherwise the request origin (honouring
 * x-forwarded-host/proto from the hosting proxy).
 */
export function resolveSiteUrl(req: Request): string {
  const configured = str(process.env.NEXT_PUBLIC_SITE_URL) ?? str(process.env.NEXT_PUBLIC_PINE_SITE_URL)
  if (configured) return configured.replace(/\/+$/, '')
  return requestOrigin(req)
}

export function requestOrigin(req: Request): string {
  const url = new URL(req.url)
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '')
  return `${proto}://${host}`
}

export function requestHost(req: Request): string {
  return new URL(requestOrigin(req)).host
}
