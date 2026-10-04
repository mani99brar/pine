'use client'

import { useEffect } from 'react'
import { useConfig } from 'wagmi'
import { reconnect } from 'wagmi/actions'
import { usePine } from '../providers/context'

/** Waits between the retries after page load (about 15 s in total). */
export const WALLET_RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]
/** Minimum gap between retries triggered by events (wallet announcements, focus). */
const EVENT_GAP_MS = 1_000

/**
 * Restores, after a reload, a wallet that was connected before but was not ready when the page loaded.
 *
 * wagmi reconnects authorized wallets once, when the app mounts. Extension wallets are often not ready at that instant:
 * MetaMask's background wakes up, Brave Wallet answers `eth_accounts` with [] until it has loaded, others inject their
 * provider late. That single attempt then finds no account, so the page shows "Connect wallet" while the backend
 * session is still valid. This repeats the same silent reconnect: only connectors the wallet already authorized and the
 * user did not disconnect, never a prompt, and only in a browser that connected a wallet before. It retries with backoff
 * after page load, and again when a wallet announces itself (EIP-6963) or the tab regains focus (after unlocking the
 * wallet, for example). A different account than the session's is handled by the wallet-switch guard (SEC-AUTH-13).
 */
export function WalletReconnect({ delays = WALLET_RECONNECT_DELAYS_MS }: { delays?: readonly number[] }): null {
  const { demo } = usePine()
  const config = useConfig()

  useEffect(() => {
    if (demo) return
    let cancelled = false
    let running = false
    let last = 0
    const attempt = async () => {
      if (cancelled || running || config.state.status !== 'disconnected') return
      const recent = await config.storage?.getItem('recentConnectorId')
      if (cancelled || !recent || config.state.status !== 'disconnected') return
      running = true
      last = Date.now()
      try {
        await reconnect(config)
      } catch {
        // The next retry or event tries again.
      } finally {
        running = false
      }
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    let at = 0
    for (const delay of delays) {
      at += delay
      timers.push(setTimeout(() => void attempt(), at))
    }
    const onEvent = () => {
      if (Date.now() - last >= EVENT_GAP_MS) void attempt()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') onEvent()
    }
    window.addEventListener('eip6963:announceProvider', onEvent)
    window.addEventListener('ethereum#initialized', onEvent)
    window.addEventListener('focus', onEvent)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      for (const t of timers) clearTimeout(t)
      window.removeEventListener('eip6963:announceProvider', onEvent)
      window.removeEventListener('ethereum#initialized', onEvent)
      window.removeEventListener('focus', onEvent)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [config, demo, delays])

  return null
}
