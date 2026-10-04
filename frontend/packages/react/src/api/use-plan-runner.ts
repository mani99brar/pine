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
  /**
   * When the offer ends, in ms since the epoch: the backend's offer expiry, or earlier (e.g. a mint deadline in the
   * plan). No step of the plan is sent after it, and a plan without it is never run.
   */
  expiresAt?: number
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
  /** Extra question ids derived on chain by the caller (never from the Pine API); see VerifyOptions. */
  reopenedQuestionIds?: Hex32[]
  limits: PlanLimits
  onDone?(): void | Promise<void>
  /** Clock in ms since the epoch (tests); default Date.now. */
  now?: () => number
}

interface StoredPlan {
  idempotencyKey: string
  wire?: unknown
  planId?: string
  /** Offer expiry, ms since the epoch. */
  expiresAt?: number
}

export type ApiPlanPhase = 'idle' | 'planning' | 'verified' | 'error'

export interface ApiPlanRunner {
  phase: ApiPlanPhase
  plan: TxPlan | null
  steps: TxStep[]
  runner: TxRunner
  error: string | null
  /** Offer expiry of the loaded plan (ms since the epoch); null when no plan is loaded or it states none. */
  expiresAt: number | null
  /**
   * A verified plan stopped part way without failing (e.g. reloaded while a step waited in the wallet): `run()` continues
   * it, verifying the stored plan again first.
   */
  canResume: boolean
  /** Creates and verifies the plan when needed, then starts (or resumes) the wallet steps. */
  run(): Promise<void>
  /** Forgets the stored plan and its progress (e.g. after it expired) so the next run creates a new one. */
  discard(): void
  /** Forgets the plan shown, in memory only: its stored plan, idempotency key and progress stay. */
  forget(): void
}

const STORE_PREFIX = 'pine:apiplan:'

export const PLAN_OFFER_EXPIRED = 'This plan’s offer has expired, so its remaining steps are not sent. Nothing more was sent; start the action again for a fresh plan.'
const PLAN_OFFER_UNKNOWN = 'This plan does not say when its offer ends, so its steps are not sent. Nothing was sent; start the action again.'

const expiryOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** Why no further step of a plan may be sent (its offer ended, or it states no expiry); null while the offer runs. */
function offerProblem(expiresAt: number | undefined, now: number): string | null {
  if (expiresAt === undefined) return PLAN_OFFER_UNKNOWN
  return expiresAt <= now ? PLAN_OFFER_EXPIRED : null
}

/** Steps that were never sent (no transaction hash) and are not done. */
function hasUnsentSteps(steps: readonly TxRunnerStep[]): boolean {
  return steps.some((s) => s.status !== 'confirmed' && s.status !== 'skipped' && !s.txHash)
}

