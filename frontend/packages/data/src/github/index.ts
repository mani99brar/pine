import { ApiGitHubSource } from '../api/github'
import type { PineApiClient } from '../api/http'
import type { GitHubSource } from '../types'
import { LiveGitHubSource } from './live'
import { MockGitHubSource } from './mock'

export { LiveGitHubSource, mapGhCommit, mapGhPull, mapGhRepo, mapGhUser, gitHubError, GITHUB_API_URL } from './live'
export type { GhCommit, GhPull, GhRepo, GhUser, LiveGitHubOptions } from './live'
export { MockGitHubSource } from './mock'

/**
 * GitHub read access.
 * - `live`: fetches https://api.github.com (or `baseUrl`) with `Accept: application/vnd.github+json`,
 *   `X-GitHub-Api-Version: 2022-11-28` and an optional bearer token. 404 → `null`/empty;
 *   403/429 with an exhausted rate limit → `PineDataError('rate_limited')` whose message carries the reset time.
 *   Use the token only server-side (the @pine/server proxy); browsers should call the app's /api/github routes.
 * - `mock`: fixture repos/PRs/commits with a small simulated latency.
 * - `api`: the Pine backend's `/api/v1/github/*` routes for the linked GitHub account of the backend session. They
 *   need the session cookie, so this source runs in the browser (`baseUrl` "", same origin) and never on the server.
 *   Signed out or not linked (401/403) reads as "not available" (null, empty lists).
 */
export function createGitHubSource(
  opts:
    | { mode: 'live' | 'mock'; token?: string; baseUrl?: string; fetch?: typeof fetch }
    | { mode: 'api'; client?: PineApiClient; baseUrl?: string; fetch?: typeof fetch },
): GitHubSource {
  if (opts.mode === 'mock') return new MockGitHubSource()
  if (opts.mode === 'api') return new ApiGitHubSource({ client: opts.client, baseUrl: opts.baseUrl ?? '', fetch: opts.fetch })
  return new LiveGitHubSource({ token: opts.token, baseUrl: opts.baseUrl, fetch: opts.fetch })
}
