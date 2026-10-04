/**
 * LOCAL DEVELOPMENT ONLY: the dev stack (scripts/dev-stack) runs Pine against an anvil fork of Gnosis on this machine.
 *
 * - Faucet: when a wallet connects, the dev control server tops its xDAI up on the fork (POST /dev/fund).
 * - Guard: MetaMask's built-in Gnosis network points at the REAL Gnosis RPC. The app reads and estimates through the fork,
 *   but the wallet would sign and broadcast on real Gnosis (real gas, contracts that exist only on the fork). The guard
 *   asks the WALLET's own provider (never the app transport) whether it is on the fork, and refuses to send otherwise.
 *   Only browser-extension (injected) wallets can be checked that way: a WalletConnect connector answers reads from the
 *   app's own transports (the fork) while the phone wallet broadcasts on its own network, so every other connector type
 *   is blocked here (fail closed).
 *
 * Everything here is inert unless the build sets NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN (written only by
 * scripts/dev-stack/up.sh) to a loopback http(s) origin, the fork RPC (NEXT_PUBLIC_RPC_URL_100) is loopback too, and the
 * deployment variables are present. Production builds never set it, so `devForkConfig()` returns null there and nothing
 * is called.
 */
import { getAddress, type Address } from 'viem'

export const DEV_FORK_CHAIN_ID = 100

export interface DevForkConfig {
  /** The dev control server's origin (faucet). */
  controlOrigin: string
  /** The fork's JSON-RPC URL (the app's own transport for chain 100). */
  rpcUrl: string
  chainId: typeof DEV_FORK_CHAIN_ID
  /** Pine's ClaimRegistry: has code on the fork, none on real Gnosis. */
  claimRegistry: Address
  /** Pine's deployment block: mined by anvil, so its hash differs from real Gnosis at the same height. */
  checkBlock: bigint
  /** The app's own origin (NEXT_PUBLIC_SITE_URL, loopback only): the one origin the faucet accepts. Null when unknown. */
  appOrigin: string | null
}

export interface DevForkEnv {
  controlOrigin?: string
  rpcUrl?: string
  chainId?: string
  claimRegistry?: string
  deploymentBlock?: string
  dataSource?: string
  appOrigin?: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A loopback http(s) URL without credentials, query or fragment; `originOnly` also requires an empty path. */
export function loopbackUrl(raw: string | undefined, originOnly: boolean): URL | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!LOOPBACK.has(url.hostname) || url.username || url.password || url.search || url.hash) return null
  if (originOnly && url.pathname !== '/') return null
  return url
}

/** Pure validation of the dev-fork variables (see `devForkConfig`). Anything missing or non-loopback: null. */
export function parseDevForkConfig(env: DevForkEnv): DevForkConfig | null {
  const control = loopbackUrl(env.controlOrigin, true)
  const rpc = loopbackUrl(env.rpcUrl, false)
  if (!control || !rpc) return null
  if (env.dataSource !== 'api') return null
  if ((env.chainId ?? '100') !== String(DEV_FORK_CHAIN_ID)) return null
  if (!env.claimRegistry || !/^0x[0-9a-fA-F]{40}$/.test(env.claimRegistry)) return null
  if (!env.deploymentBlock || !/^[1-9][0-9]{0,15}$/.test(env.deploymentBlock)) return null
  return {
    controlOrigin: control.origin,
    rpcUrl: rpc.toString(),
    chainId: DEV_FORK_CHAIN_ID,
    claimRegistry: getAddress(env.claimRegistry.toLowerCase()),
    checkBlock: BigInt(env.deploymentBlock),
    appOrigin: loopbackUrl(env.appOrigin, true)?.origin ?? null,
  }
}

