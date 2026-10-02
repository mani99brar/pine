'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { CommitSummary, SourceRef } from '@pine/core'
import { formatDate, shortSha } from '@pine/core'
import { COPY } from '@pine/core/copy'
import { fixtures } from '@pine/data/fixtures'
import { toSourceRef, useGitHubPullCommits, usePine, useResolveGitHubInput, type ClaimComposer } from '@pine/react'
import { GitBranch, GitCommitHorizontal, GitPullRequest, Lock, LockOpen, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Note } from '@/components/ui/primitives'
import { Select } from '@/components/ui/form'
import { StageHeader, StageIssues, StageNav } from './shared'
import { cn } from '@/lib/cn'

/**
 * The SHA locking in: 40 characters in groups of four. When `locking` flips on, characters settle one
 * by one (staggered), and the padlock closes. The first seven characters (the short SHA) are emphasized.
 */
export function PinnedSha({ sha, locked, animate }: { sha: string; locked: boolean; animate?: boolean }) {
  const groups = sha.match(/.{1,4}/g) ?? []
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] transition-colors duration-300',
          locked ? 'bg-ink text-on-ink' : 'border-[1.5px] border-dashed border-ink-3 text-ink-3',
        )}
      >
        {locked ? <Lock size={16} /> : <LockOpen size={16} />}
      </span>
      <p className="t-code flex flex-wrap gap-x-[0.55em] gap-y-1 text-[1.05rem] leading-[1.35] sm:text-[1.2rem]" aria-label={`Commit ${sha}${locked ? ', pinned' : ''}`}>
        {groups.map((g, gi) => (
          <span key={gi} className="whitespace-nowrap">
            {g.split('').map((ch, ci) => {
              const idx = gi * 4 + ci
              return (
                <span
                  key={ci}
                  aria-hidden
                  className={cn('inline-block', idx < 7 ? 'font-[700] text-ink' : locked ? 'text-ink-2' : 'text-ink-3')}
                  style={animate ? { animation: `lock-in 260ms cubic-bezier(.2,.8,.2,1) ${idx * 22}ms backwards` } : undefined}
                >
                  {ch}
                </span>
              )
            })}
          </span>
        ))}
      </p>
    </div>
  )
}

function SourceCard({ source, commit, children }: { source: SourceRef; commit?: CommitSummary; children?: React.ReactNode }) {
  const firstLine = (source.commit.message ?? '').split('\n')[0] ?? ''
  return (
    <div className="rounded-[var(--radius-tile)] border-[1.5px] border-ink bg-sheet">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-[0.88rem]">
        <span className="inline-flex items-center gap-1.5 font-[650]">
          <GitBranch size={15} aria-hidden />
          {source.owner}/{source.repo}
        </span>
        {source.license && <span className="text-ink-3">{source.license}</span>}
        {source.pullRequest && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-ink-2">
            <GitPullRequest size={14} aria-hidden />
            <span className="untrusted line-clamp-1 [white-space:normal]">
              #{source.pullRequest.number} {source.pullRequest.title}
            </span>
          </span>
        )}
      </div>
      <div className="px-4 py-4">
        <p className="flex items-start gap-2 text-[0.92rem]">
          <GitCommitHorizontal size={16} aria-hidden className="mt-0.5 shrink-0" />
          <span className="untrusted min-w-0 font-[600] [white-space:normal]">{firstLine || '(no commit message)'}</span>
        </p>
        <p className="mt-1 pl-6 text-[0.8rem] text-ink-3">
          {source.commit.author} committed {formatDate(source.commit.committedAt, 'long')}
          {commit?.stats && (
            <>
              , <span className="t-figure text-[0.9rem] text-ink-2">+{commit.stats.additions}</span> <span className="t-figure text-[0.9rem] text-ink-2">−{commit.stats.deletions}</span>
            </>
          )}
        </p>
        <div className="mt-4">{children}</div>
        {source.baseCommit && (
          <p className="mt-3 text-[0.8rem] text-ink-3">
            Base commit <code className="t-code text-ink-2">{shortSha(source.baseCommit.sha)}</code> is pinned too, for regression-only claims.
          </p>
        )}
      </div>
    </div>
  )
}

