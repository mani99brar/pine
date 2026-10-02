/**
 * Transaction runner state machine (framework-free; wrapped by `useTxRunner`).
 *
 *   idle ──start()──▶ running ──all steps confirmed/skipped──▶ done
 *                        │
 *                        ├──step throws──▶ failed ──retry()──▶ running
 *                        │                   └──skip(optional)──▶ paused ──start()──▶ running
 *   (reload) ──hydrate()──▶ re-checks persisted `pending` receipts ──▶ paused | failed | done
 *                        │
 *                        └──manual step (e.g. add liquidity on the DEX)──▶ paused (awaitingManual)
 *                              ──confirmManual(id, txHash?)──▶ running
 *
 * Per-step progress is persisted under `pine:tx:<key>` so an interrupted publication resumes from
 * the first incomplete step. The spending-limit guard blocks `start()` when the plan's collateral
 * costs exceed the limit, and blocks any individual step that would push spending past it.
 */
import type { DecimalString, Hex, IsoDate, TxStep, TxStepId, TxStepStatus } from '@pine/core'
import type { KeyValueStorage } from '../internal/storage'
import { readJson, removeKey, writeJson } from '../internal/storage'
import { errorMessage, fromUnits, isoNow, toUnits } from '../internal/util'

export type TxRunnerState = 'idle' | 'running' | 'paused' | 'done' | 'failed'

export interface TxRunnerStep extends TxStep {
  status: TxStepStatus
  txHash?: Hex
  error?: string
  startedAt?: IsoDate
  confirmedAt?: IsoDate
  /**
   * Manual step: done by the user outside Pine (e.g. adding liquidity on the DEX, which Seer's own
   * UI also delegates to Swapr/Algebra). The runner pauses with `awaitingManual` set; the user opens
   * `actionUrl`, then calls `confirmManual(id, txHash?)`.
   */
  manual: boolean
  actionUrl?: string
}

export interface TxLimitCheck {
  limit: DecimalString
  /** Collateral the whole plan needs (non-skipped steps, including confirmed ones) */
  required: DecimalString
  currency?: string
  within: boolean
}

export interface TxRunnerSnapshot {
  key: string
  steps: TxRunnerStep[]
  current?: TxRunnerStep
  state: TxRunnerState
  /** Collateral already spent by confirmed steps (limit currency) */
  spent: DecimalString
  /** Runner-level error, e.g. a spending-limit breach that blocked start */
  error?: string
  limit?: TxLimitCheck
  /** True once persisted progress has been loaded (client only) */
  hydrated: boolean
  /** Results returned by step handlers/executors (e.g. upload URIs), persisted with progress */
  results: Partial<Record<TxStepId, unknown>>
  completedAt?: IsoDate
  /** Id of the manual step the runner is waiting on (state is `paused`) */
  awaitingManual?: TxStepId
}

export interface StepProgress {
  onAwaitingSignature(): void
  onSubmitted(txHash: Hex): void
}

export interface StepOutcome {
  txHash?: Hex
  /** JSON-serializable result (persisted). */
  result?: unknown
}

export type PendingCheck = { status: 'confirmed'; result?: unknown } | { status: 'failed'; error: string } | { status: 'pending' }

export interface TxExecutor {
  readonly kind: 'demo' | 'live'
  execute(step: TxStep, progress: StepProgress): Promise<StepOutcome>
  /** Re-checks a step persisted as `pending` with a tx hash (after a reload). */
  checkPending(step: TxStep, txHash: Hex, startedAt: IsoDate | undefined): Promise<PendingCheck>
}

export interface StepContext {
  results: Partial<Record<TxStepId, unknown>>
  progress: StepProgress
  executor: TxExecutor
}

/** Custom handler for a step (e.g. offchain `upload_manifest` → `storage.putJson`). */
export type StepHandler = (step: TxStep, ctx: StepContext) => Promise<StepOutcome | void>

