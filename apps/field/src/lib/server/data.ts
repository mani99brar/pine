import { cache } from 'react'
import type { ClaimDetail } from '@pine/core'
import { createDataProvider } from '@pine/data'

/** Server-side data access for metadata and JSON-LD (the client re-fetches live through hooks). */
const provider = cache(() => createDataProvider())

export const getClaimServer = cache(async (id: string): Promise<ClaimDetail | null> => {
  try {
    return await provider().getClaim(id)
  } catch {
    return null
  }
})

export const getPolicyServer = cache(async (id: string, version?: string) => {
  try {
    return await provider().getPolicy(id, version)
  } catch {
    return null
  }
})
