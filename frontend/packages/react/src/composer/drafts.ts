'use client'

import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import type { ClaimDraft } from '@pine/core'
import { anyBodySchema, PineBackendError, PineWriteApi, seg, type DraftStore } from '@pine/data'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { usePineSession } from '../api/session'
import { useSessionReplacement } from '../account'
import { getBrowserStorage, removeKey } from '../internal/storage'
import { isoNow } from '../internal/util'
import { txStorageKey } from '../tx/machine'
import { createDefaultDraft } from './defaults'
import { apiDefaultDeadline } from './api-rules'

export const LOCAL_DRAFT_OWNER = 'local'

interface SessionUserLike {
  login?: string | null
  name?: string | null
}

/**
 * Draft owner: the signed-in GitHub login, or "local" when signed out. In `api` mode the owner is the backend session's
 * wallet (lowercase), since a wallet signs in there and GitHub is only linked to it.
 */
export function useDraftOwner(): string {
  const { env } = usePine()
  const session = useSession()
  const backend = usePineSession()
  useSessionReplacement()
  if (env.dataSource === 'api') return backend.session?.wallet.toLowerCase() ?? LOCAL_DRAFT_OWNER
  const user = session.data?.user as SessionUserLike | undefined
  return user?.login ?? LOCAL_DRAFT_OWNER
}

/** Publish runs are keyed by draft id. */
export function publishRunKey(draftId: string): string {
  return `publish:${draftId}`
}

function sortDrafts(list: ClaimDraft[]): ClaimDraft[] {
  return [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function upsertDraftInCache(qc: QueryClient, owner: string, draft: ClaimDraft): void {
  qc.setQueryData<ClaimDraft[]>(pineKeys.drafts(owner), (prev) => {
    if (!prev) return prev
    const rest = prev.filter((d) => d.id !== draft.id)
    return sortDrafts([draft, ...rest])
  })
}

async function listDrafts(store: DraftStore, owner: string): Promise<ClaimDraft[]> {
  const [mine, local] = await Promise.all([
    store.list(owner),
    owner !== LOCAL_DRAFT_OWNER ? store.list(LOCAL_DRAFT_OWNER) : Promise.resolve([] as ClaimDraft[]),
  ])
  const byId = new Map<string, ClaimDraft>()
  for (const d of [...local, ...mine]) byId.set(d.id, d)
  return sortDrafts([...byId.values()])
}

/**
 * Drafts and in-progress publications for the current owner (signed-in login, plus drafts created
 * while signed out on this device). Drafts with `publication` steps are recoverable publications.
 */
export function useDrafts(): {
  drafts: ClaimDraft[]
  create(partial?: Partial<ClaimDraft>): ClaimDraft
  save(d: ClaimDraft): Promise<ClaimDraft>
  /**
   * Deletes a draft. In api mode it rejects, deleting nothing, when the stored draft's market exists or its publication
   * may still land (Pine does not report it failed or expired).
   */
  remove(id: string): Promise<void>
  isLoading: boolean
  error: Error | null
  refetch(): void
} {
  const { drafts: store, env, api } = usePine()
  const owner = useDraftOwner()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: pineKeys.drafts(owner),
    queryFn: () => listDrafts(store, owner),
    staleTime: 10_000,
  })

  const create = useCallback(
    (partial?: Partial<ClaimDraft>) => {
      const account = qc.getQueryData<{ preferences?: { defaultSpendingLimit?: string; defaultChainId?: number } } | null>(
        pineKeys.account(),
      )
      const apiMode = env.dataSource === 'api'
      const d = createDefaultDraft({
        owner,
        chainId: apiMode ? env.defaultChainId : (account?.preferences?.defaultChainId ?? env.defaultChainId),
        spendingLimit: account?.preferences?.defaultSpendingLimit,
        partial,
        // api mode: the backend's default evidence window; the policy version comes from the backend catalog.
        ...(apiMode ? { deadline: apiDefaultDeadline(), normalize: { staticPolicies: false } } : {}),
      })
      qc.setQueryData(pineKeys.draft(d.id), d)
      upsertDraftInCache(qc, owner, d)
      void store.save(d)
      return d
    },
    [qc, owner, env.defaultChainId, env.dataSource, store],
  )

  const save = useCallback(
    async (d: ClaimDraft) => {
      const next = { ...d, owner: d.owner === LOCAL_DRAFT_OWNER ? owner : d.owner, updatedAt: isoNow() }
      qc.setQueryData(pineKeys.draft(next.id), next)
      upsertDraftInCache(qc, owner, next)
      return store.save(next)
    },
    [qc, owner, store],
  )

  const remove = useCallback(
    async (id: string) => {
      if (api) {
        // api mode, checked on the draft as stored now (a list shown earlier, or another tab, may be stale): a draft
        // whose market exists, or whose publication may still land, is kept with its recovery data.
        const stored = await store.get(id)
        const publication = stored?.publication
        if (publication?.marketAddress || publication?.steps?.some((s) => s.id === 'create_market' && s.status === 'confirmed')) {
          throw new Error('This draft’s market exists: its terms are on-chain, so the draft cannot be deleted.')
        }
        if (publication?.backend?.publicationId) {
          const state = await new PineWriteApi(api).getPublication(publication.backend.publicationId).then(
            (view) => view.state,
            (e: unknown) => {
              // No such publication for this wallet: nothing of it can land.
              if (e instanceof PineBackendError && e.status === 404) return null
              throw new Error('Pine could not say whether this draft’s publication may still land, so the draft is kept. Try again later.')
            },
          )
          if (state !== null && state !== 'failed' && state !== 'expired') {
            throw new Error('This draft’s publication may still land, so the draft is kept until Pine reports it failed or expired.')
          }
        }
        // Pine's copy of the draft goes too, unless a publication exists for it (Pine keeps those and answers 409).
        // Best effort: a copy that stays behind is readable by this wallet only.
        const backend = publication?.backend
        if (backend?.draftId && !backend.publicationId) {
          await api.request('DELETE', `/api/v1/drafts/${seg(backend.draftId)}`, anyBodySchema).catch(() => undefined)
        }
        removeKey(getBrowserStorage(), `pine:api-preview:${id}`)
      }
      await store.remove(id)
      removeKey(getBrowserStorage(), txStorageKey(publishRunKey(id)))
      qc.removeQueries({ queryKey: pineKeys.draft(id) })
      qc.setQueryData<ClaimDraft[]>(pineKeys.drafts(owner), (prev) => prev?.filter((d) => d.id !== id))
    },
    [qc, owner, store, api],
  )

  const refetch = useCallback(() => {
    void q.refetch()
  }, [q])

  return useMemo(
    () => ({ drafts: q.data ?? [], create, save, remove, isLoading: q.isLoading, error: q.error, refetch }),
    [q.data, q.isLoading, q.error, create, save, remove, refetch],
  )
}
