'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { buildPublishSteps, COPY } from '@pine/core'
import type { Address, ClaimDraft, Hex, PublicationStep, TxStep, TxStepId } from '@pine/core'
import { seerMarketUrl } from '@pine/core/chains'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { useWallet } from '../wallet'
import { fakeAddress, isoNow } from '../internal/util'
import { useDraftQuery } from '../composer/use-claim-composer'
import { publishRunKey, upsertDraftInCache } from '../composer/drafts'
import { deriveComposer, isDraftFrozen, ZERO_ADDRESS, type ComposerDerived } from '../composer/defaults'
import { useTxMachine, type TxRunner } from '../tx/use-tx-runner'
import { isManualStep, type StepOutcome, type TxRunnerStep } from '../tx/machine'
import { buildDemoClaimDetail, buildDemoPublishActivity } from './demo-claim'
import { allocateDemoNumber, demoWriter, marketFromReceipt } from './shared'

export const PENDING_MANIFEST_URI = 'ipfs://pending-upload'

export interface PublishClaim extends TxRunner {
  claimId?: string
  marketAddress?: Address
  // Additive
  manifestUri?: string
  manifestHash?: Hex
  /** Reasons the publication cannot start (invalid draft, gated policy, no wallet, unverified contracts) */
  blockers: string[]
  ready: boolean
  draft?: ClaimDraft
  /** Terms frozen (create_market confirmed) */
  frozen: boolean
}

interface UploadResult {
  uri: string
  hash: Hex
  cid?: string
  gatewayUrl?: string
}

function upsertStep(steps: PublicationStep[] | undefined, step: PublicationStep): PublicationStep[] {
  const rest = (steps ?? []).filter((s) => s.id !== step.id)
  return [...rest, step]
}

/**
 * Publishes a draft: pin manifest → create market (terms freeze) → approve exact collateral → split →
 * add liquidity (manual, on the DEX) . Progress is persisted both in the tx runner storage and in
 * `draft.publication`, so a partial publication can be resumed from the composer or the dashboard.
 *
 * Demo mode: runs against the simulated wallet; on completion the claim is added to the
 * MockDataProvider (it then appears in explore, dashboards and the agent API of this browser).
 */
