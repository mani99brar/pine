import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

// Optional x402 payment modules lazily imported by @coinbase/cdp-sdk (via RainbowKit's Base Account
// connector) are not installed; Pine never calls them. Alias them to an inert module so bundling succeeds.
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

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: { resolveAlias: Object.fromEntries(X402_OPTIONAL.map((m) => [m, emptyShim])) },
  transpilePackages: ['@pine/core', '@pine/data', '@pine/react', '@pine/server'],
  reactStrictMode: true,
  poweredByHeader: false,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'avatars.githubusercontent.com' }] },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
