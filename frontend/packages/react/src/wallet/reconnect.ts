'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useConfig, type Config } from 'wagmi'
import { reconnect } from 'wagmi/actions'
import { usePine } from '../providers/context'

/** Waits between the retries after page load (about 15 s in total). */
export const WALLET_RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000]
/** Minimum gap between retries triggered by events (wallet announcements, focus). */
const EVENT_GAP_MS = 1_000
/** How long after page load the UI may say "reconnecting" instead of offering to connect. */
export const WALLET_RESTORING_UI_MS = 4_000
/** Set while a wallet is connected; cleared when it disconnects while a page is open (by the user or by the wallet). */
const CONNECTED_KEY = 'pine.wallet.connected'

function rememberConnected(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(CONNECTED_KEY, '1')
    else window.localStorage.removeItem(CONNECTED_KEY)
  } catch {
    // Storage unavailable: the UI then never says "reconnecting".
  }
}

function wasConnected(): boolean {
  try {
    return window.localStorage.getItem(CONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

let restoring = false
const restoringListeners = new Set<() => void>()
function setRestoring(next: boolean): void {
  if (next === restoring) return
  restoring = next
  for (const listener of restoringListeners) listener()
}

/**
 * True while a wallet that was still connected when this browser last left a page is being restored after a load
 * (wagmi's own reconnect, then WalletReconnect's retries), for at most WALLET_RESTORING_UI_MS. Wallet buttons show
 * "Reconnecting" instead of "Connect wallet" meanwhile, so a slow extension does not look disconnected on every reload.
 * Never true for a fresh visitor, or after the wallet was disconnected by the user or by the wallet itself.
 */
export function useWalletRestoring(): boolean {
  return useSyncExternalStore(
    (listener) => {
      restoringListeners.add(listener)
      return () => restoringListeners.delete(listener)
    },
    () => restoring,
    () => false,
  )
}

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
    // wagmi reports a restore after a load as a plain 'connecting', so remember ourselves whether a wallet was connected.
    let connected = config.state.status === 'connected'
    if (!connected && wasConnected()) setRestoring(true)
    const track = (status: Config['state']['status']) => {
      if (status === 'connected') {
        connected = true
        rememberConnected(true)
        setRestoring(false)
      } else if (status === 'disconnected' && connected) {
        // Disconnected while this page is open: by the user, or by the wallet. Not a failed restore after a load.
        connected = false
        rememberConnected(false)
        setRestoring(false)
      }
    }
    const unsubscribe = config.subscribe((state) => state.status, track)
    const uiWindow = setTimeout(() => setRestoring(false), WALLET_RESTORING_UI_MS)
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
      unsubscribe()
      clearTimeout(uiWindow)
      setRestoring(false)
      for (const t of timers) clearTimeout(t)
      window.removeEventListener('eip6963:announceProvider', onEvent)
      window.removeEventListener('ethereum#initialized', onEvent)
      window.removeEventListener('focus', onEvent)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [config, demo, delays])

  return null
}
