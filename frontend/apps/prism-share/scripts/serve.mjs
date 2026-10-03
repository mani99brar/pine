// Serves dist/ the way the artifact host does, for local verification:
// - under a nested subpath (http://localhost:4173/a/b/c/), so any absolute URL breaks visibly;
// - with a Content-Security-Policy close to the artifact's (no unsafe-eval by default);
// - next to a harness page (/host.html) that frames the app in a sandboxed iframe, like claude.ai does.
//
//   node scripts/serve.mjs                 → http://localhost:4173/host.html  (frame: /a/b/c/)
//   PORT=4180 BASE=/x/y/ node scripts/serve.mjs
//   CSP=loose node scripts/serve.mjs       → the looser CSP from the brief (adds 'unsafe-eval')
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')

export const CSP_STRICT = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

export const CSP_LOOSE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
].join('; ')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function hostPage(base, hash) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Artifact harness</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100vw;height:100vh;display:block}</style></head>
<body><iframe id="app" title="Pine Prism" sandbox="allow-scripts allow-same-origin" src="${base}index.html${hash}"></iframe></body></html>`
}

/** Starts the server. `onRequest(entry)` sees every request (for verification). */
export function startServer({ port = 4173, base = '/a/b/c/', csp = CSP_STRICT, onRequest } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const entry = { method: req.method, path: url.pathname, host: req.headers.host, status: 200 }
    const send = (status, body, headers = {}) => {
      entry.status = status
      onRequest?.(entry)
      res.writeHead(status, headers)
      res.end(body)
    }
    try {
      if (url.pathname === '/host.html') {
        const hash = url.searchParams.get('route') ? `#${url.searchParams.get('route')}` : ''
        return send(200, hostPage(base, hash), { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
      }
      if (url.pathname === '/favicon.ico') return send(204, '')
      if (!url.pathname.startsWith(base)) return send(404, 'not found (outside the artifact base path)', { 'content-type': 'text/plain' })
      let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html'
      if (rel.endsWith('/')) rel += 'index.html'
      const file = normalize(join(DIST, rel))
      if (!file.startsWith(DIST)) return send(403, 'forbidden')
      const info = await stat(file).catch(() => null)
      if (!info?.isFile()) return send(404, 'not found', { 'content-type': 'text/plain' })
      const body = await readFile(file)
      const type = TYPES[extname(file)] ?? 'application/octet-stream'
      const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
      if (type.startsWith('text/html')) headers['content-security-policy'] = csp
      return send(200, body, headers)
    } catch (e) {
      return send(500, String(e))
    }
  })
  return new Promise((resolveP) => server.listen(port, () => resolveP(server)))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4173)
  const base = process.env.BASE ?? '/a/b/c/'
  const csp = process.env.CSP === 'loose' ? CSP_LOOSE : CSP_STRICT
  await startServer({ port, base, csp, onRequest: (e) => e.status >= 400 && console.log(`${e.status} ${e.method} ${e.path}`) })
  console.log(`Serving dist at http://localhost:${port}${base}  (harness: http://localhost:${port}/host.html)`)
}
