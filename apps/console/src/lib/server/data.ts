import { cache } from 'react'
import { headers } from 'next/headers'
import type { ClaimDetail } from '@pine/core'
import { createDataProvider, readPineEnv } from '@pine/data'

const env = readPineEnv()
const provider = createDataProvider(env)

export const siteUrl = env.siteUrl.replace(/\/$/, '')

/** Absolute origin for links shown to people and agents: NEXT_PUBLIC_SITE_URL when set, else the request host. */
export async function getOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_PINE_SITE_URL) return siteUrl
  try {
    const h = await headers()
    const host = h.get('x-forwarded-host') ?? h.get('host')
    if (!host) return siteUrl
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
    return `${proto}://${host}`
  } catch {
    return siteUrl
  }
}

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

export const getServerStats = cache(async () => {
  try {
    return await provider.getStats()
  } catch {
    return null
  }
})

export const getServerPriceHistory = cache(async (id: string) => {
  try {
    return await provider.getPriceHistory(id, '7d')
  } catch {
    return []
  }
})
