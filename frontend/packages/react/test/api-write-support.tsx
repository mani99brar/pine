/** Fake same-origin Pine backend and provider wrapper for the api write hook tests (no network, demo wallet). */
import type { ReactNode } from 'react'
import { createPineQueryClient, PineProviders } from '../src/providers'
import { PINE } from './api-write-chain'

export interface RecordedRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string>
  /** The JSON body text, or every multipart field value and file content joined (for "never contains" checks). */
  text: string
  json?: unknown
  form?: { name: string; value: string; type?: string; filename?: string }[]
}

type Handler = (req: RecordedRequest, match: RegExpMatchArray) => Response | Promise<Response>

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function apiError(status: number, code: string, message: string, opts: { issues?: { path: (string | number)[]; message: string }[]; retryAfter?: number } = {}): Response {
  const headers: Record<string, string> = opts.retryAfter ? { 'retry-after': String(opts.retryAfter) } : {}
  return json(status, { error: { code, message, requestId: 'req-1', ...(opts.issues ? { issues: opts.issues } : {}) } }, headers)
}

/** Routes requests by method and path pattern; records every /api/v1 request. Unknown routes answer 404. */
export class FakePine {
  readonly requests: RecordedRequest[] = []
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = []

  on(method: string, pattern: RegExp, handler: Handler): this {
    this.routes.unshift({ method, pattern, handler })
    return this
  }

  /** Recorded requests to paths matching `pattern` (and `method` when given). */
  of(pattern: RegExp, method?: string): RecordedRequest[] {
    return this.requests.filter((r) => pattern.test(r.path) && (!method || r.method === method))
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw, 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    const req: RecordedRequest = { method, path: url.pathname, query: url.searchParams, headers, text: '' }
    const body = init?.body
    if (typeof body === 'string') {
      req.text = body
      req.json = JSON.parse(body) as unknown
    } else if (body instanceof FormData) {
      req.form = []
      const parts: string[] = []
      for (const [name, value] of body.entries()) {
        if (typeof value === 'string') {
          req.form.push({ name, value })
          parts.push(value)
        } else {
          const content = await value.text()
          req.form.push({ name, value: content, type: value.type, filename: (value as File).name })
          parts.push(content)
        }
      }
      req.text = parts.join('\n')
    }
    if (!url.pathname.startsWith('/api/v1/')) return apiError(404, 'NOT_FOUND', 'Not found')
    this.requests.push(req)
    for (const route of this.routes) {
      if (route.method !== method) continue
      const match = url.pathname.match(route.pattern)
      if (match) return route.handler(req, match)
    }
    return apiError(404, 'NOT_FOUND', `No fake route for ${method} ${url.pathname}`)
  }
}

export function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'api', demoWallet: true, deployment: PINE, defaultChainId: 100 }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

/** A wait that resolves at once (polling and retries in tests). */
export const noSleep = async (): Promise<void> => undefined

export const iso = (s: number) => new Date(s * 1000).toISOString()
