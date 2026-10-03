// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run
// the script (CI runs it with --check).
// FROZEN. Swapr v3 = Algebra V1.9 on Gnosis (docs/research/liquidity-amm.md section 8). Verified on-chain unless noted.
// Algebra differs from Uniswap v3: globalState() instead of slot0(), MintParams without fee, 6-field
// IncreaseLiquidity event, uncompressed tickTable (word = tick >> 8), dynamic fees.

import { parseAbi } from "viem";

export const algebraFactoryAbi = parseAbi([
  "function poolByPair(address, address) view returns (address)",
  "function poolDeployer() view returns (address)",
  "function owner() view returns (address)",
  "event Pool(address indexed token0, address indexed token1, address pool)",
]);

export const algebraPoolAbi = parseAbi([
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function factory() view returns (address)",
  "function liquidityCooldown() view returns (uint32)",
  "function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)",
  "function tickTable(int16 wordPosition) view returns (uint256)",
  "event Initialize(uint160 price, int24 tick)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1)",
  "event Fee(uint16 fee)",
]);

export const algebraPositionManagerAbi = parseAbi([
  "struct MintParams { address token0; address token1; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }",
  "struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)",
  "function burn(uint256 tokenId) payable",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint128 actualLiquidity, uint256 amount0, uint256 amount1, address pool)",
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

/** Non-view: call with eth_call only. Applies the pool's current dynamic fee (globalState().fee can be stale). */
export const algebraQuoterAbi = parseAbi([
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)",
  "function quoteExactOutputSingle(address tokenIn, address tokenOut, uint256 amountOut, uint160 limitSqrtPrice) returns (uint256 amountIn, uint16 fee)",
]);
