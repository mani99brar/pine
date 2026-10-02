import { PineDataError } from '../types'

export type TokenGetter = () => string | undefined | null | Promise<string | undefined | null>

export interface RestClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  headers?: Record<string, string>
  /** Bearer token for write endpoints (drafts, accounts). */
  getToken?: TokenGetter
}

/** Map an HTTP status to a PineDataError code. */
export function errorCodeForStatus(status: number): PineDataError['code'] {
  if (status === 404) return 'not_found'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate_limited'
  if (status === 501) return 'unsupported'
  if (status >= 500) return 'network'
  return 'bad_response'
}

/** Minimal JSON client for the Pine REST indexer contract (docs/indexer/rest-api.openapi.yaml). */
export class RestClient {
  readonly baseUrl: string
  private readonly fetcher: typeof fetch

  constructor(private readonly opts: RestClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
  }

  /**
   * Performs a request. With `nullOn404`, a 404 resolves to `null` instead of throwing.
   * Error bodies follow the contract's `Error` schema: `{ "error": { "code": "...", "message": "..." } }`.
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { query?: Record<string, string | number | boolean | string[] | undefined>; body?: unknown; auth?: boolean; nullOn404?: boolean } = {},
  ): Promise<T | null> {
    // Built without `new URL()` so relative bases (e.g. "/api/pine" proxied by the app) work too.
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined || v === '') continue
      if (Array.isArray(v)) {
        for (const item of v) params.append(k, item)
      } else params.set(k, String(v))
    }
    const qs = params.toString()
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`
    const headers: Record<string, string> = { Accept: 'application/json', ...(this.opts.headers ?? {}) }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    if (init.auth && this.opts.getToken) {
      const token = await this.opts.getToken()
      if (token) headers.Authorization = `Bearer ${token}`
    }
    let res: Response
    try {
      res = await this.fetcher(url, {
        method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
    } catch (err) {
      throw new PineDataError(`Could not reach the Pine API (${method} ${path})`, 'network', err)
    }
    if (res.status === 404 && init.nullOn404) return null
    if (!res.ok) {
      let message = `Pine API error ${res.status} (${method} ${path})`
      let code = errorCodeForStatus(res.status)
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        if (body?.error?.message) message = body.error.message
        const c = body?.error?.code
        if (c === 'network' || c === 'not_found' || c === 'bad_response' || c === 'unauthorized' || c === 'rate_limited' || c === 'unsupported') code = c
      } catch {
        // non-JSON error body
      }
      throw new PineDataError(message, code, { status: res.status })
    }
    if (res.status === 204) return null
    try {
      return (await res.json()) as T
    } catch (err) {
      throw new PineDataError(`Pine API returned invalid JSON (${method} ${path})`, 'bad_response', err)
    }
  }

  async get<T>(path: string, query?: Record<string, string | number | boolean | string[] | undefined>): Promise<T> {
    const r = await this.request<T>('GET', path, { query })
    if (r === null) throw new PineDataError(`Empty response (GET ${path})`, 'bad_response')
    return r
  }

  getOrNull<T>(path: string, query?: Record<string, string | number | boolean | string[] | undefined>): Promise<T | null> {
    return this.request<T>('GET', path, { query, nullOn404: true })
  }
}
