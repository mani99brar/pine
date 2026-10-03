import { createIpfsHandler } from '@pine/server/ipfs'
import { readPineEnv } from '@pine/data'
import { auth } from '@/auth'

const ipfs = createIpfsHandler({ auth })

/** `api` mode: the Pine backend owns every /api/* path (the edge proxy routes them there), so this handler is inert. */
function backendOwned(): Response | null {
  if (readPineEnv().dataSource !== 'api') return null
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

export async function POST(req: Request): Promise<Response> {
  return backendOwned() ?? ipfs.POST(req)
}
