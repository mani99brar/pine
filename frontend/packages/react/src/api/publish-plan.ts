'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Hex } from '@pine/core'
import { claimRegistryAbi, type Address, type DeploymentManifest, type Hex32, type PlanLimits } from '@pine/core/pine-shared'
import { describeWriteError, PineBackendError, pollUntil, PineWriteApi, type WriteErrorInfo } from '@pine/data'
import { usePine } from '../providers/context'
import { getBrowserStorage, readJson, removeKey, writeJson } from '../internal/storage'
import { useApiPlanRunner, type ApiPlanRunner, type CreatedPlan } from './use-plan-runner'
import { pinnedManifest, type RegistryReader } from './plans'

// Shared plumbing of the api write hooks (claim publication, evidence, oracle, funding and exits): one backend plan
// action at a time per hook, run through useApiPlanRunner, then followed until the backend reports a final state.
//
// useApiPlanRunner keeps its verified plan in component state that is not keyed, so when the action key changes the
// previous plan would still be shown and run under the new key. usePlanAction clears it (discard) in a layout effect
// before anything is painted, and never starts a run while a stale plan is visible. Keys are content-addressed or carry
// a per-attempt nonce, and the hooks refuse to switch away from an action whose transactions are in flight, so a key
// is only ever cleared while its own storage is empty.

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface PlanActionSpec {
  /** Content-addressed key of the current action; null while there is nothing to run. */
  key: string | null
  /** Runner key while there is no action, scoped to the hook's subject (e.g. its draft or market). */
  idleKey: string
  create(idempotencyKey: string): Promise<CreatedPlan>
  submitted(planId: string, stepId: string, txHash: Hex): Promise<void>
  markets?: Address[]
  reopenedQuestionIds?: Hex32[]
  limits: PlanLimits
  onDone?(): void | Promise<void>
  /**
   * How often a plan request refused with 503 NOT_READY (stale chain data) is retried after its Retry-After, with the
   * same idempotency key (default 2; 0 disables).
   */
  notReadyRetries?: number
  /** Injectable wait (tests). */
  sleep?(ms: number): Promise<void>
}

export interface PlanAction {
  runner: ApiPlanRunner
  /**
   * Runs (or resumes) the plan of `expectedKey` (default: the current key) once the runner is settled on that key; resolves
   * when the run stops. Pass the key of an action that was just set: it takes effect with the next render.
   */
  runWhenReady(expectedKey?: string | null): Promise<void>
  /** Structured description of the last failed plan request (the runner itself keeps only a message). */
  lastError: WriteErrorInfo | null
  clearError(): void
}

/** True when a transaction of the run was sent (pending or mined): the action must not be abandoned or replaced. */
export function runnerHasSentSteps(runner: ApiPlanRunner): boolean {
  return runner.runner.steps.some((s) => Boolean(s.txHash) || s.status === 'pending' || s.status === 'confirmed')
}

/** True while a wallet prompt is open or a transaction is pending. */
export function runnerIsBusy(runner: ApiPlanRunner): boolean {
  return runner.phase === 'planning' || runner.runner.state === 'running'
}

