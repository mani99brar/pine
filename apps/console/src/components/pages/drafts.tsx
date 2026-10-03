'use client'

import * as React from 'react'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ClaimDraft } from '@pine/core'
import { formatClaimNumber, formatRelative, shortSha } from '@pine/core'
import { useClaims, useDrafts, useWallet } from '@pine/react'
import { cn } from '@/lib/cn'
import { useAccountSafe } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Pane } from '@/components/ui/pane'
import { SkeletonRows } from '@/components/ui/skeleton'
import { StatusDot } from '@/components/claim/status'

const STAGE_LABEL: Record<ClaimDraft['stage'], string> = {
  source: 'Source',
  policy: 'Policy',
  claim: 'Claim',
  deadlines: 'Deadlines',
  funding: 'Funding',
  review: 'Review',
  publish: 'Publishing',
}

function PublicationTicks({ d }: { d: ClaimDraft }) {
  const steps = d.publication?.steps ?? []
  if (!steps.length) return null
  return (
    <span className="flex items-center gap-1" aria-label={`${steps.filter((s) => s.status === 'confirmed').length} of ${steps.length} steps confirmed`}>
      {steps.map((s) => (
        <span
          key={s.id}
          title={`${s.id}: ${s.status}`}
          className={cn('h-3 w-[3px] rounded-full', s.status === 'confirmed' ? 'bg-bark' : s.status === 'failed' ? 'bg-flare' : s.status === 'pending' || s.status === 'awaiting_signature' ? 'bg-resin-fill' : 'bg-line-strong')}
        />
      ))}
    </span>
  )
}

export function Drafts() {
  const { drafts, remove, isLoading } = useDrafts()
  const wallet = useWallet()
  const { account } = useAccountSafe()
  const claims = useClaims({ status: ['publishing', 'failed'], limit: 50 })
  const sorted = [...drafts].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const inProgress = sorted.filter((d) => d.publication?.steps?.some((s) => s.status !== 'idle'))
  const plain = sorted.filter((d) => !inProgress.includes(d))
  const partial = (claims.data?.items ?? []).filter(
    (c) => (wallet.address && c.creator.toLowerCase() === wallet.address.toLowerCase()) || (!!account && c.creatorGithub === account.github.login),
  )

  const del = async (d: ClaimDraft) => {
    if (!window.confirm(`Delete the draft “${d.spec.title || 'untitled'}”? Anything already published on-chain stays there.`)) return
    await remove(d.id)
    toast.success('Draft deleted')
  }

  const row = (d: ClaimDraft) => (
    <li key={d.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-frost sm:px-6">
      <Link href={`/new?draft=${encodeURIComponent(d.id)}`} className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium">{d.spec.title || <span className="text-muted">Untitled draft</span>}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
          {d.source ? (
            <span className="mono-cond text-[11.5px]">
              {d.source.owner}/{d.source.repo}@{shortSha(d.source.commit.sha)}
            </span>
          ) : (
            <span>No commit pinned</span>
          )}
          {d.spec.policyId ? <span className="mono-cond text-[11.5px]">{d.spec.policyId}</span> : null}
          <span>at {STAGE_LABEL[d.stage]}</span>
          <span>edited {formatRelative(d.updatedAt)}</span>
          <PublicationTicks d={d} />
        </span>
      </Link>
      <Button asChild size="sm" variant={d.publication?.steps?.length ? 'primary' : 'secondary'}>
        <Link href={`/new?draft=${encodeURIComponent(d.id)}`}>{d.publication?.steps?.length ? 'Resume publishing' : 'Continue'}</Link>
      </Button>
      <button type="button" onClick={() => void del(d)} className="rounded-chip p-1.5 text-faint hover:bg-sunken hover:text-flare" aria-label={`Delete draft ${d.spec.title || d.id}`}>
        <Trash2 size={14} aria-hidden />
      </button>
    </li>
  )

  return (
    <div>
      <PageHeader
        title="Drafts and publications"
        description="Drafts autosave in this browser as you type. A publication that stopped part-way resumes from its first incomplete step."
        actions={
          <Button asChild variant="primary" kbd="n">
            <Link href="/new">New verification</Link>
          </Button>
        }
      />
      <div className="divide-y divide-line bg-surface">
        <Pane title="Publishing in progress" className="border-0" description="Steps already confirmed stay on-chain">
          {isLoading ? (
            <SkeletonRows rows={2} />
          ) : inProgress.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-6">No publication is in progress in this browser.</p>
          ) : (
            <ul className="divide-y divide-line">{inProgress.map(row)}</ul>
          )}
        </Pane>
        <Pane title="Claims that need recovery" className="border-0" description="Partially published or failed on-chain">
          {claims.isLoading ? (
            <SkeletonRows rows={2} />
          ) : partial.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted sm:px-6">
              {wallet.isConnected || account ? 'None of your claims need recovery.' : 'Connect a wallet or sign in to see your partially published claims.'}{' '}
              <Link href="/claims?view=recovery" className="text-needle hover:underline">
                All claims needing recovery
              </Link>
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {partial.map((c) => (
                <li key={c.id}>
                  <Link href={`/claims/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-frost sm:px-6">
                    <StatusDot status={c.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{c.title}</span>
                      <span className="mono-cond block text-[11.5px] text-muted">
                        {formatClaimNumber(c.number)} {c.source.owner}/{c.source.repo}@{shortSha(c.source.commitSha)}
                      </span>
                    </span>
                    <span className={cn('text-[12.5px] font-medium', c.status === 'failed' ? 'text-flare' : 'text-resin')}>
                      {c.status === 'failed' ? 'Failed: see what reached the chain' : 'Finish publishing'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Pane>
        <Pane title="Drafts" className="border-0">
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : plain.length === 0 ? (
            <EmptyState
              title="No drafts yet"
              action={
                <Button asChild variant="secondary">
                  <Link href="/new">Start a verification</Link>
                </Button>
              }
            >
              Paste a GitHub pull request into the command palette (⌘K) to start a draft pinned to its head commit.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">{plain.map(row)}</ul>
          )}
        </Pane>
      </div>
    </div>
  )
}
