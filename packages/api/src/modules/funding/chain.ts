// eth_call reads of the funding lane, all pinned to one block per request. Every decoded value is validated before
// use; RPC failures surface as UPSTREAM_UNAVAILABLE with a fixed message (RPC URLs and upstream bodies never reach
// clients or logs through this module).

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Hex } from "viem";
import { z } from "zod";
import { algebraFactoryAbi, algebraPoolAbi, algebraPositionManagerAbi, algebraQuoterAbi } from "@pine/shared/abi/algebra";
import { erc20Abi } from "@pine/shared/abi/external";
import type { DeploymentManifest } from "@pine/shared/deployment";
import type { Address } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";

/** sDAI (ERC-4626) reads. Module-local: no ERC-4626 ABI is frozen in @pine/shared (operator clarification 3). */
export const sdaiAbi = parseAbi([
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const addressOut = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase() as Address);
const uintOut = z.bigint().nonnegative();
const intOut = z.number().int();

export class ChainCallError extends Error {
  constructor(readonly reverted: boolean) {
    super(reverted ? "eth_call reverted" : "eth_call failed");
    this.name = "ChainCallError";
  }
}

const upstream = () => new ApiError("UPSTREAM_UNAVAILABLE", "Chain data could not be read; try again shortly");

function isRevert(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    const name = (current as { name?: unknown }).name;
    // viem wraps every eth_call failure (transport errors too) in CallExecutionError; only these mean a revert.
    if (name === "ExecutionRevertedError" || name === "RawContractError" || name === "ContractFunctionRevertedError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The pinned block of a request: the latest block number at the time of the first read. */
export async function pinBlock(ctx: AppContext): Promise<bigint> {
  let raw: unknown;
  try {
    raw = await ctx.chain.publicClient.request({ method: "eth_blockNumber" });
  } catch {
    throw upstream();
  }
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(raw)) throw upstream();
  return BigInt(raw);
}

/**
 * One reader per request: every call goes to the same block. `read` throws ApiError UPSTREAM_UNAVAILABLE on
 * transport failures and ChainCallError(reverted) for reverts, so callers can treat a revert as data (e.g. a quote
 * against an empty pool).
 */
export class ChainReader {
  constructor(
    private readonly ctx: AppContext,
    readonly manifest: DeploymentManifest,
    readonly block: bigint,
  ) {}

  private async read(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args } as never) as Hex;
    let result: { data?: Hex | undefined };
    try {
      result = await this.ctx.chain.publicClient.call({ to: address, data, blockNumber: this.block });
    } catch (error) {
      if (isRevert(error)) throw new ChainCallError(true);
      throw upstream();
    }
    if (!result.data || result.data === "0x") throw new ChainCallError(true);
    try {
      return decodeFunctionResult({ abi, functionName, data: result.data } as never);
    } catch {
      throw new ChainCallError(false);
    }
  }

  /** Reads that must succeed: any failure is UPSTREAM_UNAVAILABLE. */
  private async must(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<unknown> {
    try {
      return await this.read(address, abi, functionName, args);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw upstream();
    }
  }

  async poolByPair(tokenA: Address, tokenB: Address): Promise<Address | null> {
    const pool = addressOut.parse(await this.must(this.manifest.amm.factory, algebraFactoryAbi, "poolByPair", [tokenA, tokenB]));
    return pool === ZERO_ADDRESS ? null : pool;
  }

  async globalState(pool: Address): Promise<{ sqrtPriceX96: bigint; tick: number; fee: number }> {
    const out = z.tuple([uintOut, intOut, intOut]).rest(z.unknown()).parse(await this.must(pool, algebraPoolAbi, "globalState", []));
    return { sqrtPriceX96: out[0], tick: out[1], fee: out[2] };
  }

  async poolLiquidity(pool: Address): Promise<bigint> {
    return uintOut.parse(await this.must(pool, algebraPoolAbi, "liquidity", []));
  }

  async tickSpacing(pool: Address): Promise<number> {
    const spacing = intOut.parse(await this.must(pool, algebraPoolAbi, "tickSpacing", []));
    if (spacing <= 0 || spacing > 16_384) throw upstream();
    return spacing;
  }

  async liquidityCooldown(pool: Address): Promise<number> {
    return intOut.nonnegative().parse(await this.must(pool, algebraPoolAbi, "liquidityCooldown", []));
  }

  /** Quoter (non-view, eth_call only). Null when the quote reverts (no pool liquidity for the trade). */
  async quoteExactInputSingle(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ amountOut: bigint; fee: number } | null> {
    try {
      const out = z.tuple([uintOut, intOut]).parse(await this.read(this.manifest.amm.quoter, algebraQuoterAbi, "quoteExactInputSingle", [tokenIn, tokenOut, amountIn, 0n]));
      return { amountOut: out[0], fee: out[1] };
    } catch (error) {
      if (error instanceof ChainCallError) return null;
      throw error;
    }
  }

  async previewDeposit(assets: bigint): Promise<bigint> {
    return uintOut.parse(await this.must(this.manifest.seer.collateralToken, sdaiAbi, "previewDeposit", [assets]));
  }

  async convertToAssets(shares: bigint): Promise<bigint> {
    return uintOut.parse(await this.must(this.manifest.seer.collateralToken, sdaiAbi, "convertToAssets", [shares]));
  }

  async tokenBalance(token: Address, owner: Address): Promise<bigint> {
    return uintOut.parse(await this.must(token, erc20Abi, "balanceOf", [owner]));
  }

  async positionCount(owner: Address): Promise<bigint> {
    return uintOut.parse(await this.must(this.manifest.amm.positionManager, algebraPositionManagerAbi, "balanceOf", [owner]));
  }

  async tokenOfOwnerByIndex(owner: Address, index: bigint): Promise<bigint> {
    return uintOut.parse(await this.must(this.manifest.amm.positionManager, algebraPositionManagerAbi, "tokenOfOwnerByIndex", [owner, index]));
  }

  /** Null when the token does not exist (ownerOf reverts). */
  async ownerOf(tokenId: bigint): Promise<Address | null> {
    try {
      return addressOut.parse(await this.read(this.manifest.amm.positionManager, algebraPositionManagerAbi, "ownerOf", [tokenId]));
    } catch (error) {
      if (error instanceof ChainCallError && error.reverted) return null;
      if (error instanceof ApiError) throw error;
      throw upstream();
    }
  }

  async position(tokenId: bigint): Promise<PositionData> {
    const out = z
      .tuple([uintOut, addressOut, addressOut, addressOut, intOut, intOut, uintOut, uintOut, uintOut, uintOut, uintOut])
      .parse(await this.must(this.manifest.amm.positionManager, algebraPositionManagerAbi, "positions", [tokenId]));
    return { token0: out[2], token1: out[3], tickLower: out[4], tickUpper: out[5], liquidity: out[6], tokensOwed0: out[9], tokensOwed1: out[10] };
  }
}

export interface PositionData {
  token0: Address;
  token1: Address;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export async function chainReader(ctx: AppContext, manifest: DeploymentManifest): Promise<ChainReader> {
  return new ChainReader(ctx, manifest, await pinBlock(ctx));
}
