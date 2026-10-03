/**
 * GitHub proxy: `src/app/api/github/[...path]/route.ts`
 *
 *   import { auth } from '@/auth'
 *   import { createGitHubHandler } from '@pine/server/github'
 *   export const { GET } = createGitHubHandler(auth)
 *
 * Routes (all GET):
 *   viewer                              → GitHubUser | null
 *   viewer/repos?cursor=&limit=         → Page<RepoSummary>
 *   search/repos?q=                     → RepoSummary[]
 *   repos/:owner/:repo                  → RepoSummary
 *   repos/:owner/:repo/pulls?state=     → PullSummary[]
 *   repos/:owner/:repo/pulls/:n         → PullSummary
 *   repos/:owner/:repo/pulls/:n/commits → CommitSummary[]
 *   repos/:owner/:repo/commits?ref=     → CommitSummary[]
 *   repos/:owner/:repo/commits/:sha     → CommitSummary (short SHAs resolve to the full SHA)
 *
 * Source selection: live GitHub with the user's token when signed in with GitHub; the mock source in
 * mock mode otherwise (or when PINE_GITHUB_SOURCE=mock); unauthenticated live GitHub in rest/envio
 * mode without a token (60 requests/hour per IP). The token stays on the server.
 */
import { createGitHubSource, PineDataError, type GitHubSource } from '@pine/data'
import { readServerEnv } from './env'
import { errorResponse, json, pathSegments, type CatchAllContext } from './http'
import { getSessionUser, type PineAuthLike } from './session'

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
// Dot segments ('.', '..') would let the URL parser walk to another GitHub API path with the user's token.
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-fA-F]{4,40}$/
const REF_RE = /^[A-Za-z0-9._/-]{1,255}$/

export interface GitHubHandlerOptions {
  /** Force a source (tests). */
  mode?: 'live' | 'mock'
  /** Override the GitHub API base URL (GitHub Enterprise, tests). */
  baseUrl?: string
  /** Inject a source (tests). */
  source?: GitHubSource
}

function statusFor(code: PineDataError['code']): number {
  switch (code) {
    case 'not_found':
      return 404
    case 'unauthorized':
      return 401
    case 'rate_limited':
      return 429
    case 'unsupported':
      return 501
    case 'bad_response':
    case 'network':
    default:
      return 502
  }
}

function retryAfterFrom(err: PineDataError): number | undefined {
  const c = err.cause as { retryAfter?: number; resetAt?: number | string; reset?: number } | undefined
  if (c?.retryAfter && Number.isFinite(c.retryAfter)) return c.retryAfter
  const reset = typeof c?.resetAt === 'string' ? Date.parse(c.resetAt) : (c?.resetAt ?? (c?.reset ? c.reset * 1000 : undefined))
  if (reset && Number.isFinite(reset)) return Math.max(1, Math.ceil((reset - Date.now()) / 1000))
  const m = /(\d+)\s*s/.exec(err.message)
  return m ? Number(m[1]) : 60
}

export function mapGitHubError(e: unknown): Response {
  if (e instanceof PineDataError || (e && typeof e === 'object' && (e as { name?: string }).name === 'PineDataError')) {
    const err = e as PineDataError
    const status = statusFor(err.code)
    if (status === 429) {
      const retryAfter = retryAfterFrom(err)
      return errorResponse(429, 'rate_limited', 'GitHub rate limit reached.', {
        retryAfter,
        hint: 'Sign in with GitHub to raise the limit, or retry later.',
      })
    }
    return errorResponse(status, err.code, err.message)
  }
  // Unexpected exceptions can carry internal details (hosts, stack-ish messages): keep them server-side.
  return errorResponse(502, 'network', 'GitHub request failed.')
}

