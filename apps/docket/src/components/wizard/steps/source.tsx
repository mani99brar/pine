'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { CommitSummary, PullSummary, RepoSummary, SourceRef } from '@pine/core'
import { formatDate, shortSha } from '@pine/core'
import {
  toSourceRef,
  useAccount,
  useGitHubCommits,
  useGitHubPullCommits,
  useGitHubPulls,
  useGitHubViewerRepos,
  useResolveGitHubInput,
} from '@pine/react'
import { GitCommitHorizontal, GitPullRequest, Link2, Loader2, Lock, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Checkbox, Field, Input, MarginNote } from '@/components/ui/field'
import { ExternalLink } from '@/components/ui/external-link'
import { HashValue } from '@/components/ui/copy'
import { Notice } from '@/components/ui/notice'
import { Skeleton } from '@/components/ui/layout'
import { useWizard } from '../context'

export function SourceStep() {
  const { composer, errorFor, frozen } = useWizard()
  const src = composer.draft.source
  const [changing, setChanging] = useState(!src)
  const pin = (s: SourceRef) => {
    composer.update({ source: s })
    setChanging(false)
  }

  return (
    <>
      {src && !changing ? (
        <PinnedSource source={src} onChange={frozen ? undefined : () => setChanging(true)} />
      ) : (
        <SourcePicker onPin={pin} onCancel={src ? () => setChanging(false) : undefined} error={errorFor('source')} />
      )}

      {src ? (
        <div className="space-y-6 border-t border-rule pt-7">
          <Field
            id="f-regression"
            label="Which violations count?"
            error={errorFor('spec.regressionOnly') ?? errorFor('source.baseCommit')}
            guidance={
              <>
                <p>
                  Most claims accept <strong>any</strong> violation in the pinned commit.
                </p>
                <p>
                  Choose regression-only when you are verifying a change: a counterexample then has to show the violation is new in this
                  commit, compared with the base commit.
                </p>
              </>
            }
          >
            <Checkbox
              id="f-regression"
              checked={!!composer.draft.spec.regressionOnly}
              onChange={(e) => composer.update({ spec: { regressionOnly: e.target.checked } })}
              label="Only regressions relative to the base commit count"
              description={
                src.baseCommit ? (
                  <>
                    Base commit <code className="font-mono">{shortSha(src.baseCommit.sha)}</code>
                    {src.pullRequest ? ', the base of the pull request.' : '.'}
                  </>
                ) : (
                  'No base commit is pinned. Pin a pull request commit to get its base automatically.'
                )
              }
            />
          </Field>
        </div>
      ) : null}
    </>
  )
}

