'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { buildEvidenceTx, evidenceDraftSchema, hashJson } from '@pine/core'
import type { ClaimDetail, Evidence, EvidenceDraft, Hex, TxStep, TxStepId } from '@pine/core'
import { usePine } from '../providers/context'
import { pineKeys } from '../queries/keys'
import { useClaim } from '../queries'
import { useWallet } from '../wallet'
import { getBrowserStorage, writeJson } from '../internal/storage'
import { fakeHash, isoNow } from '../internal/util'
import { useTxMachine, type TxRunner } from '../tx/use-tx-runner'
import type { StepOutcome } from '../tx/machine'
import { arbitrationChainId, demoWriter } from './shared'

export const EVIDENCE_PACKAGE_SCHEMA = 'https://pine.dev/schemas/evidence-package/v1.json'
export const COMMITMENT_URI_PREFIX = 'pine:commitment:'

export interface SubmitEvidence {
  submit(draft: EvidenceDraft): Promise<void>
  runner: TxRunner
  // Additive
  /** URI of the uploaded evidence package (direct mode) */
  evidenceUri?: string
  /** keccak256 of the canonical evidence package */
  contentHash?: Hex
  /** Chain where evidence is submitted (Ethereum for Gnosis markets) */
  chainId: number
  /** Clears a finished/failed submission so another can be filed */
  reset(): void
  blockers: string[]
}

/** ERC-1497 evidence JSON with Pine's reproduction block under `pine`. */
export function buildEvidencePackage(draft: EvidenceDraft, ctx: { submitter?: string; claim?: ClaimDetail; at: string }) {
  return {
    name: draft.title,
    description: draft.summary,
    pine: {
      schema: EVIDENCE_PACKAGE_SCHEMA,
      claimId: draft.claimId,
      manifestHash: ctx.claim?.manifestHash,
      commit: ctx.claim?.source.commitSha,
      kind: draft.kind,
      reproduction: draft.reproduction,
      attachments: draft.attachments,
      submitter: ctx.submitter,
      preparedAt: ctx.at,
    },
  }
}

/**
 * Evidence submission. Direct mode: upload the evidence package (JSON) → `submitEvidence` on the
 * Reality.eth↔Kleros arbitrator proxy. Commit mode (front-running mitigation; a launch gate): only the
 * package hash is submitted first; the package is kept locally (`pine:evidence-reveal:<hash>`) to
 * reveal later.
 *
 * Evidence lives on Ethereum (chain 1) even for Gnosis markets, so the live wallet is switched to
 * chain 1 before the prompt (the demo wallet simulates the switch).
 */
