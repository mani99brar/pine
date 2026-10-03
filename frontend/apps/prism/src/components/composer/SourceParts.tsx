'use client'

import type { ReactNode } from 'react'
import type { SourceRef } from '@pine/core'
import { formatDate, shortSha } from '@pine/core'
import { GitBranch, GitCommitHorizontal, GitPullRequest } from 'lucide-react'
import { motion } from 'motion/react'
import { useReduceMotion } from '@/lib/hooks'
import { cn } from '@/lib/cn'

/** The SHA settles into place character by character when pinned. */
export function PinnedSha({ sha, animate }: { sha: string; animate: boolean }) {
  const reduce = useReduceMotion()
  return (
    <p className="t-code flex flex-wrap gap-x-[0.5em] gap-y-1 text-[1.02rem] leading-[1.4] sm:text-[1.12rem]" aria-label={`Commit ${sha}`}>
      {(sha.match(/.{1,4}/g) ?? []).map((g, gi) => (
        <span key={gi} className="whitespace-nowrap" aria-hidden>
          {g.split('').map((ch, ci) => {
            const idx = gi * 4 + ci
            return (
              <motion.span
                key={ci}
                className={cn('inline-block', idx < 7 ? 'font-semibold text-lumen' : 'text-lumen-2')}
                initial={animate && !reduce ? { opacity: 0, y: -6, filter: 'blur(4px)' } : false}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{ delay: idx * 0.018, duration: 0.3 }}
              >
                {ch}
              </motion.span>
            )
          })}
        </span>
      ))}
    </p>
  )
}

export function SourceCard({ source, children }: { source: SourceRef; children?: ReactNode }) {
  const first = (source.commit.message ?? '').split('\n')[0] ?? ''
  return (
    <div className="glass cut-lg overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-4 py-3 text-[0.875rem]">
        <span className="inline-flex items-center gap-1.5 font-semibold text-lumen">
          <GitBranch size={15} aria-hidden /> {source.owner}/{source.repo}
        </span>
        {source.license && <span className="text-lumen-3">{source.license}</span>}
        {source.pullRequest && (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-lumen-2">
            <GitPullRequest size={14} aria-hidden />
            <span className="untrusted line-clamp-1 [white-space:normal]">
              #{source.pullRequest.number} {source.pullRequest.title}
            </span>
          </span>
        )}
      </div>
      <div className="px-4 py-4">
        <p className="flex items-start gap-2 text-[0.9375rem] text-lumen">
          <GitCommitHorizontal size={16} aria-hidden className="mt-0.5 shrink-0 text-lumen-3" />
          {/* Commit messages are untrusted text */}
          <span className="untrusted min-w-0 font-semibold [white-space:normal]">{first || '(no commit message)'}</span>
        </p>
        <p className="mt-1 pl-6 text-[0.8125rem] text-lumen-3">
          {source.commit.author} {source.commit.committedAt ? `committed ${formatDate(source.commit.committedAt, 'long')}` : 'committed this'}
        </p>
        <div className="mt-4">{children}</div>
        {source.baseCommit && (
          <p className="mt-3 text-[0.8125rem] text-lumen-3">
            Base commit <code className="t-code text-lumen-2">{shortSha(source.baseCommit.sha)}</code> is pinned too, for regression-only claims.
          </p>
        )}
      </div>
    </div>
  )
}
