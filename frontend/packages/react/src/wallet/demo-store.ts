/**
 * Simulated wallet used in demo mode (mock data source or NEXT_PUBLIC_PINE_DEMO_WALLET=1).
 * A tiny external store so every hook instance (wallet button, tx runner, composer) shares it.
 * Persists `connected`/`chainId`/`spent` to localStorage `pine:demo-wallet`; never reads storage at
 * module load (SSR-safe).
 */
import type { DecimalString, TxStepId } from '@pine/core'
import { getBrowserStorage, readJson, writeJson } from '../internal/storage'
import { compareDecimals, subDecimals, sumDecimals } from '../internal/util'

export const DEMO_STARTING_BALANCE: DecimalString = '1250'
export const DEMO_STARTING_NATIVE: DecimalString = '42.5'
const STORAGE_KEY = 'pine:demo-wallet'

export interface DemoWalletState {
  connected: boolean
  chainId: number | undefined
  /** Collateral spent by simulated transactions (liquidity, approvals…) */
  spent: DecimalString
  /** Native-token gas spent by simulated transactions */
  gasSpent: DecimalString
  /** Next wallet prompt to reject: a specific step id, 'any', or null */
  failNext: TxStepId | 'any' | null
}

type Listener = () => void

const DEFAULT_STATE: DemoWalletState = { connected: false, chainId: undefined, spent: '0', gasSpent: '0', failNext: null }

class DemoWalletStore {
  private state: DemoWalletState = DEFAULT_STATE
  private loaded = false
  private listeners = new Set<Listener>()

  readonly serverSnapshot: DemoWalletState = DEFAULT_STATE

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    this.load()
    return () => {
      this.listeners.delete(l)
    }
  }

  getSnapshot = (): DemoWalletState => {
    return this.state
  }

  getServerSnapshot = (): DemoWalletState => this.serverSnapshot

  private load(): void {
    if (this.loaded || typeof window === 'undefined') return
    this.loaded = true
    const saved = readJson<Partial<DemoWalletState>>(getBrowserStorage(), STORAGE_KEY)
    if (saved) {
      this.set({
        connected: Boolean(saved.connected),
        chainId: typeof saved.chainId === 'number' ? saved.chainId : undefined,
        spent: typeof saved.spent === 'string' ? saved.spent : '0',
        gasSpent: typeof saved.gasSpent === 'string' ? saved.gasSpent : '0',
      })
    }
  }

  private set(patch: Partial<DemoWalletState>): void {
    this.state = { ...this.state, ...patch }
    const { connected, chainId, spent, gasSpent } = this.state
    writeJson(getBrowserStorage(), STORAGE_KEY, { connected, chainId, spent, gasSpent })
    for (const l of this.listeners) l()
  }

  connect(chainId: number): void {
    this.load()
    this.set({ connected: true, chainId: this.state.chainId ?? chainId })
  }

  disconnect(): void {
    this.set({ connected: false, failNext: null })
  }

  switchChain(chainId: number): void {
    this.set({ chainId })
  }

  currentChainId(): number | undefined {
    return this.state.chainId
  }

  failNext(stepId?: TxStepId): void {
    this.set({ failNext: stepId ?? 'any' })
  }

  /** Returns true (and clears the flag) when this step should be rejected. */
  consumeFailure(stepId: TxStepId): boolean {
    const f = this.state.failNext
    if (f === 'any' || f === stepId) {
      this.set({ failNext: null })
      return true
    }
    return false
  }

  recordSpend(amount: DecimalString, kind: 'collateral' | 'native'): void {
    if (kind === 'collateral') this.set({ spent: sumDecimals([this.state.spent, amount]) })
    else this.set({ gasSpent: sumDecimals([this.state.gasSpent, amount]) })
  }

  balance(): DecimalString {
    const b = subDecimals(DEMO_STARTING_BALANCE, this.state.spent)
    return compareDecimals(b, '0') < 0 ? '0' : b
  }

  nativeBalance(): DecimalString {
    const b = subDecimals(DEMO_STARTING_NATIVE, this.state.gasSpent)
    return compareDecimals(b, '0') < 0 ? '0' : b
  }

  /** Test helper */
  reset(): void {
    this.set({ ...DEFAULT_STATE })
  }
}

export const demoWalletStore = new DemoWalletStore()
export type DemoWalletController = Pick<DemoWalletStore, 'consumeFailure' | 'recordSpend' | 'switchChain' | 'currentChainId'>