export interface TxMachineOptions {
  storage: KeyValueStorage
  executor: TxExecutor
  handlers?: Partial<Record<TxStepId, StepHandler>>
  /** Rebuilds a step right before it runs (e.g. inject the uploaded manifest URI into calldata). */
  prepare?: (step: TxStep, results: Partial<Record<TxStepId, unknown>>) => TxStep | Promise<TxStep>
  spendingLimit?: DecimalString
  /** Currency the spending limit is denominated in (collateral symbol). Costs in other currencies (gas) are not counted. */
  limitCurrency?: string
  onConfirmed?: (step: TxRunnerStep, outcome: StepOutcome) => void | Promise<void>
  onDone?: (snapshot: TxRunnerSnapshot) => void | Promise<void>
  onFailed?: (step: TxRunnerStep) => void
  /** Decides whether a step is manual. Default: `isManualStep`. */
  isManual?: (step: TxStep) => boolean
  /** External URL for a manual step (e.g. the Seer market page with "Add liquidity"). */
  manualUrl?: (step: TxStep, results: Partial<Record<TxStepId, unknown>>) => string | undefined
  now?: () => Date
}

/**
 * Default manual-step rule: an explicit `manual: true` flag on the step, or a transaction step with
 * no `request` whose id starts with `add_liquidity` (liquidity is provided on the DEX, not by Pine).
 */
export function isManualStep(step: TxStep): boolean {
  const flagged = (step as TxStep & { manual?: boolean }).manual
  if (typeof flagged === 'boolean') return flagged
  return step.kind === 'transaction' && !step.request && step.id.startsWith('add_liquidity')
}

function stepExternalUrl(step: TxStep): string | undefined {
  const s = step as TxStep & { externalUrl?: string; actionUrl?: string; url?: string }
  return s.externalUrl ?? s.actionUrl ?? s.url
}

interface PersistedStep {
  status: TxStepStatus
  txHash?: Hex
  error?: string
  startedAt?: IsoDate
  confirmedAt?: IsoDate
  result?: unknown
}

interface PersistedRun {
  v: 1
  steps: Partial<Record<TxStepId, PersistedStep>>
  completedAt?: IsoDate
  updatedAt: IsoDate
}

export const TX_STORAGE_PREFIX = 'pine:tx:'

export function txStorageKey(key: string): string {
  return `${TX_STORAGE_PREFIX}${key}`
}

/** Reads persisted progress without creating a machine (dashboards, recovery lists). */
export function readPersistedRun(storage: KeyValueStorage, key: string): PersistedRun | null {
  return readJson<PersistedRun>(storage, txStorageKey(key))
}

export class SpendingLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendingLimitError'
  }
}

const DONE_STATUSES: TxStepStatus[] = ['confirmed', 'skipped']

export class TxMachine {
  readonly key: string
  private defs: TxStep[]
  private defsSignature: string
  private progress = new Map<TxStepId, PersistedStep>()
  private opts: TxMachineOptions
  private state: TxRunnerState = 'idle'
  private error: string | undefined
  private hydrated = false
  private hydrating: Promise<void> | null = null
  private running = false
  private completedAt: IsoDate | undefined
  private listeners = new Set<() => void>()
  private snapshot: TxRunnerSnapshot
  private serverSnapshot: TxRunnerSnapshot

  constructor(key: string, steps: TxStep[], opts: TxMachineOptions) {
    this.key = key
    this.defs = steps
    this.defsSignature = signature(steps)
    this.opts = opts
    this.snapshot = this.compute()
    this.serverSnapshot = this.snapshot
  }

  // ---------------------------------------------------------------------------
  // External store API
  // ---------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): TxRunnerSnapshot => this.snapshot

  getServerSnapshot = (): TxRunnerSnapshot => this.serverSnapshot

