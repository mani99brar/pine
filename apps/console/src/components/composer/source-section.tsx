'use client'

import * as React from 'react'
import { FolderGit2, GitCommitHorizontal, GitPullRequest, Pin, Search, X } from 'lucide-react'
import type { CommitSummary, PullSummary, RepoSummary, SourceRef } from '@pine/core'
import { formatDate, formatRelative, shortSha } from '@pine/core'
import {
  toSourceRef,
  useGitHubCommits,
  useGitHubPullCommits,
  useGitHubPulls,
  useGitHubViewerRepos,
  useResolveGitHubInput,
} from '@pine/react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ExternalLink } from '@/components/ui/external-link'
import { Checkbox, Field, Input } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { useComposerCtx, fieldId } from './context'
import { Section } from './section'

function firstLine(msg: string) {
  return msg.split('\n')[0] ?? msg
}

export function SourceSection({ initialInput }: { initialInput?: string }) {
  const { c, err, touch, disabled } = useComposerCtx()
  const [input, setInput] = React.useState(initialInput ?? '')
  const [browse, setBrowse] = React.useState(false)
  const r = useResolveGitHubInput(input)
  const autoPinned = React.useRef(false)
  const source = c.draft.source

  const pin = React.useCallback(
    (s: SourceRef) => {
      if (disabled) return
      c.update({ source: s })
      touch('source')
    },
    [c, disabled, touch],
  )

  // A URL handed over from the palette pins as soon as it resolves (the user already chose it there).
  React.useEffect(() => {
    if (!autoPinned.current && initialInput && r.status === 'resolved' && r.source && !c.draft.source) {
      autoPinned.current = true
      pin(r.source)
    }
  }, [initialInput, r.status, r.source, c.draft.source, pin])

  const sameAsPinned = !!(r.source && source && r.source.commit.sha === source.commit.sha && r.source.owner === source.owner)

  return (
    <Section
      id="source"
      index={1}
      title="Source"
      description="Pin the exact commit the claim is about. A new commit on the pull request later needs a new claim; these terms never follow the branch."
    >
      {!disabled ? (
        <div className="flex flex-col gap-2">
          <Field label="GitHub pull request, commit or repository" htmlFor="gh-input" hint="Accepts PR URLs (including /files and /commits/<sha>), commit URLs, owner/repo#12 and owner/repo@sha. Short SHAs are resolved to the full 40-character SHA.">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  id="gh-input"
                  mono
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && r.source) {
                      e.preventDefault()
                      pin(r.source)
                    }
                  }}
                  placeholder="https://github.com/owner/repo/pull/12"
                  // Keyboard-first: a fresh composer starts in the paste field.
                  autoFocus={!c.draft.source && !initialInput}
                  className="h-9 pl-8"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <Button variant="secondary" className="h-9" onClick={() => setBrowse(true)}>
                <FolderGit2 size={14} aria-hidden /> Browse
              </Button>
            </div>
          </Field>
          <Resolution r={r} onPin={pin} sameAsPinned={sameAsPinned} />
        </div>
      ) : null}

      {source ? <PinnedSource source={source} /> : null}
      {source?.pullRequest && !disabled ? <PullCommitPicker source={source} onPin={pin} /> : null}
      {source ? <BaseCommit source={source} /> : null}
      {err('source') && !source ? <p className="text-xs text-flare">{err('source')}</p> : null}

      <BrowseDialog open={browse} onOpenChange={setBrowse} onPin={(s) => { pin(s); setBrowse(false) }} />
    </Section>
  )
}