function PinnedSource({ source: s, onChange }: { source: SourceRef; onChange?: () => void }) {
  return (
    <div className="grid gap-x-10 gap-y-4 lg:grid-cols-[minmax(0,1fr)_17rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div id="f-source" tabIndex={-1} className="min-w-0 border-2 border-ink outline-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-bond px-4 py-2.5">
          <p className="flex items-center gap-2 font-bold">
            <Lock aria-hidden className="size-4" /> Pinned commit
          </p>
          {onChange ? (
            <Button variant="quiet" size="sm" onClick={onChange}>
              Choose a different commit
            </Button>
          ) : null}
        </div>
        <dl className="divide-y divide-rule text-[15px]">
          <Row term="Repository">
            <ExternalLink href={`https://github.com/${s.owner}/${s.repo}`}>
              {s.owner}/{s.repo}
            </ExternalLink>
            {s.license ? <span className="ml-2 text-graphite">{s.license}</span> : null}
          </Row>
          {s.pullRequest ? (
            <Row term="Pull request">
              <span className="untrusted">
                #{s.pullRequest.number}: {s.pullRequest.title}
              </span>{' '}
              <span className="text-graphite">by {s.pullRequest.author}</span>
            </Row>
          ) : null}
          <Row term="Commit">
            <HashValue value={s.commit.sha} wrap label="commit SHA" />
            <span className="untrusted mt-1 block">{s.commit.message.split('\n')[0]}</span>
            <span className="block text-sm text-graphite">
              {s.commit.author}, {formatDate(s.commit.committedAt, 'long')}
            </span>
          </Row>
          {s.baseCommit ? (
            <Row term="Base commit">
              <HashValue value={s.baseCommit.sha} wrap label="base commit SHA" />
            </Row>
          ) : null}
        </dl>
      </div>
      <aside>
        <MarginNote title="Why one exact commit">
          <p>
            The claim covers this commit only. If the pull request gets new commits, this claim does not follow them. A changed artifact
            needs a new claim.
          </p>
        </MarginNote>
      </aside>
    </div>
  )
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm font-bold text-graphite">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function SourcePicker({ onPin, onCancel, error }: { onPin: (s: SourceRef) => void; onCancel?: () => void; error?: string }) {
  const sp = useSearchParams()
  const [mode, setMode] = useState<'paste' | 'browse'>('paste')
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="How to choose the code" className="flex border-b-2 border-ink">
        {[
          { id: 'paste' as const, label: 'Paste a GitHub link', icon: Link2 },
          { id: 'browse' as const, label: 'Browse repositories', icon: Search },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={mode === t.id}
            aria-controls={`panel-${t.id}`}
            id={`tab-${t.id}`}
            onClick={() => setMode(t.id)}
            className={cn(
              '-mb-[2px] inline-flex items-center gap-2 border-2 border-b-0 px-4 py-2.5 font-bold',
              mode === t.id ? 'border-ink bg-sheet text-ink' : 'border-transparent text-graphite hover:text-ink',
            )}
          >
            <t.icon aria-hidden className="size-4" />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${mode}`} aria-labelledby={`tab-${mode}`}>
        {mode === 'paste' ? <PastePanel initial={sp.get('ref') ?? ''} onPin={onPin} error={error} /> : <BrowsePanel onPin={onPin} />}
      </div>
      {onCancel ? (
        <Button variant="quiet" onClick={onCancel}>
          Keep the commit already pinned
        </Button>
      ) : null}
    </div>
  )
}

function PastePanel({ initial, onPin, error }: { initial: string; onPin: (s: SourceRef) => void; error?: string }) {
  const [value, setValue] = useState(initial)
  const r = useResolveGitHubInput(value)
  return (
    <div className="space-y-5">
      <Field
        id="f-source"
        label="GitHub link or reference"
        hint="A pull request, a commit, or a repository. For example a PR link, owner/repo#12 or owner/repo@9f3c2e1."
        error={error && !value ? error : undefined}
        guidance={
          <>
            <p>
              Pine reads <strong>public</strong> repositories only, and never writes to them.
            </p>
            <p>A pull request resolves to its latest commit, and its base commit is pinned for comparison.</p>
            <p>Short SHAs are expanded to the full 40 characters, which is what goes on the record.</p>
          </>
        }
      >
        <Input
          id="f-source"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/12"
          autoComplete="off"
          spellCheck={false}
          mono
        />
      </Field>
      <div aria-live="polite">
        {r.status === 'loading' ? (
          <p className="flex items-center gap-2 text-graphite">
            <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" /> Looking this up on GitHub
          </p>
        ) : r.status === 'invalid' || r.status === 'not_found' || r.status === 'rate_limited' || r.status === 'error' ? (
          <Notice tone={r.status === 'rate_limited' ? 'warning' : 'critical'} title="That could not be resolved">
            {r.reason ?? 'Check the link and try again.'}
          </Notice>
        ) : r.status === 'resolved' && r.repo && !r.commit ? (
          <RepoCommits repo={r.repo} onPin={onPin} />
        ) : r.status === 'resolved' && r.repo && r.commit ? (
          <ResolvedPreview repo={r.repo} pull={r.pull} commit={r.commit} onPin={onPin} />
        ) : null}
      </div>
    </div>
  )
}

function ResolvedPreview({
  repo,
  pull,
  commit,
  onPin,
}: {
  repo: RepoSummary
  pull?: PullSummary
  commit: CommitSummary
  onPin: (s: SourceRef) => void
}) {
  const commits = useGitHubPullCommits(pull ? repo.owner : undefined, pull ? repo.name : undefined, pull?.number)
  const [chosen, setChosen] = useState<CommitSummary>(commit)
  const isHead = pull ? chosen.sha === pull.headSha : true
  return (
    <div className="border border-rule">
      <div className="border-b border-rule bg-bond px-4 py-3">
        <p className="font-bold">
          {repo.fullName}
          {repo.private ? <span className="ml-2 text-red">Private: not supported</span> : null}
        </p>
        {pull ? (
          <p className="untrusted mt-0.5 flex items-start gap-1.5 text-[15px]">
            <GitPullRequest aria-hidden className="mt-1 size-4 shrink-0" /> #{pull.number}: {pull.title}
            <span className="shrink-0 text-graphite">({pull.state})</span>
          </p>
        ) : null}
      </div>
      {pull && commits.data && commits.data.length > 1 ? (
        <fieldset className="px-4 py-3">
          <legend className="pt-3 text-sm font-bold">Which commit of this pull request?</legend>
          <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
            {[...commits.data].reverse().map((c) => (
              <li key={c.sha}>
                <label className={cn('flex cursor-pointer items-start gap-3 rounded-xs px-2 py-1.5', chosen.sha === c.sha && 'bg-violet-wash')}>
                  <input
                    type="radio"
                    name="pull-commit"
                    checked={chosen.sha === c.sha}
                    onChange={() => setChosen(c)}
                    className="mt-1 size-4 accent-[var(--color-violet)]"
                  />
                  <span className="min-w-0">
                    <code className="font-mono text-[13px]">{shortSha(c.sha)}</code>{' '}
                    <span className="untrusted">{c.message.split('\n')[0]}</span>
                    {c.sha === pull.headSha ? <span className="ml-2 text-sm font-bold text-violet">latest</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-4 py-3">
        <p className="min-w-0 text-[15px]">
          <GitCommitHorizontal aria-hidden className="mr-1 inline size-4" />
          <code className="font-mono">{shortSha(chosen.sha)}</code>{' '}
          <span className="untrusted text-graphite">{chosen.message.split('\n')[0]}</span>
          {!isHead ? <span className="block text-sm text-ochre">Not the latest commit of this pull request.</span> : null}
        </p>
        <Button onClick={() => onPin(toSourceRef({ repo, commit: chosen, pull }))} disabled={repo.private}>
          Pin this commit
        </Button>
      </div>
    </div>
  )
}

function RepoCommits({ repo, onPin }: { repo: RepoSummary; onPin: (s: SourceRef) => void }) {
  const pulls = useGitHubPulls(repo.owner, repo.name, 'open')
  const commits = useGitHubCommits(repo.owner, repo.name, repo.defaultBranch)
  const [pull, setPull] = useState<PullSummary | null>(null)
  if (pull) {
    return (
      <PullPicker repo={repo} pull={pull} onPin={onPin} onBack={() => setPull(null)} />
    )
  }
  return (
    <div className="space-y-6">
      <p className="text-[15px]">
        <strong>{repo.fullName}</strong> resolved. Choose a pull request, or a commit on <code className="font-mono">{repo.defaultBranch}</code>.
      </p>
      <div>
        <h3 className="text-lg font-bold">Open pull requests</h3>
        {pulls.isLoading ? (
          <Skeleton className="mt-2 h-10 w-full" />
        ) : pulls.data && pulls.data.length > 0 ? (
          <ul className="mt-2 divide-y divide-rule border-y border-rule">
            {pulls.data.map((p) => (
              <li key={p.number}>
                <button type="button" onClick={() => setPull(p)} className="flex w-full items-start gap-2 px-2 py-2.5 text-left hover:bg-bond">
                  <GitPullRequest aria-hidden className="mt-1 size-4 shrink-0 text-violet" />
                  <span className="untrusted min-w-0">
                    <strong>#{p.number}</strong> {p.title}
                    <span className="block text-sm text-graphite">
                      {p.commits} commits by {p.author.login}, updated {formatDate(p.updatedAt, 'short')}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-graphite">No open pull requests.</p>
        )}
      </div>
      <div>
        <h3 className="text-lg font-bold">Recent commits on {repo.defaultBranch}</h3>
        <CommitList commits={commits.data} loading={commits.isLoading} onChoose={(c) => onPin(toSourceRef({ repo, commit: c }))} />
      </div>
    </div>
  )
}

function PullPicker({ repo, pull, onPin, onBack }: { repo: RepoSummary; pull: PullSummary; onPin: (s: SourceRef) => void; onBack: () => void }) {
  const commits = useGitHubPullCommits(repo.owner, repo.name, pull.number)
  return (
    <div className="space-y-3">
      <Button variant="quiet" onClick={onBack}>
        Back to {repo.fullName}
      </Button>
      <p className="untrusted font-bold">
        #{pull.number}: {pull.title}
      </p>
      <CommitList
        commits={commits.data ? [...commits.data].reverse() : undefined}
        loading={commits.isLoading}
        latestSha={pull.headSha}
        onChoose={(c) => onPin(toSourceRef({ repo, commit: c, pull }))}
      />
    </div>
  )
}

function CommitList({
  commits,
  loading,
  onChoose,
  latestSha,
}: {
  commits?: CommitSummary[]
  loading: boolean
  onChoose: (c: CommitSummary) => void
  latestSha?: string
}) {
  if (loading)
    return (
      <div className="mt-2 space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  if (!commits || commits.length === 0) return <p className="mt-2 text-graphite">No commits found.</p>
  return (
    <ul className="mt-2 divide-y divide-rule border-y border-rule">
      {commits.slice(0, 12).map((c) => (
        <li key={c.sha} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-2 py-2.5">
          <span className="min-w-0 flex-1">
            <code className="font-mono text-[13px]">{shortSha(c.sha)}</code>{' '}
            <span className="untrusted">{c.message.split('\n')[0]}</span>
            {latestSha === c.sha ? <span className="ml-2 text-sm font-bold text-violet">latest</span> : null}
            <span className="block text-sm text-graphite">
              {c.author.login ?? c.author.name}, {formatDate(c.author.date, 'short')}
            </span>
          </span>
          <Button size="sm" variant="secondary" onClick={() => onChoose(c)}>
            Pin this commit
          </Button>
        </li>
      ))}
    </ul>
  )
}

function BrowsePanel({ onPin }: { onPin: (s: SourceRef) => void }) {
  const account = useAccount()
  const repos = useGitHubViewerRepos()
  const [repo, setRepo] = useState<RepoSummary | null>(null)
  if (account.status === 'signed_out') {
    return (
      <Notice
        tone="info"
        title="Sign in with GitHub to browse your repositories"
        action={
          <Button size="sm" onClick={() => void account.signIn(account.providers.github ? 'github' : 'demo')}>
            Sign in with GitHub
          </Button>
        }
      >
        Pine asks only to read your public profile. You can still paste a link to any public repository without signing in.
      </Notice>
    )
  }
  if (repo) {
    return (
      <div className="space-y-3">
        <Button variant="quiet" onClick={() => setRepo(null)}>
          Back to your repositories
        </Button>
        <RepoCommits repo={repo} onPin={onPin} />
      </div>
    )
  }
  if (repos.isLoading)
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  const items = repos.data?.items.filter((r) => !r.private) ?? []
  if (items.length === 0) return <p className="text-graphite">No public repositories found for this account.</p>
  return (
    <ul className="divide-y divide-rule border-y border-rule">
      {items.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => setRepo(r)} className="flex w-full items-start justify-between gap-4 px-2 py-3 text-left hover:bg-bond">
            <span className="min-w-0">
              <strong>{r.fullName}</strong>
              {r.description ? <span className="untrusted block text-sm text-graphite">{r.description}</span> : null}
            </span>
            <span className="shrink-0 text-sm text-graphite">
              {r.openPullRequests ?? 0} open PRs
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
