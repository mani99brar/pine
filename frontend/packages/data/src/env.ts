import type { DataSourceKind, PineEnv } from './types'

export const DEFAULT_IPFS_GATEWAY = 'https://cdn.kleros.link'
export const DEFAULT_SITE_URL = 'http://localhost:3000'

// Each env var is referenced literally (`process.env.NEXT_PUBLIC_X`) so Next.js can inline it into
// client bundles. The try/catch keeps this safe where `process` does not exist at all.
function read(fn: () => string | undefined): string | undefined {
  try {
    const v = fn()
    return v === undefined || v === '' ? undefined : v
  } catch {
    return undefined
  }
}

function trimSlash(url: string | undefined): string | undefined {
  return url ? url.replace(/\/+$/, '') : url
}

/**
 * Reads Pine configuration from environment variables. Safe on the client and the server:
 * server-only variables (PINE_IPFS_UPLOAD_URL, AUTH_GITHUB_ID) are simply absent in the browser.
 *
 * | Var | Field |
 * |---|---|
 * | NEXT_PUBLIC_PINE_DATA_SOURCE (`mock` default \| `rest` \| `envio`) | dataSource |
 * | NEXT_PUBLIC_PINE_API_URL | apiUrl |
 * | NEXT_PUBLIC_ENVIO_GRAPHQL_URL | envioGraphqlUrl |
 * | NEXT_PUBLIC_IPFS_GATEWAY (default https://cdn.kleros.link) | ipfsGateway |
 * | PINE_IPFS_UPLOAD_URL (server only) | ipfsUploadUrl |
 * | NEXT_PUBLIC_CHAIN_ID (default 100) | defaultChainId |
 * | NEXT_PUBLIC_PINE_DEMO_WALLET (`1`/`0`; auto-on in mock mode) | demoWallet |
 * | NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_PINE_SITE_URL | siteUrl |
 * | AUTH_GITHUB_ID (server) or NEXT_PUBLIC_PINE_GITHUB_OAUTH=1 (client hint) | githubOAuthConfigured |
 *
 * Unknown or incomplete configuration falls back to mock mode rather than failing: `rest` without
 * an API URL, or `envio` without a GraphQL URL, becomes `mock`.
 */
export function readPineEnv(overrides: Partial<PineEnv> = {}): PineEnv {
  const rawSource = read(() => process.env.NEXT_PUBLIC_PINE_DATA_SOURCE)?.toLowerCase()
  const apiUrl = trimSlash(read(() => process.env.NEXT_PUBLIC_PINE_API_URL))
  const envioGraphqlUrl = read(() => process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL)
  let dataSource: DataSourceKind = rawSource === 'rest' || rawSource === 'envio' ? rawSource : 'mock'
  if (dataSource === 'rest' && !apiUrl) dataSource = 'mock'
  if (dataSource === 'envio' && !envioGraphqlUrl) dataSource = 'mock'

  const chain = Number.parseInt(read(() => process.env.NEXT_PUBLIC_CHAIN_ID) ?? '100', 10)
  const demoFlag = read(() => process.env.NEXT_PUBLIC_PINE_DEMO_WALLET)
  const githubId = read(() => process.env.AUTH_GITHUB_ID)
  const githubHint = read(() => process.env.NEXT_PUBLIC_PINE_GITHUB_OAUTH)

  const env: PineEnv = {
    dataSource,
    apiUrl,
    envioGraphqlUrl,
    ipfsGateway: trimSlash(read(() => process.env.NEXT_PUBLIC_IPFS_GATEWAY)) ?? DEFAULT_IPFS_GATEWAY,
    ipfsUploadUrl: read(() => process.env.PINE_IPFS_UPLOAD_URL),
    defaultChainId: Number.isFinite(chain) && chain > 0 ? chain : 100,
    demoWallet: demoFlag === '1' || demoFlag === 'true' || (demoFlag !== '0' && demoFlag !== 'false' && dataSource === 'mock'),
    siteUrl:
      trimSlash(read(() => process.env.NEXT_PUBLIC_SITE_URL) ?? read(() => process.env.NEXT_PUBLIC_PINE_SITE_URL)) ??
      DEFAULT_SITE_URL,
    githubOAuthConfigured: Boolean(githubId) || githubHint === '1' || githubHint === 'true',
  }
  return { ...env, ...overrides }
}

/** Mock latency setting: NEXT_PUBLIC_PINE_MOCK_LATENCY=0 disables the simulated delay. */
export function readMockLatencyEnabled(): boolean {
  const v = read(() => process.env.NEXT_PUBLIC_PINE_MOCK_LATENCY)
  if (v === undefined) {
    // Simulated latency is for the browser demo only: never slow down SSR, route handlers or tests.
    if (typeof window === 'undefined') return false
    return read(() => process.env.VITEST) === undefined && read(() => process.env.NODE_ENV) !== 'test'
  }
  return !(v === '0' || v === 'false' || v === 'off')
}
