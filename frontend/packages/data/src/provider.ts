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

/**
 * Picks the adapter from `env.dataSource` (`mock` default | `rest` | `envio`).
 * Incomplete configuration (rest without apiUrl, envio without a GraphQL URL) falls back to mock.
 */
export function createDataProvider(env: PineEnv = readPineEnv()): PineDataProvider {
  if (env.dataSource === 'rest' && env.apiUrl) return new RestDataProvider({ baseUrl: env.apiUrl })
  if (env.dataSource === 'envio' && env.envioGraphqlUrl) {
    return new EnvioDataProvider({ url: env.envioGraphqlUrl, ipfsGateway: env.ipfsGateway })
  }
  return getMockDataProvider()
}