export function usePlanAction(spec: PlanActionSpec): PlanAction {
  const key = spec.key ?? spec.idleKey
  const specRef = useRef(spec)
  useIsomorphicLayoutEffect(() => {
    specRef.current = spec
  })
  const [lastError, setLastError] = useState<WriteErrorInfo | null>(null)

  const runner = useApiPlanRunner({
    key,
    create: async (idempotencyKey) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await specRef.current.create(idempotencyKey)
        } catch (e) {
          const retries = specRef.current.notReadyRetries ?? 2
          const wait = e instanceof PineBackendError && e.apiCode === 'NOT_READY' && e.retryAfter && e.retryAfter <= 120 ? e.retryAfter : null
          if (wait !== null && attempt < retries) {
            setLastError(describeWriteError(e))
            await (specRef.current.sleep ?? defaultSleep)(wait * 1000)
            continue
          }
          const info = describeWriteError(e)
          setLastError(info)
          throw new Error(info.message)
        }
      }
    },
    submitted: (planId, stepId, txHash) => specRef.current.submitted(planId, stepId, txHash),
    markets: spec.markets,
    reopenedQuestionIds: spec.reopenedQuestionIds,
    limits: spec.limits,
    onDone: () => specRef.current.onDone?.(),
  })

  // A plan still in state after the key changed belongs to the previous key (the runner loads a stored plan only
  // while its state is empty): clear it before paint.
  const shownKey = useRef(key)
  const stale = shownKey.current !== key && runner.plan !== null
  useIsomorphicLayoutEffect(() => {
    if (shownKey.current === key) return
    shownKey.current = key
    if (runner.plan !== null) runner.discard()
  })

  // The runner of the last committed render, and whether it shows its own key's plan.
  const committed = useRef({ key: spec.key, runner, settled: !stale })
  useIsomorphicLayoutEffect(() => {
    committed.current = { key: spec.key, runner, settled: !stale }
  })

  const pending = useRef<{ key: string; resolve: () => void } | null>(null)
  const [, setTick] = useState(0)
  const runWhenReady = useCallback(
    (expectedKey?: string | null) =>
      new Promise<void>((resolve) => {
        const c = committed.current
        const target = expectedKey === undefined ? c.key : expectedKey
        pending.current?.resolve()
        pending.current = null
        if (!target) {
          resolve()
          return
        }
        if (c.key === target && c.settled && c.runner.phase !== 'planning') {
          // Already showing this key's runner: run now (no render needed).
          setLastError(null)
          void c.runner.run().finally(resolve)
          return
        }
        // The key changes with the next render (a new action): run once the runner is settled on it.
        pending.current = { key: target, resolve }
        setTick((t) => t + 1)
      }),
    [],
  )
  useEffect(() => {
    const p = pending.current
    if (!p) return
    if (!spec.key) {
      pending.current = null
      p.resolve()
      return
    }
    if (stale || runner.phase === 'planning' || spec.key !== p.key) return
    pending.current = null
    setLastError(null)
    void runner.run().finally(p.resolve)
  })

  const clearError = useCallback(() => setLastError(null), [])
  return { runner, runWhenReady, lastError, clearError }
}

/** The connected chain's public client as a ClaimRegistry reader (the user's own RPC, never the Pine API). */
export function useRegistryReader(): RegistryReader | undefined {
  const { env } = usePine()
  const client = usePublicClient({ chainId: env.defaultChainId })
  return client as unknown as RegistryReader | undefined
}

/** Typed write routes over the same-origin client, or null outside api mode. */
export function useWriteApi(): PineWriteApi | null {
  const { api } = usePine()
  return useMemo(() => (api ? new PineWriteApi(api) : null), [api])
}

export function requireWriteApi(api: PineWriteApi | null): PineWriteApi {
  if (!api) throw new Error('The Pine API is not configured (set NEXT_PUBLIC_PINE_DATA_SOURCE=api).')
  return api
}

/** The pinned deployment manifest, or null when this build has none (writes are then refused). */
export function usePinnedManifest(): DeploymentManifest | null {
  const { env } = usePine()
  return useMemo(() => {
    try {
      return pinnedManifest(env)
    } catch {
      return null
    }
  }, [env])
}

/** A claim as ClaimRegistry stores it (read on chain; the API's view of the claim is never trusted for writes). */
export interface OnChainClaim {
  market: Address
  creator: Address
  evidenceDeadline: number
  revealDeadline: number
  repositoryId: bigint
  /** 40 lowercase hex characters, no 0x (the claim document's form). */
  commit: string
  claimDocumentSha256: Hex32
  policyDocumentSha256: Hex32
  questionId: Hex32
  conditionId: Hex32
  minBond: bigint
  yesToken: Address
  noToken: Address
  invalidToken: Address
}

interface RawClaim {
  creator: string
  evidenceDeadline: bigint | number
  revealDeadline: bigint | number
  repositoryId: bigint | number
  commit: string
  claimDocumentSha256: string
  policyDocumentSha256: string
  questionId: string
  conditionId: string
  minBond: bigint
  yesToken: string
  noToken: string
  invalidToken: string
}

const lowerAddress = (value: string) => value.toLowerCase() as Address
const lowerHex = (value: string) => value.toLowerCase() as Hex32

