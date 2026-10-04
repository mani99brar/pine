import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPineWagmiConfig, pineViemChains, pineWalletList } from '../src/providers/wagmi-config'

describe('wagmi config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('works without a WalletConnect project id (injected wallets only)', () => {
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', '')
    const config = createPineWagmiConfig({ appName: 'Pine Test', defaultChainId: 100 })
    expect(config.chains[0]?.id).toBe(100)
    expect(config.chains.map((c) => c.id)).toContain(1)
    const ids = config.connectors.map((c) => c.id.toLowerCase())
    expect(ids.some((id) => id.includes('walletconnect'))).toBe(false)
    expect(ids.some((id) => id.includes('base') || id.includes('coinbase'))).toBe(false)
  })

  it('adds WalletConnect-backed wallets only with a project id, never Base Account / Coinbase', () => {
    const names = (list: ReturnType<typeof pineWalletList>) => list.flatMap((g) => g.wallets.map((w) => w.name))
    expect(names(pineWalletList(undefined))).not.toContain('walletConnectWallet')
    const withId = names(pineWalletList('abc'))
    expect(withId).toContain('walletConnectWallet')
    expect(withId.join(',')).not.toMatch(/base|coinbase/i)
  })

  it('SEC-TX-05 lists only browser-extension (injected) wallets in a local dev-fork build', () => {
    const names = (list: ReturnType<typeof pineWalletList>) => list.flatMap((g) => g.wallets.map((w) => w.name))
    for (const id of [undefined, 'abc']) {
      expect(names(pineWalletList(id, true))).toEqual(['injectedWallet', 'rabbyWallet'])
    }
    vi.stubEnv('NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN', 'http://127.0.0.1:3999')
    vi.stubEnv('NEXT_PUBLIC_RPC_URL_100', 'http://127.0.0.1:8545')
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '100')
    vi.stubEnv('NEXT_PUBLIC_PINE_CLAIM_REGISTRY', '0x4Af9f320fE64C09a59572B6F687B308278367D61')
    vi.stubEnv('NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK', '48570012')
    vi.stubEnv('NEXT_PUBLIC_PINE_DATA_SOURCE', 'api')
    expect(names(pineWalletList('abc'))).toEqual(['injectedWallet', 'rabbyWallet'])
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'abc')
    const config = createPineWagmiConfig({ appName: 'Pine Test', defaultChainId: 100 })
    expect(config.connectors.map((c) => c.type)).toEqual(config.connectors.map(() => 'injected'))
  })

  it('default chain first and Ethereum always present (evidence/arbitration chain)', () => {
    expect(pineViemChains(11155111).map((c) => c.id)).toEqual([11155111, 100, 1])
  })
})
