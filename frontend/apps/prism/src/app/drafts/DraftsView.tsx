'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { ClaimDraft } from '@pine/core'
import { formatRelative, getPolicy, shortHash, shortSha } from '@pine/core'
import { FINAL_PUBLICATION_STATES, PineWriteApi, type PublicationView } from '@pine/data'
import { useDrafts, usePine } from '@pine/react'
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
  if (d.publication?.manifestHash || d.publication?.backend?.documentSha256) out.push('manifest')
  if (d.publication?.steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')) out.push('market')
  return out
}

/**
 * api mode: the publications of these drafts on Pine (owner-only reads), refreshed until they are final. Only the
 * state is taken from here; a market address is shown only once the composer verified it on chain (marketAddress).
 */
function usePublications(drafts: ClaimDraft[]): Map<string, PublicationView> {
  const { api } = usePine()
  const write = useMemo(() => (api ? new PineWriteApi(api) : null), [api])
  const ids = [...new Set(drafts.map((d) => d.publication?.backend?.publicationId).filter((x): x is string => typeof x === 'string'))]
  const results = useQueries({
    queries: ids.map((id) => ({
      // Under 'plans' so that signing out clears it with the other per-user data.
      queryKey: ['pine', 'plans', 'publication', id],
      queryFn: async () => {
        if (!write) throw new Error('The Pine API is not configured.')
        return write.getPublication(id)
      },
      enabled: write !== null,
      staleTime: 15_000,
      refetchInterval: (q: { state: { data?: PublicationView } }) => (q.state.data && FINAL_PUBLICATION_STATES.includes(q.state.data.state) ? false : 30_000),
    })),
  })
  const out = new Map<string, PublicationView>()
  ids.forEach((id, i) => {
    const view = results[i]?.data
    if (view) out.set(id, view)
  })
  return out
}

const PUBLICATION_TEXT: Record<PublicationView['state'], string> = {
  planned: 'Publication planned: finish it from the composer',
  submitted: 'Publishing: the transaction was sent',
  mined: 'Publishing: Pine is confirming the claim',
  confirmed: 'Published',
  failed: 'The publication failed',
  expired: 'The publication offer expired: request a new preview',
}

/** Where a draft stands on Pine (api mode). */
function BackendStatus({ d, publication }: { d: ClaimDraft; publication?: PublicationView }) {
  const backend = d.publication?.backend
  const market = d.publication?.marketAddress
  if (market) {
    return (
      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
        <span className="text-lumen-2">Published: market {shortHash(market)}</span>
        <Link href={`/claims/${market}`} className="link">
          Watch it live
        </Link>
      </p>
    )
  }
  if (publication) {
    const bad = publication.state === 'failed' || publication.state === 'expired'
    return (
      <p className="mt-1.5 text-[0.8125rem]">
        <span className={bad ? 'text-ha' : 'text-na'}>{PUBLICATION_TEXT[publication.state]}</span>
        {publication.state === 'failed' && publication.failureReason && <span className="untrusted ml-2 text-lumen-3">{publication.failureReason}</span>}
      </p>
    )
  }
  return (
    <p className="mt-1.5 text-[0.8125rem] text-lumen-3">
      {backend?.publicationId
        ? 'Publication started on Pine'
        : backend?.previewId && backend.documentSha256
          ? `Previewed on Pine: document ${shortHash(backend.documentSha256)}`
          : backend?.draftId
            ? `Saved on Pine, revision ${backend.revision}`
            : 'Only in this browser: Pine receives it when you request the preview'}
    </p>
  )
}

