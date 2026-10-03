import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { DEMO_WALLET_ADDRESS, getMockDataProvider } from '@pine/data'
import { createGitHubHandler } from '../../server/src/github'
import { PineProviders, createPineQueryClient } from '../src/providers'
import { useGitHubPulls, useResolveGitHubInput } from '../src/github'
import { useRedeem } from '../src/actions/redeem'
import { useWallet, demoWalletStore } from '../src/wallet'
import { __resetTxRunners } from '../src/tx/use-tx-runner'
import { setDemoTxDelays } from '../src/tx/demo-executor'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <PineProviders appName="Pine Test" session={null} env={{ dataSource: 'mock', demoWallet: true }} queryClient={createPineQueryClient()}>
      {children}
    </PineProviders>
  )
}

// Route the hooks' fetch('/api/github/…') through the real @pine/server handler (mock GitHub source).
const github = createGitHubHandler(async () => null, { mode: 'mock' })

beforeAll(() => {
  setDemoTxDelays({ signatureMs: 1, pendingMs: [1, 2], offchainMs: 1, switchMs: 1, resumeAfterMs: 1 })
})

beforeEach(() => {
  localStorage.clear()
  __resetTxRunners()
  demoWalletStore.reset()
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('/api/github/')) return github.GET(new Request(`http://localhost${url}`, init))
    return new Response('{"error":{"code":"not_found","message":"no route"}}', { status: 404 })
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useResolveGitHubInput', () => {
  it('resolves a PR URL (with /files) to its head commit and a ready SourceRef', async () => {
    const pulls = renderHook(() => useGitHubPulls('kleros', 'gateway-balancer-bot', 'all'), { wrapper })
    await waitFor(() => expect(pulls.result.current.data?.length).toBeGreaterThan(0))
    const pr = pulls.result.current.data![0]!

    const { result } = renderHook(() => useResolveGitHubInput(`https://github.com/kleros/gateway-balancer-bot/pull/${pr.number}/files/`), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('resolved'), { timeout: 3000 })
    expect(result.current.pull?.number).toBe(pr.number)
    expect(result.current.commit?.sha).toBe(pr.headSha)
    expect(result.current.source).toMatchObject({
      provider: 'github',
      owner: 'kleros',
      repo: 'gateway-balancer-bot',
      commit: { sha: pr.headSha },
      pullRequest: { number: pr.number },
      baseCommit: { sha: pr.baseSha },
    })
  })

  it('resolves a short SHA to the full SHA', async () => {
    const pulls = renderHook(() => useGitHubPulls('kleros', 'gateway-balancer-bot', 'all'), { wrapper })
    await waitFor(() => expect(pulls.result.current.data?.length).toBeGreaterThan(0))
    const sha = pulls.result.current.data![0]!.headSha
    const { result } = renderHook(() => useResolveGitHubInput(`kleros/gateway-balancer-bot@${sha.slice(0, 8).toUpperCase()}`), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('resolved'), { timeout: 3000 })
    expect(result.current.commit?.sha).toBe(sha)
    expect(result.current.source?.commit.sha).toBe(sha)
  })

  it('explains invalid input and missing repositories', async () => {
    const invalid = renderHook(() => useResolveGitHubInput('not a github ref'), { wrapper })
    await waitFor(() => expect(invalid.result.current.status).toBe('invalid'))
    expect(invalid.result.current.reason).toBeTruthy()

    const missing = renderHook(() => useResolveGitHubInput('kleros/no-such-repo'), { wrapper })
    await waitFor(() => expect(missing.result.current.status).toBe('not_found'), { timeout: 3000 })
    expect(missing.result.current.reason).toMatch(/public repositories only/)

    const empty = renderHook(() => useResolveGitHubInput('   '), { wrapper })
    expect(empty.result.current.status).toBe('empty')
  })
})

describe('useRedeem (demo)', () => {
  it('redeems the demo wallet’s resolved position', async () => {
    const portfolio = await getMockDataProvider().getPortfolio(DEMO_WALLET_ADDRESS)
    const position = portfolio.positions.find((p) => p.redeemable)
    expect(position).toBeDefined()
    const claimId = position!.claimId

    const { result } = renderHook(() => ({ redeem: useRedeem(claimId), wallet: useWallet() }), { wrapper })
    act(() => result.current.wallet.connect())
    await waitFor(() => expect(result.current.redeem.blockers).toEqual([]), { timeout: 3000 })
    expect(Number(result.current.redeem.redeemable)).toBeGreaterThan(0)
    expect(result.current.redeem.runner.steps[0]?.id).toBe('redeem_positions')
    await act(async () => {
      await result.current.redeem.runner.start()
    })
    expect(result.current.redeem.runner.state).toBe('done')
    expect(result.current.redeem.redeemable).toBe('0')
  })
})
