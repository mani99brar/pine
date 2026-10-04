// DEVELOPMENT-ONLY faucet of the local integration stack (scripts/dev-stack). Served by the dev control server
// (scripts/dev-control.ts, POST /dev/fund) of scripts/dev-server.ts, which only ever starts against a loopback anvil.
//
// It raises a wallet's NATIVE xDAI on the local anvil fork to a fixed target with `anvil_setBalance`. That call writes
// state directly: no transaction, no signature, no code runs (so it also works for EIP-7702-delegated EOAs, where a value
// transfer can revert), and the wallet's nonce on the fork is untouched. Nothing here can reach a real network:
//   - every call goes through the injected `rpc`, which dev-server.ts binds to the loopback RPC it verified at startup;
//   - before every top-up the node must STILL answer as anvil (web3_clientVersion "anvil/..."), on chain id 100, with
//     Pine's ClaimRegistry deployed (a real Gnosis node fails all three), otherwise nothing is called.
// No token is minted or deposited: every Pine flow in `api` mode (gas, the liquidity ladder's splitFromBase budget,
// Reality bonds and bounties) is paid in native xDAI; sDAI is only shown in the header.

import { checksumAddress, getAddress } from "viem";
import { z } from "zod";

/** One JSON-RPC call against the verified local anvil. Throws on transport or JSON-RPC errors. */
export type FaucetRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface FaucetLimit {
  max: number;
  windowMs: number;
}

export interface DevFaucetOptions {
  rpc: FaucetRpc;
  /** Milliseconds since the epoch (injected for deterministic tests). */
  clock: () => number;
  /** Pine's ClaimRegistry on the fork: it must have code there (it has none on real Gnosis). */
  claimRegistry: string;
  /** Top up only when the native balance is strictly below this (wei). Default 500 xDAI. */
  thresholdWei?: bigint;
  /** The balance a top-up sets (wei). Must be >= threshold. Default 1,000 xDAI. */
  targetWei?: bigint;
  /** Per-address request limit. Default 5 per minute. */
  perAddress?: FaucetLimit;
  /** Global request limit. Default 60 per minute. */
  global?: FaucetLimit;
}

export interface FundResponse {
  address: string;
  chainId: 100;
  /** True when this call raised the balance. */
  funded: boolean;
  /** Native balance after the call (wei, decimal string). */
  balanceWei: string;
  previousBalanceWei: string;
  thresholdWei: string;
  targetWei: string;
  /** The delegate of an EIP-7702-delegated EOA, else null. */
  delegatedTo: string | null;
  /** ERC-20 amounts given: none, every flow pays native xDAI. */
  tokens: { symbol: string; address: string; amountWei: string }[];
  warning?: string;
}

export type FundOutcome = { ok: true; body: FundResponse } | { ok: false; status: number; error: string; retryAfterSeconds?: number };

export interface DevFaucet {
  fund(address: unknown): Promise<FundOutcome>;
  readonly thresholdWei: bigint;
  readonly targetWei: bigint;
}

export const XDAI = 10n ** 18n;
export const DEFAULT_THRESHOLD_WEI = 500n * XDAI;
export const DEFAULT_TARGET_WEI = 1_000n * XDAI;
const FORK_CHAIN_ID_HEX = "0x64";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/);
const hexData = z.string().max(2 * 64 * 1024 + 2).regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const clientVersion = z.string().max(200);
// EIP-7702 delegation designator: 0xef0100 || 20-byte delegate.
const DELEGATION = /^0xef0100([0-9a-fA-F]{40})$/;

/** Strict body: one EIP-55 checksummed, non-zero address. */
export const fundBody = z
  .object({
    address: z
      .string()
      .regex(ADDRESS, "address must be 0x followed by 40 hex characters")
      .refine((value) => ADDRESS.test(value) && checksumAddress(value as `0x${string}`) === value, "address must be EIP-55 checksummed")
      .refine((value) => value.toLowerCase() !== ZERO, "the zero address is refused"),
  })
  .strict();

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const rpcAnswer = z.union([
  z.object({ result: z.unknown() }).passthrough(),
  z.object({ error: z.object({ code: z.number().optional(), message: z.string().max(2000).optional() }).passthrough() }).passthrough(),
]);

/**
 * JSON-RPC over fetch to a LOOPBACK http(s) URL only (throws otherwise, before any request). Redirects are refused and
 * every call times out after 5 s. Errors never carry the URL (it could embed a key on another setup).
 */
