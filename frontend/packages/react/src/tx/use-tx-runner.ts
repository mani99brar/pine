'use client'

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import { WagmiContext, type Config } from 'wagmi'
import { getAccount } from 'wagmi/actions'
import type { DecimalString, Hex, TxStep, TxStepId } from '@pine/core'
import { getChainOrDefault } from '@pine/core/chains'
import { usePine } from '../providers/context'
import { getBrowserStorage, type KeyValueStorage } from '../internal/storage'
import { demoWalletStore } from '../wallet/demo-store'
import { createDemoExecutor, type DemoExecutorOptions } from './demo-executor'
import { createLiveExecutor, type SendGuard } from './live-executor'
import { createDevForkSendGuard, devForkConfig, walletRequestOf } from '../dev/fork'
import {
  TxMachine,
  isManualStep,
  type StepHandler,
  type StepOutcome,
  type TxExecutor,
  type TxRunnerSnapshot,
  type TxRunnerStep,
} from './machine'

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

export interface TxRunner extends TxRunnerSnapshot {
  start(): Promise<void>
  retry(): Promise<void>
  skip(id: TxStepId): void
  reset(): void
  /** Marks a manual step (e.g. DEX liquidity) done and continues. */
  confirmManual(id: TxStepId, txHash?: Hex): Promise<void>
}

export interface UseTxRunnerOptions {
  /** Collateral spending limit; `start()` is blocked when the plan's collateral costs exceed it. */
  spendingLimit?: DecimalString
  /** Currency of the limit. Defaults to the collateral symbol of the first transaction step's chain. */
  limitCurrency?: string
  onConfirmed?(step: TxRunnerStep, outcome?: StepOutcome): void | Promise<void>
  onDone?(snapshot: TxRunnerSnapshot): void | Promise<void>
  onFailed?(step: TxRunnerStep): void
  /** Async handlers for offchain steps (e.g. `upload_manifest` → storage.putJson) or custom steps. */
  handlers?: Partial<Record<TxStepId, StepHandler>>
  /** Rebuilds a step right before it runs (inject results of earlier steps into calldata). */
  prepare?(step: TxStep, results: Partial<Record<TxStepId, unknown>>): TxStep | Promise<TxStep>
  /** Decides whether a step is a manual (user-confirmed) step. Default: `isManualStep`. */
  isManual?(step: TxStep): boolean
  /** External URL shown for a manual step (e.g. the Seer market page). */
  manualUrl?(step: TxStep, results: Partial<Record<TxStepId, unknown>>): string | undefined
  /** Overrides (tests): executor and storage. */
  executor?: TxExecutor
  storage?: KeyValueStorage
  demoDelays?: DemoExecutorOptions['delays']
}

/** One machine per key, shared by every component that renders the same run (composer + dashboard). */
const registry = new Map<string, TxMachine>()

/** Test helper: forget in-memory machines (simulates a page reload; persisted progress remains). */
export function __resetTxRunners(): void {
  registry.clear()
}

export function getTxMachine(key: string): TxMachine | undefined {
  return registry.get(key)
}

const missingExecutor: TxExecutor = {
  kind: 'live',
  async execute() {
    throw new Error('No wallet configuration found. Wrap the app in <PineProviders>.')
  },
  async checkPending() {
    return { status: 'pending' }
  },
}

/** Local dev-fork builds only (undefined otherwise): the wallet must be on the local fork before anything is sent. */
function devSendGuard(config: Config): SendGuard | undefined {
  const fork = devForkConfig()
  if (!fork) return undefined
  return createDevForkSendGuard(fork, () => walletRequestOf(getAccount(config).connector))
}

function defaultLimitCurrency(steps: TxStep[]): string | undefined {
  const chainId = steps.find((s) => s.request)?.request?.chainId
  return getChainOrDefault(chainId).collateral.symbol
}

/**
 * Internal: returns the machine as well, for hooks that need to drive it imperatively.
 *
 * The callbacks a machine calls (onConfirmed, onDone, prepare, handlers, …) are bound to the machine's own key: they
 * follow the options this hook passes while it shows that key, and keep the last of them once it moves on to another
 * key. A machine still running for an earlier key therefore never reaches the callbacks of the key shown now (which
 * would, e.g., report its transaction under another plan).
 */