function read(fn: () => string | undefined): string | undefined {
  try {
    const value = fn()
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** Reads the build-time variables (literal `process.env.X` reads so Next.js inlines them). Null outside local dev-fork builds. */
export function devForkConfig(): DevForkConfig | null {
  return parseDevForkConfig({
    controlOrigin: read(() => process.env.NEXT_PUBLIC_PINE_DEV_FORK_ORIGIN),
    rpcUrl: read(() => process.env.NEXT_PUBLIC_RPC_URL_100),
    chainId: read(() => process.env.NEXT_PUBLIC_CHAIN_ID),
    claimRegistry: read(() => process.env.NEXT_PUBLIC_PINE_CLAIM_REGISTRY),
    deploymentBlock: read(() => process.env.NEXT_PUBLIC_PINE_DEPLOYMENT_BLOCK),
    dataSource: read(() => process.env.NEXT_PUBLIC_PINE_DATA_SOURCE)?.toLowerCase(),
    appOrigin: read(() => process.env.NEXT_PUBLIC_SITE_URL),
  })
}

// ------------------------------------------------------------------------------------------------ wallet-on-fork check

/** An EIP-1193 `request`. */
export type Eip1193Request = (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>

/**
 * - `unsupported_wallet`: the connector is not a browser-extension (injected) wallet, so its reads cannot be trusted to
 *   come from the network it broadcasts on (WalletConnect reads through the app's transports). Always blocked.
 */
export type ForkWalletStatus = 'fork' | 'wrong_chain' | 'not_fork' | 'unsupported_wallet' | 'unknown'

export interface ForkWalletCheck {
  status: ForkWalletStatus
  /** The wallet's chain id when it answered. */
  walletChainId?: number
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]{1,64}$/
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const HASH = /^0x[0-9a-fA-F]{64}$/

function blockHash(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const hash = (value as { hash?: unknown }).hash
  return typeof hash === 'string' && HASH.test(hash) ? hash.toLowerCase() : null
}

/**
 * Asks the WALLET whether it is on the local fork: chain id 100, Pine's ClaimRegistry has code, and the hash of Pine's
 * deployment block equals the fork's (real Gnosis has a different block at that height; the registry address alone could
 * be deployed on real Gnosis by anyone holding anvil's public key). Any error or malformed answer is 'unknown'.
 */
export async function checkWalletOnFork(wallet: Eip1193Request, fork: Eip1193Request, cfg: DevForkConfig): Promise<ForkWalletCheck> {
  try {
    const chainHex = await wallet({ method: 'eth_chainId' })
    if (typeof chainHex !== 'string' || !HEX_QUANTITY.test(chainHex)) return { status: 'unknown' }
    const walletChainId = Number(BigInt(chainHex))
    if (walletChainId !== cfg.chainId) return { status: 'wrong_chain', walletChainId }
    const code = await wallet({ method: 'eth_getCode', params: [cfg.claimRegistry, 'latest'] })
    if (typeof code !== 'string' || !HEX_DATA.test(code)) return { status: 'unknown', walletChainId }
    if (code === '0x') return { status: 'not_fork', walletChainId }
    const blockTag = `0x${cfg.checkBlock.toString(16)}`
    const [walletBlock, forkBlock] = await Promise.all([
      wallet({ method: 'eth_getBlockByNumber', params: [blockTag, false] }),
      fork({ method: 'eth_getBlockByNumber', params: [blockTag, false] }),
    ])
    const forkHash = blockHash(forkBlock)
    if (!forkHash) return { status: 'unknown', walletChainId }
    const walletHash = blockHash(walletBlock)
    if (walletHash === null && walletBlock !== null) return { status: 'unknown', walletChainId }
    return { status: walletHash === forkHash ? 'fork' : 'not_fork', walletChainId }
  } catch {
    return { status: 'unknown' }
  }
}

/** JSON-RPC to the fork URL of the config (loopback, validated by `parseDevForkConfig`). */
export function forkRpc(cfg: DevForkConfig, fetchImpl: typeof fetch = fetch): Eip1193Request {
  let id = 0
  return async ({ method, params }) => {
    id += 1
    const response = await fetchImpl(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? [] }),
      credentials: 'omit',
      redirect: 'error',
    })
    const answer: unknown = await response.json()
    if (typeof answer !== 'object' || answer === null || !('result' in answer)) throw new Error(`The local fork did not answer ${method}.`)
    return (answer as { result: unknown }).result
  }
}