function DraftRow({ d, now, onDelete, apiMode, publication }: { d: ClaimDraft; now: number | null; onDelete: (d: ClaimDraft) => void; apiMode: boolean; publication?: PublicationView }) {
  const policy = d.spec.policyId ? getPolicy(d.spec.policyId) : undefined
  const steps = d.publication?.steps ?? []
  const confirmed = steps.filter((s) => s.status === 'confirmed').length
  const failed = steps.find((s) => s.status === 'failed')
  const stageLabel = UI_STEPS.find((s) => s.stage === d.stage)?.label ?? d.stage
  const frozen = steps.some((s) => s.id === 'create_market' && s.status === 'confirmed')
  const inFlight = apiMode ? Boolean(d.publication?.backend?.publicationId) && !d.publication?.marketAddress && publication?.state !== 'failed' && publication?.state !== 'expired' : steps.length > 0
  // A publication may still land while Pine has not reported it final: keep the draft (and its recovery data) until then.
  const deletable = !frozen && !(apiMode && inFlight)
  const policyLabel = apiMode ? (d.spec.policyId ? `${d.spec.policyId}${d.spec.policyVersion ? `@${d.spec.policyVersion}` : ''}` : undefined) : policy ? `${policy.id}@${policy.version}` : undefined
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
          {policyLabel && <span>{policyLabel}</span>}
          <span>At {stageLabel.toLowerCase()}</span>
          {now && <span>Edited {formatRelative(d.updatedAt, new Date(now))}</span>}
        </p>
        {apiMode ? (
          <BackendStatus d={d} publication={publication} />
        ) : (
          steps.length > 0 && (
            <p className="mt-1.5 text-[0.8125rem]">
              <span className={failed ? 'text-ha' : 'text-na'}>
                {failed ? `Publication stopped at a failed step (${confirmed} of ${steps.length} done)` : `Publishing: ${confirmed} of ${steps.length} steps done`}
              </span>
              {frozen && <span className="ml-2 text-lumen-3">Market exists, terms frozen</span>}
            </p>
          )
        )}
      </div>
      <div className="col-start-2 flex flex-wrap gap-2 sm:col-start-auto">
        <ButtonLink href={`/compose?draft=${encodeURIComponent(d.id)}`} size="sm" variant={inFlight ? 'light' : 'glass'}>
          {inFlight ? 'Resume publishing' : apiMode && d.publication?.marketAddress ? 'Open' : 'Continue'}
        </ButtonLink>
        {deletable && (
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
  const { env } = usePine()
  const apiMode = env.dataSource === 'api'
  const now = useNowMs()
  const publications = usePublications(apiMode ? drafts : [])
  const [pending, setPending] = useState<ClaimDraft | null>(null)
  const publicationOf = (d: ClaimDraft) => {
    const id = d.publication?.backend?.publicationId
    return id ? publications.get(id) : undefined
  }
  const published = apiMode ? drafts.filter((d) => Boolean(d.publication?.marketAddress)) : []
  const unfinished = apiMode
    ? drafts.filter((d) => !d.publication?.marketAddress && (Boolean(d.publication?.backend?.publicationId) || (d.publication?.steps?.length ?? 0) > 0))
    : drafts.filter((d) => (d.publication?.steps?.length ?? 0) > 0)
  const plain = drafts.filter((d) => !published.includes(d) && !unfinished.includes(d))

  if (error) return <ErrorState error={error} onRetry={refetch} />
  if (isLoading) return <LoadingBlock lines={5} />
  if (!drafts.length)
    return (
      <EmptyState
        title="No drafts yet"
        icon={<CrystalGlyph seed="drafts:empty" hue={FAMILY_HEX.FUNC} state="partial" cut={[]} size={84} glow={false} decorative />}
        action={<ButtonLink href="/compose" icon={<Plus size={15} aria-hidden />}>Compose a claim</ButtonLink>}
      >
        Drafts save automatically while you compose. Unfinished publications also appear here so you can resume them.
      </EmptyState>
    )
  const section = (id: string, title: string, list: ClaimDraft[]) =>
    list.length > 0 && (
      <section aria-labelledby={id}>
        <h2 id={id} className="t-h3 mb-3">
          {title}
        </h2>
        <ul className="glass cut-xl divide-y divide-[var(--edge)]">
          {list.map((d) => (
            <DraftRow key={d.id} d={d} now={now} onDelete={setPending} apiMode={apiMode} publication={publicationOf(d)} />
          ))}
        </ul>
      </section>
    )
  return (
    <div className="grid gap-10">
      {section('unfinished-title', 'Unfinished publications', unfinished)}
      {section('drafts-title', 'Drafts', plain)}
      {section('published-title', 'Published', published)}
      <p className="text-[0.84375rem] text-lumen-3">
        {apiMode
          ? 'Drafts are saved in this browser. Pine receives a draft when you request its preview, and only your wallet can read it there. A draft whose market already exists cannot be deleted: its terms are on-chain.'
          : 'Drafts live in this browser in demo mode. A draft whose market already exists cannot be deleted: its terms are on-chain.'}{' '}
        <Link href="/compose" className="link">
          Compose a new claim
        </Link>
      </p>
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(v) => !v && setPending(null)}
        title="Delete this draft?"
        description={
          apiMode && pending?.publication?.backend?.draftId && !pending.publication.backend.publicationId
            ?`“${pending.spec.title?.trim() || 'Untitled draft'}” and its saved progress are removed from this browser, and Pine deletes its copy. Nothing on-chain changes.`
            : `“${pending?.spec.title?.trim() || 'Untitled draft'}” and its saved progress are removed from this browser. Nothing on-chain changes.`
        }
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
