/**
 * Parse pasted GitHub references.
 *
 * Accepted forms (http/https, optional www., trailing slashes, ?query and #fragment ignored):
 *   https://github.com/o/r            github.com/o/r          o/r           git@github.com:o/r.git
 *   o/r#12                            o/r@<sha>               o/r/pull/12   (any of the URL forms without host)
 *   …/pull/12  …/pull/12/files  …/pull/12/commits  …/pull/12/commits/<sha>  …/pull/12/files/<sha>
 *   …/commit/<sha>  …/commits/<sha>  …/tree/<sha>  …/blob/<sha>/path
 *   …/tree/<branch>, …/issues, …/actions etc. → repo
 *
 * SHAs: 7–40 hex, normalized to lowercase. Fewer than 40 chars → `short: true`; short SHAs must be resolved
 * to a full 40-hex SHA via GitHub before a claim can pin them (validation enforces 40 hex).
 * Returns null for anything else.
 */
import type { ParsedGitHubRef } from './types'

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const SHA_RE = /^[0-9a-fA-F]{7,40}$/
const NUM_RE = /^[1-9]\d{0,9}$/

/** GitHub top-level paths that are not user/org names. */
const RESERVED_OWNERS = new Set([
  'about', 'apps', 'blog', 'collections', 'contact', 'customer-stories', 'enterprise', 'events', 'explore',
  'features', 'issues', 'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'organizations',
  'pricing', 'pulls', 'search', 'settings', 'signup', 'site', 'sponsors', 'topics', 'trending', 'users',
])

export interface GitHubRefResult {
  ref: ParsedGitHubRef | null
  /** Plain-language reason when `ref` is null */
  reason?: string
}

function sha(s: string | undefined): { sha: string; short?: boolean } | null {
  if (!s || !SHA_RE.test(s)) return null
  const lower = s.toLowerCase()
  return lower.length < 40 ? { sha: lower, short: true } : { sha: lower }
}

function num(s: string | undefined): number | null {
  if (!s || !NUM_RE.test(s)) return null
  const n = Number.parseInt(s, 10)
  return Number.isSafeInteger(n) ? n : null
}

function validRepoName(r: string): boolean {
  return REPO_RE.test(r) && r !== '.' && r !== '..'
}