  private emit(): void {
    this.snapshot = this.compute()
    for (const l of this.listeners) l()
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setSteps(steps: TxStep[]): void {
    const sig = signature(steps)
    if (sig === this.defsSignature) return
    this.defs = steps
    this.defsSignature = sig
    if (!this.running && this.state === 'done' && !this.allComplete()) this.state = 'paused'
    this.emit()
  }

  getSteps(): TxStep[] {
    return this.defs
  }

  setOptions(patch: Partial<TxMachineOptions>): void {
    const limitChanged =
      patch.spendingLimit !== this.opts.spendingLimit || patch.limitCurrency !== this.opts.limitCurrency
    this.opts = { ...this.opts, ...patch }
    if (limitChanged) {
      if (this.error && /spending limit/i.test(this.error)) this.error = undefined
      this.emit()
    }
  }

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  private statusOf(id: TxStepId): TxStepStatus {
    return this.progress.get(id)?.status ?? 'idle'
  }

  private allComplete(): boolean {
    return this.defs.length > 0 && this.defs.every((s) => DONE_STATUSES.includes(this.statusOf(s.id)))
  }

  private countsTowardLimit(step: TxStep): boolean {
    return this.limitAmount(step) > 0n
  }

  /** What a step spends in the limit currency: its fee estimate and any collateral it deposits. */
  private limitAmount(step: TxStep): bigint {
    const cur = this.opts.limitCurrency
    let total = 0n
    for (const c of [step.estimatedCost, step.collateralCost]) {
      if (c && (!cur || c.currency === cur)) total += toUnits(c.amount) ?? 0n
    }
    return total
  }

  /** Collateral the plan requires (all non-skipped steps). */
  requiredTotal(): bigint {
    let total = 0n
    for (const s of this.defs) {
      if (this.statusOf(s.id) === 'skipped') continue
      total += this.limitAmount(s)
    }
    return total
  }

  spentTotal(): bigint {
    let total = 0n
    for (const s of this.defs) {
      if (this.statusOf(s.id) !== 'confirmed') continue
      total += this.limitAmount(s)
    }
    return total
  }

  limitCheck(): TxLimitCheck | undefined {
    const limitRaw = this.opts.spendingLimit
    if (limitRaw === undefined || limitRaw === '') return undefined
    const limit = toUnits(limitRaw)
    const required = this.requiredTotal()
    return {
      limit: limitRaw,
      required: fromUnits(required),
      currency: this.opts.limitCurrency,
      within: limit !== null && required <= limit,
    }
  }

  private compute(): TxRunnerSnapshot {
    const partialResults: Partial<Record<TxStepId, unknown>> = {}
    for (const [id, p] of this.progress) if (p.result !== undefined) partialResults[id] = p.result
    const steps: TxRunnerStep[] = this.defs.map((d) => {
      const p = this.progress.get(d.id)
      const manual = this.isManual(d)
      return {
        ...d,
        status: p?.status ?? 'idle',
        txHash: p?.txHash,
        error: p?.error,
        startedAt: p?.startedAt,
        confirmedAt: p?.confirmedAt,
        manual,
        actionUrl: manual ? (this.opts.manualUrl?.(d, partialResults) ?? stepExternalUrl(d)) : stepExternalUrl(d),
      }
    })
    const current =
      steps.find((s) => s.status === 'awaiting_signature' || s.status === 'pending') ??
      steps.find((s) => s.status === 'failed') ??
      steps.find((s) => !DONE_STATUSES.includes(s.status))
    const results = partialResults
    const awaiting = steps.find((s) => s.manual && s.status === 'awaiting_signature')
    return {
      key: this.key,
      steps,
      current,
      state: this.state,
      spent: fromUnits(this.spentTotal()),
      error: this.error,
      limit: this.limitCheck(),
      hydrated: this.hydrated,
      results,
      completedAt: this.completedAt,
      awaitingManual: awaiting?.id,
    }
  }

  isManual(step: TxStep): boolean {
    return (this.opts.isManual ?? isManualStep)(step)
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private persist(): void {
    const steps: Partial<Record<TxStepId, PersistedStep>> = {}
    for (const [id, p] of this.progress) steps[id] = p
    const run: PersistedRun = { v: 1, steps, completedAt: this.completedAt, updatedAt: isoNow(this.now()) }
    writeJson(this.opts.storage, txStorageKey(this.key), run)
  }

  private patchStep(id: TxStepId, patch: Partial<PersistedStep>, replace = false): void {
    const prev = replace ? undefined : this.progress.get(id)
    this.progress.set(id, { status: 'idle', ...prev, ...patch })
    this.persist()
    this.emit()
  }

  private deriveState(): TxRunnerState {
    if (this.defs.length > 0 && this.allComplete()) return 'done'
    const statuses = this.defs.map((s) => this.statusOf(s.id))
    if (statuses.includes('failed')) return 'failed'
    if (statuses.some((s) => s !== 'idle')) return 'paused'
    return 'idle'
  }

  /**
   * Loads persisted progress and re-checks steps that were `pending` with a tx hash.
   * Steps interrupted while awaiting a signature go back to `idle` (the prompt is gone).
   * Never auto-continues: the user resumes with `start()`.
   */
  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve()
    if (this.hydrating) return this.hydrating
    this.hydrating = this.doHydrate().finally(() => {
      this.hydrating = null
    })
    return this.hydrating
  }

  private async doHydrate(): Promise<void> {
    const saved = readJson<PersistedRun>(this.opts.storage, txStorageKey(this.key))
    if (saved && saved.v === 1) {
      for (const [id, p] of Object.entries(saved.steps) as [TxStepId, PersistedStep][]) {
        if (!p) continue
        const def = this.defs.find((d) => d.id === id)
        if (p.status === 'awaiting_signature' && def && this.isManual(def)) {
          // Still waiting for the user's manual action.
          this.progress.set(id, p)
        } else if (p.status === 'awaiting_signature') {
          this.progress.set(id, { ...p, status: 'idle', error: undefined })
        } else if (p.status === 'pending' && !p.txHash) {
          // Interrupted offchain work: safe to redo.
          this.progress.set(id, { ...p, status: 'idle' })
        } else {
          this.progress.set(id, p)
        }
      }
      this.completedAt = saved.completedAt
    }
    this.hydrated = true
    const pendings = this.defs.filter((s) => this.statusOf(s.id) === 'pending' && this.progress.get(s.id)?.txHash)
    this.state = pendings.length > 0 ? 'running' : this.deriveState()
    this.emit()

    for (const def of pendings) {
      const p = this.progress.get(def.id)
      if (!p?.txHash) continue
      let check: PendingCheck
      try {
        check = await this.opts.executor.checkPending(def, p.txHash, p.startedAt)
      } catch (e) {
        check = { status: 'pending' }
        this.error = `Could not re-check ${def.label}: ${errorMessage(e)}`
      }
      if (check.status === 'confirmed') {
        this.patchStep(def.id, {
          status: 'confirmed',
          confirmedAt: isoNow(this.now()),
          result: check.result ?? p.result,
          error: undefined,
        })
        await this.notifyConfirmed(def.id, { txHash: p.txHash, result: check.result })
      } else if (check.status === 'failed') {
        this.patchStep(def.id, { status: 'failed', error: check.error })
      }
    }
    const stillPending = this.defs.some((s) => this.statusOf(s.id) === 'pending')
    this.state = stillPending ? 'paused' : this.deriveState()
    this.persist()
    this.emit()
    if (this.state === 'done') await this.finish()
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Starts (or continues) from the first incomplete step. Never rejects: a spending-limit breach
   * leaves the runner in its current state with `error` set; step failures set state `failed`.
   */
  async start(): Promise<void> {
    if (this.running) return
    if (!this.hydrated) await this.hydrate()
    if (this.defs.length === 0) {
      this.error = 'Nothing to run yet.'
      this.emit()
      return
    }
    if (this.allComplete()) {
      this.state = 'done'
      this.emit()
      return
    }
    const check = this.limitCheck()
    if (check && !check.within) {
      const cur = check.currency ? ` ${check.currency}` : ''
      this.error = `Blocked by your spending limit: this plan needs ${trimDecimal(check.required)}${cur} but your limit is ${trimDecimal(check.limit)}${cur}. Raise the limit or reduce the amounts before continuing.`
      this.emit()
      return
    }
    // A failed step is retried by start() as well.
    for (const s of this.defs) {
      if (this.statusOf(s.id) === 'failed') this.patchStep(s.id, { status: 'idle', error: undefined })
    }
    this.error = undefined
    await this.run()
  }

  /** Retries from the failed step. */
  async retry(): Promise<void> {
    return this.start()
  }

  /** Skips an optional step that has not confirmed. */
  skip(id: TxStepId): void {
    const def = this.defs.find((s) => s.id === id)
    if (!def) return
    if (!def.optional) {
      this.error = `"${def.label}" is required and cannot be skipped.`
      this.emit()
      return
    }
    const st = this.statusOf(id)
    if (st === 'confirmed' || st === 'pending') return
    if (st === 'awaiting_signature' && !this.isManual(def)) return
    this.patchStep(id, { status: 'skipped', error: undefined })
    if (!this.running) {
      this.state = this.deriveState()
      if (this.state === 'failed') this.state = 'paused'
      this.persist()
      this.emit()
      if (this.state === 'done') void this.finish()
    }
  }

  /**
   * Marks a manual step (e.g. "Add liquidity on the DEX") as done and continues the run.
   * `txHash` is optional (the user may paste the DEX transaction hash for the record).
   */
  async confirmManual(id: TxStepId, txHash?: Hex): Promise<void> {
    const def = this.defs.find((s) => s.id === id)
    if (!def || !this.isManual(def)) {
      this.error = def ? `"${def.label}" is not a manual step.` : `Unknown step ${id}.`
      this.emit()
      return
    }
    if (txHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      this.error = 'That does not look like a transaction hash (0x followed by 64 hex characters).'
      this.emit()
      return
    }
    const st = this.statusOf(id)
    if (st === 'confirmed' || st === 'skipped') return
    this.error = undefined
    this.patchStep(id, { status: 'confirmed', txHash, confirmedAt: isoNow(this.now()), result: { manual: true }, error: undefined })
    await this.notifyConfirmed(id, { txHash, result: { manual: true } })
    if (this.running) return
    if (this.allComplete()) {
      this.state = 'done'
      this.persist()
      this.emit()
      await this.finish()
      return
    }
    // Continue with the remaining steps unless an earlier step still needs attention.
    const firstIncomplete = this.defs.find((s) => !DONE_STATUSES.includes(this.statusOf(s.id)))
    if (firstIncomplete && this.statusOf(firstIncomplete.id) !== 'failed') await this.run()
    else {
      this.state = this.deriveState()
      this.emit()
    }
  }

  /** Clears all progress (only use before anything is on-chain, or to dismiss a finished run). */
  reset(): void {
    if (this.running) return
    this.progress.clear()
    this.completedAt = undefined
    this.error = undefined
    this.state = 'idle'
    removeKey(this.opts.storage, txStorageKey(this.key))
    this.emit()
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.running = true
    this.state = 'running'
    this.emit()
    try {
      for (;;) {
        const def = this.defs.find((s) => !DONE_STATUSES.includes(this.statusOf(s.id)))
        if (!def) {
          this.state = 'done'
          this.persist()
          this.emit()
          await this.finish()
          return
        }
        const ok = await this.runStep(def)
        if (ok === 'manual') {
          this.state = 'paused'
          this.persist()
          this.emit()
          return
        }
        if (!ok) {
          this.state = 'failed'
          this.persist()
          this.emit()
          return
        }
      }
    } finally {
      this.running = false
    }
  }

  private async runStep(def: TxStep): Promise<boolean | 'manual'> {
    const existing = this.progress.get(def.id)
    const results = this.snapshot.results

    // Resume a step that was submitted before a reload but not yet confirmed.
    if (existing?.status === 'pending' && existing.txHash) {
      const check = await this.opts.executor.checkPending(def, existing.txHash, existing.startedAt).catch(
        (e): PendingCheck => ({ status: 'failed', error: errorMessage(e) }),
      )
      if (check.status === 'confirmed') {
        this.patchStep(def.id, { status: 'confirmed', confirmedAt: isoNow(this.now()), result: check.result })
        await this.notifyConfirmed(def.id, { txHash: existing.txHash, result: check.result })
        return true
      }
      if (check.status === 'failed') {
        this.patchStep(def.id, { status: 'failed', error: check.error })
        this.notifyFailed(def.id)
        return false
      }
      this.patchStep(def.id, {
        status: 'failed',
        error: 'The transaction is still pending. Check your wallet or explorer, then retry.',
      })
      this.notifyFailed(def.id)
      return false
    }

    let step = def
    try {
      if (this.opts.prepare) step = await this.opts.prepare(def, results)
    } catch (e) {
      this.patchStep(def.id, { status: 'failed', error: errorMessage(e) })
      this.notifyFailed(def.id)
      return false
    }

    // Per-step limit guard: shown cost against the remaining limit before every wallet prompt.
    const limitRaw = this.opts.spendingLimit
    if (limitRaw !== undefined && limitRaw !== '' && this.countsTowardLimit(step)) {
      const limit = toUnits(limitRaw) ?? 0n
      const after = this.spentTotal() + this.limitAmount(step)
      if (after > limit) {
        this.patchStep(def.id, {
          status: 'failed',
          error: `Blocked: this step would bring spending to ${trimDecimal(fromUnits(after))} ${this.opts.limitCurrency ?? step.collateralCost?.currency ?? step.estimatedCost?.currency ?? ''}, above your limit of ${trimDecimal(limitRaw)}.`,
        })
        this.notifyFailed(def.id)
        return false
      }
    }

    const startedAt = isoNow(this.now())

    if (this.isManual(step) && !this.opts.handlers?.[def.id]) {
      this.patchStep(def.id, {
        status: 'awaiting_signature',
        startedAt: existing?.startedAt ?? startedAt,
        error: undefined,
      })
      return 'manual'
    }

    const progress: StepProgress = {
      onAwaitingSignature: () => this.patchStep(def.id, { status: 'awaiting_signature', startedAt, error: undefined }),
      onSubmitted: (txHash) => this.patchStep(def.id, { status: 'pending', txHash, startedAt: isoNow(this.now()) }),
    }

    try {
      const handler = this.opts.handlers?.[def.id]
      let outcome: StepOutcome
      if (handler) {
        if (step.kind === 'offchain') this.patchStep(def.id, { status: 'pending', startedAt, error: undefined, txHash: undefined })
        outcome = (await handler(step, { results, progress, executor: this.opts.executor })) ?? {}
      } else {
        outcome = await this.opts.executor.execute(step, progress)
      }
      this.patchStep(def.id, {
        status: 'confirmed',
        txHash: outcome.txHash ?? this.progress.get(def.id)?.txHash,
        confirmedAt: isoNow(this.now()),
        result: outcome.result,
        error: undefined,
      })
      await this.notifyConfirmed(def.id, outcome)
      return true
    } catch (e) {
      this.patchStep(def.id, { status: 'failed', error: errorMessage(e) })
      this.notifyFailed(def.id)
      return false
    }
  }

  private async notifyConfirmed(id: TxStepId, outcome: StepOutcome): Promise<void> {
    const step = this.snapshot.steps.find((s) => s.id === id)
    if (!step || !this.opts.onConfirmed) return
    try {
      await this.opts.onConfirmed(step, outcome)
    } catch (e) {
      // A bookkeeping failure must not undo a confirmed transaction; surface it instead.
      this.error = `Step confirmed, but saving progress failed: ${errorMessage(e)}`
      this.emit()
    }
  }

  private notifyFailed(id: TxStepId): void {
    const step = this.snapshot.steps.find((s) => s.id === id)
    if (step) this.opts.onFailed?.(step)
  }

  private async finish(): Promise<void> {
    if (this.completedAt) return
    this.completedAt = isoNow(this.now())
    this.persist()
    this.emit()
    try {
      await this.opts.onDone?.(this.snapshot)
    } catch (e) {
      this.error = `All steps confirmed, but finishing failed: ${errorMessage(e)}`
      this.emit()
    }
  }
}

function signature(steps: TxStep[]): string {
  try {
    return JSON.stringify(steps)
  } catch {
    return steps.map((s) => s.id).join('|')
  }
}

function trimDecimal(v: DecimalString): string {
  if (!v.includes('.')) return v
  const t = v.replace(/0+$/, '').replace(/\.$/, '')
  return t === '' ? '0' : t
}

