import type { z } from 'zod'
import { hasDotSegment } from '../internal/util'
import { PineDataError } from '../types'

/**
 * HTTP client for the Pine backend API (`packages/api`, served same-origin under `/api/v1`).
 *
 * - Browser: requests go to the page's own origin (`baseUrl` ""), with the `__Host-pine_session` cookie
 *   (`credentials: 'same-origin'`). The backend serves the API on the web app's origin, so no CORS is involved.
 * - Server (SSR, route handlers): `baseUrl` is the internal API URL (`PINE_API_INTERNAL_URL`); only public GET
 *   routes are called there and no cookie is ever forwarded.
 * - Unsafe methods carry the backend's CSRF contract (SEC-AUTH-14): `x-pine-csrf: 1` and a JSON body (multipart
 *   only for evidence uploads). The browser adds `Origin` and `Sec-Fetch-Site` itself.
 * - Every response body is validated with a zod schema before it reaches the app.
 */

export const CSRF_HEADER = 'x-pine-csrf'

/** Error codes of the backend error envelope (`packages/api/src/contracts/errors.ts`). */
export type PineApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'STEP_UP_REQUIRED'
  | 'CSRF_REJECTED'
  | 'FORBIDDEN'
  | 'TERMS_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTEGRITY_FAILED'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'UNAVAILABLE_FOR_LEGAL_REASONS'
  | 'INTERNAL'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NOT_READY'
  | 'FEATURE_DISABLED'

export interface PineApiIssue {
  path: (string | number)[]
  message: string
}

/** A non-2xx answer of the backend, with its stable error code. */
export class PineBackendError extends PineDataError {
  constructor(
    message: string,
    readonly status: number,
    readonly apiCode: PineApiErrorCode | 'NETWORK' | 'BAD_RESPONSE',
    readonly requestId?: string,
    readonly issues?: PineApiIssue[],
    readonly retryAfter?: number,
  ) {
    super(message, dataCodeFor(status, apiCode))
    this.name = 'PineBackendError'
  }
}

function dataCodeFor(status: number, apiCode: string): PineDataError['code'] {
  if (apiCode === 'NETWORK') return 'network'
  if (status === 404 || apiCode === 'NOT_FOUND') return 'not_found'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (apiCode === 'FEATURE_DISABLED') return 'unsupported'
  if (status >= 500) return 'network'
  return 'bad_response'
}

const KNOWN_CODES = new Set<string>([
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'STEP_UP_REQUIRED',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'TERMS_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'INTEGRITY_FAILED',
  'GONE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE_FOR_LEGAL_REASONS',
  'INTERNAL',
  'UPSTREAM_UNAVAILABLE',
  'NOT_READY',
  'FEATURE_DISABLED',
])

const MAX_MESSAGE = 300

/** Reads `{ error: { code, message, requestId, issues? } }` defensively (the body is untrusted). */
async function errorFrom(res: Response, method: string, path: string): Promise<PineBackendError> {
  let code: PineApiErrorCode | 'BAD_RESPONSE' = 'BAD_RESPONSE'
  let message = `Pine API error ${res.status} (${method} ${path})`
  let requestId: string | undefined
  let issues: PineApiIssue[] | undefined
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown; requestId?: unknown; issues?: unknown } }
    const err = body?.error
    if (err && typeof err === 'object') {
      if (typeof err.code === 'string' && KNOWN_CODES.has(err.code)) code = err.code as PineApiErrorCode
      if (typeof err.message === 'string' && err.message.length > 0) message = err.message.slice(0, MAX_MESSAGE)
      if (typeof err.requestId === 'string') requestId = err.requestId.slice(0, 100)
      if (Array.isArray(err.issues)) {
        issues = err.issues
          .slice(0, 50)
          .filter((i): i is PineApiIssue => typeof i === 'object' && i !== null && Array.isArray((i as PineApiIssue).path) && typeof (i as PineApiIssue).message === 'string')
          .map((i) => ({ path: i.path.filter((p) => typeof p === 'string' || typeof p === 'number').slice(0, 20), message: i.message.slice(0, MAX_MESSAGE) }))
      }
    }
  } catch {
    // non-JSON error body: keep the generic message
  }
  const retry = Number(res.headers.get('retry-after'))
  return new PineBackendError(message, res.status, code, requestId, issues, Number.isFinite(retry) && retry > 0 ? retry : undefined)
}

export type Query = Record<string, string | number | boolean | undefined>

export interface PineApiClientOptions {
  /** "" for same-origin (browser); the internal API origin on the server. No trailing slash. */
  baseUrl: string
  fetch?: typeof fetch
}

export interface RequestOptions {
  query?: Query
  /** JSON body (unsafe methods only). */
  body?: unknown
  /** Multipart body (the evidence upload route only). */
  form?: FormData
  /** Resolve `null` on 404 instead of throwing. */
  nullOn404?: boolean
  signal?: AbortSignal
}

export class PineApiClient {
  readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(opts: PineApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
  }

  url(path: string, query?: Query): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === '') continue
      params.set(k, String(v))
    }
    const qs = params.toString()
    return `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
  }

  /** Performs a request and validates the JSON answer with `schema` (204 → `null`). */
  async request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    opts: RequestOptions = {},
  ): Promise<z.output<S> | null> {
    // "." / ".." segments would be resolved by the URL parser to another route: refuse to send them.
    if (hasDotSegment(path)) {
      if (opts.nullOn404) return null
      throw new PineBackendError(`Invalid resource path (${method} ${path})`, 404, 'NOT_FOUND')
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    let body: BodyInit | undefined
    if (method !== 'GET') headers[CSRF_HEADER] = '1'
    if (opts.form) {
      body = opts.form // the browser sets multipart/form-data with its boundary
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    let res: Response
    try {
      res = await this.fetcher(this.url(path, opts.query), {
        method,
        headers,
        body,
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal: opts.signal,
      })
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err
      throw new PineBackendError(`Could not reach the Pine API (${method} ${path})`, 0, 'NETWORK')
    }
    if (res.status === 404 && opts.nullOn404) return null
    if (!res.ok) throw await errorFrom(res, method, path)
    if (res.status === 204) return null
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw new PineBackendError(`Pine API returned invalid JSON (${method} ${path})`, res.status, 'BAD_RESPONSE')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const where = first ? `${first.path.join('.')}: ${first.message}` : 'unexpected shape'
      throw new PineBackendError(`Pine API answered ${method} ${path} with an unexpected shape (${where})`, res.status, 'BAD_RESPONSE')
    }
    return parsed.data
  }

  async get<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.output<S>> {
    const r = await this.request('GET', path, schema, { query })
    if (r === null) throw new PineBackendError(`Empty response (GET ${path})`, 204, 'BAD_RESPONSE')
    return r
  }

  getOrNull<S extends z.ZodType>(path: string, schema: S, query?: Query): Promise<z.output<S> | null> {
    return this.request('GET', path, schema, { query, nullOn404: true })
  }

  async post<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.output<S>> {
    const r = await this.request('POST', path, schema, { body: body ?? {} })
    if (r === null) throw new PineBackendError(`Empty response (POST ${path})`, 204, 'BAD_RESPONSE')
    return r
  }
}

/** Encodes one path segment (ids, owners, repo names, hex). */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value))
}