/**
 * Runs one backend transaction plan: create (idempotent) → verify in the browser (pinned manifest, on-chain market
 * context, limits) → send each step from the user's wallet with the resumable runner → report each mined step.
 * Nothing reaches the wallet unless verification passed; a plan stored from an earlier visit is verified again, and
 * no step is sent after the plan's offer expired.
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
  const clock = useCallback(() => (specRef.current.now ?? Date.now)(), [])

  const [phase, setPhase] = useState<ApiPlanPhase>('idle')
  const [plan, setPlan] = useState<TxPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [active, setActive] = useState(false)

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

  const forget = useCallback(() => {
    setPlan(null)
    setPhase('idle')
    setError(null)
    setExpiresAt(null)
  }, [])

  // Another action (key): forget the plan loaded for the previous one.
  useEffect(() => {
    forget()
  }, [storeKey, forget])

  // A plan stored by an earlier visit is shown only after it verifies again.
  useEffect(() => {
    const stored = readJson<StoredPlan>(storage, storeKey)
    if (!stored?.wire || plan) return
    let cancelled = false
    verify(stored.wire).then(
      (p) => {
        if (cancelled) return
        setPlan(p)
        setExpiresAt(expiryOf(stored.expiresAt) ?? null)
        setPhase('verified')
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [storage, storeKey, verify, plan])

  // Reports go to the plan stored under this key, through this key's own spec (see useTxMachine): a step of a run that
  // continues after the hook moved on to another action is never reported under that action's plan.
  const report = useCallback(
    async (step: TxRunnerStep, outcome: StepOutcome | undefined, submitted: ApiPlanSpec['submitted']) => {
      const stepId = planStepIdOf(step.id)
      const stored = readJson<StoredPlan>(storage, storeKey)
      const txHash = outcome?.txHash ?? step.txHash
      if (!stepId || !stored?.planId || !txHash) return
      // The transaction is already mined: a failed report must not fail the step. The backend also confirms plans
      // from chain facts; retry a few times for prompt status.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await submitted(stored.planId, stepId, txHash)
          return
        } catch (e) {
          if (attempt === 2) console.warn(`Pine: could not report step ${stepId}: ${errorMessage(e)}`)
          else await sleep(800 * (attempt + 1))
        }
      }
    },
    [storage, storeKey],
  )

  // Checked right before every step is sent, whoever started the run (run(), runner.start() or runner.retry()).
  const requireLiveOffer = useCallback(
    (step: TxStep): TxStep => {
      const stored = readJson<StoredPlan>(storage, storeKey)
      const problem = offerProblem(expiryOf(stored?.expiresAt), clock())
      if (problem) throw new Error(problem)
      return step
    },
    [storage, storeKey, clock],
  )

  const { runner, machine } = useTxMachine(`api:${spec.key}`, steps, {
    onConfirmed: (step, outcome) => report(step, outcome, spec.submitted),
    onDone: () => spec.onDone?.(),
    prepare: requireLiveOffer,
  })

  const run = useCallback(async () => {
    setError(null)
    setActive(true)
    try {
      const stored = readJson<StoredPlan>(storage, storeKey)
      let current: TxPlan
      let offer: number | undefined
      if (stored?.wire && stored.planId) {
        // Verified again on every run, against the wallet connected NOW (it may differ from when it was loaded).
        current = await verify(stored.wire)
        offer = expiryOf(stored.expiresAt)
      } else {
        setPhase('planning')
        // The idempotency key is persisted BEFORE the request: a crash or reload retries with the same key.
        const idempotencyKey = stored?.idempotencyKey ?? newIdempotencyKey()
        writeJson(storage, storeKey, { ...stored, idempotencyKey } satisfies StoredPlan)
        const created = await specRef.current.create(idempotencyKey)
        current = await verify(created.wire)
        offer = expiryOf(created.expiresAt)
        writeJson(storage, storeKey, { idempotencyKey, wire: created.wire, planId: created.planId, expiresAt: offer } satisfies StoredPlan)
      }
      setPlan(current)
      setExpiresAt(offer ?? null)
      setPhase('verified')
      if (!manifest) throw new Error('This build has no Pine deployment configured, so it cannot verify transactions.')
      // Hand the verified steps to the machine now (the render-time sync happens a tick later).
      machine.setSteps(planToTxSteps(current, manifest))
      const problem = offerProblem(offer, clock())
      if (problem) {
        // An expired plan may still be followed to the end (pending receipts), but nothing new is sent from it.
        await machine.hydrate()
        if (hasUnsentSteps(machine.getSnapshot().steps)) throw new Error(problem)
      }
      await machine.start()
    } catch (e) {
      setError(errorMessage(e))
      setPhase('error')
    } finally {
      setActive(false)
    }
  }, [storage, storeKey, verify, machine, manifest, clock])

  const discard = useCallback(() => {
    removeKey(storage, storeKey)
    runner.reset()
    forget()
  }, [storage, storeKey, runner, forget])

  const canResume =
    !active &&
    phase === 'verified' &&
    runner.steps.length > 0 &&
    !runner.awaitingManual &&
    (runner.state === 'paused' || runner.state === 'idle')

  return { phase, plan, steps, runner, error, expiresAt, canResume, run, discard, forget }
}
