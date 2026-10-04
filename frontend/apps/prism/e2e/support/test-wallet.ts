import type { BrowserContext, Page } from '@playwright/test'

/**
 * A test-only EIP-1193 wallet for the local e2e stack: the page gets `window.ethereum` (also announced through EIP-6963 as
 * "Pine Test Wallet"), and every request is answered in the Playwright process by forwarding it to the LOCAL anvil fork,
 * where the dev account is unlocked (anvil signs `personal_sign` and `eth_sendTransaction` itself). No private key is
 * handled here, and the RPC URL must be loopback: this never talks to a real network.
 */
export interface TestWalletOptions {
  rpcUrl: string
  account: `0x${string}`
  chainId: number
  /**
   * Like an extension wallet whose background is still waking up after a page load (MetaMask's service worker, Brave
   * Wallet loading its keyring): for this long after each load, `eth_accounts` answers [] although the site is authorized.
   */
  wakeMs?: number
}

interface RpcPayload {
  method: string
  params?: unknown[]
}

type RpcAnswer = { result: unknown } | { error: { code: number; message: string } }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

async function anvil(rpcUrl: string, method: string, params: unknown[] = []): Promise<RpcAnswer> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
  return body.error ? { error: { code: body.error.code, message: body.error.message } } : { result: body.result ?? null }
}

export async function installTestWallet(context: BrowserContext, opts: TestWalletOptions): Promise<{ requests: RpcPayload[] }> {
  if (!LOOPBACK.has(new URL(opts.rpcUrl).hostname)) throw new Error('The test wallet only forwards to a loopback (local anvil) RPC.')
  const account = opts.account.toLowerCase() as `0x${string}`
  const chainHex = `0x${opts.chainId.toString(16)}`
  const requests: RpcPayload[] = []
  const loadedAt = new WeakMap<Page, number>()

  await context.exposeBinding('__pineTestWalletLoaded', ({ page }) => {
    loadedAt.set(page, Date.now())
  })
  await context.exposeBinding('__pineTestWalletRpc', async ({ page }, payload: RpcPayload): Promise<RpcAnswer> => {
    requests.push(payload)
    const params = payload.params ?? []
    const waking = Date.now() - (loadedAt.get(page) ?? 0) < (opts.wakeMs ?? 0)
    switch (payload.method) {
      case 'eth_requestAccounts':
        return { result: [account] }
      case 'eth_accounts':
        return { result: waking ? [] : [account] }
      case 'eth_chainId':
        return { result: chainHex }
      case 'net_version':
        return { result: String(opts.chainId) }
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return { result: [{ parentCapability: 'eth_accounts' }] }
      case 'wallet_revokePermissions':
      case 'wallet_addEthereumChain':
        return { result: null }
      case 'wallet_switchEthereumChain': {
        const wanted = Number((params[0] as { chainId?: string } | undefined)?.chainId)
        return wanted === opts.chainId ? { result: null } : { error: { code: 4902, message: `Chain ${wanted} is not available in the test wallet` } }
      }
      case 'personal_sign':
        return anvil(opts.rpcUrl, 'personal_sign', [params[0], account])
      case 'eth_sendTransaction': {
        const tx = { ...(params[0] as Record<string, unknown>), from: account }
        return anvil(opts.rpcUrl, 'eth_sendTransaction', [tx])
      }
      case 'eth_sign':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        // Pine never asks for these (SEC-TX-04): fail loudly if anything does.
        return { error: { code: 4200, message: `${payload.method} is refused by the test wallet` } }
      default:
        return anvil(opts.rpcUrl, payload.method, params)
    }
  })

  await context.addInitScript(
    ({ account: acct, chainHex: chain }) => {
      void (window as unknown as { __pineTestWalletLoaded(): Promise<void> }).__pineTestWalletLoaded()
      type Listener = (...args: unknown[]) => void
      const listeners = new Map<string, Set<Listener>>()
      const provider = {
        isPineTestWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const answer = await (window as unknown as { __pineTestWalletRpc(p: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> }).__pineTestWalletRpc({ method, params })
          if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code })
          if (method === 'eth_requestAccounts') queueMicrotask(() => listeners.get('connect')?.forEach((l) => l({ chainId: chain })))
          return answer.result
        },
        on(event: string, listener: Listener) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event)?.add(listener)
          return provider
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener)
          return provider
        },
        selectedAddress: acct,
        chainId: chain,
      }
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: false, writable: false })
      const icon =
        'data:image/svg+xml;base64,' +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#5AD8FF"/><text x="16" y="21" font-size="14" text-anchor="middle" fill="#16110f">T</text></svg>')
      const info = { uuid: '9f3a7f9e-5b8d-4f4e-9d0c-pine-test-wallet'.slice(0, 36), name: 'Pine Test Wallet', icon, rdns: 'dev.pine.testwallet' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { account, chainHex },
  )
  return { requests }
}
