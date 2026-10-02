/** Error thrown by calls to the app's own API routes (/api/github, /api/account, /api/ipfs). */
export class PineApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'PineApiError'
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; retryAfter?: number; hint?: string } | string
  message?: string
}

export async function apiFetch<T>(apiBase: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${apiBase}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (e) {
    throw new PineApiError(
      `Network error while calling ${path}: ${e instanceof Error ? e.message : String(e)}`,
      0,
      'network',
    )
  }
  if (!res.ok) {
    let body: ErrorBody | null = null
    try {
      body = (await res.json()) as ErrorBody
    } catch {
      body = null
    }
    const err = typeof body?.error === 'object' ? body.error : undefined
    const message =
      err?.message ?? (typeof body?.error === 'string' ? body.error : undefined) ?? body?.message ?? `${res.status} ${res.statusText}`
    const retryHeader = Number(res.headers.get('retry-after'))
    throw new PineApiError(
      message,
      res.status,
      err?.code ?? (res.status === 404 ? 'not_found' : res.status === 401 ? 'unauthorized' : 'error'),
      err?.retryAfter ?? (Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined),
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
