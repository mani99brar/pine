'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { erc20Abi, formatUnits } from 'viem'
import {
  useAccount as useWagmiAccount,
  useBalance,
  useDisconnect,
  useReadContract,
  useSwitchChain,
} from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address, DecimalString, TxStepId } from '@pine/core'
import { getChainOrDefault, isPlaceholderAddress } from '@pine/core/chains'
import { DEMO_WALLET_ADDRESS } from '@pine/data'
import { usePine } from '../providers/context'
import { demoWalletStore, type DemoWalletState } from './demo-store'

export { demoWalletStore, DEMO_STARTING_BALANCE, DEMO_STARTING_NATIVE } from './demo-store'
export type { DemoWalletState } from './demo-store'

export interface WalletState {
  address?: Address
  chainId?: number
  isConnected: boolean
  isDemo: boolean
  /** Opens the RainbowKit connect modal, or connects the simulated wallet in demo mode. */
  connect(): void
  disconnect(): void
  switchChain(id: number): Promise<void>
  /** Collateral balance when known (falls back to the native balance while the collateral is unconfigured). */
  balance?: { amount: DecimalString; symbol: string }
  /** Native token balance (gas, oracle bonds). */
  nativeBalance?: { amount: DecimalString; symbol: string }
  /** True while wagmi is reconnecting a previously connected wallet. */
  isReconnecting: boolean
}

export function useDemoWalletState(): DemoWalletState {
  return useSyncExternalStore(demoWalletStore.subscribe, demoWalletStore.getSnapshot, demoWalletStore.getServerSnapshot)
}

/** Demo wallet controls. `enabled` is false outside demo mode (the controls are then no-ops). */
export function useDemoWallet(): {
  enabled: boolean
  address?: Address
  connected: boolean
  connect(): void
  disconnect(): void
  failNext(stepId?: TxStepId): void
  balance: DecimalString
  nativeBalance: DecimalString
  pendingFailure: TxStepId | 'any' | null
} {
  const { demo, env } = usePine()
  const s = useDemoWalletState()
  const connect = useCallback(() => {
    if (demo) demoWalletStore.connect(env.defaultChainId)
  }, [demo, env.defaultChainId])
  const disconnect = useCallback(() => {
    if (demo) demoWalletStore.disconnect()
  }, [demo])
  const failNext = useCallback(
    (stepId?: TxStepId) => {
      if (demo) demoWalletStore.failNext(stepId)
    },
    [demo],
  )
  return {
    enabled: demo,
    address: demo && s.connected ? DEMO_WALLET_ADDRESS : undefined,
    connected: demo && s.connected,
    connect,
    disconnect,
    failNext,
    // Recomputed from `s` so the value updates with the store.
    balance: s.spent !== undefined ? demoWalletStore.balance() : '0',
    nativeBalance: s.gasSpent !== undefined ? demoWalletStore.nativeBalance() : '0',
    pendingFailure: s.failNext,
  }
}

/**
 * Unified wallet API for every wallet button and state in the apps. Uses the simulated wallet in
 * demo mode and wagmi + RainbowKit otherwise.
 */
export function useWallet(): WalletState {
  const { demo, env } = usePine()
  const demoState = useDemoWalletState()
  const account = useWagmiAccount()
  const { openConnectModal } = useConnectModal()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()

  const liveChainId = account.chainId ?? env.defaultChainId
  const chain = getChainOrDefault(liveChainId)
  const collateralConfigured = !isPlaceholderAddress(chain.collateral.address)
  const liveEnabled = !demo && Boolean(account.address)

  const native = useBalance({
    address: account.address,
    chainId: liveChainId,
    query: { enabled: liveEnabled, staleTime: 30_000 },
  })
  const collateral = useReadContract({
    address: chain.collateral.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: account.address ? [account.address] : undefined,
    chainId: liveChainId,
    query: { enabled: liveEnabled && collateralConfigured, staleTime: 30_000 },
  })

  const connect = useCallback(() => {
    if (demo) demoWalletStore.connect(env.defaultChainId)
    else openConnectModal?.()
  }, [demo, env.defaultChainId, openConnectModal])

  const disconnect = useCallback(() => {
    if (demo) demoWalletStore.disconnect()
    else wagmiDisconnect()
  }, [demo, wagmiDisconnect])

  const switchChain = useCallback(
    async (id: number) => {
      if (demo) {
        demoWalletStore.switchChain(id)
        return
      }
      await switchChainAsync({ chainId: id })
    },
    [demo, switchChainAsync],
  )

  return useMemo<WalletState>(() => {
    if (demo) {
      const demoChain = getChainOrDefault(demoState.chainId ?? env.defaultChainId)
      return {
        address: demoState.connected ? DEMO_WALLET_ADDRESS : undefined,
        chainId: demoState.connected ? (demoState.chainId ?? env.defaultChainId) : undefined,
        isConnected: demoState.connected,
        isDemo: true,
        isReconnecting: false,
        connect,
        disconnect,
        switchChain,
        balance: demoState.connected ? { amount: demoWalletStore.balance(), symbol: demoChain.collateral.symbol } : undefined,
        nativeBalance: demoState.connected
          ? { amount: demoWalletStore.nativeBalance(), symbol: demoChain.nativeSymbol }
          : undefined,
      }
    }
    const nativeBal = native.data
      ? { amount: formatUnits(native.data.value, native.data.decimals), symbol: native.data.symbol }
      : undefined
    const collateralBal =
      typeof collateral.data === 'bigint'
        ? { amount: formatUnits(collateral.data, chain.collateral.decimals), symbol: chain.collateral.symbol }
        : undefined
    return {
      address: account.address,
      chainId: account.chainId,
      isConnected: account.isConnected,
      isDemo: false,
      isReconnecting: account.isReconnecting,
      connect,
      disconnect,
      switchChain,
      balance: collateralBal ?? nativeBal,
      nativeBalance: nativeBal,
    }
  }, [
    demo,
    demoState,
    env.defaultChainId,
    connect,
    disconnect,
    switchChain,
    native.data,
    collateral.data,
    chain,
    account.address,
    account.chainId,
    account.isConnected,
    account.isReconnecting,
  ])
}
