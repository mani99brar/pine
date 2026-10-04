import type { Address } from '@pine/core'
import type { DataSourceKind, PineDeploymentEnv, PineEnv } from './types'

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
 * | NEXT_PUBLIC_PINE_DATA_SOURCE (`mock` default \| `rest` \| `envio` \| `api`) | dataSource |
 * | PINE_API_INTERNAL_URL (server only; `api` mode SSR reads) | apiInternalUrl |
 * | NEXT_PUBLIC_PINE_CLAIM_REGISTRY, NEXT_PUBLIC_PINE_EVIDENCE_REGISTRY, NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK | deployment |
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
 * an API URL, or `envio` without a GraphQL URL, becomes `mock`. `api` mode needs no URL in the browser (the
 * backend is served on the page's own origin under /api/v1); on the server it reads PINE_API_INTERNAL_URL.
 * `api` mode never enables the demo wallet unless NEXT_PUBLIC_PINE_DEMO_WALLET=1 is set explicitly.
 */
export function readPineEnv(overrides: Partial<PineEnv> = {}): PineEnv {
  const rawSource = read(() => process.env.NEXT_PUBLIC_PINE_DATA_SOURCE)?.toLowerCase()
  const apiUrl = trimSlash(read(() => process.env.NEXT_PUBLIC_PINE_API_URL))
  const envioGraphqlUrl = read(() => process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL)
  let dataSource: DataSourceKind = rawSource === 'rest' || rawSource === 'envio' || rawSource === 'api' ? rawSource : 'mock'
  if (dataSource === 'rest' && !apiUrl) dataSource = 'mock'
  if (dataSource === 'envio' && !envioGraphqlUrl) dataSource = 'mock'

  const chain = Number.parseInt(read(() => process.env.NEXT_PUBLIC_CHAIN_ID) ?? '100', 10)
  const demoFlag = read(() => process.env.NEXT_PUBLIC_PINE_DEMO_WALLET)
  const githubId = read(() => process.env.AUTH_GITHUB_ID)
  const githubHint = read(() => process.env.NEXT_PUBLIC_PINE_GITHUB_OAUTH)

  const env: PineEnv = {
    dataSource,
    apiUrl,
    apiInternalUrl: trimSlash(read(() => process.env.PINE_API_INTERNAL_URL)),
    deployment: readDeployment(),
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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Pine's deployment from NEXT_PUBLIC_PINE_* (all three or nothing; malformed values are ignored). */
function readDeployment(): PineDeploymentEnv | undefined {
  const claimRegistry = read(() => process.env.NEXT_PUBLIC_PINE_CLAIM_REGISTRY)
  const evidenceRegistry = read(() => process.env.NEXT_PUBLIC_PINE_EVIDENCE_REGISTRY)
  const block = read(() => process.env.NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK)
  if (!claimRegistry || !evidenceRegistry || block === undefined) return undefined
  if (!ADDRESS.test(claimRegistry) || !ADDRESS.test(evidenceRegistry) || !/^(?:0|[1-9][0-9]{0,15})$/.test(block)) return undefined
  const deploymentBlock = Number(block)
  if (!Number.isSafeInteger(deploymentBlock)) return undefined
  return {
    claimRegistry: claimRegistry.toLowerCase() as Address,
    evidenceRegistry: evidenceRegistry.toLowerCase() as Address,
    deploymentBlock,
  }
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
