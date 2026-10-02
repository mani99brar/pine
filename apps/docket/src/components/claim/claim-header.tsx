import Link from 'next/link'
import type { ClaimDetail } from '@pine/core'
import { formatClaimNumber, formatDate, shortSha } from '@pine/core'
import { GitCommitHorizontal, GitPullRequest, ScrollText } from 'lucide-react'
import { StageTag } from '@/components/ui/stage'
import { Breadcrumbs } from '@/components/ui/layout'
import { ExternalLink } from '@/components/ui/external-link'
import { ClaimActions } from './claim-actions'

export function ClaimHeader({ claim }: { claim: ClaimDetail }) {
  const number = formatClaimNumber(claim.number)
  const s = claim.source
  const repoUrl = `https://github.com/${s.owner}/${s.repo}`
  return (
    <header className="mb-8">
      <Breadcrumbs items={[{ href: '/docket', label: 'Docket' }, { label: number }]} />
      <p className="print-only mb-4 border-b-2 border-ink pb-2 text-sm">
        Pine Docket: filing record {number}. This printout reproduces the public record; the binding terms are the hashed manifest.
      </p>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 max-w-[52rem]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-lg font-[800] tracking-tight text-violet tabular">{number}</span>
            <StageTag status={claim.status} outcome={claim.outcome} short={false} />
            {claim.sponsored ? (
              <span className="rounded-xs border border-rule bg-sheet px-1.5 py-0.5 text-sm font-bold text-graphite">Sponsored</span>
            ) : null}
          </div>
          <h1 className="record-title untrusted mt-3 text-[1.9rem] leading-[2.35rem] sm:text-[2.35rem] sm:leading-[2.85rem]">
            {claim.title}
          </h1>
          <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[15px] text-graphite">
            <li className="flex items-center gap-1.5">
              <GitCommitHorizontal aria-hidden className="size-4" />
              <ExternalLink href={repoUrl} icon={false} className="text-ink!">
                {s.owner}/{s.repo}
              </ExternalLink>
              <span>at</span>
              <code className="font-mono text-[14px] text-ink">{shortSha(s.commitSha)}</code>
            </li>
            {s.prNumber ? (
              <li className="flex min-w-0 items-center gap-1.5">
                <GitPullRequest aria-hidden className="size-4 shrink-0" />
                <span className="untrusted truncate">
                  PR #{s.prNumber}
                  {s.prTitle ? `: ${s.prTitle}` : ''}
                </span>
              </li>
            ) : null}
            <li className="flex items-center gap-1.5">
              <ScrollText aria-hidden className="size-4" />
              <Link href={`/policies/${claim.policy.id}?version=${claim.policy.version}`} className="link text-ink!">
                {claim.policy.id}@{claim.policy.version}
              </Link>
              <span className="hidden sm:inline">{claim.policy.title}</span>
            </li>
            <li>
              Filed <time dateTime={claim.createdAt}>{formatDate(claim.createdAt, 'short')}</time>
              {claim.creatorGithub ? <> by {claim.creatorGithub}</> : null}
            </li>
          </ul>
        </div>
        <ClaimActions claim={claim} />
      </div>
    </header>
  )
}
