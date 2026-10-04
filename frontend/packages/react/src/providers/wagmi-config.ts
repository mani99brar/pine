import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { createConfig, http, type Config } from 'wagmi'
import type { Chain } from 'viem'
import { gnosis, mainnet, sepolia } from 'viem/chains'
import { SUPPORTED_CHAIN_IDS } from '@pine/core/chains'
import { devForkConfig } from '../dev/fork'

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
 * The RainbowKit wallet list. Explicit on purpose: no Base Account and no Coinbase Wallet SDK
 * connectors (their SDKs pull optional `@x402/*` payment peers and are not needed by Pine).
 * Without a WalletConnect project id, only wallets that never need WalletConnect are listed
 * (RainbowKit throws for WalletConnect-backed wallets without a project id); EIP-6963 discovery
 * still shows every installed browser wallet, MetaMask included.
 *
 * In a local dev-fork build (`devForkConfig()` non-null) only browser-extension wallets backed by wagmi's `injected`
 * connector are listed: WalletConnect answers reads from the app's transports (the fork) while the phone wallet
 * broadcasts on its own network, RainbowKit's `metaMaskWallet` uses the MetaMask SDK connector (or WalletConnect), and
 * Safe is an iframe connector; none of them can be checked against the fork (the dev send guard blocks them anyway).
 * EIP-6963 discovery still shows an installed MetaMask as an injected wallet.
 */
export function pineWalletList(projectId: string | undefined, devFork: boolean = devForkConfig() !== null) {
  if (devFork) return [{ groupName: 'Installed', wallets: [injectedWallet, rabbyWallet] }]
  return projectId
    ? [
        { groupName: 'Installed', wallets: [injectedWallet, metaMaskWallet, rabbyWallet] },
        { groupName: 'More', wallets: [rainbowWallet, safeWallet, walletConnectWallet] },
      ]
    : [{ groupName: 'Installed', wallets: [injectedWallet, rabbyWallet, safeWallet] }]
}

/**
 * Builds the wagmi config with `connectorsForWallets` and an explicit wallet list (see
 * `pineWalletList`). Works without `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (injected wallets only),
 * so the app never crashes for a missing project id.
 */
export function createPineWagmiConfig(opts: { appName: string; defaultChainId: number; siteUrl?: string }): Config {
  const chains = pineViemChains(opts.defaultChainId)
  const transports = Object.fromEntries(chains.map((c) => [c.id, http(rpcOverride(c.id))])) as Record<
    number,
    ReturnType<typeof http>
  >
  const projectId = walletConnectProjectId()
  const connectors = connectorsForWallets(pineWalletList(projectId), {
    appName: opts.appName,
    appUrl: opts.siteUrl,
    // Only read by WalletConnect-backed wallets, which are listed only when a project id exists.
    projectId: projectId ?? '',
  })
  return createConfig({
    chains,
    connectors,
    transports,
    ssr: true,
  }) as unknown as Config
}