export function usePublishClaim(draftId: string): PublishClaim {
  const { data, storage, demo, drafts: draftStore } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const session = useSession()
  const login = (session.data?.user as { login?: string } | undefined)?.login
  const draftQ = useDraftQuery(draftId)
  const draft = draftQ.data ?? undefined
  const creator = (wallet.address ?? ZERO_ADDRESS) as Address

  const derived = useMemo<ComposerDerived | undefined>(
    () => (draft ? deriveComposer(draft, { creator }) : undefined),
    [draft, creator],
  )

  const latest = useRef<{ draft?: ClaimDraft; derived?: ComposerDerived }>({})
  useEffect(() => {
    latest.current = { draft, derived }
  })

  const frozen = isDraftFrozen(draft)

  const buildSteps = useCallback(
    (d: ClaimDraft, der: ComposerDerived, overrides?: { manifestUri?: string; manifestHash?: Hex; market?: Address }): TxStep[] => {
      if (!der.question || !der.manifestHash) return []
      return buildPublishSteps({
        chainId: der.fundingInput.chainId,
        manifestUri: overrides?.manifestUri ?? d.publication?.manifestUri ?? PENDING_MANIFEST_URI,
        manifestHash: overrides?.manifestHash ?? d.publication?.manifestHash ?? der.manifestHash,
        question: der.question,
        oracle: der.spec.oracle,
        funding: der.fundingInput,
        creator,
        market: overrides?.market ?? d.publication?.marketAddress,
        allowPlaceholderAddresses: demo,
      })
    },
    [creator, demo],
  )

  const { steps, buildError } = useMemo(() => {
    if (!draft || !derived) return { steps: [] as TxStep[], buildError: undefined }
    try {
      return { steps: buildSteps(draft, derived), buildError: undefined }
    } catch (e) {
      return { steps: [] as TxStep[], buildError: e instanceof Error ? e.message : String(e) }
    }
  }, [draft, derived, buildSteps])

  /** Writes publication progress into the draft (cache + store). */
  const writePublication = useCallback(
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

  const handlers = useMemo(
    () => ({
      upload_manifest: async (): Promise<StepOutcome> => {
        const der = latest.current.derived
        if (!der?.manifest || !der.manifestHash) throw new Error('The claim manifest is incomplete. Finish the composer first.')
        const r = await storage.putJson(der.manifest, `${der.claimId}.manifest.json`)
        if (r.hash.toLowerCase() !== der.manifestHash.toLowerCase()) {
          throw new Error(
            `Storage reported content hash ${r.hash}, but the manifest hash is ${der.manifestHash}. Publication stopped so the published terms cannot differ from what you reviewed.`,
          )
        }
        await writePublication((p) => ({ ...p, manifestUri: r.uri, manifestHash: r.hash, claimId: der.claimId }))
        const result: UploadResult = { uri: r.uri, hash: r.hash, cid: r.cid, gatewayUrl: r.gatewayUrl }
        return { result }
      },
    }),
    [storage, writePublication],
  )

  /** Latest draft: the query cache is updated synchronously by writePublication, before re-render. */
  const currentDraft = useCallback(
    () => qc.getQueryData<ClaimDraft | null>(pineKeys.draft(draftId)) ?? latest.current.draft,
    [qc, draftId],
  )

  const prepare = useCallback(
    (step: TxStep, results: Partial<Record<TxStepId, unknown>>): TxStep => {
      const d = currentDraft()
      const der = latest.current.derived
      if (!d || !der) return step
      const upload = results.upload_manifest as UploadResult | undefined
      const market =
        (results.create_market as { market?: Address } | undefined)?.market ??
        marketFromReceipt(results.create_market) ??
        d.publication?.marketAddress
      try {
        const rebuilt = buildSteps(d, der, {
          manifestUri: upload?.uri ?? d.publication?.manifestUri,
          manifestHash: upload?.hash ?? d.publication?.manifestHash,
          market,
        })
        return rebuilt.find((s) => s.id === step.id) ?? step
      } catch {
        return step
      }
    },
    [buildSteps, currentDraft],
  )

  const onConfirmed = useCallback(
    async (step: TxRunnerStep, outcome?: StepOutcome) => {
      let market: Address | undefined
      if (step.id === 'create_market') {
        market =
          marketFromReceipt(outcome?.result) ??
          (demo ? fakeAddress('market', latest.current.derived?.claimId ?? draftId) : undefined)
      }
      await writePublication((p) => ({
        ...p,
        ...(market ? { marketAddress: market } : {}),
        claimId: p.claimId ?? latest.current.derived?.claimId,
        steps: upsertStep(p.steps, { id: step.id, status: 'confirmed', txHash: outcome?.txHash ?? step.txHash, at: isoNow() }),
      }))
    },
    [demo, draftId, writePublication],
  )

  const onFailed = useCallback(
    (step: TxRunnerStep) => {
      void writePublication((p) => ({
        ...p,
        steps: upsertStep(p.steps, { id: step.id, status: 'failed', error: step.error, txHash: step.txHash, at: isoNow() }),
      }))
    },
    [writePublication],
  )

  const onDone = useCallback(async () => {
    const d = latest.current.draft
    const der = latest.current.derived
    if (!d || !der?.policy) return
    const fresh = qc.getQueryData<ClaimDraft | null>(pineKeys.draft(draftId)) ?? d
    const pub = fresh.publication
    const writer = demoWriter(data)
    if (writer && der.manifest && pub?.manifestUri) {
      const txHashes: Partial<Record<string, Hex>> = {}
      for (const s of pub.steps ?? []) if (s.txHash) txHashes[s.id] = s.txHash
      const number = await allocateDemoNumber(data)
      // Use the manifest that was pinned (same hash), with the creator that published it.
      const detail = buildDemoClaimDetail({
        draft: fresh,
        manifest: der.manifest,
        manifestHash: pub.manifestHash ?? (der.manifestHash as Hex),
        manifestUri: pub.manifestUri,
        policy: der.policy,
        funding: der.fundingInput,
        plan: der.funding,
        number,
        creator,
        creatorGithub: login,
        marketAddress: pub.marketAddress,
        txHashes,
      })
      writer.addClaim(detail)
      for (const a of buildDemoPublishActivity(detail, txHashes, isoNow())) writer.recordActivity(a)
    }
    await writePublication((p) => ({ ...p, claimId: p.claimId ?? der.claimId }))
    await qc.invalidateQueries({
      predicate: (q) => q.queryKey[0] === 'pine' && q.queryKey[1] !== 'draft' && q.queryKey[1] !== 'drafts',
    })
  }, [qc, draftId, data, creator, login, writePublication])

  const manualUrl = useCallback(
    (step: TxStep, results: Partial<Record<TxStepId, unknown>>) => {
      const d = currentDraft()
      const chainId = latest.current.derived?.fundingInput.chainId ?? 100
      const market = d?.publication?.marketAddress ?? marketFromReceipt(results.create_market)
      return isManualStep(step) && market ? seerMarketUrl(chainId, market) : undefined
    },
    [currentDraft],
  )

  const { runner } = useTxMachine(publishRunKey(draftId), steps, {
    spendingLimit: derived?.fundingInput.spendingLimit,
    handlers,
    prepare,
    onConfirmed,
    onFailed,
    onDone,
    manualUrl,
  })

  const blockers = useMemo(() => {
    const out: string[] = []
    if (!draft) {
      out.push(draftQ.isLoading ? 'Loading draft…' : 'Draft not found.')
      return out
    }
    if (!frozen && derived) {
      if (!derived.validation.ok) {
        const n = derived.validation.issues.length
        out.push(`Fix ${n} issue${n === 1 ? '' : 's'} in the claim before publishing.`)
      }
      if (derived.policy && derived.policy.status === 'gated') out.push(derived.policy.gateReason ?? COPY.scGate)
      if (!derived.policy) out.push('Choose a policy.')
      if (!draft.source) out.push('Pin a commit first.')
    }
    if (buildError) out.push(buildError)
    if (derived?.buildError) out.push(derived.buildError)
    if (!wallet.isConnected) out.push('Connect a wallet to publish.')
    if (!demo) {
      const missing = steps.filter(
        (s) => s.kind === 'transaction' && !s.request && !isManualStep(s) && s.id !== 'split_position',
      )
      if (missing.length > 0) {
        out.push(
          `Contract addresses for this chain are unverified placeholders, so ${missing.map((s) => s.label).join(', ')} cannot be sent. Publishing is disabled until they are verified.`,
        )
      }
    }
    return out
  }, [draft, draftQ.isLoading, frozen, derived, buildError, wallet.isConnected, demo, steps])

  const [localError, setLocalError] = useState<string | undefined>()
  const start = useCallback(async () => {
    if (blockers.length > 0) {
      setLocalError(blockers[0])
      return
    }
    setLocalError(undefined)
    await runner.start()
  }, [blockers, runner])

  const pub = draft?.publication
  return {
    ...runner,
    start,
    retry: start,
    error: localError ?? runner.error,
    claimId: runner.state === 'done' ? (pub?.claimId ?? derived?.claimId) : undefined,
    marketAddress: pub?.marketAddress,
    manifestUri: pub?.manifestUri,
    manifestHash: pub?.manifestHash ?? derived?.manifestHash,
    blockers,
    ready: blockers.length === 0,
    draft,
    frozen,
  }
}
