import { cache } from 'react'
import type { ClaimDetail } from '@pine/core'
import { createDataProvider, readPineEnv } from '@pine/data'

const env = readPineEnv()
const provider = createDataProvider(env)

export const siteUrl = env.siteUrl.replace(/\/$/, '')

/** Server-side claim lookup for metadata and JSON-LD. Returns null on miss or transport error. */
export const getServerClaim = cache(async (id: string): Promise<ClaimDetail | null> => {
  try {
    return await provider.getClaim(id)
  } catch {
    return null
  }
})

export const getServerClaims = cache(async (limit = 8) => {
  try {
    return (await provider.listClaims({ status: 'open', sort: 'deadline', limit })).items
  } catch {
    return []
  }
})

/** JSON for a <script type="application/ld+json">: escapes "<" so the payload cannot close the tag. */
export function jsonLdString(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}
