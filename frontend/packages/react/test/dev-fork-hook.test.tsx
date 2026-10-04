/** useDevForkWallet: checks the wallet's own provider, asks the faucet on every connect / load / move to the fork, never outside dev-fork builds. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const account = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('wagmi', async (orig) => ({ ...(await orig<typeof import('wagmi')>()), useAccount: () => account.current }))

import { __devForkFaucetDedupe, DEV_FORK_RECHECK_MS, useDevForkWallet, type DevForkWalletState, type UseDevForkWalletOptions } from '../src/dev/use-dev-fork'

const REGISTRY = '0x4Af9f320fE64C09a59572B6F687B308278367D61'
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const FORK_HASH = `0x${'aa'.repeat(32)}`

/** A wallet provider; `state.onFork` can be flipped to model the user switching the wallet's RPC. */
function provider(onFork: boolean, type = 'injected') {
  const state = { onFork }
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x64'
    if (method === 'eth_getCode') return state.onFork ? '0x6080' : '0x'
    if (method === 'eth_getBlockByNumber') return { hash: state.onFork ? FORK_HASH : `0x${'bb'.repeat(32)}` }
    if (method === 'wallet_addEthereumChain') return null
    throw new Error(method)
  })
  return { request, state, connector: { type, getProvider: async () => ({ request }) } }
}

function stubDevEnv() {
  vi.stubEnv('NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN', 'http://127.0.0.1:3999')
  vi.stubEnv('NEXT_PUBLIC_RPC_URL_100', 'http://127.0.0.1:8545')
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '100')
  vi.stubEnv('NEXT_PUBLIC_PINE_CLAIM_REGISTRY', REGISTRY)
  vi.stubEnv('NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK', '48570012')
  vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
}