export function createLoopbackRpc(url: string, fetchImpl: typeof fetch = fetch): FaucetRpc {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("dev faucet: the RPC URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !LOOPBACK.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) {
    throw new Error("dev faucet: the RPC URL must be a loopback http(s) URL");
  }
  const target = parsed.toString();
  let id = 0;
  return async (method, params) => {
    id += 1;
    let answer: z.infer<typeof rpcAnswer>;
    try {
      const response = await fetchImpl(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      answer = rpcAnswer.parse(await response.json());
    } catch {
      throw new Error(`dev faucet: ${method} failed`);
    }
    if (!("result" in answer)) throw new Error(`dev faucet: ${method} returned an error`);
    return answer.result;
  };
}

class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: FaucetLimit) {}

  /** Records a hit and returns 0 when allowed, else the seconds until the oldest hit leaves the window. */
  take(key: string, now: number): number {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.limit.windowMs);
    if (recent.length >= this.limit.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.limit.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Bounded memory: forget idle keys.
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((at) => now - at >= this.limit.windowMs)) this.hits.delete(k);
    return 0;
  }
}

const refusal = (status: number, error: string, retryAfterSeconds?: number): FundOutcome => ({ ok: false, status, error, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });

export function createDevFaucet(options: DevFaucetOptions): DevFaucet {
  const thresholdWei = options.thresholdWei ?? DEFAULT_THRESHOLD_WEI;
  const targetWei = options.targetWei ?? DEFAULT_TARGET_WEI;
  if (thresholdWei <= 0n || targetWei < thresholdWei) throw new Error("dev faucet: the target must be at least the threshold");
  if (!ADDRESS.test(options.claimRegistry)) throw new Error("dev faucet: claimRegistry must be an address");
  const perAddress = new SlidingWindow(options.perAddress ?? { max: 5, windowMs: 60_000 });
  const global = new SlidingWindow(options.global ?? { max: 60, windowMs: 60_000 });
  const rpc = options.rpc;
  // One top-up at a time: concurrent connects of the same wallet must not interleave read-then-set.
  let queue: Promise<unknown> = Promise.resolve();

  /** The node must still be the local anvil fork with Pine deployed. Re-checked before every top-up (cheap reads). */
  async function isLocalFork(): Promise<boolean> {
    try {
      const version = clientVersion.parse(await rpc("web3_clientVersion", []));
      if (!version.toLowerCase().startsWith("anvil/")) return false;
      if (z.string().parse(await rpc("eth_chainId", [])).toLowerCase() !== FORK_CHAIN_ID_HEX) return false;
      return hexData.parse(await rpc("eth_getCode", [options.claimRegistry, "latest"])) !== "0x";
    } catch {
      return false;
    }
  }

  async function topUp(address: string): Promise<FundOutcome> {
    if (!(await isLocalFork())) return refusal(503, "the RPC is not the local anvil fork with Pine deployed; nothing was funded");
    let code: string;
    let before: bigint;
    try {
      code = hexData.parse(await rpc("eth_getCode", [address, "latest"]));
      before = BigInt(hexQuantity.parse(await rpc("eth_getBalance", [address, "latest"])));
    } catch {
      return refusal(502, "the local fork did not answer; nothing was funded");
    }
    let delegatedTo: string | null = null;
    if (code !== "0x") {
      const delegation = DELEGATION.exec(code);
      if (!delegation?.[1]) return refusal(422, "the address holds contract code; only wallets (EOAs) are funded");
      delegatedTo = getAddress(`0x${delegation[1]}`);
    }
    let after = before;
    let funded = false;
    // Top up only below the threshold, and only ever upwards (target >= threshold > before).
    if (before < thresholdWei && targetWei > before) {
      try {
        await rpc("anvil_setBalance", [address, `0x${targetWei.toString(16)}`]);
        after = BigInt(hexQuantity.parse(await rpc("eth_getBalance", [address, "latest"])));
      } catch {
        return refusal(502, "the local fork refused the top-up; nothing was funded");
      }
      funded = after > before;
    }
    const body: FundResponse = {
      address,
      chainId: 100,
      funded,
      balanceWei: after.toString(),
      previousBalanceWei: before.toString(),
      thresholdWei: thresholdWei.toString(),
      targetWei: targetWei.toString(),
      delegatedTo,
      tokens: [],
    };
    if (delegatedTo !== null) {
      body.warning = `This wallet is EIP-7702-delegated to ${delegatedTo}. Steps that pay xDAI back to it (merge, redeem, Reality withdraw) run that code and revert if it cannot receive xDAI.`;
    }
    return { ok: true, body };
  }

  return {
    thresholdWei,
    targetWei,
    async fund(input: unknown): Promise<FundOutcome> {
      const parsed = fundBody.safeParse(input);
      if (!parsed.success) return refusal(400, parsed.error.issues[0]?.message ?? "invalid body");
      const address = parsed.data.address;
      const now = options.clock();
      const globalWait = global.take("*", now);
      if (globalWait > 0) return refusal(429, "too many faucet requests; try again shortly", globalWait);
      const addressWait = perAddress.take(address.toLowerCase(), now);
      if (addressWait > 0) return refusal(429, "too many faucet requests for this address; try again shortly", addressWait);
      const run = queue.then(() => topUp(address));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
