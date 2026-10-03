import { wellKnownHandler } from '@pine/server/agent'
import { readPineEnv } from '@pine/data'

export const dynamic = 'force-dynamic'

const wellKnown = wellKnownHandler({ appName: 'Pine Prism' })

/**
 * `api` mode: the Pine backend serves /.well-known/pine.json (deployment, commitment formula, feeds); the edge proxy, or
 * the Next.js rewrite in development, routes it there. This app handler only answers if that routing is missing.
 */
function backendOwned(): Response | null {
  if (readPineEnv().dataSource !== 'api') return null
  return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404, headers: { 'cache-control': 'no-store' } })
}

export async function GET(req: Request): Promise<Response> {
  return backendOwned() ?? wellKnown.GET(req)
}
