/**
 * In-browser API. Installed before the app mounts: a `fetch` wrapper serves every same-origin call to
 * Prism's route handlers (`/api/*`, `/llms.txt`, `/llms-full.txt`, `/.well-known/pine.json`) in the page,
 * reusing @pine/server's Fetch-API handlers wherever they are browser-safe (GitHub mock source, IPFS mock
 * pinning, agent API). Any other network request is refused here, so the preview never talks to RPC
 * endpoints, GitHub, IPFS gateways or wallet relays.
 */
import { createAgentHandler, llmsFullTxtHandler, llmsTxtHandler, wellKnownHandler } from '@pine/server/agent'
import { createGitHubHandler } from '@pine/server/github'
import { createIpfsHandler } from '@pine/server/ipfs'
import { handleAccount } from './account'
import { errorJson } from './respond'
import { auth } from './session'

const APP_NAME = 'Pine Prism'

const github = createGitHubHandler(auth, { mode: 'mock' })
const ipfs = createIpfsHandler({ auth })
const agent = createAgentHandler({ appName: APP_NAME })
const llms = llmsTxtHandler({ appName: APP_NAME })
const llmsFull = llmsFullTxtHandler({ appName: APP_NAME })
const wellKnown = wellKnownHandler({ appName: APP_NAME })

/** Paths the in-browser API answers. */
export function isLocalEndpoint(pathname: string): boolean {
  return pathname.startsWith('/api/') || pathname === '/llms.txt' || pathname === '/llms-full.txt' || pathname === '/.well-known/pine.json'
}

function segmentsAfter(pathname: string, prefix: string): string[] {
  return pathname
    .slice(prefix.length)
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
}

/** Routes a request to the matching handler (mirrors apps/prism/src/app/**\/route.ts). */
export async function handleLocal(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method.toUpperCase()
  try {
    if (path === '/llms.txt' && method === 'GET') return await llms.GET(req)
    if (path === '/llms-full.txt' && method === 'GET') return await llmsFull.GET(req)
    if (path === '/.well-known/pine.json' && method === 'GET') return await wellKnown.GET(req)
    if (path.startsWith('/api/account/') || path === '/api/account') return await handleAccount(req, segmentsAfter(path, '/api/account'))
    if (path.startsWith('/api/github/')) {
      if (method !== 'GET') return errorJson(405, 'method_not_allowed', 'GitHub routes are read-only.')
      return await github.GET(req)
    }
    if (path === '/api/ipfs') {
      if (method !== 'POST') return errorJson(405, 'method_not_allowed', 'POST JSON to /api/ipfs.')
      return await ipfs.POST(req)
    }
    if (path.startsWith('/api/agent/')) {
      if (method === 'OPTIONS') return await agent.OPTIONS()
      if (method !== 'GET' && method !== 'HEAD') return errorJson(405, 'method_not_allowed', 'The agent API is read-only.')
      return await agent.GET(req)
    }
    if (path.startsWith('/api/auth/')) {
      return errorJson(404, 'not_found', 'Auth.js is replaced by a local demo session in the static preview.')
    }
    return errorJson(404, 'not_found', `No route for ${path} in the static preview.`)
  } catch (e) {
    return errorJson(500, 'server_error', e instanceof Error ? e.message : 'Request failed.')
  }
}

/** Request URL as an absolute URL (relative inputs resolve against the document, like fetch does). */
function toUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) return input
    if (typeof input === 'string') return new URL(input, document.baseURI)
    return new URL(input.url)
  } catch {
    return null
  }
}

let installed = false

export function installApi(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const realFetch = window.fetch.bind(window)
  const origin = window.location.origin
  const wrapped: typeof fetch = async (input, init) => {
    const url = toUrl(input)
    if (url && url.origin === origin && isLocalEndpoint(url.pathname)) {
      const req = input instanceof Request && !init ? input : new Request(url, init ?? (input instanceof Request ? input : undefined))
      return handleLocal(req)
    }
    if (url && url.origin !== origin && url.protocol !== 'data:' && url.protocol !== 'blob:') {
      // The artifact's CSP blocks this anyway; refusing here keeps the console clean and the promise fast.
      throw new TypeError(`Network access to ${url.host} is disabled in the Pine Prism static preview.`)
    }
    return realFetch(input as RequestInfo, init)
  }
  window.fetch = wrapped
}
