/** useDevForkWallet: checks the wallet's own provider, funds once per address per tab, never outside dev-fork builds. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const account = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
vi.mock('wagmi', async (orig) => ({ ...(await orig<typeof import('wagmi')>()), useAccount: () => account.current }))

import { __devForkFundingTracker, useDevForkWallet, type DevForkWalletState, type UseDevForkWalletOptions } from '../src/dev/use-dev-fork'

const REGISTRY = '0x4Af9f320fE64C09a59572B6F687B308278367D61'
const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const FORK_HASH = `0x${'aa'.repeat(32)}`

function provider(onFork: boolean) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x64'
    if (method === 'eth_getCode') return onFork ? '0x6080' : '0x'
    if (method === 'eth_getBlockByNumber') return { hash: onFork ? FORK_HASH : `0x${'bb'.repeat(32)}` }
    throw new Error(method)
  })
  return { request, connector: { getProvider: async () => ({ request }) } }
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
function stubFetch(faucetOk = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'http://127.0.0.1:8545/') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hash: FORK_HASH } }))
    if (url === 'http://127.0.0.1:3999/dev/fund') {
      if (!faucetOk) throw new TypeError('Failed to fetch')
      const { address } = JSON.parse(String(init?.body)) as { address: string }
      return new Response(JSON.stringify({ address, chainId: 100, funded: true, balanceWei: '1000000000000000000000', previousBalanceWei: '0', thresholdWei: '1', targetWei: '1000000000000000000000', delegatedTo: null, tokens: [] }))
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
  __devForkFundingTracker.reset()
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

  it('funds a wallet on the fork once per address per tab session and refreshes balances', async () => {
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
    first.unmount()

    // Reload in the same tab, same address: not funded again.
    const again = mount({ onFunded })
    await waitFor(() => expect(again.state.current?.status).toBe('fork'))
    expect(faucetCalls(fetchMock)).toHaveLength(1)

    // Account switch: the new address is funded once.
    account.current = { address: B, chainId: 100, isConnected: true, connector: p.connector }
    again.rerender()
    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(2))
    expect(faucetCalls(fetchMock)).toHaveLength(2)
    expect(JSON.parse(String(faucetCalls(fetchMock)[1]?.[1]?.body))).toEqual({ address: B })
    again.unmount()
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

  it('warns when the faucet cannot be reached, and retries on the next connect', async () => {
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
