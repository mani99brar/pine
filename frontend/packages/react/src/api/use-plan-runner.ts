'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Hex, TxStep } from '@pine/core'
import type { Address, Hex32, PlanLimits, TxPlan } from '@pine/core/pine-shared'
import { newIdempotencyKey } from '@pine/data'
import { usePine } from '../providers/context'
import { useWallet } from '../wallet'
import { getBrowserStorage, readJson, removeKey, writeJson } from '../internal/storage'
import { errorMessage, sleep } from '../internal/util'
import { useTxMachine, type TxRunner } from '../tx/use-tx-runner'
import type { TxRunnerStep, StepOutcome } from '../tx/machine'
import { pinnedManifest, planStepIdOf, planToTxSteps, verifyWirePlan, type RegistryReader } from './plans'

/** One backend plan as the API returns it. */
export interface CreatedPlan {
  /** The wire plan (`plan` of the response); decoded and verified here, never trusted. */
  wire: unknown
  /** The backend plan id (`planState.id` / publication id) used for `/submitted` reports. */
  planId: string
}

export interface ApiPlanSpec {
  /** Stable key of the action (e.g. `evidence-commit:<market>:<sha>`): persists the idempotency key and the plan. */
  key: string
  /** Creates the plan on the backend with this idempotency key (a retry with the same key returns the same plan). */
  create(idempotencyKey: string): Promise<CreatedPlan>
  /** Reports a mined step to the backend (POST …/submitted {stepId, txHash}). */
  submitted(planId: string, stepId: string, txHash: Hex): Promise<void>
  /** Markets the plan may reference; read from ClaimRegistry on chain. */
  markets?: Address[]
  reopenedQuestionIds?: Hex32[]
  limits: PlanLimits
  onDone?(): void | Promise<void>
}

interface StoredPlan {
  idempotencyKey: string
  wire?: unknown
  planId?: string
}

export type ApiPlanPhase = 'idle' | 'planning' | 'verified' | 'error'

export interface ApiPlanRunner {
  phase: ApiPlanPhase
  plan: TxPlan | null
  steps: TxStep[]
  runner: TxRunner
  error: string | null
  /** Creates and verifies the plan when needed, then starts (or resumes) the wallet steps. */
  run(): Promise<void>
  /** Forgets the stored plan and its progress (e.g. after it expired) so the next run creates a new one. */
  discard(): void
}

const STORE_PREFIX = 'pine:apiplan:'

/**
 * Runs one backend transaction plan: create (idempotent) → verify in the browser (pinned manifest, on-chain market
 * context, limits) → send each step from the user's wallet with the resumable runner → report each mined step.
 * Nothing reaches the wallet unless verification passed; a plan stored from an earlier visit is verified again.
 */
export function useApiPlanRunner(spec: ApiPlanSpec): ApiPlanRunner {
  const { env } = usePine()
  const wallet = useWallet()
  const publicClient = usePublicClient({ chainId: env.defaultChainId })
  const storage = getBrowserStorage()
  const storeKey = `${STORE_PREFIX}${spec.key}`
  const specRef = useRef(spec)
  useEffect(() => {
    specRef.current = spec
  })

  const [phase, setPhase] = useState<ApiPlanPhase>('idle')
  const [plan, setPlan] = useState<TxPlan | null>(null)
  const [error, setError] = useState<string | null>(null)

  const manifest = useMemo(() => {
    try {
      return pinnedManifest(env)
    } catch {
      return null
    }
  }, [env])

  const steps = useMemo(() => (plan && manifest ? planToTxSteps(plan, manifest) : []), [plan, manifest])

  const verify = useCallback(
    async (wire: unknown): Promise<TxPlan> => {
      if (!manifest) throw new Error('This build has no Pine deployment configured, so it cannot verify transactions.')
      if (!publicClient) throw new Error(`No RPC is configured for chain ${env.defaultChainId}.`)
      if (!wallet.address) throw new Error('Connect the wallet you signed in with.')
      const s = specRef.current
      const { plan: verified } = await verifyWirePlan(wire, {
        manifest,
        account: wallet.address,
        reader: publicClient as unknown as RegistryReader,
        markets: s.markets,
        reopenedQuestionIds: s.reopenedQuestionIds,
        limits: s.limits,
      })
      return verified
    },
    [manifest, publicClient, wallet.address, env.defaultChainId],
  )

  // Another action (key): forget the plan loaded for the previous one.
  useEffect(() => {
    setPlan(null)
    setPhase('idle')
    setError(null)
  }, [storeKey])

  // A plan stored by an earlier visit is shown only after it verifies again.
  useEffect(() => {
    const stored = readJson<StoredPlan>(storage, storeKey)
    if (!stored?.wire || plan) return
    let cancelled = false
    verify(stored.wire).then(
      (p) => {
        if (cancelled) return
        setPlan(p)
        setPhase('verified')
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [storage, storeKey, verify, plan])

  const report = useCallback(
    async (step: TxRunnerStep, outcome?: StepOutcome) => {
      const stepId = planStepIdOf(step.id)
      const stored = readJson<StoredPlan>(storage, storeKey)
      const txHash = outcome?.txHash ?? step.txHash
      if (!stepId || !stored?.planId || !txHash) return
      // The transaction is already mined: a failed report must not fail the step. The backend also confirms plans
      // from chain facts; retry a few times for prompt status.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await specRef.current.submitted(stored.planId, stepId, txHash)
          return
        } catch (e) {
          if (attempt === 2) console.warn(`Pine: could not report step ${stepId}: ${errorMessage(e)}`)
          else await sleep(800 * (attempt + 1))
        }
      }
    },
    [storage, storeKey],
  )

  const { runner, machine } = useTxMachine(`api:${spec.key}`, steps, {
    onConfirmed: report,
    onDone: () => specRef.current.onDone?.(),
  })

  const run = useCallback(async () => {
    setError(null)
    try {
      const stored = readJson<StoredPlan>(storage, storeKey)
      let current: TxPlan
      if (stored?.wire && stored.planId) {
        // Verified again on every run, against the wallet connected NOW (it may differ from when it was loaded).
        current = await verify(stored.wire)
      } else {
        setPhase('planning')
        // The idempotency key is persisted BEFORE the request: a crash or reload retries with the same key.
        const idempotencyKey = stored?.idempotencyKey ?? newIdempotencyKey()
        writeJson(storage, storeKey, { ...stored, idempotencyKey } satisfies StoredPlan)
        const created = await specRef.current.create(idempotencyKey)
        current = await verify(created.wire)
        writeJson(storage, storeKey, { idempotencyKey, wire: created.wire, planId: created.planId } satisfies StoredPlan)
      }
      setPlan(current)
      setPhase('verified')
      if (!manifest) throw new Error('This build has no Pine deployment configured, so it cannot verify transactions.')
      // Hand the verified steps to the machine now (the render-time sync happens a tick later).
      machine.setSteps(planToTxSteps(current, manifest))
      await machine.start()
    } catch (e) {
      setError(errorMessage(e))
      setPhase('error')
    }
  }, [storage, storeKey, verify, machine, manifest])

  const discard = useCallback(() => {
    removeKey(storage, storeKey)
    runner.reset()
    setPlan(null)
    setPhase('idle')
    setError(null)
  }, [storage, storeKey, runner])

  return { phase, plan, steps, runner, error, run, discard }
}