export function useSubmitEvidence(claimId: string): SubmitEvidence {
  const { data, storage, demo } = usePine()
  const qc = useQueryClient()
  const wallet = useWallet()
  const claimQ = useClaim(claimId)
  const claim = claimQ.data ?? undefined
  const marketChainId = claim?.chainId ?? 100
  /** Evidence/arbitration chain (Ethereum for Gnosis markets) */
  const chainId = arbitrationChainId(marketChainId)
  const questionId = (claim?.oracle?.realityQuestionId ?? claim?.market?.questionId) as Hex | undefined

  const [pending, setPending] = useState<{ draft: EvidenceDraft; pkg: unknown; contentHash: Hex } | null>(null)
  const pendingRef = useRef(pending)
  const [evidenceUri, setEvidenceUri] = useState<string | undefined>()

  const buildSteps = useCallback(
    (mode: EvidenceDraft['mode'], uri: string): TxStep[] => {
      if (!questionId) return []
      // buildEvidenceTx takes the market chain and targets the arbitration chain (request.chainId).
      const tx = buildEvidenceTx({ chainId: marketChainId, questionId, evidenceUri: uri, allowPlaceholderAddresses: demo })
      if (mode === 'commit') {
        return [{ ...tx, label: 'Submit evidence commitment', description: `Records only the hash of your evidence package on-chain now; reveal the package later. ${tx.description}` }]
      }
      return [
        {
          id: 'upload_evidence',
          label: 'Upload evidence package',
          description: 'Pins the evidence JSON (title, summary, reproduction, attachment list) to IPFS. The content becomes public.',
          kind: 'offchain',
        },
        tx,
      ]
    },
    [questionId, marketChainId, demo],
  )

  const steps = useMemo(
    () => (pending ? buildSteps(pending.draft.mode, pending.draft.mode === 'commit' ? `${COMMITMENT_URI_PREFIX}${pending.contentHash}` : 'ipfs://pending-upload') : []),
    [pending, buildSteps],
  )

  const handlers = useMemo(
    () => ({
      upload_evidence: async (): Promise<StepOutcome> => {
        const p = pendingRef.current
        if (!p) throw new Error('Nothing to upload.')
        const r = await storage.putJson(p.pkg, `${claimId}.evidence.json`)
        setEvidenceUri(r.uri)
        return { result: { uri: r.uri, hash: r.hash } }
      },
    }),
    [storage, claimId],
  )

  const prepare = useCallback(
    (step: TxStep, results: Partial<Record<TxStepId, unknown>>): TxStep => {
      const p = pendingRef.current
      if (step.id !== 'submit_evidence' || !p) return step
      const uri =
        p.draft.mode === 'commit'
          ? `${COMMITMENT_URI_PREFIX}${p.contentHash}`
          : (results.upload_evidence as { uri?: string } | undefined)?.uri
      if (!uri) throw new Error('The evidence package was not uploaded.')
      return buildSteps(p.draft.mode, uri).find((s) => s.id === 'submit_evidence') ?? step
    },
    [buildSteps],
  )

  const onDone = useCallback(
    async (snap: { steps: { id: TxStepId; txHash?: Hex }[]; results: Partial<Record<TxStepId, unknown>> }) => {
      const p = pendingRef.current
      if (!p) return
      const writer = demoWriter(data)
      const txHash = snap.steps.find((s) => s.id === 'submit_evidence')?.txHash ?? fakeHash('evidence', claimId, Date.now())
      const uri =
        p.draft.mode === 'commit'
          ? `${COMMITMENT_URI_PREFIX}${p.contentHash}`
          : ((snap.results.upload_evidence as { uri?: string } | undefined)?.uri ?? '')
      const at = isoNow()
      if (writer) {
        const deadline = claim?.evidenceDeadline ? Date.parse(claim.evidenceDeadline) : Number.POSITIVE_INFINITY
        const evidence: Evidence = {
          id: `${claimId}-ev-${p.contentHash.slice(2, 10)}`,
          claimId,
          kind: p.draft.mode === 'commit' ? 'commitment' : p.draft.kind,
          title: p.draft.title,
          summary: p.draft.mode === 'commit' ? 'Commitment: the evidence package hash was recorded; the package is not revealed yet.' : p.draft.summary,
          submitter: wallet.address ?? ('0x0000000000000000000000000000000000000000' as Hex),
          submittedAt: at,
          blockNumber: 0,
          txHash,
          chainId,
          uri,
          contentHash: p.contentHash,
          timely: Date.now() <= deadline,
          ...(p.draft.mode === 'direct' && p.draft.reproduction ? { reproduction: p.draft.reproduction } : {}),
          attachments:
            p.draft.mode === 'direct'
              ? p.draft.attachments.map((a) => ({ ...a, uri: `${uri}#${encodeURIComponent(a.name)}`, hash: hashJson(a) }))
              : [],
          ...(p.draft.mode === 'commit' ? { commitment: { hash: p.contentHash, revealed: false } } : {}),
        }
        writer.addEvidence(claimId, evidence)
        if (claim) {
          writer.recordActivity({
            id: `${evidence.id}-act`,
            type: 'evidence_submitted',
            claimId,
            claimNumber: claim.number,
            claimTitle: claim.title,
            actor: evidence.submitter,
            at,
            txHash,
            chainId,
            summary: p.draft.mode === 'commit' ? 'Submitted an evidence commitment' : `Submitted evidence: ${p.draft.title}`,
            status: 'confirmed',
          })
        }
      }
      await qc.invalidateQueries({ queryKey: pineKeys.evidence(claimId) })
      await qc.invalidateQueries({ queryKey: pineKeys.claim(claimId) })
      await qc.invalidateQueries({ queryKey: ['pine', 'activity'] })
    },
    [data, claimId, claim, wallet.address, chainId, qc],
  )

  const { runner, machine } = useTxMachine(`evidence:${claimId}`, steps, { handlers, prepare, onDone })

  const blockers = useMemo(() => {
    const out: string[] = []
    if (claimQ.isLoading) out.push('Loading claim…')
    else if (!claim) out.push('Claim not found.')
    else if (!questionId) out.push('This claim has no oracle question yet, so evidence cannot be linked to it.')
    if (!wallet.isConnected) out.push('Connect a wallet to submit evidence.')
    return out
  }, [claimQ.isLoading, claim, questionId, wallet.isConnected])

  const submit = useCallback(
    async (draft: EvidenceDraft) => {
      if (blockers.length > 0) throw new Error(blockers[0])
      // A second submit while one is running would swap the package under the running upload/submit steps.
      const state = machine.getSnapshot().state
      if (state === 'running') throw new Error('An evidence submission is already in progress. Wait for it to finish.')
      const parsed = evidenceDraftSchema.safeParse(draft)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(issue ? `${issue.path.join('.') || 'evidence'}: ${issue.message}` : 'The evidence draft is invalid.')
      }
      const at = isoNow()
      const pkg = buildEvidencePackage(draft, { submitter: wallet.address, claim, at })
      const contentHash = hashJson(pkg)
      if (draft.mode === 'commit') {
        writeJson(getBrowserStorage(), `pine:evidence-reveal:${contentHash}`, { claimId, pkg, committedAt: at })
      }
      const next = { draft, pkg, contentHash }
      pendingRef.current = next
      setPending(next)
      setEvidenceUri(undefined)
      machine.reset()
      machine.setSteps(buildSteps(draft.mode, draft.mode === 'commit' ? `${COMMITMENT_URI_PREFIX}${contentHash}` : 'ipfs://pending-upload'))
      await machine.start()
      const snap = machine.getSnapshot()
      if (snap.state === 'failed') {
        const failed = snap.steps.find((s) => s.status === 'failed')
        throw new Error(failed?.error ?? 'Evidence submission failed.')
      }
      if (snap.error && snap.state !== 'done') throw new Error(snap.error)
    },
    [blockers, wallet.address, claim, claimId, machine, buildSteps],
  )

  const reset = useCallback(() => {
    machine.reset()
    pendingRef.current = null
    setPending(null)
    setEvidenceUri(undefined)
  }, [machine])

  return { submit, runner, evidenceUri, contentHash: pending?.contentHash, chainId, reset, blockers }
}