/** Like parseGitHubRef but explains why an input was rejected. */
export function parseGitHubRefDetailed(input: string): GitHubRefResult {
  if (typeof input !== 'string') return { ref: null, reason: 'Paste a GitHub URL or owner/repo.' }
  let s = input.trim()
  if (!s) return { ref: null, reason: 'Paste a GitHub URL or owner/repo.' }
  if (/\s/.test(s)) return { ref: null, reason: 'A GitHub reference cannot contain spaces.' }

  // git@github.com:owner/repo(.git)
  const ssh = /^git@github\.com:(.+)$/i.exec(s)
  if (ssh) s = `github.com/${ssh[1]}`

  // A first segment containing "." is a host (GitHub owner names cannot contain dots).
  let hadHost = false
  const urlLike = /^(?:(?:https?:)?\/\/)?(?:www\.)?([^/?#]+)(.*)$/i.exec(s)
  if (urlLike && urlLike[1] && /\./.test(urlLike[1]) && !/^[^/]*@/.test(urlLike[1])) {
    const host = urlLike[1].toLowerCase()
    if (host !== 'github.com') {
      return { ref: null, reason: `Only github.com references are supported (got ${host}).` }
    }
    hadHost = true
    s = urlLike[2] ?? ''
  } else if (/^[a-z]+:/i.test(s)) {
    return { ref: null, reason: 'Only github.com references are supported.' }
  }

  // Strip query and fragment, but keep "#123" shorthand for owner/repo#123 (no host).
  let fragmentPr: number | null = null
  const hashIdx = s.indexOf('#')
  if (hashIdx >= 0) {
    const frag = s.slice(hashIdx + 1)
    if (!hadHost) {
      fragmentPr = num(frag)
      if (fragmentPr === null) return { ref: null, reason: 'Use owner/repo#<number> for a pull request.' }
    }
    s = s.slice(0, hashIdx)
  }
  const qIdx = s.indexOf('?')
  if (qIdx >= 0) s = s.slice(0, qIdx)

  const segments = s.split('/').filter((x) => x.length > 0)
  if (segments.length < 2) {
    return { ref: null, reason: 'Include both the owner and the repository, e.g. owner/repo.' }
  }

  const owner = segments[0] as string
  let repoSeg = segments[1] as string
  // owner/repo@sha shorthand
  let atSha: string | undefined
  const at = repoSeg.indexOf('@')
  if (at >= 0) {
    atSha = repoSeg.slice(at + 1)
    repoSeg = repoSeg.slice(0, at)
  }
  const repo = repoSeg.replace(/\.git$/i, '')

  if (!OWNER_RE.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { ref: null, reason: `"${owner}" is not a valid GitHub owner.` }
  }
  if (!validRepoName(repo)) return { ref: null, reason: `"${repo}" is not a valid repository name.` }

  const base = { owner, repo }

  if (atSha !== undefined) {
    if (segments.length > 2) return { ref: null, reason: 'Use owner/repo@<commit sha> without a path.' }
    const c = sha(atSha)
    if (!c) return { ref: null, reason: 'After "@" use a commit SHA (7–40 hex characters).' }
    return { ref: { kind: 'commit', ...base, ...c } }
  }

  if (fragmentPr !== null) {
    if (segments.length > 2) return { ref: null, reason: 'Use owner/repo#<number> for a pull request.' }
    return { ref: { kind: 'pull', ...base, number: fragmentPr } }
  }

  const section = segments[2]?.toLowerCase()
  const rest = segments.slice(3)

  if (section === undefined) return { ref: { kind: 'repo', ...base } }

  if (section === 'pull' || section === 'pulls') {
    if (section === 'pulls' && rest.length === 0) return { ref: { kind: 'repo', ...base } }
    const n = num(rest[0])
    if (n === null) return { ref: null, reason: 'The pull request number is missing or invalid.' }
    const sub = rest[1]?.toLowerCase()
    if ((sub === 'commits' || sub === 'files') && rest[2] !== undefined) {
      // /pull/12/commits/<sha> or /pull/12/files/<sha>[..<sha>] (range: last SHA wins)
      const target = rest[2].split('..').pop()
      const c = sha(target)
      if (!c) return { ref: null, reason: 'The commit SHA in the pull request URL is invalid.' }
      return { ref: { kind: 'pull_commit', ...base, number: n, ...c } }
    }
    return { ref: { kind: 'pull', ...base, number: n } }
  }

  if (section === 'commit' || section === 'commits' || section === 'tree' || section === 'blob') {
    const c = sha(rest[0])
    if (c) return { ref: { kind: 'commit', ...base, ...c } }
    if (section === 'commit') return { ref: null, reason: 'The commit SHA is missing or invalid (7–40 hex characters).' }
    // branch names / commit lists → the repository
    return { ref: { kind: 'repo', ...base } }
  }

  // Any other repository page (issues, actions, releases, compare…) resolves to the repository.
  return { ref: { kind: 'repo', ...base } }
}

/** Parse a pasted GitHub URL or shorthand; null when it is not a recognizable github.com reference. */
export function parseGitHubRef(input: string): ParsedGitHubRef | null {
  return parseGitHubRefDetailed(input).ref
}

/** Canonical GitHub web URL for a parsed reference. */
export function gitHubRefUrl(ref: ParsedGitHubRef): string {
  const repo = `https://github.com/${ref.owner}/${ref.repo}`
  switch (ref.kind) {
    case 'repo':
      return repo
    case 'pull':
      return `${repo}/pull/${ref.number}`
    case 'commit':
      return `${repo}/commit/${ref.sha}`
    case 'pull_commit':
      return `${repo}/pull/${ref.number}/commits/${ref.sha}`
  }
}

/** True for a full, lowercase-or-uppercase 40-hex commit SHA. */
export function isFullSha(s: string | undefined | null): boolean {
  return typeof s === 'string' && /^[0-9a-fA-F]{40}$/.test(s)
}
