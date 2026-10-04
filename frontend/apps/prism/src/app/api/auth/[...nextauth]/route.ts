import type { NextRequest } from 'next/server'
import { readPineEnv } from '@pine/data'
import { handlers } from '@/auth'

/**
 * `api` mode: identity is the backend's SIWE session and the backend owns every /api/* path (the edge proxy routes them
 * there), so Auth.js stays inert behind a 404.
 */
function backendOwned(): Response | null {
  if (readPineEnv().dataSource !== 'api') return null
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

export async function GET(req: NextRequest): Promise<Response> {
  return backendOwned() ?? handlers.GET(req)
}

export async function POST(req: NextRequest): Promise<Response> {
  return backendOwned() ?? handlers.POST(req)
}
