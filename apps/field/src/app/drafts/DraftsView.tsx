'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDraft } from '@pine/core'
import { formatClaimNumber, formatRelative, shortSha } from '@pine/core'
import { isDraftFrozen, useClaims, useDrafts, useWallet } from '@pine/react'
import { Lock, Plus, Trash2, Wrench } from 'lucide-react'
import { STAGES, stageIndex } from '@/components/composer/shared'
import { PolicyMark } from '@/components/glyphs/PolicyMark'
import { StatusPill } from '@/components/glyphs/Status'
import { Button, ButtonLink } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { SectionHeading, Skeleton } from '@/components/ui/primitives'
import { useNowMs } from '@/lib/now'
import { cn } from '@/lib/cn'

function StageRope({ draft }: { draft: ClaimDraft }) {
  const cur = stageIndex(draft.stage)
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label={`At step ${cur + 1} of ${STAGES.length}: ${STAGES[cur]?.label}`}>
      {STAGES.map((s, i) => (
        <span key={s.id} className={cn('h-[5px] w-5 rounded-[1px]', i < cur ? 'bg-ink' : i === cur ? 'bg-ink shadow-[0_0_0_2px_var(--lumen)]' : 'bg-line-strong')} />
      ))}
    </div>
  )
}

function DraftRow({ d, onRemove }: { d: ClaimDraft; onRemove: (id: string) => void }) {
  const now = useNowMs()
  const [confirm, setConfirm] = useState(false)
  const pub = d.publication
  const confirmed = pub?.steps.filter((s) => s.status === 'confirmed').length ?? 0
  const failed = pub?.steps.find((s) => s.status === 'failed')
  const frozen = isDraftFrozen(d)
  const family = (d.spec.policyId?.split('-')[0] ?? 'FUNC') as 'FUNC' | 'BOT' | 'SC'
  return (
    <li className="grid gap-4 rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8rem] text-ink-3">
          {d.spec.policyId ? <PolicyMark family={family} code={`${d.spec.policyId}@${d.spec.policyVersion ?? ''}`} size={13} /> : <span>No policy yet</span>}
          {d.source && (
            <span>
              {d.source.owner}/{d.source.repo} <code className="t-code text-ink-2">@{shortSha(d.source.commit.sha)}</code>
            </span>
          )}
          <span>edited {now === null ? '' : formatRelative(d.updatedAt, new Date(now))}</span>
        </div>
        <p className="mt-1 truncate text-[1.02rem] font-[650]">{d.spec.title?.trim() || 'Untitled claim'}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <StageRope draft={d} />
          <span className="text-[0.8rem] text-ink-2">{STAGES[stageIndex(d.stage)]?.label}</span>
          {pub && (
            <span className={cn('inline-flex items-center gap-1.5 text-[0.8rem] font-[600]', failed ? 'text-flare-ink' : 'text-ink-2')}>
              {frozen && <Lock size={12} aria-hidden />}
              {confirmed} of {Math.max(pub.steps.length, confirmed)} publication steps confirmed{failed ? `, ${failed.id.replace(/_/g, ' ')} failed` : ''}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ButtonLink href={`/compose?draft=${encodeURIComponent(d.id)}`} variant={pub ? 'primary' : 'secondary'} size="sm" icon={pub ? <Wrench size={14} aria-hidden /> : undefined}>
          {pub ? 'Finish publishing' : 'Resume'}
        </ButtonLink>
        {!frozen &&
          (confirm ? (
            <>
              <Button size="sm" variant="danger" onClick={() => onRemove(d.id)}>
                Delete draft
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)} aria-label={`Delete ${d.spec.title || 'untitled draft'}`} icon={<Trash2 size={14} aria-hidden />}>
              <span className="sr-only sm:not-sr-only">Delete</span>
            </Button>
          ))}
      </div>
    </li>
  )
}

export function DraftsView() {
  const { drafts, isLoading, error, remove, refetch } = useDrafts()
  const wallet = useWallet()
  const publishing = useClaims({ status: ['publishing', 'failed'], limit: 50 })
  const mine = (publishing.data?.items ?? []).filter((c) => !wallet.address || c.creator.toLowerCase() === wallet.address.toLowerCase() || wallet.isDemo)
  const inProgress = drafts.filter((d) => d.publication && d.publication.steps.length > 0)
  const plain = drafts.filter((d) => !d.publication || d.publication.steps.length === 0)

  return (
    <div className="mx-auto max-w-[1320px] px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      <SectionHeading
        as="h1"
        title="Drafts and publications"
        description="Drafts save as you type. A publication that stopped part-way is listed here until it is finished, and resumes from the first incomplete step."
        action={
          <ButtonLink href="/compose" icon={<Plus size={16} aria-hidden />}>
            Put a claim on the board
          </ButtonLink>
        }
      />

      {error ? (
        <ErrorState className="mt-8" title="Drafts could not be loaded" error={error} onRetry={refetch} />
      ) : isLoading ? (
        <div className="mt-8 grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <section className="mt-10" aria-labelledby="inprog">
            <h2 id="inprog" className="t-h2">
              Publications in progress
            </h2>
            {inProgress.length === 0 && mine.length === 0 ? (
              <p className="mt-3 text-ink-2">Nothing is half-published. Every publication you start is tracked here until its last step confirms.</p>
            ) : (
              <ul className="mt-4 grid gap-3">
                {inProgress.map((d) => (
                  <DraftRow key={d.id} d={d} onRemove={(id) => void remove(id)} />
                ))}
                {mine.map((c) => (
                  <li key={c.id} className="grid gap-3 rounded-[var(--radius-tile)] border border-line bg-sheet p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3 text-[0.8rem] text-ink-3">
                        <span className="t-figure text-[0.88rem] text-ink-2">{formatClaimNumber(c.number)}</span>
                        <StatusPill status={c.status} size="sm" />
                        <span>
                          {c.source.owner}/{c.source.repo}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-[1.02rem] font-[650]">{c.title}</p>
                      <p className="mt-1 text-[0.84rem] text-ink-2">
                        {c.status === 'failed' ? 'Creation failed before the market existed. Start again from the same terms.' : 'The market exists but funding is incomplete. Terms are frozen.'}
                      </p>
                    </div>
                    <ButtonLink href={c.status === 'failed' ? `/compose?from=${c.id}` : `/claims/${c.id}`} size="sm" variant={c.status === 'failed' ? 'secondary' : 'primary'}>
                      {c.status === 'failed' ? 'Start again from these terms' : 'Finish publishing'}
                    </ButtonLink>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-12" aria-labelledby="drafts">
            <h2 id="drafts" className="t-h2">
              Drafts
            </h2>
            {plain.length === 0 ? (
              <EmptyState
                className="mt-4"
                title="No drafts yet"
                body="Paste a pull request or commit URL to start one. Nothing is published until you finish the review and sign."
                action={
                  <ButtonLink href="/compose" icon={<Plus size={16} aria-hidden />}>
                    Put a claim on the board
                  </ButtonLink>
                }
              />
            ) : (
              <ul className="mt-4 grid gap-3">
                {plain.map((d) => (
                  <DraftRow key={d.id} d={d} onRemove={(id) => void remove(id)} />
                ))}
              </ul>
            )}
            <p className="mt-4 text-[0.8rem] text-ink-3">
              Drafts live in this browser{wallet.isDemo ? ' (demo mode)' : ''} and, when you are signed in, under your GitHub account.{' '}
              <Link href="/account" className="underline underline-offset-2">
                Account
              </Link>
            </p>
          </section>
        </>
      )}
    </div>
  )
}
