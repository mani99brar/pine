import type { CatchAllContext } from '@pine/server'
import { createAccountHandler } from '@pine/server/siwe'
import { readPineEnv } from '@pine/data'
import { auth } from '@/auth'

const account = createAccountHandler(auth)

/** `api` mode: the Pine backend owns every /api/* path (the edge proxy routes them there), so this handler is inert. */
function backendOwned(): Response | null {
  if (readPineEnv().dataSource !== 'api') return null
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

export async function GET(req: Request, ctx?: CatchAllContext): Promise<Response> {
  return backendOwned() ?? account.GET(req, ctx)
}

export async function POST(req: Request, ctx?: CatchAllContext): Promise<Response> {
  return backendOwned() ?? account.POST(req, ctx)
}

export async function PATCH(req: Request, ctx?: CatchAllContext): Promise<Response> {
  return backendOwned() ?? account.PATCH(req, ctx)
}

export async function DELETE(req: Request, ctx?: CatchAllContext): Promise<Response> {
  return backendOwned() ?? account.DELETE(req, ctx)
}
