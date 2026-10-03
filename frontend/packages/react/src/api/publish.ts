'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Address, ClaimDraft, Hex, PublicationStep } from '@pine/core'
import { canonicalJson, PlanVerificationError, type JsonValue } from '@pine/core/pine-shared'
import {
  claimPreviewResponseSchema,
  describeWriteError,
  draftInputSchema,
  FINAL_PUBLICATION_STATES,
  PineBackendError,
  type ClaimPreviewResponse,
  type DraftInput,
  type DraftView,
  type PublicationView,
  type WriteErrorInfo,
} from '@pine/data'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { useWallet } from '../wallet'
import { isoNow } from '../internal/util'
import { useDraftQuery } from '../composer/use-claim-composer'
import { upsertDraftInCache } from '../composer/drafts'
import type { ApiPlanRunner } from './use-plan-runner'
import { chosenEvidenceDeadline, composerPathOf, toDraftInput, toDraftTerms, type DraftFieldError, type DraftTerms, type DraftTermsResult } from './draft-input'
import { checkCreateClaimPlan, verifyPreview, type PreviewIssue, type VerifiedPreview } from './verify-preview'
import {
  readOnChainClaim,
  requireWriteApi,
  runnerHasSentSteps,
  runnerIsBusy,
  usePinnedManifest,
  usePlanAction,
  usePolledStatus,
  useRegistryReader,
  useStoredRecord,
  useWriteApi,
} from './publish-plan'

// Claim publication against the backend (api mode): the local composer draft is mirrored to a backend draft, previewed
// (the backend freezes the claim document), verified in the browser, then published with the single createClaim plan the
// backend proposes, which is checked against the previewed document before any wallet prompt. After the transaction is
// mined the publication is followed until the backend has indexed the claim and reports its market.

export type ApiPublishStatus =
  | 'idle' // nothing synced with Pine yet
  | 'invalid' // the draft cannot be sent as is (see fieldErrors)
  | 'saving'
  | 'saved' // mirrored to a backend draft
  | 'previewing'
  | 'reviewable' // the preview verified; publishing is possible
  | 'blocked' // the preview failed verification or is outdated (see verifyIssues)
  | 'publishing' // creating the publication, verifying its plan, wallet prompt
  | 'confirming' // the transaction was sent; Pine is indexing the claim
  | 'confirmed' // the claim exists: `market` is set
  | 'failed'
  | 'expired' // the publication offer expired: request a new preview

export interface UseApiPublishOptions {
  /** Branch used for the membership proof when the source has no pull request and no `branch` (e.g. the default branch). */
  defaultBranch?: string
  /** Delay between publication status polls (default 5 s). */
  pollIntervalMs?: number
  /** Clock (tests). */
  now?: () => Date
  /** Injectable wait used by polling and retries (tests). */
  sleep?(ms: number): Promise<void>
}

export type BackendDraftRef = NonNullable<NonNullable<ClaimDraft['publication']>['backend']>

export interface ApiPublish {
  status: ApiPublishStatus
  draft: ClaimDraft | undefined
  /** The backend draft, preview and publication this draft is mirrored to. */
  backend: BackendDraftRef | undefined
  /**
   * Fields the backend would refuse: local checks of the current draft, plus the issues of Pine's last refusal while
   * the draft still has the terms Pine refused (an edit drops them, and the refusal's error, until the next save).
   */
  fieldErrors: DraftFieldError[]
  /** The latest preview, verified in this browser (null when none). Render it only from these fields. */
  preview: VerifiedPreview | null
  /** Reasons the preview cannot be published; empty when it is reviewable. */
  verifyIssues: PreviewIssue[]
  /** The wallet steps (createClaim). Drive it with `publish()`, not with runner.run(). */
  runner: ApiPlanRunner
  publication: PublicationView | null
  /** The claim's Seer market once the backend confirmed it and ClaimRegistry (user's RPC) records this document for it. */
  market: Address | null
  error: WriteErrorInfo | null
  busy: boolean
  /** Mirrors the draft to the backend (create or update). Returns false when invalid or refused. */
  saveDraft(): Promise<boolean>
  /**
   * Saves the draft (refreshing the evidence window) and asks the backend to freeze a claim document. Pass the user's
   * explicit attestation that no counterexample would demonstrate an exploitable flaw in a deployed system holding
   * third-party funds or data; nothing is requested without it.
   */
  requestPreview(attestation: { liveSystemImpactNone: true }): Promise<boolean>
  /** Publishes the verified preview: publication plan → checks → wallet → status until confirmed. */
  publish(): Promise<void>
  /** Reloads the publication status. */
  refresh(): Promise<void>
  /** Forgets the local preview (before anything was sent). */
  discardPreview(): void
}

