'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { ClaimDraft } from '@pine/core'
import { formatRelative, getPolicy, shortSha } from '@pine/core'
import { useDrafts } from '@pine/react'
import { Plus, Trash2 } from 'lucide-react'
import { CrystalGlyph } from '@/components/crystal/CrystalGlyph'
import { Button, ButtonLink } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/interactive'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/primitives'
import { FAMILY_HEX, type FacetId } from '@/lib/crystal'
import { useNowMs } from '@/lib/hooks'
import { UI_STEPS } from '@/components/composer/shared'

function draftFacets(d: ClaimDraft): FacetId[] {
  const out: FacetId[] = []
  if (d.source) out.push('commit')
  if (d.spec.policyId) out.push('policy')
  if (d.spec.title?.trim() && d.spec.violation?.trim()) out.push('question')
  if (d.spec.environment?.runtime?.trim() && d.spec.environment.reproductionCommand?.trim()) out.push('environment')
  const order = ['source', 'policy', 'claim', 'deadlines', 'funding', 'review', 'publish']
  const idx = order.indexOf(d.stage)
  if (idx > 3) out.push('deadline', 'oracle')
  if (idx > 4) out.push('funding')
  if (d.publication?.manifestHash) out.push('manifest')
  if (d.publication?.steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')) out.push('market')
  return out
}

function DraftRow({ d, now, onDelete }: { d: ClaimDraft; now: number | null; onDelete: (d: ClaimDraft) => void }) {
  const policy = d.spec.policyId ? getPolicy(d.spec.policyId) : undefined
  const steps = d.publication?.steps ?? []
  const confirmed = steps.filter((s) => s.status === 'confirmed').length
  const failed = steps.find((s) => s.status === 'failed')
  const stageLabel = UI_STEPS.find((s) => s.stage === d.stage)?.label ?? d.stage
  const frozen = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
      <CrystalGlyph seed={d.id} hue={FAMILY_HEX[policy?.family ?? 'FUNC']} state="partial" cut={draftFacets(d)} size={60} glow={false} decorative />
      <div className="min-w-0">
        <p className="truncate text-[1rem] font-semibold text-lumen">{d.spec.title?.trim() || 'Untitled draft'}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.8125rem] text-lumen-3">
          {d.source ? (
            <span>
              {d.source.owner}/{d.source.repo} <span className="t-code text-lumen-2">{shortSha(d.source.commit.sha)}</span>
            </span>
          ) : (
            <span>No commit pinned</span>
          )}
          {policy && <span>{policy.id}@{policy.version}</span>}
          <span>At {stageLabel.toLowerCase()}</span>
          {now && <span>Edited {formatRelative(d.updatedAt, new Date(now))}</span>}
        </p>
        {steps.length > 0 && (
          <p className="mt-1.5 text-[0.8125rem]">
            <span className={failed ? 'text-ha' : 'text-na'}>
              {failed ? `Publication stopped at a failed step (${confirmed} of ${steps.length} done)` : `Publishing: ${confirmed} of ${steps.length} steps done`}
            </span>
            {frozen && <span className="ml-2 text-lumen-3">Market exists, terms frozen</span>}
          </p>
        )}
      </div>
      <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-auto">
        <ButtonLink href={`/compose?draft=${encodeURIComponent(d.id)}`} size="sm" variant={steps.length ? 'light' : 'glass'}>
          {steps.length ? 'Resume publishing' : 'Continue'}
        </ButtonLink>
        {!frozen && (
          <Button size="sm" variant="ghost" onClick={() => onDelete(d)} aria-label={`Delete draft ${d.spec.title || d.id}`} icon={<Trash2 size={14} aria-hidden />}>
            Delete
          </Button>
        )}
      </div>
    </li>
  )
}

export function DraftsView() {
  const { drafts, isLoading, error, refetch, remove } = useDrafts()
  const now = useNowMs()
  const [pending, setPending] = useState<ClaimDraft | null>(null)
  const unfinished = drafts.filter((d) => (d.publication?.steps?.length ?? 0) > 0)
  const plain = drafts.filter((d) => !(d.publication?.steps?.length ?? 0))

  if (error) return <ErrorState error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock lines={5} />
  if (!drafts.length)
    return (
      <EmptyState title="No drafts yet" action={<ButtonLink href="/compose" icon={<Plus size={15} aria-hidden />}>Compose a claim</ButtonLink>}>
        Drafts save automatically while you compose. Unfinished publications also appear here so you can resume them.
      </EmptyState>
    )
  return (
    <div className="grid gap-10">
      {unfinished.length > 0 && (
        <section aria-labelledby="unfinished-title">
          <h2 id="unfinished-title" className="t-h3 mb-3">
            Unfinished publications
          </h2>
          <ul className="glass cut-xl divide-y divide-[var(--edge)]">
            {unfinished.map((d) => (
              <DraftRow key={d.id} d={d} now={now} onDelete={setPending} />
            ))}
          </ul>
        </section>
      )}
      {plain.length > 0 && (
        <section aria-labelledby="drafts-title">
          <h2 id="drafts-title" className="t-h3 mb-3">
            Drafts
          </h2>
          <ul className="glass cut-xl divide-y divide-[var(--edge)]">
            {plain.map((d) => (
              <DraftRow key={d.id} d={d} now={now} onDelete={setPending} />
            ))}
          </ul>
        </section>
      )}
      <p className="text-[0.84375rem] text-lumen-3">
        Drafts live in this browser in demo mode. A draft whose market already exists cannot be deleted: its terms are on-chain.{' '}
        <Link href="/compose" className="link">
          Compose a new claim
        </Link>
      </p>
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(v) => !v && setPending(null)}
        title="Delete this draft?"
        description={`“${pending?.spec.title?.trim() || 'Untitled draft'}” and its saved progress are removed from this browser. Nothing on-chain changes.`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPending(null)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (pending) void remove(pending.id)
              setPending(null)
            }}
          >
            Delete draft
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