function Resolution({ r, onPin, sameAsPinned }: { r: ReturnType<typeof useResolveGitHubInput>; onPin: (s: SourceRef) => void; sameAsPinned: boolean }) {
  if (r.status === 'empty') return null
  if (r.status === 'loading' || r.isLoading)
    return (
      <div className="flex items-center gap-3 rounded-ctl border border-line bg-frost px-3 py-2.5" role="status">
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3 w-48" />
        <span className="text-xs text-muted">Resolving on GitHub…</span>
      </div>
    )
  if (r.status !== 'resolved' || !r.source)
    return (
      <Callout tone={r.status === 'invalid' ? 'info' : 'warning'}>
        {r.reason ?? 'Could not resolve that reference.'}
        {r.ref?.kind === 'repo' ? ' Pick a pull request or commit with Browse, or paste a PR or commit URL.' : null}
      </Callout>
    )
  const s = r.source
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-ctl border border-needle/40 bg-needle-soft/50 px-3 py-2.5">
      <GitCommitHorizontal size={16} aria-hidden className="shrink-0 text-needle" />
      <div className="min-w-0 flex-1">
        <p className="mono-cond truncate text-[12px]">
          {s.owner}/{s.repo}@{s.commit.sha}
        </p>
        <p className="truncate text-[12.5px] text-muted">
          {r.pull ? (
            <>
              PR #{r.pull.number} <span className="text-bark">{r.pull.title}</span> ({r.pull.state}), head commit
            </>
          ) : (
            <span>{firstLine(s.commit.message)}</span>
          )}
        </p>
      </div>
      {sameAsPinned ? (
        <span className="text-[12.5px] font-medium text-needle">Pinned</span>
      ) : (
        <Button variant="primary" size="sm" onClick={() => onPin(s)}>
          <Pin size={13} aria-hidden /> Pin this commit <Kbd className="border-needle-ink/30 bg-transparent text-needle-ink/80 shadow-none">↵</Kbd>
        </Button>
      )}
    </div>
  )
}