interface StoredPreview {
  v: 1
  backendDraftId: string
  revision: number
  /** The input saved for `revision` (what the preview must contain). */
  input: DraftInput
  /** Evidence deadline the composer showed, unix seconds. */
  chosenEvidenceDeadline?: number
  response: ClaimPreviewResponse
}

function isStoredPreview(value: unknown): value is StoredPreview {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<StoredPreview>
  return (
    v.v === 1 &&
    typeof v.backendDraftId === 'string' &&
    typeof v.revision === 'number' &&
    draftInputSchema.safeParse(v.input).success &&
    claimPreviewResponseSchema.safeParse(v.response).success
  )
}

/** The input without the evidence window (it is relative to the time of saving). */
function termsOf(input: DraftInput): DraftTerms {
  const { evidenceWindowSeconds: _window, ...terms } = input
  return terms
}

const termsJson = (terms: DraftTerms): string => canonicalJson(terms as unknown as JsonValue)

/** Clock-independent identity of what a save sends: the terms and the absolute evidence deadline chosen. */
const termsKey = (terms: DraftTerms, deadline: number | undefined): string => `${termsJson(terms)}|${deadline ?? ''}`

/** A VALIDATION_FAILED answer to a save, with the terms it was given for: it applies only while the draft still has them. */
interface Refusal {
  key: string
  issues: DraftFieldError[]
  error: WriteErrorInfo
}

const NO_ISSUES: DraftFieldError[] = []

/**
 * SEC-CLAIM-04: a preview is publishable only while the current draft composes exactly the terms it was made from and
 * keeps its evidence deadline. Fails closed: a draft that cannot be mapped any more (for any reason but the evidence
 * window drifting with the clock, which toDraftTerms ignores) makes the preview stale too.
 */
function staleIssues(stored: StoredPreview, live: DraftTermsResult, deadline: number | undefined): PreviewIssue[] {
  const issues: PreviewIssue[] = []
  if (!live.ok) {
    const first = live.errors[0]?.message
    issues.push({ code: 'stale_preview', message: `The claim changed after this preview and cannot be sent to Pine as it is${first ? ` (${first})` : ''}. Fix it, then request a new preview.` })
  } else if (termsJson(live.terms) !== termsJson(termsOf(stored.input))) {
    issues.push({ code: 'stale_preview', message: 'You edited the claim after this preview. Request a new preview to publish the current terms.' })
  }
  if (deadline !== stored.chosenEvidenceDeadline) {
    issues.push({ code: 'stale_preview', field: 'evidence.evidenceDeadline', message: 'You changed the evidence deadline after this preview. Request a new preview to publish the new deadline.' })
  }
  return issues
}

function upsertStep(steps: PublicationStep[] | undefined, step: PublicationStep): PublicationStep[] {
  return [...(steps ?? []).filter((s) => s.id !== step.id), step]
}

const PUBLICATION_LIMITS = { maxTotalValueWei: 0n, maxApprovalAmount: 0n } as const

