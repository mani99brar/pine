'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAccount } from 'wagmi'
import {
  checkConnectorOnFork,
  createInFlightDedupe,
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

/** Page-wide: one faucet call per address in flight (memory only; nothing persisted). */
const faucetDedupe = createInFlightDedupe()

export interface DevForkWalletState {
  /** False in every build that is not a local dev-fork build: the hook then does nothing at all. */
  enabled: boolean
  config: DevForkConfig | null
  /** null while disconnected or not yet checked. */
  status: ForkWalletStatus | null
  check: ForkWalletCheck | null
  /** Asks the connected wallet to add the fork's RPC for its chain (wallet_addEthereumChain), then re-checks. Throws when it refuses. */
  addForkNetwork(): Promise<void>
  /** Re-checks now (coalesced: never two checks at once). */
  recheck(): void
}

export interface UseDevForkWalletOptions {
  onFunded?(result: DevFundingResult): void
  onFundingFailed?(message: string): void
}

/** wagmi query keys that hold balances: refreshed after a top-up. */
const BALANCE_KEYS = new Set(['balance', 'readContract', 'readContracts'])

/**
 * LOCAL DEVELOPMENT ONLY (inert unless `devForkConfig()` is non-null). Checks through the wallet's own provider that it
 * is on the local fork: on connect, account or chain change, page load, window focus, the tab becoming visible, after
 * `addForkNetwork`, and every 15 s. Only browser-extension (injected) wallets can pass. Whenever the wallet is newly on
 * the fork (connect, account switch, load, or a move from another status to 'fork') it asks the dev faucet to top it up
 * (the faucet is idempotent and rate-limited), then refreshes the balances wagmi shows. Never funds a wallet that is not
 * on the fork.
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
  const recheckRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!config || !fork || !isConnected || !address || !connector) {
      setCheck(null)
      recheckRef.current = null
      return
    }
    let cancelled = false
    // The last status seen in this effect run: a fresh run (connect / account / chain / load) starts from null, so the
    // first 'fork' asks the faucet; later 'fork' results ask again only after another status in between.
    let lastStatus: ForkWalletStatus | null = null
    let running = false
    let again = false

    const fund = async () => {
      if (!faucetDedupe.claim(address)) return
      try {
        const funding = await requestDevFunding(config, address)
        await queryClient.invalidateQueries({ predicate: (q) => BALANCE_KEYS.has(String(q.queryKey[0])) })
        if (!cancelled) optsRef.current.onFunded?.(funding)
      } catch (e) {
        if (!cancelled) optsRef.current.onFundingFailed?.(e instanceof Error ? e.message : 'The local dev faucet failed.')
      } finally {
        faucetDedupe.settle(address)
      }
    }

    const checkOnce = async () => {
      const result = await checkConnectorOnFork(connector, fork, config).catch((): ForkWalletCheck => ({ status: 'unknown' }))
      if (cancelled) return
      setCheck((prev) => (prev && prev.status === result.status && prev.walletChainId === result.walletChainId ? prev : result))
      const becameFork = result.status === 'fork' && lastStatus !== 'fork'
      lastStatus = result.status
      if (becameFork) await fund()
    }

    // Never two checks at once: a request during a run schedules exactly one more run after it.
    const run = () => {
      if (cancelled) return
      if (running) {
        again = true
        return
      }
      running = true
      void (async () => {
        try {
          do {
            again = false
            await checkOnce()
          } while (again && !cancelled)
        } finally {
          running = false
        }
      })()
    }
    recheckRef.current = run

    const onFocus = () => run()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    run()
    const timer = setInterval(run, DEV_FORK_RECHECK_MS)
    return () => {
      cancelled = true
      if (recheckRef.current === run) recheckRef.current = null
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [config, fork, isConnected, address, chainId, connector, queryClient])

  const recheck = useCallback(() => recheckRef.current?.(), [])

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
    recheckRef.current?.()
  }, [config, connector])

  return { enabled: config !== null, config, status: check?.status ?? null, check, addForkNetwork, recheck }
}

/** Test helper: the page-wide in-flight faucet dedupe. */
export const __devForkFaucetDedupe = faucetDedupe
