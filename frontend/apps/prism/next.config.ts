import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

// Optional x402 payment modules lazily imported by @coinbase/cdp-sdk (via RainbowKit's Base Account
// connector) are not installed; Pine never calls them. Alias them to a stub module so bundling succeeds.
const X402_OPTIONAL = [
  '@x402/core/client',
  '@x402/core/schemas',
  '@x402/core/server',
  '@x402/evm',
  '@x402/evm/auth-capture/client',
  '@x402/evm/batch-settlement/client',
  '@x402/evm/exact/client',
  '@x402/evm/exact/server',
  '@x402/evm/exact/v1/client',
  '@x402/evm/upto/client',
  '@x402/evm/upto/server',
  '@x402/express',
  '@x402/extensions/bazaar',
  '@x402/extensions/builder-code',
  '@x402/fetch',
  '@x402/svm/exact/client',
  '@x402/svm/exact/server',
  '@x402/svm/exact/v1/client',
  '@x402/svm/upto/client',
  '@x402/svm/upto/server',
]
const emptyShim = './src/lib/shims/x402.js'

/**
 * Backend routes served on the web app's own origin. In production the edge proxy routes these paths to pine-api
 * before Next.js sees them (deploy/proxy); for local development and e2e (`NEXT_PUBLIC_PINE_DATA_SOURCE=api` with
 * `PINE_API_INTERNAL_URL`), Next.js proxies them itself so the session cookie, CSRF Origin and SIWE domain all see
 * one origin. `beforeFiles` makes them win over the app's own handlers (e.g. /.well-known/pine.json).
 */
const BACKEND_PATHS = ['/api/v1/:path*', '/api/openapi.json', '/.well-known/pine.json', '/healthz', '/readyz']

function backendRewrites(): { source: string; destination: string }[] {
  if ((process.env.NEXT_PUBLIC_PINE_DATA_SOURCE ?? '').toLowerCase() !== 'api') return []
  const raw = process.env.PINE_API_INTERNAL_URL
  if (!raw) return []
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('PINE_API_INTERNAL_URL must be an http(s) URL')
  if (url.username || url.password || url.search || url.hash) throw new Error('PINE_API_INTERNAL_URL must be a bare origin')
  return BACKEND_PATHS.map((source) => ({ source, destination: `${url.origin}${source}` }))
}

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: false,
  turbopack: { resolveAlias: Object.fromEntries(X402_OPTIONAL.map((m) => [m, emptyShim])) },
  transpilePackages: ['@pine/core', '@pine/data', '@pine/react', '@pine/server'],
  reactStrictMode: true,
  env: {
    // Absolute links in JSON-LD, agent briefs and OG tags. Override in deployment.
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_PINE_SITE_URL ?? 'http://localhost:3004',
  },
  poweredByHeader: false,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'avatars.githubusercontent.com' }] },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
  async rewrites() {
    return { beforeFiles: backendRewrites(), afterFiles: [], fallback: [] }
  },
  async redirects() {
    return [
      { source: '/launch-gates', destination: '/risks#gates', permanent: false },
      { source: '/table', destination: '/claims', permanent: false },
      { source: '/new', destination: '/compose', permanent: false },
    ]
  },
}

export default nextConfig
