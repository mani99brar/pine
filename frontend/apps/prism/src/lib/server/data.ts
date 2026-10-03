import { cache } from 'react'
import type { ClaimDetail, PolicyVersion } from '@pine/core'
import { createDataProvider } from '@pine/data'

/** Server-side reads for metadata, JSON-LD and OG images. The client re-fetches live through hooks. */
const provider = cache(() => createDataProvider())

export const getClaimServer = cache(async (id: string): Promise<ClaimDetail | null> => {
  try {
    return await provider().getClaim(id)
  } catch {
    return null
  }
})

export const getPolicyServer = cache(async (id: string, version?: string): Promise<PolicyVersion | null> => {
  try {
    return await provider().getPolicy(id, version)
  } catch {
    return null
  }
})

export const listPoliciesServer = cache(async (): Promise<PolicyVersion[]> => {
  try {
    return await provider().listPolicies()
  } catch {
    return []
  }
})

/** Like getPolicyServer, but a transport failure throws (only a definite "not found" is null). */
export const getPolicyServerStrict = cache(async (id: string, version?: string): Promise<PolicyVersion | null> => provider().getPolicy(id, version))
