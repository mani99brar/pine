/**
 * LOCAL DEVELOPMENT ONLY: the dev stack (scripts/dev-stack) runs Pine against an anvil fork of Gnosis on this machine.
 *
 * - Faucet: when a wallet connects, the dev control server tops its xDAI up on the fork (POST /dev/fund).
 * - Guard: MetaMask's built-in Gnosis network points at the REAL Gnosis RPC. The app reads and estimates through the fork,
 *   but the wallet would sign and broadcast on real Gnosis (real gas, contracts that exist only on the fork). The guard
 *   asks the WALLET's own provider (never the app transport) whether it is on the fork, and refuses to send otherwise.
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
}

export interface DevForkEnv {
  controlOrigin?: string
  rpcUrl?: string
  chainId?: string
  claimRegistry?: string
  deploymentBlock?: string
  dataSource?: string
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
  })
}

// ------------------------------------------------------------------------------------------------ wallet-on-fork check

/** An EIP-1193 `request`. */
export type Eip1193Request = (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>

export type ForkWalletStatus = 'fork' | 'wrong_chain' | 'not_fork' | 'unknown'

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

export function forkStatusMessage(check: ForkWalletCheck, cfg: DevForkConfig): string {
  switch (check.status) {
    case 'fork':
      return 'Your wallet is on the local fork.'
    case 'wrong_chain':
      return `Your wallet is on chain ${check.walletChainId ?? '?'}, not the local Gnosis fork (chain ${cfg.chainId}).`
    case 'not_fork':
      return 'Your wallet is on the REAL Gnosis network, not the local fork.'
    default:
      return 'Could not confirm that your wallet is on the local fork.'
  }
}

/** The fix shown with the guard: point the wallet's Gnosis network at the fork's RPC. */
export function forkFixHint(cfg: DevForkConfig): string {
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
 * arbitration step would hit real Ethereum) and any wallet whose own RPC is not the fork.
 */
export function createDevForkSendGuard(
  cfg: DevForkConfig,
  wallet: () => Promise<Eip1193Request | null>,
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
      const request = await wallet().catch(() => null)
      const check: ForkWalletCheck = request ? await checkWalletOnFork(request, fork, cfg) : { status: 'unknown' }
      if (check.status !== 'fork') {
        throw new DevForkSendRefused(`${forkStatusMessage(check, cfg)} Nothing was sent. ${forkFixHint(cfg)}`)
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

/** Asks the dev control server to top the wallet up on the fork. Throws a short message on any failure. */
export async function requestDevFunding(cfg: DevForkConfig, address: string, fetchImpl: typeof fetch = fetch): Promise<DevFundingResult> {
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
    throw new Error(`The local dev faucet (${cfg.controlOrigin}) could not be reached. Is scripts/dev-stack/up.sh running?`)
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error.slice(0, 200) : `HTTP ${response.status}`
    throw new Error(`The local dev faucet refused: ${error}`)
  }
  const parsed = parseFunding(body)
  if (!parsed || parsed.address.toLowerCase() !== address.toLowerCase()) throw new Error('The local dev faucet sent an unexpected answer.')
  return parsed
}

/** Once per address per tab session: sessionStorage (per tab) plus memory when storage is unavailable. */
export function createFundingTracker(storage: () => Pick<Storage, 'getItem' | 'setItem'> | null, key = 'pine:dev-fork:funded') {
  const memory = new Set<string>()
  const inFlight = new Set<string>()
  const readStored = (): string[] => {
    try {
      const raw = storage()?.getItem(key)
      const list: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const has = (address: string) => memory.has(address.toLowerCase()) || readStored().includes(address.toLowerCase())
  return {
    has,
    /** True when the caller should fund now (not done in this tab, not in flight); marks it in flight. */
    claim(address: string): boolean {
      const a = address.toLowerCase()
      if (inFlight.has(a) || has(a)) return false
      inFlight.add(a)
      return true
    },
    done(address: string): void {
      const a = address.toLowerCase()
      inFlight.delete(a)
      memory.add(a)
      try {
        const list = readStored()
        if (!list.includes(a)) storage()?.setItem(key, JSON.stringify([...list, a].slice(-50)))
      } catch {
        /* storage unavailable: memory only */
      }
    },
    /** A failed attempt: may be retried on the next connect or account switch. */
    release(address: string): void {
      inFlight.delete(address.toLowerCase())
    },
    /** Tests: forget everything in memory (storage is the caller's). */
    reset(): void {
      memory.clear()
      inFlight.clear()
    },
  }
}
