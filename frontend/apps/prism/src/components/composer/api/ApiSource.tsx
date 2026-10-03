'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { RepoSummary, SourceRef } from '@pine/core'
import { shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { GIT_BRANCH_PATTERN } from '@pine/data'
import { toSourceRef, useAccount, useGitHubLink, useGitHubPullCommits, useGitHubPulls, useResolveGitHubInput, type ClaimComposer } from '@pine/react'
import { GitBranch, GitPullRequest, Lock, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { FormField, Notice, Skeleton } from '@/components/ui/primitives'
import { StageHeader, StageIssues, StageNav, type StepNav } from '../shared'
import { PinnedSha, SourceCard } from '../SourceParts'
import { ApiIdentityGate, identityReady, useApiIdentity } from './identity'

// Source stage in api mode. GitHub is read through the Pine backend with the user's linked account. Existence is not
// membership (SEC-GH-11): the commit is pinned together with the pull request or the branch that contains it, and the
// backend proves that membership when the preview is requested. There is no branch history in api mode, so a commit
// comes from a pull request or from a pasted full SHA plus its branch.

const SHA40 = /^[0-9a-fA-F]{40}$/

function branchProblem(name: string): string | null {
  const b = name.trim()
  if (!b) return 'Name the branch that contains this commit.'
  if (!GIT_BRANCH_PATTERN.test(b) || b.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return 'Use a branch name made of letters, digits and . _ - / (no empty, “.” or “..” parts).'
  }
  return null
}

/** How the backend will prove that the pinned commit belongs to the repository. */
export function MembershipNote({ source, className }: { source: SourceRef; className?: string }) {
  return (
    <p className={className ?? 'text-[0.84375rem] text-lumen-2'}>
      {source.pullRequest ? (
        <>
          <span className="font-semibold text-lumen">Membership: pull request #{source.pullRequest.number}.</span> When you request the preview, Pine checks with
          GitHub that this commit is the pull request&apos;s head or one of its commits.
        </>
      ) : source.branch ? (
        <>
          <span className="font-semibold text-lumen">
            Membership: branch <code className="t-code">{source.branch}</code>.
          </span>{' '}
          When you request the preview, Pine checks with GitHub that this commit is in the branch&apos;s history.
        </>
      ) : (
        <span className="font-semibold text-ha">Membership missing: choose the pull request or the branch that contains this commit.</span>
      )}
    </p>
  )
}

/** A repository without a commit: pick an open pull request, or a commit on a branch by its full SHA. */
function RepoPicker({ repo, onPull, onCommit }: { repo: RepoSummary; onPull: (n: number) => void; onCommit: (sha: string, branch: string) => void }) {
  const pulls = useGitHubPulls(repo.owner, repo.name, 'open')
  const [sha, setSha] = useState('')
  const [branch, setBranch] = useState(repo.defaultBranch)
  const shaError = sha && !SHA40.test(sha.trim()) ? 'Paste the full 40-character commit SHA (Pine does not resolve short SHAs).' : null
  const bError = branchProblem(branch)
  return (
    <div className="glass cut-lg overflow-hidden">
      <p className="flex items-center gap-1.5 border-b border-edge px-4 py-3 text-[0.875rem] font-semibold text-lumen">
        <GitBranch size={15} aria-hidden /> {repo.owner}/{repo.name}
      </p>
      <div className="grid gap-6 px-4 py-4 md:grid-cols-2">
        <section aria-labelledby="pick-pr">
          <h3 id="pick-pr" className="t-h4">
            From a pull request
          </h3>
          <p className="help mt-1">The pull request proves the commit belongs to the repository.</p>
          {pulls.isLoading ? (
            <Skeleton className="mt-3 h-24 w-full" />
          ) : pulls.isError ? (
            <p className="mt-3 text-[0.875rem] text-ha" role="alert">
              <span className="untrusted">{pulls.error.message}</span>
            </p>
          ) : (pulls.data?.length ?? 0) === 0 ? (
            <p className="mt-3 text-[0.875rem] text-lumen-3">No open pull requests. Paste a pull request URL above for a closed one.</p>
          ) : (
            <ul className="mt-3 grid gap-1.5">
              {(pulls.data ?? []).slice(0, 8).map((p) => (
                <li key={p.number}>
                  <button
                    type="button"
                    onClick={() => onPull(p.number)}
                    className="cut-sm flex w-full items-start gap-2 border border-edge bg-smoke px-3 py-2 text-left text-[0.875rem] hover:border-edge-strong"
                  >
                    <GitPullRequest size={14} aria-hidden className="mt-1 shrink-0 text-hb" />
                    <span className="min-w-0">
                      <span className="sr-only">Use pull request </span>
                      <span className="untrusted [white-space:normal]">
                        #{p.number} {p.title}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <form
          aria-labelledby="pick-commit"
          onSubmit={(e) => {
            e.preventDefault()
            if (SHA40.test(sha.trim()) && !bError) onCommit(sha.trim().toLowerCase(), branch.trim())
          }}
        >
          <h3 id="pick-commit" className="t-h4">
            A commit on a branch
          </h3>
          <p className="help mt-1">The branch must contain the commit in its history.</p>
          <div className="mt-3 grid gap-3">
            <FormField id="pick-sha" label="Full commit SHA" error={shaError ?? undefined}>
              <input id="pick-sha" className="field t-code" value={sha} spellCheck={false} autoComplete="off" maxLength={40} onChange={(e) => setSha(e.target.value)} placeholder="40 hex characters" aria-invalid={Boolean(shaError) || undefined} />
            </FormField>
            <FormField id="pick-branch" label="Branch" error={bError ?? undefined}>
              <input id="pick-branch" className="field t-code" value={branch} spellCheck={false} autoComplete="off" maxLength={200} onChange={(e) => setBranch(e.target.value)} aria-invalid={Boolean(bError) || undefined} />
            </FormField>
            <Button type="submit" variant="glass" className="w-fit" disabled={!SHA40.test(sha.trim()) || Boolean(bError)}>
              Look up this commit
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function ApiStageSource({ c, nav, initialInput }: { c: ClaimComposer; nav: StepNav; initialInput?: string }) {
  const id = useApiIdentity()
  const account = useAccount()
  const gh = useGitHubLink()
  const ready = identityReady(id, 'github')
  const pinned = c.draft.source
  const [input, setInput] = useState(initialInput ?? '')
  const [justPinned, setJustPinned] = useState(false)
  const [altSha, setAltSha] = useState('')
  // null: the repository's default branch.
  const [branch, setBranch] = useState<string | null>(null)
  const resolved = useResolveGitHubInput(ready ? input : '')
  const prCommits = useGitHubPullCommits(resolved.repo?.owner, resolved.repo?.name, resolved.pull?.number)

  const candidate = useMemo(() => {
    if (!resolved.source) return undefined
    if (altSha && resolved.repo) {
      const alt = prCommits.data?.find((x) => x.sha === altSha)
      if (alt) return toSourceRef({ repo: resolved.repo, commit: alt, pull: resolved.pull })
    }
    return resolved.source
  }, [resolved.source, resolved.repo, resolved.pull, altSha, prCommits.data])

  const branchName = branch ?? resolved.repo?.defaultBranch ?? ''
  const branchError = candidate && !candidate.pullRequest ? branchProblem(branchName) : null
  const isPinned = Boolean(candidate && pinned && pinned.commit.sha === candidate.commit.sha && (candidate.pullRequest ? pinned.pullRequest?.number === candidate.pullRequest.number : pinned.branch === branchName.trim()))

  const edit = (next: string) => {
    setInput(next)
    setJustPinned(false)
    setAltSha('')
    setBranch(null)
  }

  const pin = () => {
    if (!candidate || c.frozen || branchError) return
    c.update({ source: candidate.pullRequest ? candidate : { ...candidate, branch: branchName.trim() } })
    setJustPinned(true)
  }

  if (pinned && !input) {
    return (
      <div>
        <StageHeader step="source">The claim is about this exact commit and nothing else. New commits on the pull request or branch need a new claim.</StageHeader>
        <SourceCard source={pinned}>
          <PinnedSha sha={pinned.commit.sha} animate={justPinned} />
          <p className="mt-3 inline-flex items-center gap-2 text-[0.875rem] font-semibold text-lumen">
            <Lock size={14} aria-hidden /> Pinned. The commit facet is cut.
          </p>
          <MembershipNote source={pinned} className="mt-2 text-[0.84375rem] text-lumen-2" />
        </SourceCard>
        {!c.frozen ? (
          <Button variant="ghost" className="mt-4" onClick={() => edit(`${pinned.owner}/${pinned.repo}`)}>
            Pin a different commit
          </Button>
        ) : (
          <Notice className="mt-4" tone="boundary">
            {COPY.frozenTerms}
          </Notice>
        )}
        <StageIssues c={c} step="source" className="mt-5" />
        <StageNav nav={nav} />
      </div>
    )
  }

  const status = resolved.error?.status
  return (
    <div>
      <StageHeader step="source">
        Paste a pull request, a commit URL or <code className="t-code text-lumen">owner/repo</code>. Pine reads it through your linked GitHub account (public
        repositories only), pins the full 40-character SHA, and proves when you request the preview that the commit belongs to the repository.
      </StageHeader>
      {!ready ? (
        <ApiIdentityGate need="github" reason="Pine reads GitHub for the wallet you sign in with, so pinning a commit starts with signing in and linking GitHub." />
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (resolved.status === 'resolved') pin()
            }}
          >
            <label htmlFor="source-input" className="sr-only">
              Pull request, commit URL or owner/repo reference
            </label>
            <div className="relative">
              <Search size={19} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lumen-3" />
              <input
                id="source-input"
                value={input}
                onChange={(e) => edit(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://github.com/owner/repo/pull/12"
                aria-describedby="source-status"
                className="field t-code h-14 pl-11 text-[0.95rem]"
              />
            </div>
          </form>
          <div id="source-status" className="mt-6" aria-live="polite">
            {resolved.status === 'empty' ? (
              <p className="text-[0.9375rem] text-lumen-2">
                Or{' '}
                <Link href="/repos" className="link">
                  browse your repositories
                </Link>{' '}
                and pick a pull request.
              </p>
            ) : resolved.status === 'loading' ? (
              <div className="cut-lg border border-dashed border-edge-strong p-5">
                <p className="text-[0.9rem] text-lumen-2">Looking it up on GitHub</p>
                <span className="skeleton mt-3 block h-4 w-1/2" />
                <span className="skeleton mt-2 block h-6 w-full" />
              </div>
            ) : resolved.status === 'resolved' && candidate ? (
              <SourceCard source={candidate}>
                <PinnedSha key={`${candidate.commit.sha}-${justPinned}`} sha={candidate.commit.sha} animate={justPinned} />
                {resolved.pull && (prCommits.data?.length ?? 0) > 1 && (
                  <label className="mt-4 flex flex-wrap items-center gap-2 text-[0.84375rem] text-lumen-2">
                    Use a different commit from this pull request
                    <select value={altSha} onChange={(e) => setAltSha(e.target.value)} className="field w-auto max-w-full text-[0.84375rem]">
                      <option value="">Head commit (latest)</option>
                      {(prCommits.data ?? []).map((cm) => (
                        <option key={cm.sha} value={cm.sha}>
                          {shortSha(cm.sha)} {(cm.message.split('\n')[0] ?? '').slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {candidate.pullRequest ? (
                  <MembershipNote source={candidate} className="mt-4 text-[0.84375rem] text-lumen-2" />
                ) : (
                  <FormField
                    id="source-branch"
                    className="mt-4 max-w-[28rem]"
                    label="Branch that contains this commit"
                    help="Pine checks with GitHub, when you request the preview, that this commit is in the branch's history. Use the branch it was merged or pushed to."
                    error={branchError ?? undefined}
                  >
                    <input
                      id="source-branch"
                      className="field t-code"
                      value={branchName}
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={200}
                      disabled={c.frozen}
                      aria-invalid={Boolean(branchError) || undefined}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                  </FormField>
                )}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <Button onClick={pin} disabled={c.frozen || Boolean(branchError)} icon={<Lock size={15} aria-hidden />}>
                    Use this commit
                  </Button>
                  <p className="text-[0.8125rem] text-lumen-3" role="status">
                    {isPinned ? 'Pinned. Continue when you are ready.' : resolved.pull && !altSha ? 'This is the pull request’s head commit right now. Later pushes are not covered.' : ''}
                  </p>
                </div>
              </SourceCard>
            ) : resolved.status === 'resolved' && resolved.ref?.kind === 'repo' && resolved.repo ? (
              <RepoPicker
                key={resolved.repo.fullName}
                repo={resolved.repo}
                onPull={(n) => edit(`${resolved.repo?.owner}/${resolved.repo?.name}/pull/${n}`)}
                onCommit={(sha, b) => {
                  edit(`${resolved.repo?.owner}/${resolved.repo?.name}@${sha}`)
                  setBranch(b)
                }}
              />
            ) : resolved.status === 'error' && (status === 401 || status === 403) ? (
              <Notice
                tone="caution"
                title={status === 401 ? 'Your Pine session has ended' : 'GitHub is not linked to this session'}
                action={
                  status === 401 ? (
                    <Button size="sm" onClick={() => void account.signIn().catch(() => undefined)}>
                      Sign in again
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void gh.link().catch(() => undefined)} loading={gh.busy}>
                      Link GitHub again
                    </Button>
                  )
                }
              >
                {/* The backend's own message (platform text), shown as plain text. */}
                <span className="untrusted">{resolved.reason}</span>
              </Notice>
            ) : (
              <Notice
                tone="caution"
                title={
                  resolved.status === 'rate_limited'
                    ? 'GitHub rate limit reached'
                    : resolved.status === 'not_found'
                      ? 'Not found on GitHub'
                      : status === 422
                        ? 'Not a public repository'
                        : 'That reference did not resolve'
                }
              >
                <span className="untrusted">{resolved.reason ?? 'Check the URL and try again.'}</span>
              </Notice>
            )}
          </div>
        </>
      )}
      <StageIssues c={c} step="source" className="mt-6" />
      <StageNav nav={nav} nextDisabled={!c.draft.source} />
    </div>
  )
}