/** fetch: the fork RPC (block hash) and the dev faucet. */
function stubFetch(faucetOk = true, funded = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'http://127.0.0.1:8545/') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: FORK_HASH } }))
    if (url === 'http://127.0.0.1:3999/dev/fund') {
      if (!faucetOk) throw new TypeError('Failed to fetch')
      const { address } = JSON.parse(String(init?.body)) as { address: string }
      return new Response(JSON.stringify({ address, chainId: 100, funded, balanceWei: '1000000000000000000000', previousBalanceWei: '0', thresholdWei: '1', targetWei: '1000000000000000000000', delegatedTo: null, tokens: [] }))
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const faucetCalls = (f: ReturnType<typeof stubFetch>) => f.mock.calls.filter(([url]) => String(url).endsWith('/dev/fund'))

function mount(opts: UseDevForkWalletOptions = {}) {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const state: { current: DevForkWalletState | null } = { current: null }
  function Probe() {
    state.current = useDevForkWallet(opts)
    return null
  }
  const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
  const view = render(wrap(<Probe />))
  return { state, invalidate, rerender: () => view.rerender(wrap(<Probe />)), unmount: view.unmount }
}

beforeEach(() => {
  __devForkFaucetDedupe.reset()
  window.sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('useDevForkWallet', () => {
  it('PRODUCTION-SAFETY: without the dev-fork variable nothing is called (no wallet check, no faucet)', async () => {
    const fetchMock = stubFetch()
    const p = provider(true)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const { state } = mount({ onFunded })
    await act(async () => {})
    expect(state.current).toMatchObject({ enabled: false, status: null })
    expect(p.request).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onFunded).not.toHaveBeenCalled()
  })

  it('funds a wallet on the fork on connect and account switch, and refreshes balances', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(true)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const first = mount({ onFunded })
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    expect(first.state.current?.status).toBe('fork')
    expect(first.invalidate).toHaveBeenCalled()
    // The wallet's own provider was asked (not only the app transport).
    expect(p.request.mock.calls.map(([a]) => a.method)).toEqual(expect.arrayContaining(['eth_chainId', 'eth_getCode', 'eth_getBlockByNumber']))

    // Account switch: the new address is funded.
    account.current = { address: B, chainId: 100, isConnected: true, connector: p.connector }
    first.rerender()
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(2))
    expect(faucetCalls(fetchMock)).toHaveLength(2)
    expect(JSON.parse(String(faucetCalls(fetchMock)[1]?.[1]?.body))).toEqual({ address: B })
    first.unmount()
  })

  it('funds again after a remount when the faucet says funded', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(true)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const first = mount({ onFunded })
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    first.unmount()
    // Reload in the same tab (the wallet was drained, or anvil restarted): nothing persisted blocks a new top-up.
    const again = mount({ onFunded })
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(2))
    expect(faucetCalls(fetchMock)).toHaveLength(2)
    expect(onFunded.mock.calls[1]?.[0]).toMatchObject({ funded: true })
    expect(window.sessionStorage.length).toBe(0)
    again.unmount()
  })

  it('reports a faucet answer of funded: false to the caller (the app shows no success toast for it)', async () => {
    stubDevEnv()
    stubFetch(true, false)
    const p = provider(true)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const view = mount({ onFunded })
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    expect(onFunded.mock.calls[0]?.[0]).toMatchObject({ funded: false })
    view.unmount()
  })

  it('does not ask the faucet again on a periodic re-check while the wallet stays on the fork', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setInterval', 'clearInterval'] })
    try {
      stubDevEnv()
      const fetchMock = stubFetch()
      const p = provider(true)
      account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
      const onFunded = vi.fn()
      const view = mount({ onFunded })
      await vi.waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
      const checks = p.request.mock.calls.filter(([a]) => a.method === 'eth_chainId').length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEV_FORK_RECHECK_MS)
      })
      await vi.waitFor(() => expect(p.request.mock.calls.filter(([a]) => a.method === 'eth_chainId').length).toBeGreaterThan(checks))
      expect(faucetCalls(fetchMock)).toHaveLength(1)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-checks on window focus: not_fork, the wallet switches to the fork, focus, then fork and funding (no timer)', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(false)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const view = mount({ onFunded })
    await waitFor(() => expect(view.state.current?.status).toBe('not_fork'))
    expect(faucetCalls(fetchMock)).toHaveLength(0)
    p.state.onFork = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(view.state.current?.status).toBe('fork'))
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    expect(faucetCalls(fetchMock)).toHaveLength(1)
    view.unmount()
  })

  it('re-checks when the tab becomes visible and after addForkNetwork resolves', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(false)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFunded = vi.fn()
    const view = mount({ onFunded })
    await waitFor(() => expect(view.state.current?.status).toBe('not_fork'))
    const checks = () => p.request.mock.calls.filter(([a]) => a.method === 'eth_chainId').length
    const before = checks()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(checks()).toBeGreaterThan(before))
    p.state.onFork = true
    await act(async () => {
      await view.state.current?.addForkNetwork()
    })
    await waitFor(() => expect(view.state.current?.status).toBe('fork'))
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    expect(faucetCalls(fetchMock)).toHaveLength(1)
    view.unmount()
  })

  it('never runs two checks at once: overlapping re-checks are coalesced', async () => {
    stubDevEnv()
    stubFetch()
    const p = provider(false)
    let active = 0
    let maxActive = 0
    const inner = p.request.getMockImplementation()
    p.request.mockImplementation(async (args) => {
      if (args.method === 'eth_chainId') {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
      }
      return inner ? inner(args) : null
    })
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const view = mount()
    await act(async () => {
      view.state.current?.recheck()
      view.state.current?.recheck()
      view.state.current?.recheck()
    })
    await waitFor(() => expect(view.state.current?.status).toBe('not_fork'))
    expect(maxActive).toBe(1)
    view.unmount()
  })

  it('SEC-TX-05 a WalletConnect connector is blocked and never funded, even when its reads answer like the fork', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(true, 'walletConnect')
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const { state, unmount } = mount()
    await waitFor(() => expect(state.current?.status).toBe('unsupported_wallet'))
    expect(faucetCalls(fetchMock)).toHaveLength(0)
    unmount()
  })

  it('SEC-TX-05 never funds a wallet that is on the real network, and reports not_fork', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    const p = provider(false)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const { state, unmount } = mount()
    await waitFor(() => expect(state.current?.status).toBe('not_fork'))
    expect(faucetCalls(fetchMock)).toHaveLength(0)
    unmount()
  })

  it('warns when the faucet cannot be reached, and retries on the next load', async () => {
    stubDevEnv()
    stubFetch(false)
    const p = provider(true)
    account.current = { address: A, chainId: 100, isConnected: true, connector: p.connector }
    const onFundingFailed = vi.fn()
    const view = mount({ onFundingFailed })
    await waitFor(() => expect(onFundingFailed).toHaveBeenCalledWith(expect.stringMatching(/could not be reached/)))
    view.unmount()
    const fetchMock = stubFetch(true)
    const onFunded = vi.fn()
    const next = mount({ onFunded })
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1))
    expect(faucetCalls(fetchMock)).toHaveLength(1)
    next.unmount()
  })

  it('does nothing while disconnected', async () => {
    stubDevEnv()
    const fetchMock = stubFetch()
    account.current = { address: undefined, isConnected: false }
    const { state, unmount } = mount()
    await act(async () => {})
    expect(state.current).toMatchObject({ enabled: true, status: null })
    expect(fetchMock).not.toHaveBeenCalled()
    unmount()
  })
})