export function useApiPublish(draftId: string, options: UseApiPublishOptions = {}): ApiPublish {
  const { env, drafts: draftStore } = usePine()
  const api = useWriteApi()
  const qc = useQueryClient()
  const wallet = useWallet()
  const manifest = usePinnedManifest()
  const draftQ = useDraftQuery(draftId)
  const draft = draftQ.data ?? undefined
  const backend = draft?.publication?.backend
  const clockRef = useRef(options.now)
  useEffect(() => {
    clockRef.current = options.now
  })
  const now = useCallback(() => clockRef.current?.() ?? new Date(), [])
  const account = wallet.address?.toLowerCase() as Address | undefined

  const [stored, setStored] = useStoredRecord<StoredPreview>(`pine:api-preview:${draftId}`, isStoredPreview)
  const [op, setOp] = useState<'saving' | 'previewing' | null>(null)
  const [error, setError] = useState<WriteErrorInfo | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [publication, setPublication] = useState<PublicationView | null>(null)
  const noPlanRef = useRef<PublicationView | null>(null)

  /** Writes publication bookkeeping into the local draft (query cache and draft store). */
  const writeDraft = useCallback(
    async (patch: (p: NonNullable<ClaimDraft['publication']>) => NonNullable<ClaimDraft['publication']>) => {
      let next: ClaimDraft | undefined
      qc.setQueryData<ClaimDraft | null>(pineKeys.draft(draftId), (prev) => {
        if (!prev) return prev
        next = { ...prev, publication: patch(prev.publication ?? { steps: [] }), updatedAt: isoNow() }
        return next
      })
      if (next) {
        upsertDraftInCache(qc, next.owner, next)
        await draftStore.save(next)
      }
    },
    [qc, draftId, draftStore],
  )

  const live = useMemo(
    () => (draft ? toDraftInput(draft, { defaultBranch: options.defaultBranch, chainId: env.defaultChainId, now: now() }) : null),
    [draft, options.defaultBranch, env.defaultChainId, now],
  )
  // What the preview is compared with: the current terms (clock-independent) and the absolute deadline chosen.
  const liveTerms = useMemo(
    () => (draft ? toDraftTerms(draft, { defaultBranch: options.defaultBranch, chainId: env.defaultChainId }) : null),
    [draft, options.defaultBranch, env.defaultChainId],
  )
  const liveDeadline = draft ? chosenEvidenceDeadline(draft) : undefined
  // Pine's refusal of a save holds only for the terms it was given: any edit of them drops its issues (and its error),
  // so the user can save again; the same terms bring it back.
  const refusalApplies = refusal !== null && liveTerms !== null && liveTerms.ok && refusal.key === termsKey(liveTerms.terms, liveDeadline)
  const backendIssues = refusalApplies ? refusal.issues : NO_ISSUES
  const fieldErrors = useMemo(() => [...(live && !live.ok ? live.errors : []), ...backendIssues], [live, backendIssues])

  // The preview, verified again on every load and whenever the wallet changes. Until the draft is loaded there is
  // nothing to compare it with, so none is shown.
  const verified = useMemo(() => {
    if (!stored || !manifest || !liveTerms) return null
    const result = verifyPreview(stored.response, {
      input: stored.input,
      account,
      manifest,
      chainId: env.defaultChainId,
      draftRevision: stored.revision,
      chosenEvidenceDeadline: stored.chosenEvidenceDeadline,
    })
    const issues = [...result.issues]
    if (stored.backendDraftId !== backend?.draftId || stored.revision !== backend?.revision) {
      issues.push({ code: 'stale_preview', message: 'The draft was saved again after this preview. Request a new preview.' })
    }
    issues.push(...staleIssues(stored, liveTerms, liveDeadline))
    return { preview: result.preview, issues }
  }, [stored, manifest, account, env.defaultChainId, backend?.draftId, backend?.revision, liveTerms, liveDeadline])
  const preview = verified?.preview ?? null
  const verifyIssues = useMemo(() => verified?.issues ?? [], [verified])

  const latest = useRef({ preview, verifyIssues, account, manifest, backend })
  useEffect(() => {
    latest.current = { preview, verifyIssues, account, manifest, backend }
  })

  // The market Pine reports is accepted only once ClaimRegistry on the user's own RPC says it carries this document
  // and creator (the backend is never trusted for chain facts).
  const reader = useRegistryReader()
  const [market, setMarket] = useState<Address | null>(null)
  const checkedMarket = useRef<string | null>(null)
  const followPublication = useCallback(
    (view: PublicationView) => {
      setPublication(view)
      const reported = view.market?.toLowerCase() as Address | undefined
      const { preview: p, manifest: m } = latest.current
      if (!reported || !p || !m || !reader || checkedMarket.current === reported) return
      checkedMarket.current = reported
      readOnChainClaim(reader, m, reported).then(
        (claim) => {
          if (!claim || claim.claimDocumentSha256 !== p.documentSha256 || claim.creator !== p.document.creator) {
            checkedMarket.current = null
            setError({ code: 'PLAN_REJECTED', action: 'none', message: 'Pine reported a market that ClaimRegistry does not record for this claim. It was not saved.' })
            return
          }
          setMarket(reported)
          void writeDraft((pub) => ({ ...pub, marketAddress: reported, claimId: reported }))
        },
        () => {
          // RPC unavailable: check again with the next status.
          checkedMarket.current = null
        },
      )
    },
    [reader, writeDraft],
  )

  const action = usePlanAction({
    // The wallet is part of every runner key: a wallet switch discards a plan verified for another account.
    key: preview && account ? `api-publish:${draftId}:${account}:${preview.documentSha256}` : null,
    idleKey: `api-publish-idle:${draftId}`,
    limits: PUBLICATION_LIMITS,
    notReadyRetries: 0, // NOT_READY here usually means "being created": follow the publication instead
    sleep: options.sleep,
    now: () => now().getTime(),
    async create() {
      const client = requireWriteApi(api)
      const { preview: p, verifyIssues: issues, account: acct, manifest: m } = latest.current
      if (!p || issues.length > 0) throw new Error('Request a preview and resolve its issues before publishing.')
      if (!acct || !m) throw new Error('Connect the wallet you signed in with.')
      const res = await client.publish(p.previewId, p.documentSha256)
      const view = res.publication
      if (view.documentSha256.toLowerCase() !== p.documentSha256 || view.previewId !== p.previewId) {
        throw new PlanVerificationError(null, 'Pine answered with a publication for another document')
      }
      if (view.creator.toLowerCase() !== acct) throw new PlanVerificationError(null, 'the publication names another creator wallet')
      setPublication(view)
      void writeDraft((pub) => ({ ...pub, backend: pub.backend ? { ...pub.backend, publicationId: view.id } : pub.backend }))
      if (res.plan === null) {
        noPlanRef.current = view
        if (res.planExpired) throw new Error('The offer to publish this preview expired. Request a new preview.')
        throw new Error('Pine is already following this claim’s creation, so there is nothing to send.')
      }
      // SEC-TX-02: the single createClaim step must encode exactly the previewed document, byte for byte.
      checkCreateClaimPlan(res.plan, { document: p.document, documentSha256: p.documentSha256, account: acct, manifest: m })
      return { wire: res.plan, planId: view.id, expiresAt: Math.min(view.planExpiresAt, p.planExpiresAt) * 1000 }
    },
    async submitted(publicationId, _stepId, txHash) {
      // The publication route takes the hash only; the step is implied (one createClaim per publication).
      const view = await requireWriteApi(api).reportPublicationTx(publicationId, txHash)
      followPublication(view)
      await writeDraft((p) => ({
        ...p,
        steps: upsertStep(p.steps, { id: 'create_market', status: 'confirmed', txHash: txHash.toLowerCase() as Hex, at: isoNow() }),
      }))
    },
  })
  const { runner } = action

  // Follow the publication while Pine is indexing it: after a reload (state unknown), once a transaction was reported,
  // and when the createClaim step was mined before the report reached Pine. A planned publication with nothing sent is
  // not polled.
  const publicationId = publication?.id ?? backend?.publicationId ?? null
  const awaitingIndex =
    publication === null ||
    publication.state === 'submitted' ||
    publication.state === 'mined' ||
    (publication.state === 'planned' && runner.runner.state === 'done')
  usePolledStatus<PublicationView>({
    key: publicationId && awaitingIndex ? `publication:${publicationId}` : null,
    load: () => requireWriteApi(api).getPublication(publicationId ?? ''),
    done: (v) => FINAL_PUBLICATION_STATES.includes(v.state) || (v.state === 'planned' && !runnerHasSentSteps(runner)),
    onValue: followPublication,
    intervalMs: options.pollIntervalMs ?? 5_000,
    sleep: options.sleep ? (ms) => options.sleep?.(ms) ?? Promise.resolve() : undefined,
  })

  /** Terms are locked once a createClaim transaction may land (until the backend says it failed or expired). */
  const locked =
    publication?.state === 'submitted' ||
    publication?.state === 'mined' ||
    publication?.state === 'confirmed' ||
    (publication?.state !== 'failed' && publication?.state !== 'expired' && runnerHasSentSteps(runner))

  const saveDraftInternal = useCallback(async (): Promise<{ input: DraftInput; view: DraftView } | null> => {
    setError(null)
    setRefusal(null)
    if (!draft) {
      setError({ code: 'UNKNOWN', action: 'none', message: 'The draft is not loaded yet.' })
      return null
    }
    if (locked) {
      setError({ code: 'UNKNOWN', action: 'none', message: 'This claim is being published; its terms can no longer change.' })
      return null
    }
    const result = toDraftInput(draft, { defaultBranch: options.defaultBranch, chainId: env.defaultChainId, now: now() })
    if (!result.ok) return null
    setOp('saving')
    try {
      const client = requireWriteApi(api)
      let view: DraftView
      if (backend?.draftId) {
        try {
          view = await client.updateDraft(backend.draftId, result.input, backend.revision)
        } catch (e) {
          if (e instanceof PineBackendError && e.status === 404) view = await client.createDraft(result.input)
          else if (e instanceof PineBackendError && e.apiCode === 'CONFLICT') {
            // Saved elsewhere (another tab): this composer is the source of the terms, so overwrite at the new revision.
            const current = await client.getDraft(backend.draftId)
            view = await client.updateDraft(backend.draftId, result.input, current.revision)
          } else throw e
        }
      } else {
        view = await client.createDraft(result.input)
      }
      // A saved revision invalidates any earlier preview and publication offer (the backend refuses them).
      await writeDraft((p) => ({ ...p, backend: { draftId: view.id, revision: view.revision } }))
      setStored(null)
      setPublication(null)
      return { input: result.input, view }
    } catch (e) {
      const info = describeWriteError(e)
      setError(info)
      if (info.code === 'VALIDATION_FAILED') {
        setRefusal({
          key: termsKey(termsOf(result.input), chosenEvidenceDeadline(draft)),
          issues: (info.issues ?? []).map((i) => ({ field: i.path.map(String).filter((s) => s !== 'input').join('.'), composerPath: composerPathOf(i.path), message: i.message })),
          error: info,
        })
      }
      return null
    } finally {
      setOp(null)
    }
  }, [draft, locked, options.defaultBranch, env.defaultChainId, now, api, backend, writeDraft, setStored])

  const saveDraft = useCallback(async () => (await saveDraftInternal()) !== null, [saveDraftInternal])

  const requestPreview = useCallback(
    async (attestation: { liveSystemImpactNone: true }): Promise<boolean> => {
      if (attestation?.liveSystemImpactNone !== true) {
        setError({ code: 'UNKNOWN', action: 'fix_input', message: 'Confirm that no counterexample would demonstrate an exploitable flaw in a deployed system holding third-party funds or data.' })
        return false
      }
      const saved = await saveDraftInternal()
      if (!saved || !draft) return false
      setOp('previewing')
      try {
        const response = await requireWriteApi(api).preview(saved.view.id, { liveSystemImpactNone: true })
        setStored({
          v: 1,
          backendDraftId: saved.view.id,
          revision: saved.view.revision,
          input: saved.input,
          chosenEvidenceDeadline: chosenEvidenceDeadline(draft),
          response,
        })
        await writeDraft((p) => ({
          ...p,
          backend: { draftId: saved.view.id, revision: saved.view.revision, previewId: response.previewId, documentSha256: response.documentSha256.toLowerCase() as Hex },
        }))
        return true
      } catch (e) {
        setError(describeWriteError(e))
        return false
      } finally {
        setOp(null)
      }
    },
    [saveDraftInternal, draft, api, setStored, writeDraft],
  )

  const publish = useCallback(async () => {
    setError(null)
    noPlanRef.current = null
    const { preview: p, verifyIssues: issues, account: acct } = latest.current
    if (!p) {
      setError({ code: 'UNKNOWN', action: 'repreview', message: 'Request a preview first.' })
      return
    }
    if (issues.length > 0) {
      setError({ code: 'UNKNOWN', action: 'repreview', message: issues[0]?.message ?? 'The preview cannot be published.' })
      return
    }
    if (!acct || acct !== p.document.creator) {
      setError({ code: 'UNKNOWN', action: 'none', message: 'Connect the wallet named as the claim’s creator.' })
      return
    }
    if (p.planExpiresAt <= Math.floor(now().getTime() / 1000) && !runnerHasSentSteps(runner)) {
      setError({ code: 'CONFLICT', action: 'repreview', message: 'The offer to publish this preview expired. Request a new preview.' })
      return
    }
    await action.runWhenReady()
    // Set by create() during the run (TS keeps the narrowing from the reset above across the await).
    const noPlan = noPlanRef.current as PublicationView | null
    if (noPlan) {
      // Not an error: the claim is already being created (or exists), or the offer expired.
      action.clearError()
      followPublication(noPlan)
      if (noPlan.planExpired) setError({ code: 'CONFLICT', action: 'repreview', message: 'The offer to publish this preview expired. Request a new preview.' })
    }
  }, [action, runner, now, followPublication])

  const refresh = useCallback(async () => {
    const id = publication?.id ?? backend?.publicationId
    if (!api || !id) return
    try {
      followPublication(await api.getPublication(id))
    } catch (e) {
      setError(describeWriteError(e))
    }
  }, [api, publication?.id, backend?.publicationId, followPublication])

  const discardPreview = useCallback(() => {
    if (locked) return
    setStored(null)
    void writeDraft((p) => ({ ...p, backend: p.backend ? { draftId: p.backend.draftId, revision: p.backend.revision } : undefined }))
  }, [locked, setStored, writeDraft])

  const sent = runnerHasSentSteps(runner)
  let status: ApiPublishStatus
  if (publication?.state === 'confirmed') status = 'confirmed'
  else if (publication?.state === 'failed') status = 'failed'
  else if (publication?.state === 'expired' || (publication?.state === 'planned' && publication.planExpired && !sent)) status = 'expired'
  else if (publication && (publication.state === 'submitted' || publication.state === 'mined')) status = 'confirming'
  else if (runnerIsBusy(runner)) status = 'publishing'
  else if (sent) status = 'confirming'
  else if (op === 'saving') status = 'saving'
  else if (op === 'previewing') status = 'previewing'
  else if (preview && verifyIssues.length > 0) status = 'blocked'
  else if (preview) status = 'reviewable'
  else if (fieldErrors.length > 0) status = 'invalid'
  else if (backend) status = 'saved'
  else status = 'idle'

  const runnerError = runner.error ?? runner.runner.error ?? null
  const shownError =
    (refusal !== null && error === refusal.error && !refusalApplies ? null : error) ??
    action.lastError ??
    (runnerError && !noPlanRef.current ? { code: 'UNKNOWN' as const, action: 'none' as const, message: runnerError } : null)

  return {
    status,
    draft,
    backend,
    fieldErrors,
    preview,
    verifyIssues,
    runner,
    publication,
    market,
    error: shownError,
    busy: op !== null || runnerIsBusy(runner),
    saveDraft,
    requestPreview,
    publish,
    refresh,
    discardPreview,
  }
}
