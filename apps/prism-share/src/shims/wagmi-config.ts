/**
 * Replaces packages/react/src/providers/wagmi-config.ts in the static build (wired by the
 * `prism-share:overrides` plugin in vite.config.ts).
 *
 * Demo mode uses the simulated wallet, so wagmi only has to exist for its hooks. This config has the
 * same chains but no connectors (no injected-wallet discovery, no Safe iframe probing, no WalletConnect)
 * and transports that refuse every RPC call, so the preview can never reach an RPC endpoint.
 */
import { createConfig, custom, type Config } from 'wagmi'
import type { Chain } from 'viem'
import { gnosis, mainnet, sepolia } from 'viem/chains'
import { SUPPORTED_CHAIN_IDS } from '@pine/core/chains'

const VIEM_CHAINS: Record<number, Chain> = { 100: gnosis, 1: mainnet, 11155111: sepolia }

export function walletConnectProjectId(): string | undefined {
  return undefined
}

/** Same chain selection as Prism: default chain first, Ethereum mainnet always included. */
export function pineViemChains(defaultChainId: number): [Chain, ...Chain[]] {
  const ids = [...new Set([defaultChainId, ...SUPPORTED_CHAIN_IDS, 1])]
  const chains = ids.map((id) => VIEM_CHAINS[id]).filter((c): c is Chain => Boolean(c))
  const [first, ...rest] = chains
  return first ? [first, ...rest] : [gnosis]
}

/** No external wallets in the static preview. */
export function pineWalletList(_projectId: string | undefined): never[] {
  return []
}

const offline = custom({
  async request({ method }: { method: string }) {
    throw new Error(`RPC is disabled in the Pine Prism static preview (${method}). The demo wallet is simulated.`)
  },
})

export function createPineWagmiConfig(opts: { appName: string; defaultChainId: number; siteUrl?: string }): Config {
  const chains = pineViemChains(opts.defaultChainId)
  const transports = Object.fromEntries(chains.map((c) => [c.id, offline]))
  return createConfig({
    chains,
    connectors: [],
    transports,
    multiInjectedProviderDiscovery: false,
    ssr: false,
  }) as unknown as Config
}
