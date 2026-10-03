/** Small Response helpers shared by every @pine/server handler (Web Request/Response only). */

export const PUBLIC_CACHE = 'public, max-age=30, stale-while-revalidate=300'
export const PRIVATE_NO_STORE = 'private, no-store'

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-expose-headers': 'x-pine-manifest-hash, link',
  'access-control-max-age': '86400',
}

export interface ResponseInit2 {
  status?: number
  headers?: Record<string, string>
  cors?: boolean
  cache?: string
}

function baseHeaders(init: ResponseInit2 | undefined, contentType: string): Headers {
  const h = new Headers({ 'content-type': contentType, 'x-content-type-options': 'nosniff' })
  if (init?.cors) for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v)
  if (init?.cache) h.set('cache-control', init.cache)
  for (const [k, v] of Object.entries(init?.headers ?? {})) h.set(k, v)
  return h
}

export function json(body: unknown, init?: ResponseInit2): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: init?.status ?? 200,
    headers: baseHeaders(init, 'application/json; charset=utf-8'),
  })
}

export function rawJson(text: string, init?: ResponseInit2 & { contentType?: string }): Response {
  return new Response(text, {
    status: init?.status ?? 200,
    headers: baseHeaders(init, init?.contentType ?? 'application/json; charset=utf-8'),
  })
}

export function text(body: string, init?: ResponseInit2 & { contentType?: string }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: baseHeaders(init, init?.contentType ?? 'text/plain; charset=utf-8'),
  })
}

export interface ErrorBody {
  error: { code: string; message: string; hint?: string; retryAfter?: number; [k: string]: unknown }
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra?: { hint?: string; retryAfter?: number; cors?: boolean; details?: Record<string, unknown> },
): Response {
  const headers: Record<string, string> = {}
  if (extra?.retryAfter) headers['retry-after'] = String(Math.max(1, Math.ceil(extra.retryAfter)))
  return json(
    {
      error: {
        code,
        message,
        ...(extra?.hint ? { hint: extra.hint } : {}),
        ...(extra?.retryAfter ? { retryAfter: Math.ceil(extra.retryAfter) } : {}),
        ...extra?.details,
      },
    } satisfies ErrorBody,
    { status, headers, cors: extra?.cors, cache: PRIVATE_NO_STORE },
  )
}

/**
 * Reads a request body as text, refusing more than `maxBytes` without buffering it all first
 * (the Content-Length header is checked when present, and the stream is cut off when it is not).
 */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const bytes = await readBodyBytes(req, maxBytes)
  return new TextDecoder().decode(bytes)
}

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes.`)
    this.name = 'BodyTooLargeError'
  }
}

export async function readBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes)
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLargeError(maxBytes)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * CSRF check for state-changing routes. Browsers send `Sec-Fetch-Site` and `Origin` on cross-origin
 * POST/PATCH/DELETE: a request marked cross-site/same-site, or whose Origin host is not ours, is rejected.
 * Requests with neither header come from non-browser clients, which cannot ride a user's cookies.
 */
export function isSameOriginRequest(req: Request, allowedHosts: string[]): boolean {
  const site = req.headers.get('sec-fetch-site')?.toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return false
  const origin = req.headers.get('origin')
  if (!origin) return true
  try {
    return allowedHosts.includes(new URL(origin).host)
  } catch {
    return false // "null" (sandboxed frames, opaque redirects) and malformed origins
  }
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/** Route context for catch-all handlers (`params` is a Promise in Next.js 15+). */
export interface CatchAllContext {
  params: Promise<{ path?: string[] }>
}

/**
 * Path segments after the mount prefix. Prefers Next's `params.path`; falls back to parsing the URL
 * after `prefix` (useful in tests or when mounted without a catch-all).
 */
export async function pathSegments(req: Request, ctx: CatchAllContext | undefined, prefix: string): Promise<string[]> {
  if (ctx?.params) {
    try {
      const p = await ctx.params
      if (Array.isArray(p?.path)) return p.path.map((s) => decodeURIComponentSafe(s))
    } catch {
      // fall through
    }
  }
  const pathname = new URL(req.url).pathname
  const idx = pathname.indexOf(prefix)
  const rest = idx >= 0 ? pathname.slice(idx + prefix.length) : ''
  return rest
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponentSafe(s))
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Cookie parsing (no dependency on next/headers so handlers work in any Fetch runtime and tests). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k === name) {
      const v = part.slice(i + 1).trim()
      try {
        return decodeURIComponent(v)
      } catch {
        return v
      }
    }
  }
  return undefined
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None' },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${opts.path ?? '/'}`)
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`)
  if (opts.maxAge === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  if (opts.httpOnly !== false) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}

export function isHttps(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return (proto ?? new URL(req.url).protocol.replace(':', '')) === 'https'
}

/** Appends Set-Cookie headers to a response. */
export function withCookies(res: Response, cookies: string[]): Response {
  for (const c of cookies) res.headers.append('set-cookie', c)
  return res
}