/** The connected wallet's own EIP-1193 provider (via the wagmi connector), never the app transport. */
export async function walletRequestOf(connector: { getProvider(): Promise<unknown> } | undefined): Promise<Eip1193Request | null> {
  if (!connector) return null
  const provider = await connector.getProvider()
  if (typeof provider !== 'object' || provider === null) return null
  const request = (provider as { request?: unknown }).request
  if (typeof request !== 'function') return null
  return (args) => (request as Eip1193Request).call(provider, args)
}

/** The parts of a wagmi connector the fork check uses. */
export interface DevForkConnector {
  /** wagmi's connector type: 'injected' for browser-extension wallets (EIP-1193 provider in the page). */
  readonly type?: unknown
  getProvider(): Promise<unknown>
}

/** The only connector type whose own provider is the wallet's network: a browser-extension wallet. */
export const CHECKABLE_CONNECTOR_TYPE = 'injected'

/**
 * The fork check for a wagmi connector: fails closed (`unsupported_wallet`) for anything but a browser-extension
 * (injected) wallet, without asking its provider anything; otherwise `checkWalletOnFork` through its own provider.
 */
export async function checkConnectorOnFork(connector: DevForkConnector | null | undefined, fork: Eip1193Request, cfg: DevForkConfig): Promise<ForkWalletCheck> {
  if (!connector) return { status: 'unknown' }
  if (connector.type !== CHECKABLE_CONNECTOR_TYPE) return { status: 'unsupported_wallet' }
  const wallet = await walletRequestOf(connector).catch(() => null)
  return wallet ? checkWalletOnFork(wallet, fork, cfg) : { status: 'unknown' }
}

export const UNSUPPORTED_WALLET_MESSAGE = 'Only a browser-extension wallet can be checked on the local fork; this wallet is blocked here.'

export function forkStatusMessage(check: ForkWalletCheck, cfg: DevForkConfig): string {
  switch (check.status) {
    case 'fork':
      return 'Your wallet is on the local fork.'
    case 'wrong_chain':
      return `Your wallet is on chain ${check.walletChainId ?? '?'}, not the local Gnosis fork (chain ${cfg.chainId}).`
    case 'not_fork':
      return 'Your wallet is on the REAL Gnosis network, not the local fork.'
    case 'unsupported_wallet':
      return UNSUPPORTED_WALLET_MESSAGE
    default:
      return 'Could not confirm that your wallet is on the local fork.'
  }
}

/** The fix shown with the guard: point the wallet's Gnosis network at the fork's RPC (or use an extension wallet). */
export function forkFixHint(cfg: DevForkConfig, status?: ForkWalletStatus | null): string {
  if (status === 'unsupported_wallet') {
    return `Disconnect it and connect a browser-extension wallet (MetaMask, Rabby) whose Gnosis network points at ${new URL(cfg.rpcUrl).origin}.`
  }
  return `Point your wallet's Gnosis network (chain ${cfg.chainId}) at ${new URL(cfg.rpcUrl).origin}: in MetaMask, Networks → Gnosis → RPC URLs → Add RPC URL, then select it.`
}

/** Thrown by the dev send guard; nothing was sent. */
export class DevForkSendRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevForkSendRefused'
  }
}

/**
 * The dev-fork send guard for the live executor: refuses any chain that is not the fork (chain 1 is not forked, so an
 * arbitration step would hit real Ethereum), any wallet whose own RPC is not the fork, and any connector that is not a
 * browser-extension wallet (see `checkConnectorOnFork`).
 */
export function createDevForkSendGuard(
  cfg: DevForkConfig,
  connector: () => DevForkConnector | null | undefined,
  fork: Eip1193Request = forkRpc(cfg),
): { refuseChain(chainId: number): string | null; beforeSend(req: { chainId: number }): Promise<void> } {
  const refuseChain = (chainId: number): string | null =>
    chainId === cfg.chainId
      ? null
      : `Local development: chain ${chainId} is not part of the local fork, so this step would use a real network. Nothing was sent.`
  return {
    refuseChain,
    async beforeSend(req) {
      const chainRefusal = refuseChain(req.chainId)
      if (chainRefusal) throw new DevForkSendRefused(chainRefusal)
      let check: ForkWalletCheck
      try {
        check = await checkConnectorOnFork(connector(), fork, cfg)
      } catch {
        check = { status: 'unknown' }
      }
      if (check.status !== 'fork') {
        throw new DevForkSendRefused(`${forkStatusMessage(check, cfg)} Nothing was sent. ${forkFixHint(cfg, check.status)}`)
      }
    },
  }
}