/** Reads a registered claim from ClaimRegistry; null when the market is not registered there. */
export async function readOnChainClaim(reader: RegistryReader, manifest: DeploymentManifest, market: Address): Promise<OnChainClaim | null> {
  const address = manifest.pine.claimRegistry
  const m = lowerAddress(market)
  const registered = await reader.readContract({ address, abi: claimRegistryAbi, functionName: 'isRegistered', args: [m] })
  if (registered !== true) return null
  const raw = (await reader.readContract({ address, abi: claimRegistryAbi, functionName: 'getClaim', args: [m] })) as RawClaim
  const commit = String(raw.commit).toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('ClaimRegistry returned a malformed commit')
  return {
    market: m,
    creator: lowerAddress(raw.creator),
    evidenceDeadline: Number(raw.evidenceDeadline),
    revealDeadline: Number(raw.revealDeadline),
    repositoryId: BigInt(raw.repositoryId),
    commit,
    claimDocumentSha256: lowerHex(raw.claimDocumentSha256),
    policyDocumentSha256: lowerHex(raw.policyDocumentSha256),
    questionId: lowerHex(raw.questionId),
    conditionId: lowerHex(raw.conditionId),
    minBond: BigInt(raw.minBond),
    yesToken: lowerAddress(raw.yesToken),
    noToken: lowerAddress(raw.noToken),
    invalidToken: lowerAddress(raw.invalidToken),
  }
}

/** The market's claim from ClaimRegistry on the user's RPC (cached for a minute; deadlines and tokens never change). */
export function useOnChainClaim(market: Address | undefined): { claim: OnChainClaim | null; loading: boolean; error: Error | null } {
  const reader = useRegistryReader()
  const manifest = usePinnedManifest()
  const q = useQuery({
    queryKey: ['pine', 'chain-claim', manifest?.pine.claimRegistry ?? null, market?.toLowerCase() ?? null],
    enabled: Boolean(reader && manifest && market),
    staleTime: 60_000,
    queryFn: async () => {
      if (!reader || !manifest || !market) return null
      return readOnChainClaim(reader, manifest, market)
    },
  })
  return { claim: q.data ?? null, loading: q.isLoading, error: q.error }
}

/**
 * A small record persisted in localStorage (the action in progress), loaded after mount so server and client render
 * the same first frame. `set(null)` forgets it.
 */
export function useStoredRecord<T>(storageKey: string | null, isValid: (value: unknown) => value is T): [T | null, (value: T | null) => void] {
  const [value, setValue] = useState<T | null>(null)
  const validRef = useRef(isValid)
  useIsomorphicLayoutEffect(() => {
    validRef.current = isValid
  })
  useEffect(() => {
    if (!storageKey) {
      setValue(null)
      return
    }
    const stored = readJson<unknown>(getBrowserStorage(), storageKey)
    setValue(validRef.current(stored) ? stored : null)
  }, [storageKey])
  const set = useCallback(
    (next: T | null) => {
      if (storageKey) {
        if (next === null) removeKey(getBrowserStorage(), storageKey)
        else writeJson(getBrowserStorage(), storageKey, next)
      }
      setValue(next)
    },
    [storageKey],
  )
  return [value, set]
}

export interface PolledStatus<T> {
  value: T | null
  error: WriteErrorInfo | null
  polling: boolean
}

/**
 * Follows a backend status until `done`: starts whenever `key` is non-null, restarts when it changes, stops on
 * unmount. Honours Retry-After (NOT_READY, 429) and backs off on transient failures.
 */
export function usePolledStatus<T>(opts: {
  key: string | null
  load(signal: AbortSignal): Promise<T>
  done(value: T): boolean
  onValue?(value: T): void
  intervalMs: number
  sleep?(ms: number, signal: AbortSignal): Promise<void>
}): PolledStatus<T> {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState<WriteErrorInfo | null>(null)
  const [polling, setPolling] = useState(false)
  const optsRef = useRef(opts)
  useIsomorphicLayoutEffect(() => {
    optsRef.current = opts
  })
  useEffect(() => {
    if (!opts.key) {
      setPolling(false)
      return
    }
    const controller = new AbortController()
    setPolling(true)
    setError(null)
    pollUntil<T>({
      load: (signal) => optsRef.current.load(signal),
      done: (v) => optsRef.current.done(v),
      onValue: (v) => {
        setValue(v)
        optsRef.current.onValue?.(v)
      },
      intervalMs: opts.intervalMs,
      sleep: opts.sleep,
      signal: controller.signal,
    }).then(
      () => {
        if (!controller.signal.aborted) setPolling(false)
      },
      (e: unknown) => {
        if (controller.signal.aborted) return
        setError(describeWriteError(e))
        setPolling(false)
      },
    )
    return () => controller.abort()
    // Restart only when the followed resource changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.key])
  return { value, error, polling }
}

/** Random nonce for per-attempt action keys. */
export function actionNonce(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
