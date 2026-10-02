import { createDataProvider, type PineDataProvider } from '@pine/data'

let provider: PineDataProvider | null = null

/** One data provider per server process (mock, rest or envio from env). */
export function serverData(): PineDataProvider {
  if (!provider) provider = createDataProvider()
  return provider
}

/** Never let a data-layer failure take down metadata generation. */
export async function safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
