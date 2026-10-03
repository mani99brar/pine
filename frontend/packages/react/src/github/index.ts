'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { parseGitHubRefDetailed } from '@pine/core'
import type { CommitSummary, Page, ParsedGitHubRef, PullSummary, RepoSummary, SourceRef } from '@pine/core'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { apiFetch, PineApiError } from '../internal/api'

/**
 * GitHub hooks. They call the app's `/api/github/*` proxy (mounted from `@pine/server/github`),
 * which uses the signed-in user's token (scope `read:user`, public repositories only) or the mock
 * GitHub source in demo mode. The token never reaches the browser.
 */

const GH_STALE = 60_000

function useGh<T>(key: (string | number | undefined)[], path: string | null, opts?: { staleTime?: number }) {
  const { apiBase } = usePine()
  return useQuery<T, PineApiError>({
    queryKey: pineKeys.github(...key),
    queryFn: () => apiFetch<T>(apiBase, `/api/github/${path}`),
    enabled: path !== null,
    staleTime: opts?.staleTime ?? GH_STALE,
    retry: (count, err) => (err.status === 429 || err.status >= 500 || err.status === 0) && count < 1,
  })
}

const enc = encodeURIComponent

export function useGitHubViewerRepos(opts?: { cursor?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (opts?.cursor) params.set('cursor', opts.cursor)
  if (opts?.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  return useGh<Page<RepoSummary>>(['viewer-repos', opts?.cursor, opts?.limit], `viewer/repos${qs ? `?${qs}` : ''}`)
}

export function useGitHubRepoSearch(query: string) {
  const q = useDebouncedValue(query.trim(), 300)
  return useGh<RepoSummary[]>(['search', q], q.length >= 2 ? `search/repos?q=${enc(q)}` : null)
}

export function useGitHubRepo(owner?: string, repo?: string) {
  return useGh<RepoSummary>(['repo', owner, repo], owner && repo ? `repos/${enc(owner)}/${enc(repo)}` : null)
}

export function useGitHubPulls(owner?: string, repo?: string, state: 'open' | 'closed' | 'all' = 'open') {
  return useGh<PullSummary[]>(
    ['pulls', owner, repo, state],
    owner && repo ? `repos/${enc(owner)}/${enc(repo)}/pulls?state=${state}` : null,
  )
}

export function useGitHubPull(owner?: string, repo?: string, number?: number) {
  return useGh<PullSummary>(
    ['pull', owner, repo, number],
    owner && repo && number ? `repos/${enc(owner)}/${enc(repo)}/pulls/${number}` : null,
  )
}

export function useGitHubPullCommits(owner?: string, repo?: string, number?: number) {
  return useGh<CommitSummary[]>(
    ['pull-commits', owner, repo, number],
    owner && repo && number ? `repos/${enc(owner)}/${enc(repo)}/pulls/${number}/commits` : null,
  )
}

export function useGitHubCommits(owner?: string, repo?: string, ref?: string) {
  return useGh<CommitSummary[]>(
    ['commits', owner, repo, ref],
    owner && repo ? `repos/${enc(owner)}/${enc(repo)}/commits${ref ? `?ref=${enc(ref)}` : ''}` : null,
  )
}

export function useGitHubCommit(owner?: string, repo?: string, sha?: string) {
  // A full SHA is immutable: cache it for long.
  return useGh<CommitSummary>(
    ['commit', owner, repo, sha?.toLowerCase()],
    owner && repo && sha ? `repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}` : null,
    { staleTime: sha && sha.length === 40 ? Number.POSITIVE_INFINITY : GH_STALE },
  )
}

/** Builds a claim SourceRef from resolved GitHub objects (commit required). */
export function toSourceRef(input: { repo: RepoSummary; commit: CommitSummary; pull?: PullSummary | null }): SourceRef {
  const { repo, commit, pull } = input
  return {
    provider: 'github',
    owner: repo.owner,
    repo: repo.name,
    repoId: repo.id,
    ...(pull
      ? {
          pullRequest: {
            number: pull.number,
            title: pull.title,
            htmlUrl: pull.htmlUrl,
            author: pull.author.login,
            state: pull.state,
          },
          baseCommit: { sha: pull.baseSha, htmlUrl: `https://github.com/${repo.fullName}/commit/${pull.baseSha}` },
        }
      : {}),
    commit: {
      sha: commit.sha.toLowerCase(),
      message: commit.message,
      author: commit.author.login ?? commit.author.name,
      committedAt: commit.author.date,
      htmlUrl: commit.htmlUrl,
    },
    license: repo.license,
  }
}

export type ResolveStatus = 'empty' | 'invalid' | 'loading' | 'resolved' | 'not_found' | 'rate_limited' | 'error'

export interface ResolvedGitHubInput {
  ref: ParsedGitHubRef | null
  repo?: RepoSummary
  pull?: PullSummary
  commit?: CommitSummary
  /** Ready-to-use claim source when a commit was resolved */
  source?: SourceRef
  status: ResolveStatus
  /** Plain-language explanation for invalid / not found / rate limited */
  reason?: string
  isLoading: boolean
  error: PineApiError | null
}

/**
 * Parses a pasted GitHub URL or shorthand (PR URLs incl. /files and /commits/<sha>, owner/repo#12,
 * owner/repo@sha, short SHAs) and fetches the repo, pull request and commit. Short SHAs are resolved
 * to the full 40-hex SHA via the commit endpoint. A PR resolves to its head commit (and base commit).
 */
export function useResolveGitHubInput(input: string): ResolvedGitHubInput {
  const debounced = useDebouncedValue(input.trim(), 250)
  const parsed = useMemo(() => (debounced ? parseGitHubRefDetailed(debounced) : { ref: null }), [debounced])
  const ref = parsed.ref
  const owner = ref?.owner
  const repoName = ref?.repo
  const prNumber = ref && (ref.kind === 'pull' || ref.kind === 'pull_commit') ? ref.number : undefined

  const repoQ = useGitHubRepo(owner, repoName)
  const pullQ = useGitHubPull(owner, repoName, prNumber)
  const sha =
    ref && (ref.kind === 'commit' || ref.kind === 'pull_commit') ? ref.sha : ref?.kind === 'pull' ? pullQ.data?.headSha : undefined
  const commitQ = useGitHubCommit(owner, repoName, sha)

  return useMemo<ResolvedGitHubInput>(() => {
    if (!debounced) return { ref: null, status: 'empty', isLoading: false, error: null }
    if (!ref) {
      return {
        ref: null,
        status: 'invalid',
        reason: (parsed as { reason?: string }).reason ?? 'That does not look like a GitHub repository, pull request or commit.',
        isLoading: false,
        error: null,
      }
    }
    const errors = [repoQ.error, pullQ.error, commitQ.error].filter((e): e is PineApiError => Boolean(e))
    const error = errors[0] ?? null
    const repo = repoQ.data
    const pull = pullQ.data
    const commit = commitQ.data
    const loading = repoQ.isLoading || (prNumber !== undefined && pullQ.isLoading) || (Boolean(sha) && commitQ.isLoading)
    let status: ResolveStatus = loading ? 'loading' : 'resolved'
    let reason: string | undefined
    if (error) {
      if (error.status === 404) {
        status = 'not_found'
        reason =
          error === repoQ.error
            ? `Repository ${owner}/${repoName} was not found or is private. Pine supports public repositories only.`
            : error === pullQ.error
              ? `Pull request #${prNumber} was not found in ${owner}/${repoName}.`
              : `Commit ${sha} was not found in ${owner}/${repoName}.`
      } else if (error.status === 429 || error.code === 'rate_limited') {
        status = 'rate_limited'
        reason = `GitHub rate limit reached${error.retryAfter ? `; try again in ${Math.ceil(error.retryAfter / 60)} min` : ''}. Signing in with GitHub raises the limit.`
      } else {
        status = 'error'
        reason = error.message
      }
    } else if (repo?.private) {
      status = 'invalid'
      reason = 'Private repositories are not supported yet. Pine verifies public code only.'
    }
    const source = repo && commit ? toSourceRef({ repo, commit, pull }) : undefined
    return { ref, repo, pull, commit, source, status, reason, isLoading: loading, error }
  }, [debounced, ref, parsed, repoQ.data, repoQ.error, repoQ.isLoading, pullQ.data, pullQ.error, pullQ.isLoading, commitQ.data, commitQ.error, commitQ.isLoading, prNumber, sha, owner, repoName])
}

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    if (ms <= 0) {
      setV(value)
      return
    }
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
