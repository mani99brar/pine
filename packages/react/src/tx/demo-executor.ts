import type { Hex, TxStep } from '@pine/core'
import { fakeHash, sleep } from '../internal/util'
import type { DemoWalletController } from '../wallet/demo-store'
import type { PendingCheck, StepOutcome, StepProgress, TxExecutor } from './machine'

export interface DemoExecutorOptions {
  wallet: DemoWalletController
  /** Collateral symbol of the chain, to decide which costs reduce the simulated balance. */
  collateralSymbol?: string
  delays?: {
    /** Time the simulated wallet prompt stays open (default ~0.8s) */
    signatureMs?: number
    /** Confirmation delay range (default 1.2–3s) */
    pendingMs?: [number, number]
    /** Offchain step delay (default 0.4s) */
    offchainMs?: number
    /** Simulated network switch (default 0.6s) */
    switchMs?: number
    /** A step persisted as pending is treated as confirmed once older than this (default 5s) */
    resumeAfterMs?: number
  }
  random?: () => number
  now?: () => number
}

export const DEMO_REJECTION_MESSAGE = 'User rejected the request.'

/**
 * Simulated wallet/chain: awaiting_signature (~0.8s) → pending (1.2–3s) → confirmed, with fake
 * tx hashes. `failNext` on the demo wallet makes the next wallet prompt reject.
 */
export function createDemoExecutor(opts: DemoExecutorOptions): TxExecutor {
  const random = opts.random ?? Math.random
  const now = opts.now ?? Date.now
  const signatureMs = opts.delays?.signatureMs ?? 800
  const [pMin, pMax] = opts.delays?.pendingMs ?? [1200, 3000]
  const offchainMs = opts.delays?.offchainMs ?? 400
  const switchMs = opts.delays?.switchMs ?? 600
  const resumeAfterMs = opts.delays?.resumeAfterMs ?? 5000

  return {
    kind: 'demo',
    async execute(step: TxStep, progress: StepProgress): Promise<StepOutcome> {
      if (step.kind === 'offchain') {
        await sleep(offchainMs)
        return {}
      }
      // Simulate the wallet network switch (e.g. Gnosis → Ethereum for ERC-1497 evidence/arbitration).
      const target = step.request?.chainId
      if (target !== undefined && opts.wallet.currentChainId() !== target) {
        await sleep(switchMs)
        opts.wallet.switchChain(target)
      }
      progress.onAwaitingSignature()
      await sleep(signatureMs)
      if (opts.wallet.consumeFailure(step.id)) throw new Error(DEMO_REJECTION_MESSAGE)
      if (step.kind === 'signature') {
        return { result: { signature: fakeHash('sig', step.id, now()) } }
      }
      const hash: Hex = fakeHash('demo-tx', step.id, now(), random())
      progress.onSubmitted(hash)
      await sleep(pMin + Math.round(random() * Math.max(0, pMax - pMin)))
      if (step.estimatedCost) {
        const isCollateral = !opts.collateralSymbol || step.estimatedCost.currency === opts.collateralSymbol
        opts.wallet.recordSpend(step.estimatedCost.amount, isCollateral ? 'collateral' : 'native')
      }
      return { txHash: hash, result: { simulated: true } }
    },
    async checkPending(_step: TxStep, _txHash: Hex, startedAt: string | undefined): Promise<PendingCheck> {
      const started = startedAt ? Date.parse(startedAt) : 0
      const age = now() - (Number.isFinite(started) ? started : 0)
      if (age < resumeAfterMs) await sleep(resumeAfterMs - age)
      return { status: 'confirmed', result: { simulated: true, resumed: true } }
    },
  }
}