export function createGitHubHandler(auth: PineAuthLike, opts: GitHubHandlerOptions = {}) {
  async function resolveSource(req: Request): Promise<{ source: GitHubSource; authenticated: boolean }> {
    if (opts.source) return { source: opts.source, authenticated: true }
    const env = readServerEnv()
    const user = await getSessionUser(auth, req)
    let token: string | null = null
    if (user && !user.demo && auth.pine) token = await auth.pine.getAccessToken(req)
    const forced = opts.mode ?? (process.env.PINE_GITHUB_SOURCE === 'mock' || process.env.PINE_GITHUB_SOURCE === 'live' ? process.env.PINE_GITHUB_SOURCE : undefined)
    const mode: 'live' | 'mock' = forced ?? (token ? 'live' : env.dataSource === 'mock' ? 'mock' : 'live')
    return {
      source: createGitHubSource({ mode, token: token ?? undefined, baseUrl: opts.baseUrl }),
      authenticated: Boolean(token) || mode === 'mock',
    }
  }

  async function GET(req: Request, ctx?: CatchAllContext): Promise<Response> {
    const segs = await pathSegments(req, ctx, '/api/github/')
    const url = new URL(req.url)
    const q = url.searchParams
    const cache = { cache: 'private, max-age=30' }
    try {
      const { source, authenticated } = await resolveSource(req)
      const [a, b, c, d, e, f] = segs

      if (a === 'viewer' && segs.length === 1) {
        return json(await source.getViewer(), cache)
      }
      if (a === 'viewer' && b === 'repos' && segs.length === 2) {
        if (!authenticated) {
          return errorResponse(401, 'unauthorized', 'Sign in with GitHub to list your repositories.', {
            hint: 'Paste a public repository or pull request URL instead.',
          })
        }
        const limit = clampInt(q.get('limit'), 1, 100, 30)
        return json(await source.listViewerRepos({ cursor: q.get('cursor') ?? undefined, limit }), cache)
      }
      if (a === 'search' && b === 'repos' && segs.length === 2) {
        const query = (q.get('q') ?? '').trim()
        if (query.length < 2) return errorResponse(400, 'bad_request', 'Search needs at least 2 characters (?q=).')
        if (query.length > 256) return errorResponse(400, 'bad_request', 'Search query is too long.')
        return json(await source.searchRepos(query), cache)
      }
      if (a === 'repos' && b && c) {
        if (!NAME_RE.test(b) || !REPO_RE.test(c)) return errorResponse(400, 'bad_request', 'Invalid owner or repository name.')
        if (segs.length === 3) {
          const repo = await source.getRepo(b, c)
          return repo ? json(repo, cache) : errorResponse(404, 'not_found', `Repository ${b}/${c} was not found or is private.`)
        }
        if (d === 'pulls' && segs.length === 4) {
          const stateParam = q.get('state')
          const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open'
          return json(await source.listPulls(b, c, { state }), cache)
        }
        if (d === 'pulls' && e) {
          const n = Number(e)
          if (!Number.isInteger(n) || n <= 0) return errorResponse(400, 'bad_request', 'Pull request number must be a positive integer.')
          if (segs.length === 5) {
            const pull = await source.getPull(b, c, n)
            return pull ? json(pull, cache) : errorResponse(404, 'not_found', `Pull request #${n} was not found in ${b}/${c}.`)
          }
          if (f === 'commits' && segs.length === 6) return json(await source.listPullCommits(b, c, n), cache)
        }
        if (d === 'commits' && segs.length === 4) {
          const ref = q.get('ref') ?? undefined
          if (ref && !REF_RE.test(ref)) return errorResponse(400, 'bad_request', 'Invalid ref.')
          const limit = clampInt(q.get('limit'), 1, 100, 30)
          return json(await source.listCommits(b, c, { ref, limit }), cache)
        }
        if (d === 'commits' && e && segs.length === 5) {
          if (!SHA_RE.test(e)) return errorResponse(400, 'bad_request', 'Commit must be a 4–40 character hex SHA.')
          const commit = await source.getCommit(b, c, e.toLowerCase())
          // A full SHA is immutable; allow longer caching.
          return commit
            ? json(commit, { cache: e.length === 40 ? 'private, max-age=3600' : 'private, max-age=30' })
            : errorResponse(404, 'not_found', `Commit ${e} was not found in ${b}/${c}.`)
        }
      }
      return errorResponse(404, 'not_found', `Unknown GitHub route: /${segs.join('/')}`, {
        hint: 'Supported: viewer, viewer/repos, search/repos?q=, repos/:owner/:repo[/pulls[/:n[/commits]]|/commits[/:sha]]',
      })
    } catch (err) {
      return mapGitHubError(err)
    }
  }

  return { GET }
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
