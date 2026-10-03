import { describe, expect, it } from 'vitest'
import { gitHubRefUrl, parseGitHubRef, parseGitHubRefDetailed } from '../src/github-ref'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA_UP = SHA.toUpperCase()

describe('parseGitHubRef', () => {
  it.each([
    ['https://github.com/o/r', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['http://www.github.com/o/r/', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['github.com/o/r', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['o/r', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['  kleros/gateway-balancer-bot  ', { kind: 'repo', owner: 'kleros', repo: 'gateway-balancer-bot' }],
    ['https://github.com/o/r.git', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['git@github.com:o/r.git', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['https://github.com/o/r?tab=readme#top', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/tree/main', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['https://github.com/o/r/issues/4', { kind: 'repo', owner: 'o', repo: 'r' }],
    ['https://github.com/o/my.repo_x-1', { kind: 'repo', owner: 'o', repo: 'my.repo_x-1' }],
    ['o/r#12', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['https://github.com/o/r/pull/12', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['https://github.com/o/r/pull/12/', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['https://github.com/o/r/pull/12/files', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['https://github.com/o/r/pull/12/files?diff=split#diff-abc', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['https://github.com/o/r/pull/12/commits', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    ['github.com/o/r/pull/12#issuecomment-1', { kind: 'pull', owner: 'o', repo: 'r', number: 12 }],
    [`https://github.com/o/r/pull/12/commits/${SHA}`, { kind: 'pull_commit', owner: 'o', repo: 'r', number: 12, sha: SHA }],
    [`https://github.com/o/r/pull/12/commits/${SHA_UP}/`, { kind: 'pull_commit', owner: 'o', repo: 'r', number: 12, sha: SHA }],
    [`https://github.com/o/r/commit/${SHA}`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    [`https://github.com/o/r/commit/${SHA_UP}?diff=unified`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    [`https://github.com/o/r/tree/${SHA}`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    [`https://github.com/o/r/blob/${SHA}/src/index.ts`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    [`o/r@${SHA}`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    [`o/r@${SHA_UP}`, { kind: 'commit', owner: 'o', repo: 'r', sha: SHA }],
    ['o/r@abc1234', { kind: 'commit', owner: 'o', repo: 'r', sha: 'abc1234', short: true }],
    ['https://github.com/o/r/commit/ABC1234', { kind: 'commit', owner: 'o', repo: 'r', sha: 'abc1234', short: true }],
    ['https://github.com/o/r/pull/7/commits/abc1234def', { kind: 'pull_commit', owner: 'o', repo: 'r', number: 7, sha: 'abc1234def', short: true }],
  ])('%s', (input, expected) => {
    expect(parseGitHubRef(input)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    'hello',
    'o',
    'https://gitlab.com/o/r',
    'https://github.com/',
    'https://github.com/o',
    'o/r#abc',
    'o/r#0',
    'o/r@main',
    'o/r@abc12',
    'https://github.com/o/r/pull/abc',
    'https://github.com/o/r/commit/xyz',
    'https://github.com/o/r/pull/12/commits/nothex!!',
    'javascript:alert(1)',
    '-bad/r',
    'o/..',
    'some text o/r',
    'https://github.com/settings/profile',
  ])('rejects %j', (input) => {
    expect(parseGitHubRef(input)).toBeNull()
    expect(parseGitHubRefDetailed(input).reason).toBeTruthy()
  })

  it('builds canonical urls', () => {
    expect(gitHubRefUrl({ kind: 'pull_commit', owner: 'o', repo: 'r', number: 3, sha: SHA })).toBe(
      `https://github.com/o/r/pull/3/commits/${SHA}`,
    )
  })
})
