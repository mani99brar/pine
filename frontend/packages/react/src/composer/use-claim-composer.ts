'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DRAFT_KEY_PREFIX } from '@pine/data'
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
import { usePolicy } from '../queries'
import { pineKeys } from '../queries/keys'
import { isoNow } from '../internal/util'
import { useWallet } from '../wallet'
import { useDraftOwner, upsertDraftInCache } from './drafts'
import { createDefaultDraft, deriveComposer, isDraftFrozen, mergeDraft, newDraftId, normalizeDraft, type ApiDerived } from './defaults'
import { API_COMPOSER_RULES, apiDeadlineForDays, apiDefaultDeadline } from './api-rules'

export const AUTOSAVE_DEBOUNCE_MS = 600

export type DraftPatch = Partial<ClaimDraft> | ((d: ClaimDraft) => ClaimDraft)

/** The draft changed in another tab while this composer had it open. */
export interface DraftConflict {
  /** `changed`: the composer took the draft as the other tab saved it. `deleted`: the other tab deleted it. */
  kind: 'changed' | 'deleted'
  /** `changed`: some unsaved edits of this tab were not kept (the other tab changed the same fields, or sealed the draft). */
  editsDropped: boolean
}

/** `api` mode (Pine backend) composer state; see ./api-rules for the rules. */
export interface ApiComposerState extends ApiDerived {
  /** The chosen policy is being read from the backend catalog. */
  policyLoading: boolean
  /** Why the chosen policy could not be read from the backend. */
  policyError: Error | null
  rules: typeof API_COMPOSER_RULES
  /** Evidence deadline for "N days from now", inside the backend window. */
  deadlineForDays(days: number, now?: Date): IsoDate
  /** The backend's default evidence deadline (7 days, on the hour). */
  defaultDeadline(now?: Date): IsoDate
}

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
  /**
   * The draft changed in another tab. On `changed` the composer already shows the draft as stored, with the unsaved
   * edits of this tab kept only in fields the other tab left alone. On `deleted` nothing is saved (and the deletion is
   * never undone) until the user keeps the draft or lets it go (`resolveDeleted`).
   */
  conflict?: DraftConflict
  /** Hides a `changed` notice. */
  dismissConflict(): void
  /** After `conflict.kind === 'deleted'`: `true` saves the draft again as shown here; `false` leaves it deleted. */
  resolveDeleted(keep: boolean): Promise<void>
  /**
   * `api` mode only (Pine backend): the policy comes from the backend catalog, `validation` holds the backend's draft
   * rules, and question/manifest/funding are not built locally (the backend freezes the claim document at preview).
   */
  api?: ApiComposerState
}

const FUNDING_STEP_IDS = new Set(['approve_collateral', 'split_position', 'add_liquidity_yes', 'add_liquidity_no'])

function isFundingFrozen(d: ClaimDraft): boolean {
  return Boolean(d.publication?.steps?.some((s) => FUNDING_STEP_IDS.has(s.id) && s.status === 'confirmed'))
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The draft's content, whatever its revision (`updatedAt`). */
function sameContent(a: ClaimDraft | null | undefined, b: ClaimDraft | null | undefined): boolean {
  return same(a ? { ...a, updatedAt: '' } : a, b ? { ...b, updatedAt: '' } : b)
}

/**
 * The unsaved edits of this tab (`mine`) on top of the draft another tab saved (`theirs`), both from the version this
 * tab last saw stored (`base`). `stage`, `source`, and each field of `spec` and `funding` keep this tab's value only
 * where the other tab left it as in `base`; the publication is always the stored one, and a draft the other tab sealed
 * (or whose funding it confirmed) keeps its terms (or funding) as stored.
 */
export function rebaseDraft(base: ClaimDraft | null, mine: ClaimDraft, theirs: ClaimDraft): { draft: ClaimDraft; dropped: boolean } {
  let dropped = false
  const pick = <V>(b: V | undefined, m: V, t: V): V => {
    if (same(m, b) || same(m, t)) return t
    if (same(t, b)) return m
    dropped = true
    return t
  }
  const pickFields = <R extends object>(b: R | undefined, m: R | undefined, t: R | undefined): R | undefined => {
    if (!m || !t) return pick(b, m, t)
    const bb = (b ?? {}) as Record<string, unknown>
    const mm = m as Record<string, unknown>
    const tt = t as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(tt), ...Object.keys(mm)])) {
      const v = pick(bb[k], mm[k], tt[k])
      if (v !== undefined) out[k] = v
    }
    return out as R
  }
  const keep = <V>(m: V, t: V): V => {
    if (!same(m, t)) dropped = true
    return t
  }
  const sealed = isDraftFrozen(theirs) || Boolean(theirs.publication?.marketAddress)
  const spec = sealed ? keep(mine.spec, theirs.spec) : (pickFields(base?.spec, mine.spec, theirs.spec) ?? theirs.spec)
  const source = sealed ? keep(mine.source, theirs.source) : pickFields(base?.source, mine.source, theirs.source)
  const funding = isFundingFrozen(theirs) ? keep(mine.funding, theirs.funding) : pickFields(base?.funding, mine.funding, theirs.funding)
  const draft: ClaimDraft = { ...theirs, stage: pick(base?.stage, mine.stage, theirs.stage), spec }
  if (source) draft.source = source
  else delete draft.source
  if (funding) draft.funding = funding
  else delete draft.funding
  return { draft, dropped }
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
export interface UseClaimComposerOptions {
  /**
   * `api` mode: read the chosen policy from the backend catalog (status, version, parameters) and check the draft against
   * it. The composer UI turns this on; hooks that only need the draft (publication, recovery) leave it off and make no
   * catalog request.
   */
  backendPolicy?: boolean
}

