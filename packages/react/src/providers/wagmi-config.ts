import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { createConfig, http, injected, type Config } from 'wagmi'
import type { Chain } from 'viem'
import { gnosis, mainnet, sepolia } from 'viem/chains'
import { SUPPORTED_CHAIN_IDS } from '@pine/core/chains'

const VIEM_CHAINS: Record<number, Chain> = {
  100: gnosis,
  1: mainnet,
  11155111: sepolia,
}

/** Optional RPC overrides. Literal `process.env.X` reads so Next.js inlines them on the client. */
function rpcOverride(chainId: number): string | undefined {
  const byId: Record<number, string | undefined> = {
    100: process.env.NEXT_PUBLIC_RPC_URL_100,
    1: process.env.NEXT_PUBLIC_RPC_URL_1,
    11155111: process.env.NEXT_PUBLIC_RPC_URL_11155111,
  }
  const v = byId[chainId]
  return v && v.length > 0 ? v : undefined
}

export function walletConnectProjectId(): string | undefined {
  const v = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
  return v && v.trim().length > 0 ? v.trim() : undefined
}

/** The viem chains Pine supports, default chain first. */
export function pineViemChains(defaultChainId: number): [Chain, ...Chain[]] {
  // Ethereum mainnet is always included: ERC-1497 evidence and Kleros arbitration happen on L1 even
  // for Gnosis markets (docs/research/seer-integration.md).
  const ids = [...new Set([defaultChainId, ...SUPPORTED_CHAIN_IDS, 1])]
  const chains = ids.map((id) => VIEM_CHAINS[id]).filter((c): c is Chain => Boolean(c))
  const [first, ...rest] = chains
  return first ? [first, ...rest] : [gnosis]
}

/**
 * Builds the wagmi config. With `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` it uses RainbowKit's
 * default wallet list (WalletConnect, Coinbase, MetaMask, Rainbow…). Without it, it falls back to
 * injected wallets only (EIP-6963 discovery), so the app never crashes for a missing project id.
 */
export function createPineWagmiConfig(opts: { appName: string; defaultChainId: number; siteUrl?: string }): Config {
  const chains = pineViemChains(opts.defaultChainId)
  const transports = Object.fromEntries(chains.map((c) => [c.id, http(rpcOverride(c.id))])) as Record<
    number,
    ReturnType<typeof http>
  >
  const projectId = walletConnectProjectId()
  if (projectId) {
    return getDefaultConfig({
      appName: opts.appName,
      appUrl: opts.siteUrl,
      projectId,
      chains,
      transports,
      ssr: true,
    }) as unknown as Config
  }
  return createConfig({
    chains,
    connectors: [injected({ shimDisconnect: true })],
    transports,
    ssr: true,
  }) as unknown as Config
}
