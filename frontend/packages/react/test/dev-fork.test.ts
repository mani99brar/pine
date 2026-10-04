/** Local dev-fork helpers (src/dev/fork.ts): loopback-only config, the wallet-on-fork decision, the faucet call. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkWalletOnFork,
  createDevForkSendGuard,
  createFundingTracker,
  devForkConfig,
  loopbackUrl,
  parseDevForkConfig,
  requestDevFunding,
  type DevForkConfig,
  type DevForkEnv,
  type Eip1193Request,
} from '../src/dev/fork'

const REGISTRY = '0x4Af9f320fE64C09a59572B6F687B308278367D61'
const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const FORK_HASH = `0x${'aa'.repeat(32)}`
const REAL_HASH = `0x${'bb'.repeat(32)}`

const ENV: DevForkEnv = {
  controlOrigin: 'http://127.0.0.1:3999',
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: '100',
  claimRegistry: REGISTRY,
  deploymentBlock: '48570012',
  dataSource: 'api',
}
const CFG = parseDevForkConfig(ENV) as DevForkConfig

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('dev fork config: loopback only', () => {
  it('accepts the dev-stack values', () => {
    expect(CFG).toEqual({ controlOrigin: 'http://127.0.0.1:3999', rpcUrl: 'http://127.0.0.1:8545/', chainId: 100, claimRegistry: REGISTRY, checkBlock: 48570012n })
    expect(parseDevForkConfig({ ...ENV, controlOrigin: 'http://localhost:3999', rpcUrl: 'http://[::1]:8545' })).not.toBeNull()
  })

  it.each([
    ['a public origin', { controlOrigin: 'https://faucet.example.com' }],
    ['a loopback-looking public host', { controlOrigin: 'http://127.0.0.1.nip.io:3999' }],
    ['a localhost subdomain', { controlOrigin: 'http://localhost.evil.com:3999' }],
    ['credentials', { controlOrigin: 'http://user:pw@127.0.0.1:3999' }],
    ['a path', { controlOrigin: 'http://127.0.0.1:3999/dev' }],
    ['a query', { controlOrigin: 'http://127.0.0.1:3999/?x=1' }],
    ['a fragment', { controlOrigin: 'http://127.0.0.1:3999/#x' }],
    ['another scheme', { controlOrigin: 'javascript:alert(1)' }],
    ['a malformed URL', { controlOrigin: 'not a url' }],
    ['an empty value', { controlOrigin: '' }],
    ['a public fork RPC', { rpcUrl: 'https://rpc.gnosischain.com' }],
    ['another chain', { chainId: '1' }],
    ['a non-api data source', { dataSource: 'mock' }],
    ['a malformed registry', { claimRegistry: '0x1234' }],
    ['a malformed block', { deploymentBlock: '12abc' }],
  ])('is null for %s (nothing funds or blocks)', (_name, patch) => {
    expect(parseDevForkConfig({ ...ENV, ...patch })).toBeNull()
  })

  it('loopbackUrl allows a path only when asked to', () => {
    expect(loopbackUrl('http://127.0.0.1:8545/rpc', false)?.pathname).toBe('/rpc')
    expect(loopbackUrl('http://127.0.0.1:8545/rpc', true)).toBeNull()
  })

  it('PRODUCTION-SAFETY: without NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN the dev fork is off even with every other variable set', () => {
    vi.stubEnv('NEXT_PUBLIC_RPC_URL_100', 'http://127.0.0.1:8545')
    vi.stubEnv('NEXT_PUBLIC_PINE_CLAIM_REGISTRY', REGISTRY)
    vi.stubEnv('NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK', '48570012')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    vi.stubEnv('NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN', '')
    expect(devForkConfig()).toBeNull()
    vi.stubEnv('NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN', 'http://127.0.0.1:3999')
    expect(devForkConfig()).not.toBeNull()
  })
})

/** A wallet provider that answers like a node; `hash` is its block hash at the check height. */
function wallet(over: { chainId?: string; code?: string; hash?: string | null; fail?: boolean } = {}): Eip1193Request & { methods: string[] } {
  const methods: string[] = []
  const fn = (async ({ method }: { method: string }) => {
    methods.push(method)
    if (over.fail) throw new Error('provider disconnected')
    if (method === 'eth_chainId') return over.chainId ?? '0x64'
    if (method === 'eth_getCode') return over.code ?? '0x6080'
    if (method === 'eth_getBlockByNumber') return over.hash === null ? null : { hash: over.hash ?? FORK_HASH }
    throw new Error(`unexpected ${method}`)
  }) as Eip1193Request & { methods: string[] }
  fn.methods = methods
  return fn
}
const fork: Eip1193Request = async ({ method, params }) => {
  expect(method).toBe('eth_getBlockByNumber')
  expect(params).toEqual(['0x2e51e9c', false])
  return { hash: FORK_HASH }
}