export function useClaimComposer(draftId?: string, opts: UseClaimComposerOptions = {}): ClaimComposer {
  const { drafts: store, env } = usePine()
  const apiMode = env.dataSource === 'api'
  const readPolicy = apiMode && opts.backendPolicy === true
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
      // Pine publishes on its own chain only; the backend's default window replaces the 72 h default.
      chainId: apiMode ? env.defaultChainId : (account?.preferences?.defaultChainId ?? env.defaultChainId),
      spendingLimit: account?.preferences?.defaultSpendingLimit,
      ...(apiMode ? { deadline: apiDefaultDeadline(), normalize: { staticPolicies: false } } : {}),
    })
  }, [id, owner, env.defaultChainId, qc, apiMode])

  const placeholder = useMemo(() => makeDefault(), [makeDefault])
  const q = useDraftQuery(id, makeDefault)
  const draft = q.data ?? placeholder

  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<IsoDate | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dirty = useRef(false)
  const [conflict, setConflict] = useState<DraftConflict | undefined>(undefined)
  // Deleted in another tab: nothing is saved until the user keeps the draft.
  const deleted = useRef(false)
  const flushRef = useRef<() => Promise<void>>(async () => undefined)

  const schedule = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void flushRef.current()
    }, AUTOSAVE_DEBOUNCE_MS)
  }, [])

  /** Takes the draft as another tab saved it, keeping the unsaved edits of this tab where that is safe. */
  const adopt = useCallback(
    (current: ClaimDraft, base: ClaimDraft | null) => {
      const mine = qc.getQueryData<ClaimDraft | null>(pineKeys.draft(id))
      const { draft: next, dropped } = mine && dirty.current ? rebaseDraft(base, mine, current) : { draft: current, dropped: false }
      qc.setQueryData(pineKeys.draft(id), next)
      upsertDraftInCache(qc, owner, next)
      setConflict({ kind: 'changed', editsDropped: dropped })
      dirty.current = !sameContent(next, current)
      if (dirty.current) schedule()
    },
    [qc, id, owner, schedule],
  )

  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    if (!dirty.current || deleted.current) return
    const latest = qc.getQueryData<ClaimDraft | null>(pineKeys.draft(id))
    if (!latest) return
    dirty.current = false
    setSaving(true)
    try {
      // Saved only over the version this tab last saw: another tab's save or deletion is never overwritten.
      const result = await store.saveIfUnchanged(latest)
      if (result.ok) {
        upsertDraftInCache(qc, owner, latest)
        setLastSavedAt(isoNow())
      } else if (result.current) {
        dirty.current = true
        adopt(result.current, result.base)
      } else {
        dirty.current = true
        deleted.current = true
        setConflict({ kind: 'deleted', editsDropped: false })
      }
    } catch {
      dirty.current = true
    } finally {
      setSaving(false)
    }
  }, [qc, id, store, owner, adopt])

  /** Another tab saved or deleted this draft (`removed`: its storage key was removed). */
  const sync = useCallback(
    async (removed: boolean) => {
      if (deleted.current) return
      // Unsaved edits: the save finds the change and merges them into it.
      if (dirty.current) return flush()
      const current = await store.get(id)
      if (dirty.current || deleted.current) return
      if (!current) {
        if (!removed) return
        deleted.current = true
        setConflict({ kind: 'deleted', editsDropped: false })
        return
      }
      if (!sameContent(current, qc.getQueryData<ClaimDraft | null>(pineKeys.draft(id)))) adopt(current, null)
    },
    [store, id, qc, flush, adopt],
  )

  const update = useCallback(
    (patch: DraftPatch) => {
      qc.setQueryData<ClaimDraft | null>(pineKeys.draft(id), (prev) => {
        const base = prev ?? placeholder
        let next = typeof patch === 'function' ? patch(base) : mergeDraft(base, patch)
        if (isDraftFrozen(base)) next = { ...next, source: base.source, spec: base.spec }
        if (isFundingFrozen(base)) next = { ...next, funding: base.funding }
        next = normalizeDraft(next, base, apiMode ? { staticPolicies: false } : undefined)
        return { ...next, id: base.id, owner: base.owner === 'local' ? owner : base.owner, updatedAt: isoNow() }
      })
      dirty.current = true
      schedule()
    },
    [qc, id, placeholder, schedule, owner, apiMode],
  )

  const setStage = useCallback((s: ComposerStage) => update({ stage: s }), [update])

  // Flush pending edits when the composer unmounts.
  useEffect(() => {
    flushRef.current = flush
  }, [flush])
  useEffect(() => () => void flushRef.current(), [])

  // Another tab saved or deleted this draft (`storage` fires in the other tabs only): take its version.
  const syncRef = useRef(sync)
  useEffect(() => {
    syncRef.current = sync
  }, [sync])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const key = DRAFT_KEY_PREFIX + id
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== key) return
      void syncRef.current(e.key === key && e.newValue === null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [id])

  const dismissConflict = useCallback(() => setConflict((c) => (c?.kind === 'changed' ? undefined : c)), [])
  const resolveDeleted = useCallback(
    async (keep: boolean) => {
      if (!deleted.current) return
      clearTimeout(timer.current)
      if (!keep) {
        // Left deleted: this composer saves nothing more.
        dirty.current = false
        qc.setQueryData<ClaimDraft[]>(pineKeys.drafts(owner), (prev) => prev?.filter((d) => d.id !== id))
        setConflict(undefined)
        return
      }
      const latest = qc.getQueryData<ClaimDraft | null>(pineKeys.draft(id))
      if (!latest) return
      setSaving(true)
      try {
        await store.save(latest)
        deleted.current = false
        dirty.current = false
        upsertDraftInCache(qc, owner, latest)
        setLastSavedAt(isoNow())
        setConflict(undefined)
      } finally {
        setSaving(false)
      }
    },
    [qc, id, owner, store],
  )

  // `api` mode: the chosen policy from the backend catalog (no version yet → its latest version).
  const policyQ = usePolicy(readPolicy ? draft.spec.policyId || undefined : undefined, readPolicy ? draft.spec.policyVersion || undefined : undefined)
  const apiPolicy = readPolicy ? policyQ.data : undefined
  const policyFailed = readPolicy && policyQ.isError
  const evidenceRegistry = env.deployment?.evidenceRegistry

  // A policy chosen by id only (a policy page link, an older draft) takes the backend's latest version once it is known.
  const frozenDraft = isDraftFrozen(draft)
  useEffect(() => {
    if (!apiMode || frozenDraft || !apiPolicy || draft.spec.policyVersion || draft.spec.policyId !== apiPolicy.id) return
    update({ spec: { policyVersion: apiPolicy.version } })
  }, [apiMode, frozenDraft, apiPolicy, draft.spec.policyId, draft.spec.policyVersion, update])

  // The backend measures the evidence window from "now": re-check the draft every minute in api mode.
  const [minute, setMinute] = useState(0)
  useEffect(() => {
    if (!apiMode) return
    const t = setInterval(() => setMinute((m) => m + 1), 60_000)
    return () => clearInterval(t)
  }, [apiMode])

  const derived = useMemo(
    () =>
      deriveComposer(draft, {
        creator: wallet.address,
        ...(apiMode ? { api: { policy: apiPolicy, policyError: policyFailed, evidenceRegistry, chainId: env.defaultChainId } } : {}),
      }),
    // `minute` re-derives with a fresh clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, wallet.address, apiMode, apiPolicy, policyFailed, evidenceRegistry, env.defaultChainId, minute],
  )
  const policyLoading = readPolicy && Boolean(draft.spec.policyId) && policyQ.isLoading
  const policyError = readPolicy ? policyQ.error : null
  const api = useMemo<ApiComposerState | undefined>(
    () =>
      derived.api
        ? {
            ...derived.api,
            policyLoading,
            policyError,
            rules: API_COMPOSER_RULES,
            deadlineForDays: (days: number, now?: Date) => apiDeadlineForDays(days, now),
            defaultDeadline: (now?: Date) => apiDefaultDeadline(now),
          }
        : undefined,
    [derived.api, policyLoading, policyError],
  )

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
    ...(conflict ? { conflict } : {}),
    dismissConflict,
    resolveDeleted,
    ...(api ? { api } : {}),
  }
}
