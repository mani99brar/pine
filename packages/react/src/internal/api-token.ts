/**
 * REST API bearer for client-side stores (rest mode): fetched from the app's
 * `GET /api/account/api-token` (short-lived, identity only) and cached until shortly before expiry.
 * Returns null when signed out; stores then call the API unauthenticated.
 */
export function createApiTokenGetter(apiBase: string): () => Promise<string | null> {
  let cached: { token: string; exp: number } | null = null
  let inflight: Promise<string | null> | null = null
  return async () => {
    if (typeof window === 'undefined') return null
    if (cached && cached.exp - 60_000 > Date.now()) return cached.token
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await fetch(`${apiBase}/api/account/api-token`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        if (!res.ok) return null
        const body = (await res.json()) as { token?: string; expiresAt?: string }
        if (!body.token) return null
        cached = { token: body.token, exp: body.expiresAt ? Date.parse(body.expiresAt) : Date.now() + 5 * 60_000 }
        return body.token
      } catch {
        return null
      } finally {
        inflight = null
      }
    })()
    return inflight
  }
}
