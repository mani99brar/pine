/**
 * WalletReconnect: a wallet connected before a reload but not ready at page load (MetaMask's background waking up,
 * Brave Wallet answering eth_accounts with [] until loaded, late injection) is restored without a prompt, and nothing
 * else is ever connected. Each "page load" is a new wagmi config over the same storage, as in a browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createConfig, createStorage, http, type Config } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { connect, disconnect } from 'wagmi/actions'
import { gnosis } from 'viem/chains'
import type { EIP1193Provider } from 'viem'
import { PineProviders, createPineQueryClient } from '../src/providers'

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const PROMPTS = ['eth_requestAccounts', 'wallet_requestPermissions']

/** An extension-like wallet: permission persists across reloads; until `ready`, eth_accounts answers []. */
function extensionWallet() {
  const state = { ready: true, permitted: false, calls: [] as string[] }
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const provider = {
    async request({ method }: { method: string }) {
      state.calls.push(method)
      switch (method) {
        case 'eth_accounts':
          return state.ready && state.permitted ? [A] : []
        case 'eth_requestAccounts':
          state.permitted = true
          return [A]
        case 'wallet_requestPermissions':
          state.permitted = true
          return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [A] }] }]
        case 'wallet_revokePermissions':
          state.permitted = false
          return null
        case 'eth_chainId':
          return '0x64'
        default:
          throw Object.assign(new Error(`${method} is not supported`), { code: 4200 })
      }
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)?.add(listener)
      return provider
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return provider
    },
  }
  return { state, provider: provider as unknown as EIP1193Provider }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return createStorage({
    storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) },
  })
}

/** The wagmi config of one page load. */
function pageConfig(storage: ReturnType<typeof memoryStorage>, provider: EIP1193Provider): Config {
  return createConfig({
    chains: [gnosis],
    connectors: [injected({ target: () => ({ id: 'extensionWallet', name: 'Extension Wallet', provider }) })],
    transports: { [gnosis.id]: http('http://127.0.0.1:1') },
    storage,
    multiInjectedProviderDiscovery: false,
  })
}

function load(config: Config) {
  render(
    <PineProviders appName="Pine test" env={{ dataSource: 'api', demoWallet: false }} wagmiConfig={config} queryClient={createPineQueryClient()}>
      <div />
    </PineProviders>,
  )
}

/** Connects on a first page load, as the user did before reloading. */
async function connectedBefore(storage: ReturnType<typeof memoryStorage>, provider: EIP1193Provider): Promise<Config> {
  const first = pageConfig(storage, provider)
  const [connector] = first.connectors
  if (!connector) throw new Error('no connector')
  await connect(first, { connector })
  expect(first.state.status).toBe('connected')
  return first
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WalletReconnect', () => {
  it('restores a wallet that answered [] at page load once it is ready, without a prompt', async () => {
    const storage = memoryStorage()
    const wallet = extensionWallet()
    await connectedBefore(storage, wallet.provider)

    wallet.state.ready = false
    const callsAtReload = wallet.state.calls.length
    const page = pageConfig(storage, wallet.provider)
    load(page)
    await advance(200)
    // wagmi's single mount-time attempt found no account.
    expect(page.state.status).toBe('disconnected')

    wallet.state.ready = true
    await advance(600)
    expect(page.state.status).toBe('connected')
    expect([...page.state.connections.values()][0]?.accounts).toEqual([A])
    expect(wallet.state.calls.slice(callsAtReload).filter((m) => PROMPTS.includes(m))).toEqual([])
  })

  it('keeps retrying with backoff while the wallet wakes up slowly', async () => {
    const storage = memoryStorage()
    const wallet = extensionWallet()
    await connectedBefore(storage, wallet.provider)

    wallet.state.ready = false
    const page = pageConfig(storage, wallet.provider)
    load(page)
    await advance(3_600)
    expect(page.state.status).toBe('disconnected')
    wallet.state.ready = true
    await advance(4_100)
    expect(page.state.status).toBe('connected')
  })

  it('retries at once when a wallet announces itself, and when the tab regains focus', async () => {
    const storage = memoryStorage()
    const wallet = extensionWallet()
    await connectedBefore(storage, wallet.provider)

    wallet.state.ready = false
    const page = pageConfig(storage, wallet.provider)
    load(page)
    await advance(200)
    expect(page.state.status).toBe('disconnected')
    wallet.state.ready = true
    act(() => void window.dispatchEvent(new Event('eip6963:announceProvider')))
    await advance(50)
    expect(page.state.status).toBe('connected')

    // A wallet locked through every retry, unlocked later: focus brings it back.
    const locked = extensionWallet()
    const otherStorage = memoryStorage()
    await connectedBefore(otherStorage, locked.provider)
    cleanup()
    locked.state.ready = false
    const later = pageConfig(otherStorage, locked.provider)
    load(later)
    await advance(20_000)
    expect(later.state.status).toBe('disconnected')
    locked.state.ready = true
    act(() => void window.dispatchEvent(new Event('focus')))
    await advance(50)
    expect(later.state.status).toBe('connected')
  })

  it('never reconnects a wallet the user disconnected', async () => {
    const storage = memoryStorage()
    const wallet = extensionWallet()
    const first = await connectedBefore(storage, wallet.provider)
    await disconnect(first)

    const page = pageConfig(storage, wallet.provider)
    load(page)
    await advance(20_000)
    act(() => void window.dispatchEvent(new Event('focus')))
    await advance(50)
    expect(page.state.status).toBe('disconnected')
  })

  it('does nothing in a browser that never connected a wallet', async () => {
    const wallet = extensionWallet()
    wallet.state.permitted = true
    const page = pageConfig(memoryStorage(), wallet.provider)
    load(page)
    await advance(200)
    const settled = wallet.state.calls.length
    await advance(20_000)
    act(() => void window.dispatchEvent(new Event('focus')))
    await advance(50)
    expect(wallet.state.calls.slice(settled)).toEqual([])
    expect(wallet.state.calls.filter((m) => PROMPTS.includes(m))).toEqual([])
  })
})