// ------------------------------------------------------------------------------------------------ faucet

export interface DevFundingResult {
  address: Address
  funded: boolean
  balanceWei: bigint
  previousBalanceWei: bigint
  targetWei: bigint
  delegatedTo: Address | null
  warning?: string
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

function parseFunding(value: unknown): DevFundingResult | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const dec = (x: unknown): bigint | null => (typeof x === 'string' && DECIMAL.test(x) ? BigInt(x) : null)
  const balanceWei = dec(v.balanceWei)
  const previousBalanceWei = dec(v.previousBalanceWei)
  const targetWei = dec(v.targetWei)
  if (typeof v.address !== 'string' || !ADDRESS.test(v.address) || typeof v.funded !== 'boolean') return null
  if (balanceWei === null || previousBalanceWei === null || targetWei === null) return null
  const delegatedTo = typeof v.delegatedTo === 'string' && ADDRESS.test(v.delegatedTo) ? getAddress(v.delegatedTo) : null
  const warning = typeof v.warning === 'string' ? v.warning.slice(0, 500) : undefined
  return { address: getAddress(v.address), funded: v.funded, balanceWei, previousBalanceWei, targetWei, delegatedTo, ...(warning ? { warning } : {}) }
}

function currentPageOrigin(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.location.origin
  } catch {
    return null
  }
}

/**
 * Asks the dev control server to top the wallet up on the fork. Throws a short message on any failure; when the page is
 * not on the app origin the faucet accepts (`cfg.appOrigin`), the message says so instead of blaming the stack.
 */
export async function requestDevFunding(
  cfg: DevForkConfig,
  address: string,
  fetchImpl: typeof fetch = fetch,
  pageOrigin: string | null = currentPageOrigin(),
): Promise<DevFundingResult> {
  const wrongOrigin = cfg.appOrigin !== null && pageOrigin !== null && pageOrigin !== cfg.appOrigin
  const originMessage = `Open Prism at ${cfg.appOrigin ?? ''}; the local faucet only accepts it.`
  let response: Response
  try {
    response = await fetchImpl(`${cfg.controlOrigin}/dev/fund`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pine-dev': '1' },
      body: JSON.stringify({ address: getAddress(address) }),
      credentials: 'omit',
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    if (wrongOrigin) throw new Error(originMessage)
    throw new Error(`The local dev faucet (${cfg.controlOrigin}) could not be reached. Is scripts/dev-stack/up.sh running?`)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    if (wrongOrigin) throw new Error(originMessage)
    const error = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error.slice(0, 200) : `HTTP ${response.status}`
    throw new Error(`The local dev faucet refused: ${error}`)
  }
  const parsed = parseFunding(body)
  if (!parsed || parsed.address.toLowerCase() !== address.toLowerCase()) throw new Error('The local dev faucet sent an unexpected answer.')
  return parsed
}

/**
 * In-memory, per-page dedupe of faucet calls: at most one call per address in flight. Nothing is persisted, so a drained
 * wallet or a restarted fork is topped up again on the next connect, load or move to the fork (the faucet is idempotent
 * and rate-limited).
 */
export function createInFlightDedupe() {
  const inFlight = new Set<string>()
  return {
    /** True when the caller may call now (no call for this address in flight); marks it in flight. */
    claim(address: string): boolean {
      const a = address.toLowerCase()
      if (inFlight.has(a)) return false
      inFlight.add(a)
      return true
    },
    /** The call finished (either way). */
    settle(address: string): void {
      inFlight.delete(address.toLowerCase())
    },
    /** Tests: forget everything. */
    reset(): void {
      inFlight.clear()
    },
  }
}
