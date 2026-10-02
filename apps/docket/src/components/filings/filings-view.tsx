'use client'

import Link from 'next/link'
import type { ClaimDraft } from '@pine/core'
import { formatClaimNumber, formatDate, shortSha, validateClaimDraft } from '@pine/core'
import { useClaims, useDrafts, useWallet } from '@pine/react'
import { FilePlus2, Lock, Trash2 } from 'lucide-react'
import { ButtonLink } from '@/components/ui/button'
import { Confirm } from '@/components/ui/confirm'
import { EmptyState, Skeleton } from '@/components/ui/layout'
import { StageTag } from '@/components/ui/stage'
import { WIZARD_STEPS } from '@/lib/wizard'
import { toast } from 'sonner'

function stepsDone(d: ClaimDraft) {
  const steps = d.publication?.steps ?? []
  return { done: steps.filter((s) => s.status === 'confirmed' || s.status === 'skipped').length, total: steps.length }
}

function isFiled(d: ClaimDraft) {
  const s = d.publication?.steps ?? []
  return s.length > 0 && s.every((x) => x.status === 'confirmed' || x.status === 'skipped')
}

function isStarted(d: ClaimDraft) {
  return (d.publication?.steps ?? []).some((s) => s.status !== 'idle')
}

function isFrozen(d: ClaimDraft) {
  return (d.publication?.steps ?? []).some((s) => s.id === 'create_market' && s.status === 'confirmed')
}

export function FilingsView() {
  const { drafts, remove, isLoading } = useDrafts()
  const wallet = useWallet()
  const incompleteOnDocket = useClaims({ status: 'publishing', creator: wallet.address, limit: 50 })

  const mineIncomplete = wallet.address
    ? (incompleteOnDocket.data?.items ?? []).filter((c) => c.creator.toLowerCase() === wallet.address!.toLowerCase())
    : []
  const inProgress = drafts.filter((d) => isStarted(d) && !isFiled(d))
  const plain = drafts.filter((d) => !isStarted(d))
  const filed = drafts.filter(isFiled)

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  const nothing = drafts.length === 0 && mineIncomplete.length === 0

  return (
    <div className="space-y-12">
      {nothing ? (
        <EmptyState
          title="No drafts or filings yet"
          action={
            <ButtonLink href="/file" icon={<FilePlus2 aria-hidden />}>
              File a verification
            </ButtonLink>
          }
        >
          Drafts save automatically as you fill in the filing steps, so they will appear here.
        </EmptyState>
      ) : null}

      {inProgress.length > 0 || mineIncomplete.length > 0 ? (
        <section aria-labelledby="inprog">
          <h2 id="inprog" className="flex items-center gap-3 text-2xl">
            <span aria-hidden className="h-7 w-2 bg-flag" /> Filing started, not finished
          </h2>
          <p className="mt-1 text-graphite measure">
            Finish these first. Where the market already exists, its terms are frozen and only the funding steps remain.
          </p>
          <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
            {inProgress.map((d) => {
              const { done, total } = stepsDone(d)
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5">
                  <div className="min-w-0">
                    <p className="record-title untrusted text-lg">{d.spec.title?.trim() || 'Untitled filing'}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-graphite">
                      <span>
                        {done} of {total} filing steps confirmed
                      </span>
                      {isFrozen(d) ? (
                        <span className="inline-flex items-center gap-1 font-bold text-ink">
                          <Lock aria-hidden className="size-3.5" /> Terms frozen
                        </span>
                      ) : null}
                      <span>Saved {formatDate(d.updatedAt, 'long')}</span>
                    </p>
                  </div>
                  <ButtonLink href={`/file/${encodeURIComponent(d.id)}?step=publish`}>Finish filing</ButtonLink>
                </li>
              )
            })}
            {mineIncomplete.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-3">
                    <span className="font-[800] text-violet tabular">{formatClaimNumber(c.number)}</span>
                    <StageTag status={c.status} />
                  </p>
                  <p className="record-title untrusted mt-1 text-lg">{c.title}</p>
                </div>
                <ButtonLink href={`/claims/${c.id}#filing`}>Finish filing</ButtonLink>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {plain.length > 0 ? (
        <section aria-labelledby="drafts">
          <h2 id="drafts" className="text-2xl">
            Drafts
          </h2>
          <p className="mt-1 text-graphite">Nothing is on-chain yet. Every term can still change.</p>
          <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
            {plain.map((d) => {
              const issues = validateClaimDraft(d).issues.length
              const at = WIZARD_STEPS.find((w) => w.stage === d.stage)
              return (
                <li key={d.id} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                  <div className="min-w-0">
                    <p className="record-title untrusted text-lg">{d.spec.title?.trim() || 'Untitled filing'}</p>
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-graphite">
                      {d.source ? (
                        <span>
                          {d.source.owner}/{d.source.repo} at <code className="font-mono">{shortSha(d.source.commit.sha)}</code>
                        </span>
                      ) : (
                        <span>No commit pinned yet</span>
                      )}
                      {d.spec.policyId ? <span>{d.spec.policyId}</span> : null}
                      <span>At step: {at?.title ?? d.stage}</span>
                      <span className={issues ? 'font-bold text-ochre' : ''}>{issues ? `${issues} thing${issues === 1 ? '' : 's'} to complete` : 'Ready to review'}</span>
                      <span>Saved {formatDate(d.updatedAt, 'long')}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ButtonLink href={`/file/${encodeURIComponent(d.id)}?step=${d.stage}`} variant="secondary">
                      Continue
                    </ButtonLink>
                    <Confirm
                      title="Delete this draft?"
                      confirmLabel="Delete draft"
                      onConfirm={async () => {
                        await remove(d.id)
                        toast('Draft deleted')
                      }}
                      trigger={
                        <button type="button" className="inline-flex h-11 items-center gap-1.5 rounded-sm px-3 text-sm font-bold text-red hover:bg-red-wash">
                          <Trash2 aria-hidden className="size-4" />
                          <span className="sr-only sm:not-sr-only">Delete</span>
                        </button>
                      }
                    >
                      <span className="untrusted">&ldquo;{d.spec.title?.trim() || 'Untitled filing'}&rdquo;</span> is removed from this browser. Nothing was published, so
                      nothing on-chain is affected.
                    </Confirm>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {filed.length > 0 ? (
        <section aria-labelledby="filed">
          <h2 id="filed" className="text-2xl">
            Filed from this browser
          </h2>
          <ul className="mt-4 divide-y divide-rule border-y border-rule bg-sheet">
            {filed.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <span className="record-title untrusted text-lg">{d.spec.title}</span>
                {d.publication?.claimId ? (
                  <Link href={`/claims/${d.publication.claimId}`} className="link font-bold">
                    Open the case file
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
