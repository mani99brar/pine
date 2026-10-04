import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Directives that need no script nonces: no framing, no <base> or plugin injection, forms post only to this origin.
  // (A script-src policy needs per-request nonces for Next.js inline scripts; see docs/frontend/deployment.md.)
  { key: 'Content-Security-Policy', value: "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" },
  // Wallet SDK popups keep working; no other window can script this one.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
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
 * Local development only: Next.js proxies the backend's same-origin paths to pine-api, so the session cookie, the CSRF
 * Origin and the SIWE domain all see one origin. In production the edge proxy routes these paths to pine-api before
 * Next.js sees them (deploy/proxy), and this proxy must not exist: Next matches rewrites case-insensitively, so it would
 * let /API/v1/... bypass the edge's API location (and its header handling). Enabled only by PINE_DEV_PROXY=1 (written by
 * scripts/dev-stack/up.sh), and refused for any non-loopback site. `beforeFiles` makes the paths win over the app's
 * own handlers (e.g. /.well-known/pine.json).
 */
const BACKEND_PATHS = ['/api/v1/:path*', '/api/openapi.json', '/.well-known/pine.json', '/healthz', '/readyz']
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function backendRewrites(): { source: string; destination: string }[] {
  if (process.env.PINE_DEV_PROXY !== '1') return []
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_PINE_SITE_URL ?? 'http://localhost:3004'
  const raw = process.env.PINE_API_INTERNAL_URL
  if (!raw) throw new Error('PINE_DEV_PROXY=1 needs PINE_API_INTERNAL_URL')
  const url = new URL(raw)
  if (!LOOPBACK.has(new URL(site).hostname) || !LOOPBACK.has(url.hostname)) {
    throw new Error('PINE_DEV_PROXY=1 is for local development only (site and API must be loopback)')
  }
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