describe('wallet-on-fork decision (through the wallet provider)', () => {
  it('is fork when chain 100, the registry has code and the block hash matches the fork', async () => {
    expect(await checkWalletOnFork(wallet(), fork, CFG)).toEqual({ status: 'fork', walletChainId: 100 })
  })

  it('SEC-TX-05 is not_fork for MetaMask on the real Gnosis RPC (registry has no code there)', async () => {
    expect((await checkWalletOnFork(wallet({ code: '0x' }), fork, CFG)).status).toBe('not_fork')
  })

  it('SEC-TX-05 is not_fork when the registry address has code on the real chain but the block hash differs', async () => {
    expect((await checkWalletOnFork(wallet({ hash: REAL_HASH }), fork, CFG)).status).toBe('not_fork')
    expect((await checkWalletOnFork(wallet({ hash: null }), fork, CFG)).status).toBe('not_fork')
  })

  it('is wrong_chain on another chain and does not query further', async () => {
    const w = wallet({ chainId: '0x1' })
    expect(await checkWalletOnFork(w, fork, CFG)).toEqual({ status: 'wrong_chain', walletChainId: 1 })
    expect(w.methods).toEqual(['eth_chainId'])
  })

  it('is unknown on provider errors or malformed answers', async () => {
    expect((await checkWalletOnFork(wallet({ fail: true }), fork, CFG)).status).toBe('unknown')
    expect((await checkWalletOnFork(wallet({ chainId: 'one hundred' }), fork, CFG)).status).toBe('unknown')
    expect((await checkWalletOnFork(wallet({ code: 'zz' }), fork, CFG)).status).toBe('unknown')
    const deadFork: Eip1193Request = async () => {
      throw new Error('fork down')
    }
    expect((await checkWalletOnFork(wallet(), deadFork, CFG)).status).toBe('unknown')
  })
})

describe('dev send guard', () => {
  it('refuses chains that are not forked (chain 1 would hit real Ethereum)', async () => {
    const guard = createDevForkSendGuard(CFG, async () => wallet(), fork)
    expect(guard.refuseChain(1)).toMatch(/not part of the local fork.*Nothing was sent/)
    expect(guard.refuseChain(100)).toBeNull()
    await expect(guard.beforeSend({ chainId: 1 })).rejects.toThrow(/Nothing was sent/)
  })

  it('passes a wallet on the fork and refuses one on the real network or an unreachable one', async () => {
    await expect(createDevForkSendGuard(CFG, async () => wallet(), fork).beforeSend({ chainId: 100 })).resolves.toBeUndefined()
    await expect(createDevForkSendGuard(CFG, async () => wallet({ code: '0x' }), fork).beforeSend({ chainId: 100 })).rejects.toThrow(/REAL Gnosis.*Nothing was sent.*127\.0\.0\.1:8545/)
    await expect(createDevForkSendGuard(CFG, async () => null, fork).beforeSend({ chainId: 100 })).rejects.toThrow(/Could not confirm/)
  })
})

describe('faucet request', () => {
  const ok = { address: USER, chainId: 100, funded: true, balanceWei: '1000000000000000000000', previousBalanceWei: '0', thresholdWei: '1', targetWei: '1000000000000000000000', delegatedTo: null, tokens: [] }

  it('posts the checksummed address with the dev header and no credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(ok), { status: 200 }))
    const out = await requestDevFunding(CFG, USER.toLowerCase(), fetchImpl as unknown as typeof fetch)
    expect(out).toMatchObject({ funded: true, balanceWei: 10n ** 21n, delegatedTo: null })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://127.0.0.1:3999/dev/fund')
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', body: JSON.stringify({ address: USER }) })
    expect((init?.headers as Record<string, string>)['x-pine-dev']).toBe('1')
  })

  it('reports an unreachable faucet, a refusal and a malformed answer', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(requestDevFunding(CFG, USER, down)).rejects.toThrow(/could not be reached/)
    const refused = (async () => new Response(JSON.stringify({ error: 'too many faucet requests' }), { status: 429 })) as unknown as typeof fetch
    await expect(requestDevFunding(CFG, USER, refused)).rejects.toThrow(/refused: too many/)
    const odd = (async () => new Response(JSON.stringify({ ...ok, balanceWei: 1e21 }), { status: 200 })) as unknown as typeof fetch
    await expect(requestDevFunding(CFG, USER, odd)).rejects.toThrow(/unexpected answer/)
    const other = (async () => new Response(JSON.stringify({ ...ok, address: REGISTRY }), { status: 200 })) as unknown as typeof fetch
    await expect(requestDevFunding(CFG, USER, other)).rejects.toThrow(/unexpected answer/)
  })
})

describe('funding tracker: once per address per tab session', () => {
  it('claims an address once, survives a new tracker on the same session storage, and lets a failure retry', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const t = createFundingTracker(() => storage)
    expect(t.claim(USER)).toBe(true)
    expect(t.claim(USER.toLowerCase())).toBe(false) // in flight
    t.release(USER)
    expect(t.claim(USER)).toBe(true)
    t.done(USER)
    expect(t.claim(USER)).toBe(false)
    expect(createFundingTracker(() => storage).claim(USER)).toBe(false)
    expect(t.claim(REGISTRY)).toBe(true)
  })

  it('works in memory when storage throws', () => {
    const t = createFundingTracker(() => {
      throw new Error('blocked')
    })
    expect(t.claim(USER)).toBe(true)
    t.done(USER)
    expect(t.claim(USER)).toBe(false)
  })
})
