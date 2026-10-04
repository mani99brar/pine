'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import {
  checkWalletOnFork,
  createFundingTracker,
  devForkConfig,
  forkRpc,
  requestDevFunding,
  walletRequestOf,
  type DevForkConfig,
  type DevFundingResult,
  type ForkWalletCheck,
  type ForkWalletStatus,
} from './fork'

/** Re-check interval: a wallet can change its RPC for the same chain id without telling the page. */
export const DEV_FORK_RECHECK_MS = 15_000

const tracker = createFundingTracker(() => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
})

export interface DevForkWalletState {
  /** False in every build that is not a local dev-fork build: the hook then does nothing at all. */
  enabled: boolean
  config: DevForkConfig | null
  /** null while disconnected or not yet checked. */
  status: ForkWalletStatus | null
  check: ForkWalletCheck | null
  /** Asks the connected wallet to add the fork's RPC for its chain (wallet_addEthereumChain). Throws when it refuses. */
  addForkNetwork(): Promise<void>
}

export interface UseDevForkWalletOptions {
  onFunded?(result: DevFundingResult): void
  onFundingFailed?(message: string): void
}

/** wagmi query keys that hold balances: refreshed after a top-up. */
const BALANCE_KEYS = new Set(['balance', 'readContract', 'readContracts'])

/**
 * LOCAL DEVELOPMENT ONLY (inert unless `devForkConfig()` is non-null). Checks through the wallet's own provider that it
 * is on the local fork, on connect, account or chain change and every 15 s; when it is, asks the dev faucet once per
 * address per tab session to top the wallet up, then refreshes the balances wagmi shows. Never funds a wallet that is
 * not on the fork.
 */
export function useDevForkWallet(opts: UseDevForkWalletOptions = {}): DevForkWalletState {
  const config = useMemo(() => devForkConfig(), [])
  const { address, chainId, connector, isConnected } = useAccount()
  const queryClient = useQueryClient()
  const [check, setCheck] = useState<ForkWalletCheck | null>(null)
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const fork = useMemo(() => (config ? forkRpc(config) : null), [config])

  useEffect(() => {
    if (!config || !fork || !isConnected || !address || !connector) {
      setCheck(null)
      return
    }
    let cancelled = false
    // One faucet attempt per connect / account / chain change (a failure is retried on the next one, not every 15 s).
    let attempted = false
    const run = async () => {
      const wallet = await walletRequestOf(connector).catch(() => null)
      const result: ForkWalletCheck = wallet ? await checkWalletOnFork(wallet, fork, config) : { status: 'unknown' }
      if (cancelled) return
      setCheck((prev) => (prev && prev.status === result.status && prev.walletChainId === result.walletChainId ? prev : result))
      if (result.status !== 'fork' || attempted || !tracker.claim(address)) return
      attempted = true
      try {
        const funding = await requestDevFunding(config, address)
        tracker.done(address)
        await queryClient.invalidateQueries({ predicate: (q) => BALANCE_KEYS.has(String(q.queryKey[0])) })
        optsRef.current.onFunded?.(funding)
      } catch (e) {
        tracker.release(address)
        optsRef.current.onFundingFailed?.(e instanceof Error ? e.message : 'The local dev faucet failed.')
      }
    }
    void run()
    const timer = setInterval(() => void run(), DEV_FORK_RECHECK_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [config, fork, isConnected, address, chainId, connector, queryClient])

  // Here rather than in the app: wagmi's hooks must come from the same wagmi copy as the provider (@pine/react's).
  const addForkNetwork = useCallback(async () => {
    if (!config) return
    const request = await walletRequestOf(connector)
    if (!request) throw new Error('No wallet provider is connected.')
    await request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: `0x${config.chainId.toString(16)}`,
          chainName: 'Gnosis (local fork)',
          nativeCurrency: { name: 'xDAI', symbol: 'XDAI', decimals: 18 },
          rpcUrls: [new URL(config.rpcUrl).origin],
        },
      ],
    })
  }, [config, connector])

  return { enabled: config !== null, config, status: check?.status ?? null, check, addForkNetwork }
}

/** Test helper: the per-tab tracker. */
export const __devForkFundingTracker = tracker
