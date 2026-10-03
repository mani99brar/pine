import { cache } from 'react'
import { headers } from 'next/headers'
import type { ClaimDetail, PolicyVersion } from '@pine/core'
import { createDataProvider, readPineEnv, type PineDataProvider } from '@pine/data'

/**
 * Server-side reads for metadata, JSON-LD and OG images. The client re-fetches live through hooks. In api mode every
 * read carries the visitor's IP (the single value the edge proxy writes into X-Forwarded-For; anything else is dropped
 * by the provider), so pine-api's per-IP limits apply per visitor instead of to the web server as a whole.
 */
const provider = cache(async (): Promise<PineDataProvider> => {
  const env = readPineEnv()
  if (env.dataSource !== 'api') return createDataProvider(env)
  return createDataProvider(env, { forwardedFor: (await headers()).get('x-forwarded-for') ?? undefined })
})

export const getClaimServer = cache(async (id: string): Promise<ClaimDetail | null> => {
  try {
    return await (await provider()).getClaim(id)
  } catch {
    return null
  }
})

export const getPolicyServer = cache(async (id: string, version?: string): Promise<PolicyVersion | null> => {
  try {
    return await (await provider()).getPolicy(id, version)
  } catch {
    return null
  }
})

export const listPoliciesServer = cache(async (): Promise<PolicyVersion[]> => {
  try {
    return await (await provider()).listPolicies()
  } catch {
    return []
  }
})

/** Like getPolicyServer, but a transport failure throws (only a definite "not found" is null). */
export const getPolicyServerStrict = cache(async (id: string, version?: string): Promise<PolicyVersion | null> => (await provider()).getPolicy(id, version))
