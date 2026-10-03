import type { CatchAllContext } from '@pine/server'
import { createAgentHandler } from '@pine/server/agent'
import { readPineEnv } from '@pine/data'

export const dynamic = 'force-dynamic'

const agent = createAgentHandler({ appName: 'Pine Prism' })

/** `api` mode: the Pine backend owns every /api/* path (the edge proxy routes them there), so this handler is inert. */
function backendOwned(): Response | null {
  if (readPineEnv().dataSource !== 'api') return null
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

export async function GET(req: Request, ctx?: CatchAllContext): Promise<Response> {
  return backendOwned() ?? agent.GET(req, ctx)
}

export async function OPTIONS(): Promise<Response> {
  return backendOwned() ?? agent.OPTIONS()
}
