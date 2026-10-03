import { ApiDataProvider } from './api/provider'
import { readPineEnv } from './env'
import { EnvioDataProvider } from './envio/provider'
import { MockDataProvider } from './mock/provider'
import { RestDataProvider } from './rest/provider'
import type { PineDataProvider, PineEnv } from './types'

let sharedMock: MockDataProvider | undefined

/**
 * The process-wide mock provider. Every caller shares it so demo writes (publishing, evidence,
 * trades) show up across hooks, pages and route handlers in the same runtime.
 */
export function getMockDataProvider(): MockDataProvider {
  sharedMock ??= new MockDataProvider()
  return sharedMock
}

export interface CreateDataProviderOptions {
  /** `api` mode: where the provider runs. Defaults to `server` when there is no `window`. */
  runtime?: 'browser' | 'server'
  fetch?: typeof fetch
}

/** PINE_API_INTERNAL_URL when it is a plain http(s) URL (no credentials, query or fragment), else null. */
function internalApiBase(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null
    return url.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * `api` mode. Browser: the backend on the page's own origin (cookies stay same-origin). Server: the internal API URL
 * (public GET routes only, no cookie is ever forwarded); without one, an offline provider whose reads resolve
 * empty/null so SSR renders and the client fetches live.
 */
function createApiDataProvider(env: PineEnv, opts: CreateDataProviderOptions): ApiDataProvider {
  const runtime = opts.runtime ?? (typeof window === 'undefined' ? 'server' : 'browser')
  if (runtime === 'browser') return new ApiDataProvider({ baseUrl: '', fetch: opts.fetch })
  const base = internalApiBase(env.apiInternalUrl)
  return base ? new ApiDataProvider({ baseUrl: base, fetch: opts.fetch }) : new ApiDataProvider({ offline: true })
}

/**
 * Picks the adapter from `env.dataSource` (`mock` default | `rest` | `envio` | `api`).
 * Incomplete configuration (rest without apiUrl, envio without a GraphQL URL) falls back to mock.
 */
export function createDataProvider(env: PineEnv = readPineEnv(), opts: CreateDataProviderOptions = {}): PineDataProvider {
  if (env.dataSource === 'api') return createApiDataProvider(env, opts)
  if (env.dataSource === 'rest' && env.apiUrl) return new RestDataProvider({ baseUrl: env.apiUrl })
  if (env.dataSource === 'envio' && env.envioGraphqlUrl) {
    return new EnvioDataProvider({ url: env.envioGraphqlUrl, ipfsGateway: env.ipfsGateway })
  }
  return getMockDataProvider()
}