export function StageSource({ c, initialInput }: { c: ClaimComposer; initialInput?: string }) {
  const { demo } = usePine()
  const [input, setInput] = useState(initialInput ?? '')
  const [justPinned, setJustPinned] = useState(false)
  const resolved = useResolveGitHubInput(input)
  const pinned = c.draft.source
  const prCommitsQ = useGitHubPullCommits(resolved.repo?.owner, resolved.repo?.name, resolved.pull?.number)
  const [altSha, setAltSha] = useState<string>('')

  const candidate: SourceRef | undefined = useMemo(() => {
    if (!resolved.source) return undefined
    if (altSha && resolved.repo) {
      const alt = prCommitsQ.data?.find((x) => x.sha === altSha)
      if (alt) return toSourceRef({ repo: resolved.repo, commit: alt, pull: resolved.pull })
    }
    return resolved.source
  }, [resolved.source, resolved.repo, resolved.pull, altSha, prCommitsQ.data])

  const examples = useMemo(() => {
    if (!demo) return []
    const out: string[] = []
    for (const r of fixtures.repos.slice(0, 6)) {
      const p = (fixtures.pulls[r.fullName] ?? []).find((x) => x.state === 'open')
      if (p) out.push(`https://github.com/${r.fullName}/pull/${p.number}`)
      if (out.length >= 3) break
    }
    return out
  }, [demo])

  const pin = () => {
    if (!candidate) return
    c.update({ source: candidate })
    setJustPinned(true)
  }

  if (pinned && !justPinned && !input) {
    return (
      <div>
        <StageHeader stage="source">The claim is about this exact commit and nothing else. New commits on the pull request need a new claim.</StageHeader>
        <SourceCard source={pinned}>
          <PinnedSha sha={pinned.commit.sha} locked />
        </SourceCard>
        {!c.frozen ? (
          <Button variant="quiet" className="mt-4" onClick={() => setInput(`${pinned.owner}/${pinned.repo}`)}>
            Pin a different commit
          </Button>
        ) : (
          <Note className="mt-4" icon={<Lock size={15} aria-hidden />}>
            {COPY.frozenTerms}
          </Note>
        )}
        <StageIssues c={c} stage="source" className="mt-5" />
        <StageNav c={c} />
      </div>
    )
  }

  return (
    <div>
      <StageHeader stage="source">
        Paste a pull request, a commit URL or <code className="t-code">owner/repo#12</code>. Pine looks it up on GitHub (public repositories only) and pins the full 40-character SHA.
      </StageHeader>

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
          <Search size={20} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            id="source-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setJustPinned(false)
              setAltSha('')
            }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="https://github.com/owner/repo/pull/12"
            aria-describedby="source-status"
            className="h-16 w-full rounded-[6px] border-2 border-ink bg-sheet pl-12 pr-4 font-mono text-[1rem] placeholder:font-sans placeholder:text-ink-3 focus:outline-none focus-visible:shadow-[0_0_0_4px_var(--lumen)] sm:text-[1.1rem]"
          />
        </div>
      </form>
      {examples.length > 0 && !input && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.84rem] text-ink-3">
          <span>Try a demo pull request:</span>
          {examples.map((ex) => (
            <button key={ex} type="button" onClick={() => setInput(ex)} className="rounded-full border border-line-strong bg-sheet px-2.5 py-1 font-mono text-[0.78rem] text-ink-2 hover:border-ink hover:text-ink">
              {ex.replace('https://github.com/', '')}
            </button>
          ))}
        </div>
      )}

      <div id="source-status" className="mt-6" aria-live="polite">
        {resolved.status === 'empty' ? (
          <p className="text-[0.9rem] text-ink-2">
            Or{' '}
            <Link href="/repos" className="font-[620] underline underline-offset-[3px]">
              browse your repositories
            </Link>{' '}
            and pick a commit from a pull request.
          </p>
        ) : resolved.status === 'loading' ? (
          <div className="rounded-[var(--radius-tile)] border border-dashed border-line-strong p-5">
            <p className="text-[0.9rem] text-ink-2">Looking it up on GitHub…</p>
            <div className="mt-3 grid gap-2">
              <span className="skeleton h-4 w-1/2" />
              <span className="skeleton h-6 w-full" />
            </div>
          </div>
        ) : resolved.status === 'resolved' && candidate ? (
          <SourceCard source={candidate} commit={resolved.commit}>
            <PinnedSha key={`${candidate.commit.sha}-${justPinned}`} sha={candidate.commit.sha} locked={justPinned && pinned?.commit.sha === candidate.commit.sha} animate={justPinned} />
            {resolved.pull && (prCommitsQ.data?.length ?? 0) > 1 && !justPinned && (
              <label className="mt-4 flex flex-wrap items-center gap-2 text-[0.84rem] text-ink-2">
                Pin a different commit from this pull request
                <Select value={altSha} onChange={(e) => setAltSha(e.target.value)} className="h-9 w-auto max-w-full text-[0.84rem]">
                  <option value="">Head commit (latest)</option>
                  {prCommitsQ.data!.map((cm) => (
                    <option key={cm.sha} value={cm.sha}>
                      {shortSha(cm.sha)} {(cm.message.split('\n')[0] ?? '').slice(0, 60)}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              {justPinned && pinned?.commit.sha === candidate.commit.sha ? (
                <>
                  <p className="inline-flex items-center gap-2 font-[650]">
                    <Lock size={15} aria-hidden /> Pinned. This exact commit is what the claim is about.
                  </p>
                  <Button onClick={() => c.setStage('policy')}>Continue to policy</Button>
                </>
              ) : (
                <Button onClick={pin} disabled={c.frozen} icon={<Lock size={15} aria-hidden />}>
                  Pin this commit
                </Button>
              )}
            </div>
            {resolved.pull && !altSha && <p className="mt-3 text-[0.8rem] text-ink-3">This is the pull request&apos;s head commit right now. Later pushes are not covered by this claim.</p>}
          </SourceCard>
        ) : (
          <Note tone="caution" title={resolved.status === 'rate_limited' ? 'GitHub rate limit reached' : resolved.status === 'not_found' ? 'Not found' : 'That reference did not resolve'}>
            {resolved.reason ?? 'Check the URL and try again.'}
          </Note>
        )}
      </div>

      <StageIssues c={c} stage="source" className="mt-6" />
      <StageNav c={c} />
    </div>
  )
}