export function useTxMachine(key: string, steps: TxStep[], opts: UseTxRunnerOptions = {}): { runner: TxRunner; machine: TxMachine } {
  const pine = usePine()
  const wagmiConfig = useContext(WagmiContext)
  // One holder per key (a new object whenever the key changes); only the current key's holder is updated.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const optsRef = useMemo(() => ({ current: opts }), [key])
  useIsomorphicLayoutEffect(() => {
    optsRef.current = opts
  })

  const limitCurrency = opts.limitCurrency ?? defaultLimitCurrency(steps)
  const demoDelaysKey = JSON.stringify(opts.demoDelays ?? null)

  const executor = useMemo<TxExecutor>(() => {
    if (opts.executor) return opts.executor
    if (pine.demo) {
      return createDemoExecutor({ wallet: demoWalletStore, collateralSymbol: limitCurrency, delays: opts.demoDelays })
    }
    if (!wagmiConfig) return missingExecutor
    const sendGuard = devSendGuard(wagmiConfig)
    return createLiveExecutor(wagmiConfig, sendGuard ? { sendGuard } : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.executor, pine.demo, wagmiConfig, limitCurrency, demoDelaysKey])

  const proxied = useMemo(
    () => ({
      onConfirmed: (s: TxRunnerStep, o: StepOutcome) => optsRef.current.onConfirmed?.(s, o),
      onDone: (snap: TxRunnerSnapshot) => optsRef.current.onDone?.(snap),
      onFailed: (s: TxRunnerStep) => optsRef.current.onFailed?.(s),
      prepare: (s: TxStep, r: Partial<Record<TxStepId, unknown>>) => optsRef.current.prepare?.(s, r) ?? s,
      isManual: (s: TxStep) => (optsRef.current.isManual ? optsRef.current.isManual(s) : isManualStep(s)),
      manualUrl: (s: TxStep, r: Partial<Record<TxStepId, unknown>>) => optsRef.current.manualUrl?.(s, r),
    }),
    [optsRef],
  )
  const handlerIds = Object.keys(opts.handlers ?? {}).sort().join(',')
  const handlers = useMemo(() => {
    const out: Partial<Record<TxStepId, StepHandler>> = {}
    for (const id of handlerIds ? (handlerIds.split(',') as TxStepId[]) : []) {
      out[id] = (step, ctx) => {
        const h = optsRef.current.handlers?.[id]
        if (!h) throw new Error(`No handler for ${id}`)
        return h(step, ctx)
      }
    }
    return out
  }, [handlerIds, optsRef])

  const machine = useMemo(() => {
    let m = registry.get(key)
    if (!m) {
      m = new TxMachine(key, steps, {
        storage: opts.storage ?? getBrowserStorage(),
        executor,
        handlers,
        spendingLimit: opts.spendingLimit,
        limitCurrency,
        ...proxied,
      })
      registry.set(key, m)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useIsomorphicLayoutEffect(() => {
    machine.setOptions({ executor, handlers, spendingLimit: opts.spendingLimit, limitCurrency, ...proxied })
  }, [machine, executor, handlers, opts.spendingLimit, limitCurrency, proxied])

  useIsomorphicLayoutEffect(() => {
    machine.setSteps(steps)
  }, [machine, steps])

  useEffect(() => {
    void machine.hydrate()
  }, [machine])

  const snap = useSyncExternalStore(machine.subscribe, machine.getSnapshot, machine.getServerSnapshot)

  const start = useCallback(() => machine.start(), [machine])
  const retry = useCallback(() => machine.retry(), [machine])
  const skip = useCallback((id: TxStepId) => machine.skip(id), [machine])
  const reset = useCallback(() => machine.reset(), [machine])
  const confirmManual = useCallback((id: TxStepId, txHash?: Hex) => machine.confirmManual(id, txHash), [machine])

  const runner = useMemo<TxRunner>(
    () => ({ ...snap, start, retry, skip, reset, confirmManual }),
    [snap, start, retry, skip, reset, confirmManual],
  )
  return { runner, machine }
}

/**
 * Generic resumable transaction runner (publish, evidence, redeem, finish-funding).
 * Progress persists to localStorage `pine:tx:<key>`; on reload pending receipts are re-checked and
 * the runner pauses at the first incomplete step (call `start()` to continue).
 */
export function useTxRunner(key: string, steps: TxStep[], opts?: UseTxRunnerOptions): TxRunner {
  return useTxMachine(key, steps, opts).runner
}