function PinnedSource({ source }: { source: SourceRef }) {
  const { c, disabled } = useComposerCtx()
  return (
    <div id={fieldId('source.commit.sha')} className="overflow-hidden rounded-ctl border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5">
        <Pin size={12} aria-hidden className="text-needle" />
        <span className="stretch-cond text-[12.5px] font-semibold">Pinned commit</span>
        {!disabled ? (
          <button
            type="button"
            onClick={() => c.update((d) => ({ ...d, source: undefined }))}
            className="ml-auto flex items-center gap-1 rounded-chip px-1 text-[12px] text-muted hover:text-flare"
          >
            <X size={12} aria-hidden /> Unpin
          </button>
        ) : (
          <span className="ml-auto text-[12px] text-slate">frozen</span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-3 py-2.5 text-[13px]">
        <dt className="text-muted">Repository</dt>
        <dd>
          <ExternalLink href={`https://github.com/${source.owner}/${source.repo}`} className="mono-cond text-[12px]">
            {source.owner}/{source.repo}
          </ExternalLink>
          {source.license ? <span className="ml-2 text-xs text-muted">{source.license}</span> : null}
        </dd>
        {source.pullRequest ? (
          <>
            <dt className="text-muted">Pull request</dt>
            <dd className="min-w-0">
              <ExternalLink href={source.pullRequest.htmlUrl}>
                #{source.pullRequest.number}
              </ExternalLink>{' '}
              <span className="wrap-anywhere">{source.pullRequest.title}</span>
              <span className="ml-1.5 text-xs text-muted">
                by {source.pullRequest.author}, {source.pullRequest.state}
              </span>
            </dd>
          </>
        ) : null}
        <dt className="text-muted">Commit</dt>
        <dd className="mono-cond wrap-anywhere text-[12px]">
          <ExternalLink href={source.commit.htmlUrl} icon={false} className="text-bark hover:text-needle">
            {source.commit.sha}
          </ExternalLink>
        </dd>
        <dt className="text-muted">Message</dt>
        <dd className="wrap-anywhere line-clamp-3 whitespace-pre-wrap text-[13px]">{source.commit.message}</dd>
        <dt className="text-muted">Author</dt>
        <dd className="text-[13px]">
          {source.commit.author} <span className="text-muted">{formatDate(source.commit.committedAt, 'utc')}</span>
        </dd>
      </dl>
    </div>
  )
}

function PullCommitPicker({ source, onPin }: { source: SourceRef; onPin: (s: SourceRef) => void }) {
  const pr = source.pullRequest!
  const commits = useGitHubPullCommits(source.owner, source.repo, pr.number)
  const list = [...(commits.data ?? [])].reverse()
  if (commits.isLoading) return <Skeleton className="h-20 w-full" />
  if (list.length < 2) return null
  return (
    <fieldset className="min-w-0">
      <legend className="stretch-cond mb-1.5 text-[13px] font-medium">Commit on this pull request</legend>
      <p className="mb-2 text-xs text-muted">The head commit is pinned by default. Choose an earlier commit to make a claim about that exact state instead.</p>
      <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-ctl border border-line">
        {list.map((cm, i) => {
          const checked = cm.sha.toLowerCase() === source.commit.sha.toLowerCase()
          return (
            <li key={cm.sha}>
              <label className={cn('flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-frost', checked && 'bg-needle-soft/50')}>
                <input
                  type="radio"
                  name="pr-commit"
                  checked={checked}
                  onChange={() =>
                    onPin({
                      ...source,
                      commit: {
                        sha: cm.sha.toLowerCase(),
                        message: cm.message,
                        author: cm.author.login ?? cm.author.name,
                        committedAt: cm.author.date,
                        htmlUrl: cm.htmlUrl,
                      },
                    })
                  }
                  className="mt-1 accent-[var(--needle)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="mono-cond text-[11.5px]">{shortSha(cm.sha)}</span>
                  {i === 0 ? <span className="ml-2 rounded-chip bg-sunken px-1 text-[11px] text-muted">head</span> : null}
                  <span className="wrap-anywhere ml-2 text-[13px]">{firstLine(cm.message)}</span>
                  <span className="block text-[11.5px] text-muted">
                    {cm.author.login ?? cm.author.name}, {formatRelative(cm.author.date)}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

function BaseCommit({ source }: { source: SourceRef }) {
  const { c, err, touch, disabled } = useComposerCtx()
  const regression = !!c.draft.spec.regressionOnly
  const [manual, setManual] = React.useState(source.baseCommit?.sha ?? '')
  return (
    <div className="flex flex-col gap-2">
      <Checkbox
        id="regression-only"
        checked={regression}
        disabled={disabled}
        onChange={(v) => {
          c.update({ spec: { regressionOnly: v } })
          touch('source.baseCommit')
        }}
        label="Only regressions relative to a base commit qualify"
        description="Use this for a bug-fix or refactor claim: a counterexample must fail on the pinned commit but not on the base."
      />
      {regression || source.baseCommit ? (
        <Field
          label="Base commit"
          htmlFor={fieldId('source.baseCommit')}
          error={err('source.baseCommit')}
          hint={source.pullRequest ? 'Taken from the pull request base. Edit only if the comparison point differs.' : 'Full 40-character SHA of the commit to compare against.'}
        >
          <Input
            id={fieldId('source.baseCommit')}
            mono
            value={manual}
            disabled={disabled}
            onBlur={() => touch('source.baseCommit')}
            aria-invalid={!!err('source.baseCommit')}
            onChange={(e) => {
              const v = e.target.value.trim()
              setManual(v)
              c.update((d) =>
                d.source
                  ? {
                      ...d,
                      source: {
                        ...d.source,
                        baseCommit: v ? { sha: v.toLowerCase(), htmlUrl: `https://github.com/${d.source.owner}/${d.source.repo}/commit/${v.toLowerCase()}` } : undefined,
                      },
                    }
                  : d,
              )
            }}
            placeholder="40-character SHA"
          />
        </Field>
      ) : null}
    </div>
  )
}

/** Miller columns: repositories → pull requests (or default branch) → commits. */
function BrowseDialog({ open, onOpenChange, onPin }: { open: boolean; onOpenChange: (o: boolean) => void; onPin: (s: SourceRef) => void }) {
  const repos = useGitHubViewerRepos({ limit: 50 })
  const [repo, setRepo] = React.useState<RepoSummary | null>(null)
  const [pull, setPull] = React.useState<PullSummary | 'branch' | null>(null)
  const pulls = useGitHubPulls(repo?.owner, repo?.name, 'all')
  const prCommits = useGitHubPullCommits(repo?.owner, repo?.name, pull && pull !== 'branch' ? pull.number : undefined)
  const branchCommits = useGitHubCommits(repo?.owner, repo?.name, pull === 'branch' ? repo?.defaultBranch : undefined)
  const commits: CommitSummary[] = (pull === 'branch' ? branchCommits.data : prCommits.data) ?? []
  const col = 'scrollbar-thin min-h-0 overflow-y-auto border-line'
  const item = (active: boolean) =>
    cn('flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left hover:bg-frost', active && 'bg-needle-soft/60')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Browse repositories" description="Public repositories only. Pick a pull request or branch, then the exact commit." className="w-[min(980px,calc(100vw-24px))]">
        <div className="grid h-[min(60vh,520px)] grid-cols-1 md:grid-cols-3 md:divide-x md:divide-line">
          <div className={cn(col, repo && 'hidden md:block')}>
            {repos.isLoading ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              (repos.data?.items ?? []).map((rp) =>
                rp.private ? (
                  <div key={rp.id} className="flex flex-col items-start gap-0.5 border-b border-line px-3 py-2 opacity-70">
                    <span className="mono-cond text-[12px] text-muted">{rp.fullName}</span>
                    <span className="text-[12px] text-muted">Private. Pine verifies public repositories only.</span>
                  </div>
                ) : (
                  <button key={rp.id} type="button" className={item(repo?.id === rp.id)} onClick={() => { setRepo(rp); setPull(null) }}>
                    <span className="mono-cond text-[12px]">{rp.fullName}</span>
                    <span className="line-clamp-1 text-[12px] text-muted">{rp.description ?? 'No description'}</span>
                  </button>
                ),
              )
            )}
          </div>
          <div className={cn(col, (!repo || pull) && 'hidden md:block')}>
            {repo ? (
              <>
                <button type="button" className="px-3 py-1.5 text-xs text-needle md:hidden" onClick={() => setRepo(null)}>
                  Back to repositories
                </button>
                <button type="button" className={item(pull === 'branch')} onClick={() => setPull('branch')}>
                  <span className="text-[13px] font-medium">Default branch</span>
                  <span className="mono-cond text-[11.5px] text-muted">{repo.defaultBranch}</span>
                </button>
                {pulls.isLoading ? <Skeleton className="m-3 h-8" /> : null}
                {(pulls.data ?? []).map((p) => (
                  <button key={p.number} type="button" className={item(pull !== 'branch' && pull?.number === p.number)} onClick={() => setPull(p)}>
                    <span className="flex items-center gap-1.5 text-[13px]">
                      <GitPullRequest size={12} aria-hidden className={p.state === 'open' ? 'text-needle' : 'text-muted'} />#{p.number}
                      <span className="text-[11px] text-muted">{p.state}</span>
                    </span>
                    <span className="wrap-anywhere line-clamp-2 text-[12.5px]">{p.title}</span>
                  </button>
                ))}
              </>
            ) : (
              <p className="p-4 text-sm text-muted">Choose a repository.</p>
            )}
          </div>
          <div className={cn(col, !pull && 'hidden md:block')}>
            {pull ? (
              <>
                <button type="button" className="px-3 py-1.5 text-xs text-needle md:hidden" onClick={() => setPull(null)}>
                  Back to pull requests
                </button>
                {(pull === 'branch' ? branchCommits.isLoading : prCommits.isLoading) ? <Skeleton className="m-3 h-8" /> : null}
                {[...commits].reverse().map((cm) => (
                  <div key={cm.sha} className="flex items-start gap-2 border-b border-line px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <span className="mono-cond text-[11.5px]">{shortSha(cm.sha)}</span>
                      <p className="wrap-anywhere line-clamp-2 text-[12.5px]">{firstLine(cm.message)}</p>
                      <p className="text-[11px] text-muted">{formatRelative(cm.author.date)}</p>
                    </div>
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => repo && onPin(toSourceRef({ repo, commit: cm, pull: pull === 'branch' ? null : pull }))}
                    >
                      Pin
                    </Button>
                  </div>
                ))}
              </>
            ) : (
              <p className="p-4 text-sm text-muted">Choose a pull request or the default branch.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
