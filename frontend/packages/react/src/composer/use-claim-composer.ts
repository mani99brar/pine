'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ClaimDraft,
  ClaimManifest,
  ClaimQuestion,
  ClaimSpec,
  ComposerStage,
  FundingInput,
  FundingPlan,
  Hex,
  IsoDate,
  PolicyVersion,
  validateClaimDraft,
} from '@pine/core'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { isoNow } from '../internal/util'
import { useWallet } from '../wallet'
import { useDraftOwner, upsertDraftInCache } from './drafts'
import { createDefaultDraft, deriveComposer, isDraftFrozen, mergeDraft, newDraftId, normalizeDraft } from './defaults'

export const AUTOSAVE_DEBOUNCE_MS = 600

export type DraftPatch = Partial<ClaimDraft> | ((d: ClaimDraft) => ClaimDraft)

export interface ClaimComposer {
  draft: ClaimDraft
  /** Object patches merge `spec`/`funding` one level deep; use the function form for deep edits. */
  update(patch: DraftPatch): void
  setStage(s: ComposerStage): void
  policy?: PolicyVersion
  question?: ClaimQuestion
  manifest?: ClaimManifest
  manifestHash?: Hex
  validation: ReturnType<typeof validateClaimDraft>
  funding?: FundingPlan
  saving: boolean
  lastSavedAt?: IsoDate
  // Additive
  /** Manifest claim id (stable per draft) */
  claimId: string
  /** The spec with placeholders filled, as used for the question/manifest preview */
  spec: ClaimSpec
  fundingInput: FundingInput
  /** True once `create_market` confirmed: source/spec edits are ignored */
  frozen: boolean
  /** True once a funding step confirmed: funding edits are ignored */
  fundingFrozen: boolean
  blockedStages: ComposerStage[]
  isLoading: boolean
  buildError?: string
  /** Persists immediately (skips the debounce). */
  saveNow(): Promise<void>
}

const FUNDING_STEP_IDS = new Set(['approve_collateral', 'split_position', 'add_liquidity_yes', 'add_liquidity_no'])

function isFundingFrozen(d: ClaimDraft): boolean {
  return Boolean(d.publication?.steps?.some((s) => FUNDING_STEP_IDS.has(s.id) && s.status === 'confirmed'))
}

/** Shared query for a single draft (composer, publish hook, recovery). */
export function useDraftQuery(id: string | undefined, makeDefault?: () => ClaimDraft) {
  const { drafts: store } = usePine()
  return useQuery({
    queryKey: pineKeys.draft(id),
    queryFn: async () => {
      const found = await store.get(id as string)
      return found ?? makeDefault?.() ?? null
    },
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/**
 * Claim composer state. Holds the draft in the query cache (so the publish hook and dashboards see
 * the same object), autosaves to the DraftStore 600ms after the last edit, and derives the policy,
 * question, manifest + hash, validation and funding plan live as the draft changes.
 *
 * Without `draftId`, a new draft id is generated; the draft is persisted on the first edit.
 */
export function useClaimComposer(draftId?: string): ClaimComposer {
  const { drafts: store, env } = usePine()
  const owner = useDraftOwner()
  const qc = useQueryClient()
  const wallet = useWallet()
  const [generatedId] = useState(() => newDraftId())
  const id = draftId ?? generatedId

  const makeDefault = useCallback(() => {
    const account = qc.getQueryData<{ preferences?: { defaultSpendingLimit?: string; defaultChainId?: number } } | null>(
      pineKeys.account(),
    )
    return createDefaultDraft({
      id,
      owner,
      chainId: account?.preferences?.defaultChainId ?? env.defaultChainId,
      spendingLimit: account?.preferences?.defaultSpendingLimit,
    })
  }, [id, owner, env.defaultChainId, qc])

  const placeholder = useMemo(() => makeDefault(), [makeDefault])
  const q = useDraftQuery(id, makeDefault)
  const draft = q.data ?? placeholder

  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<IsoDate | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    const latest = qc.getQueryData<ClaimDraft | null>(pineKeys.draft(id))
    if (!latest) return
    setSaving(true)
    try {
      await store.save(latest)
      upsertDraftInCache(qc, owner, latest)
      setLastSavedAt(isoNow())
    } catch {
      dirty.current = true
    } finally {
      setSaving(false)
    }
  }, [qc, id, store, owner])

  const update = useCallback(
    (patch: DraftPatch) => {
      qc.setQueryData<ClaimDraft | null>(pineKeys.draft(id), (prev) => {
        const base = prev ?? placeholder
        let next = typeof patch === 'function' ? patch(base) : mergeDraft(base, patch)
        if (isDraftFrozen(base)) next = { ...next, source: base.source, spec: base.spec }
        if (isFundingFrozen(base)) next = { ...next, funding: base.funding }
        next = normalizeDraft(next, base)
        return { ...next, id: base.id, owner: base.owner === 'local' ? owner : base.owner, updatedAt: isoNow() }
      })
      dirty.current = true
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void flush()
      }, AUTOSAVE_DEBOUNCE_MS)
    },
    [qc, id, placeholder, flush, owner],
  )

  const setStage = useCallback((s: ComposerStage) => update({ stage: s }), [update])

  // Flush pending edits when the composer unmounts.
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  }, [flush])
  useEffect(() => () => void flushRef.current(), [])

  const derived = useMemo(() => deriveComposer(draft, { creator: wallet.address }), [draft, wallet.address])

  return {
    draft,
    update,
    setStage,
    policy: derived.policy,
    question: derived.question,
    manifest: derived.manifest,
    manifestHash: derived.manifestHash,
    validation: derived.validation,
    funding: derived.funding,
    saving,
    lastSavedAt,
    claimId: derived.claimId,
    spec: derived.spec,
    fundingInput: derived.fundingInput,
    frozen: derived.frozen,
    fundingFrozen: isFundingFrozen(draft),
    blockedStages: derived.blockedStages,
    isLoading: Boolean(draftId) && q.isLoading,
    buildError: derived.buildError,
    saveNow: async () => {
      dirty.current = true
      await flush()
    },
  }
}
