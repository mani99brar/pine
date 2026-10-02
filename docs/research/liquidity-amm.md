# Seer outcome-token liquidity on Gnosis: AMM, pricing, depth, CTF accounting, costs, commitment, economics

Research date: 2026-10-02. Chain: Gnosis (chainId 100). Reads were taken at blocks around **48,554,520–48,554,595**.
Sources used:
- **On-chain:** Foundry `cast` 1.8.1 against `https://rpc.gnosischain.com`.
- **Verified source:** Gnosisscan smart-contract API (`gnosis.blockscout.com/api/v2/smart-contracts/<addr>`, which redirects to `gnosisscan.io/api/v2/...`). Dumps are in `scratchpad/research/liquidity/{factory,deployer,npm,router,quoter,ctf,w1155}/src`.
- **Seer source:** `seer-pm/demo` clone at commit `60423441a71dd4eead5a026a4cff93fbd4c6f4f3` (2026-10-01), stored at `scratchpad/research/seer-demo`.
- **Seer deployed source:** a previous agent dumped `deployed-src/gr`, `deployed-src/mf`. Its `Router.sol`, `GnosisRouter.sol` and `RealityProxy.sol` differ from the repo only in whitespace (checked with `diff`).

Legend: **V-chain** means checked on-chain (code present plus a view call, or a topic seen in real logs). **V-src** means read from verified source or a primary repo, but not exercised on-chain. **UNVERIFIED** means a claim I could not check, stated as such.

---

## 0. Executive summary

1. **AMM.** On Gnosis, Seer outcome tokens trade on **Swapr v3**, which is **Algebra V1.9** (the verified `AlgebraFactory.sol` header says `/// @dev Version: Algebra V1.9`).
   - Pools are created per pair by `AlgebraFactory` and deployed with CREATE2 by `AlgebraPoolDeployer`.
   - Concentrated liquidity uses an ERC-721 position manager, `Algebra Positions NFT-V1` / `ALGB-POS`.
   - Fees are **dynamic** (adaptive fee) per pool.
   - **tickSpacing defaults to 60**. The factory owner can change it per pool.
2. **No in-app LP minting.** The Seer UI does not mint LP positions on Gnosis.
   - It links out to the Swapr UI at `https://v3.swapr.eth.limo/#/add/{token0}/{token1}/enter-amounts`, after the user has split collateral into outcome tokens.
   - Pairs are *outcome/sDAI* for root markets and *outcome/parent-outcome* for conditional markets.
   - Seer's own Gnosis liquidity script (`web/scripts/add-other-chain-liquidity.ts`) splits sDAI into complete sets. It mints **one concentrated position per outcome/sDAI pool over a common sDAI price range**, defaults the initial price to 1/N, re-prices empty pools before minting, and leaves INVALID tokens in the wallet.
3. **Pricing and depth.** For the headline price, read `globalState().price` (sqrtPriceX96) at a pinned block. For executable numbers, use `eth_call` on the Algebra `Quoter`, which applies the *current* dynamic fee. Use local tick traversal for depth curves.
   - Algebra v1.9 `tickTable` words are indexed by `tick >> 8` and are **not compressed by tickSpacing**, unlike Uniswap v3.
4. **Conditional Tokens.** CTF `0xCeAfDD6b…` (Gnosis CTF, solc 0.5.10) and `Wrapped1155Factory` `0xD194319D…` are verified.
   - A Seer binary market has **3 outcome slots: YES, NO, INVALID**.
   - Wrapper ERC20 addresses depend on `(factory, CTF, positionId, 65-byte name/symbol/decimals data)`. Always take wrapper addresses from `Market.wrappedOutcome(i)`.
5. **Costs.** Gas is negligible versus the budget at current Gnosis prices. Pool creation is the largest item, about **6.77M gas per pool**.
   - Swap fee: dynamic between **0.01% and 1.5%** under the current default config (observed 0.30–0.35%). **10% of swap fees go to the Swapr vault** (communityFee 100/1000).
6. **Liquidity commitment.** LP NFTs are withdrawable at any time unless a pool cooldown is set (currently 0). The factory owner (a 2-of-3 Safe) can set a cooldown of up to 1 day.
   - I found **no verified, audited Algebra-NFT locker on Gnosis**. A minimal, immutable locker is feasible; the design and risks are in §6.
7. **Economics.** The customer's worst-case loss is exactly computable for a **single-sided YES sell ladder**: `S·(1 − √(a·b))` before fees, where `[a, b]` is the YES price range.
   - With a YES-only ladder, the customer loses money only if YES (a counterexample) resolves. If NO or INVALID resolves, the customer redeems their NO or INVALID tokens and recovers the budget minus gas.
   - **Liquidity is not a bounty.** The subsidy goes to whoever buys first, and it requires correct resolution.

---

## 1. Verified addresses (Gnosis, chainId 100)

| Contract | Address | How verified |
|---|---|---|
| **AlgebraFactory** (Algebra V1.9, Swapr) | `0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766` | Gnosisscan verified (`AlgebraFactory`, solc 0.7.6, full match). Code size 13,503 B. `poolDeployer()` → `0xC1b5…dB47`. `farmingAddress()` → `0xDe51…9106`. `vaultAddress()` → `0x187E…37AF`. `owner()` → `0x4D0A…4BbE`. `defaultCommunityFee()` = 100. `baseFeeConfiguration()` = (2900, 12000, 360, 60000, 59, 8500, 0, 10, 100). Found via `AlgebraPoolDeployer` storage slot 4 (`factory`) and confirmed by the reverse call. |
| **AlgebraPoolDeployer** | `0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47` | Gnosisscan verified (`AlgebraPoolDeployer`). Bytecode has only 3 selectors: `setFactory(address)`, `parameters()`, `deploy(address,address,address,address)`. **Seer SDK `POOL_FACTORY_ADDRESSES[100]` holds this address and labels it "factory".** That is correct for CREATE2 (Algebra pools are deployed by the deployer) but mislabelled: it is *not* the factory, and factory views revert on it. |
| **NonfungiblePositionManager** | `0x91fD594c46D8B01E62dBDeBed2401dde01817834` | Gnosisscan verified (`NonfungiblePositionManager`). Code size 24,114 B. `factory()` → `0xA086…a766`. `poolDeployer()` → `0xC1b5…dB47`. `WNativeToken()` → `0xe91D…a97d` (WXDAI). `name()` = "Algebra Positions NFT-V1". `symbol()` = "ALGB-POS". `totalSupply()` = 4647. Also in Seer `web/src/lib/config.ts` (`SWAPR_CONFIG`). |
| **SwapRouter** | `0xfFB643E73f280B97809A8b41f7232AB401a04ee1` | Gnosisscan verified (`SwapRouter`). Code 12,697 B. `factory()`, `poolDeployer()` and `WNativeToken()` match the rows above. Bytecode contains `exactInputSingle` 0xbc651188. Seen in real swaps. Seer test constants `SWAPR_ROUTER`. |
| **Quoter** (Algebra v1, non-view, revert-based) | `0xcBaD9FDf0D2814659Eb26f600EFDeAF005Eda0F7` | Gnosisscan verified (`contracts/lens/Quoter.sol`). Code 5,028 B. Immutables match the rows above. A live `eth_call` of `quoteExactInputSingle` returned values (see §3). Seer test constants `SWAPR_QUOTER`. **I did not find or verify a QuoterV2 on Gnosis.** |
| **FarmingCenter** (Algebra farming) | `0xde51ddf1ae7d5bbd7bf1a0e40aaa1f6c12579106` | Equals `factory.farmingAddress()` (V-chain). Code 24,267 B. Seer `SWAPR_CONFIG.FARMING_CENTER`. Source not reviewed. |
| Algebra factory owner | `0x4D0AC33ACA8dcC38Cd547763Af0d5Bba29534BbE` | Gnosis Safe proxy (`VERSION()` "1.3.0"), **threshold 2 of 3**. Owners: `0x05A4Ed23…c722`, `0xc2Cd6E11…C0b0`, `0x2B1a6dD2…05A1`. |
| Algebra community-fee vault | `0x187E0966046dA5b110Fdc986c9B94Bd8416837AF` | `factory.vaultAddress()`, code 3,474 B. Source not reviewed. |
| Example pool NO_sDAI | `0x4FCE874E745a7487a1961F93161b734Bc3C52C89` | `poolByPair(NO, sDAI)` returns the same address in both argument orders. CREATE2 recomputed with `cast create2 --deployer 0xC1b5… --salt keccak256(abi.encode(token0, token1)) --init-code-hash 0xbce37a54…97e7` gives **the exact same address**. The pool source is verified inside the deployer's verified source (`AlgebraPool.sol`); the pool itself is not separately verified. |
| **ConditionalTokens** | `0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce` | Gnosisscan verified (`ConditionalTokens`, solc v0.5.10, partial/metadata match, verified 2020-09-01). Code 15,007 B. Event topics seen in real logs (§4). |
| **Wrapped1155Factory** | `0xD194319D1804C1051DD21Ba1Dc931cA72410B79f` | Gnosisscan verified (`Wrapped1155Factory`, solc 0.6.12, full match). Code 6,755 B. `Wrapped1155Creation` topic seen in a real Seer market-creation receipt. |
| sDAI (Savings xDAI, ERC-4626) | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | `name()` = "Savings xDAI". `asset()` = WXDAI. `convertToAssets(1e18)` = **1.259870628 xDAI** at block ~48,554,5xx. It is token1 in the sampled pool. Seer `collateral.ts`. |
| WXDAI | `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` | `NPM.WNativeToken()` (V-chain). |
| Seer MarketFactory | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | Seer `contracts/deployments/gnosis/MarketFactory.json`. Emits `NewMarket` (topic `0x109e5ac0…`) in real txs. I decoded one real `createCategoricalMarket` call. |
| Seer GnosisRouter | `0xeC9048b59b3467415b1a38F63416407eA0c70fB8` | Seer deployments. Many real `splitPosition` txs to it (§5). The other agent's deployed-source dump matches the repo. |
| Seer ConditionalRouter / MarketView | `0x774284d5…c29c` / `0x010Bc822…D8D4` | Seer deployments only. **Not checked by me (UNVERIFIED here).** |
| Seer LiquidityManager (legacy) | see `deployments/gnosis/LiquidityManager.json` | Source calls `IUniswapV2Router.addLiquidity`, so it is a **legacy Uniswap-v2-style** helper and not used for Algebra. Not checked on-chain. |

Pool init-code hash: `0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7`. It is a constant in the verified factory, used with `poolDeployer` as the CREATE2 deployer and salt `keccak256(abi.encode(token0, token1))`. This was **V-chain** checked by recomputing the address.

---

## 2. Algebra V1.9 mechanics relevant to the backend

### 2.1 Pool creation and initialisation
- `NonfungiblePositionManager.createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96) payable returns (address pool)`, selector `0x51246d6e` (V-src; also V-chain from real txs).
  - It requires `token0 < token1` (sorted).
  - If the pool exists **and is initialised, the price argument is silently ignored**. If the pool exists but is uninitialised, it is initialised at your price.
  - **Security:** anyone can create and initialise a pool at an arbitrary price first, and anyone can initialise an empty pool from the Swapr UI. The Seer script notes this explicitly. Before minting, always re-read `globalState().price` at the latest block. Mint with tight `amount0Min`/`amount1Min`, and abort if the price is outside tolerance. If the pool is empty but mis-priced, follow Seer's approach: mint a tiny seed position, then swap with `limitSqrtPrice` set to the target price.
- Factory `createPool(address tokenA, address tokenB)` deploys a `DataStorageOperator`, copies `baseFeeConfiguration` into it, deploys the pool through the deployer, and emits `Pool(token0, token1, pool)`.
- Pool constructor: `globalState.fee = BASE_FEE (100)`, `tickSpacing = 60`.
- `initialize(uint160 initialPrice)` sets `communityFeeToken0/1 = factory.defaultCommunityFee()` (currently 100, which is 10%) and emits `Initialize(price, tick)`.
- Real `createAndInitializePoolIfNecessary` txs used **~6.77M gas** each (6 samples: 6,771,284–6,774,094).

### 2.2 Mint parameters (exact field order, V-src, selector V-chain)
`mint((address token0, address token1, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`, selector `0x9cc1a283`.
- There is **no `fee` field**, unlike Uniswap v3 (`0x88316456`).
- Ticks must be multiples of the pool's current `tickSpacing`. The pool requires `bottomTick % tickSpacing | topTick % tickSpacing == 0`.
- Full range for spacing 60 is `[-887220, 887220]` (MIN_TICK = −887272, MAX_TICK = 887272).
- Real single `mint` txs: **~399,6xx gas** (many samples).

### 2.3 Fees (dynamic)
- `fee` is in hundredths of a bip (1e-6).
- It is recomputed by `DataStorageOperator.getFee` at the first swap of each new block, from time-weighted volatility and volume per liquidity: `fee = baseFee + sigmoidVolume(sigmoid1(vol) + sigmoid2(vol))`.
- With the factory default config (alpha1 2900, alpha2 12000, baseFee 100): **min 0.01%, max 1.5%**.
- Observed values:
  - Sampled pool `globalState.fee` = 2959 (0.296%).
  - `Quoter` reported fees of 3488–3499 (0.35%) for the next swap, so **`globalState.fee` is stale relative to what a new swap pays**.
- Community fee is 100/1000 = **10% of LP fees**, sent to the vault.
- **Governance:** the factory owner, or the factory, can call `DataStorageOperator.changeFeeConfiguration` per pool. The only bound is `alpha1 + alpha2 + baseFee ≤ 65535`, so the **fee could be raised to as much as 6.55%**. The owner can also:
  - set community fee up to 250 (25%) with `setCommunityFee(uint8,uint8)`;
  - set `tickSpacing` up to 500 with `setTickSpacing(int24)`;
  - set `liquidityCooldown` up to **1 day** with `setLiquidityCooldown(uint32)`. This delays `burn` after the last add. It is currently 0 on the sampled pool.
  - The `farmingAddress` can attach an "incentive" virtual pool (`setIncentive`) that is called during swaps.
- Indexers should watch `Fee`, `CommunityFee`, `TickSpacing`, `LiquidityCooldown` and `Incentive` events.

### 2.4 Pool lookup
- `AlgebraFactory.poolByPair(address,address) view returns (address)`. Either argument order works because the mapping is populated twice.
- Offline: CREATE2 from **`poolDeployer`** (not the factory) with the init-code hash above. Seer's `computePoolAddress` does exactly this with the deployer address.

### 2.5 `globalState()` (Algebra uses globalState, not slot0)
`globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)`. This is V-chain: a call decoded to `45853788521954131972830883304, -10939, 2959, 6, 100, 100, true`.

Other views:
- `liquidity() → uint128`
- `tickSpacing() → int24` (60)
- `token0()` / `token1()`
- `ticks(int24) → (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)`
- `tickTable(int16) → uint256`
- `liquidityCooldown() → uint32`
- `activeIncentive() → address`
- `dataStorageOperator() → address`

**TickTable indexing (V-src, `TickTable.sol`):** `rowNumber = tick >> 8`, `bitNumber = tick & 0xFF`. The **tick is not divided by tickSpacing**, which differs from Uniswap v3's compressed bitmap.

---

## 3. Price and executable depth for a backend API

### 3.1 Spot price
Read all values at one pinned block, `B`:
```
sqrtP  = globalState().price            // Q64.96, sqrt(token1/token0) in raw units
P01    = sqrtP^2 / 2^192                // token1 per token0 (raw)
Pdec   = P01 * 10^(dec0 - dec1)         // Seer wrappers use 18 decimals and sDAI uses 18, but read decimals() anyway
outcomeIsToken0 = lower(outcome) < lower(collateral)
price_outcome_in_collateral = outcomeIsToken0 ? Pdec : 1 / Pdec
price_outcome_in_xDAI = price_outcome_in_collateral * sDAI.convertToAssets(1e18)/1e18   // root markets with sDAI collateral
```
- Use bigint math: `priceWad = sqrtP*sqrtP*1e18 >> 192`, or `mulDiv`. Do **not** use `tick` for display, because it is floored. `1.0001^tick` is fine for range math.
- The sampled NO_sDAI pool gives `(45853788521954131972830883304 / 2^96)^2 ≈ 0.335 sDAI` per NO.
- For conditional markets the counter-token is a *parent outcome token*. Price = child price in parent units × parent price.
- **Label it** "last pool price / marginal ask-bid midpoint". It is not a probability, and spec §5 says the same.

### 3.2 Executable amounts: use the on-chain Quoter via `eth_call`
- Signatures:
  - `quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)` (`0x2d9ebd1d`)
  - `quoteExactOutputSingle(address tokenIn, address tokenOut, uint256 amountOut, uint160 limitSqrtPrice) returns (uint256 amountIn, uint16 fee)` (`0x9e73c81d`)
  - Pass `limitSqrtPrice = 0` for no limit.
- These are **non-view**: they simulate a swap and revert with the result. Call them **only with `eth_call`**, which works through viem `readContract` or `simulateContract`. Never send a transaction to them.
- Live example (block ~48,554,5xx), buying NO with sDAI in the NO_sDAI pool:

| sDAI in | NO out | avg price | fee reported |
|---|---|---|---|
| 0.001 | 0.0029732 | 0.3363 | 3488 (0.349%) |
| 0.1 | 0.28043 | 0.3566 | 3492 |
| 1 | 1.84927 | 0.5408 | 3496 |
| 5 | 3.67852 | 1.359 (over 1: the pool is very thin, L ≈ 2.83e18) | 3499 |

The last row shows why the UI must show size-dependent quotes. A headline price of 0.335 means nothing for a trade of 5 sDAI.

### 3.3 Depth curves: local tick traversal from a pinned snapshot
Snapshot at block `B`:
1. Read `globalState`, `liquidity()` and `tickSpacing`.
2. Scan `tickTable(word)` for words around the current tick (`word = tick >> 8`), then `ticks(t)` for each initialized tick. Use multicall, all at block `B`.

Then, with `f` as the fee for the next swap (take it from a small Quoter call; bound it with 1.5% or the configured max), step through each segment of constant `L`, from `√P_cur` to the next initialized tick `√P_t`.

**Buying token0 with token1** (price goes up, `zeroToOne = false`):
```
maxNetIn1  = L·(√P_t − √P_cur)            // token1 net of fee
out0       = L·(1/√P_cur − 1/√P_t)
grossIn1   = maxNetIn1 / (1 − f)
on crossing tick t upward:  L += liquidityDelta(t)
```

**Buying token1 with token0** (price goes down, `zeroToOne = true`):
```
maxNetIn0  = L·(1/√P_t − 1/√P_cur)
out1       = L·(√P_cur − √P_t)
grossIn0   = maxNetIn0 / (1 − f)
on crossing tick t downward: L −= liquidityDelta(t)
```

- **Partial last segment** (net input Δ is left over): price up gives `√P' = √P + Δ/L`; price down gives `1/√P' = 1/√P + Δ/L`.
- **Depth to a target price `p*`:** sum the segments until `√p*`.
- **Price impact:** `avgPrice/spot − 1`, and also `postTradePrice/spot − 1`.

### 3.4 Recommendation
Use a **hybrid** approach.
- **Quoted sizes** for the user-facing "executable at size X" figures (for example $1, $10, $100, and the user's own size): `eth_call` the Quoter at a pinned `blockNumber`. This uses exactly the on-chain math and the fresh dynamic fee.
- **Depth curves and "depth to price p"**: local tick traversal over the same block snapshot.
  - Cross-check traversal against the Quoter at two sizes on every refresh, and alarm if they differ by more than 1 bp.
  - Show the fee range, because the fee can change on the next block.
- Pin every read to one block number. Fetch from at least two RPCs and require matching block hashes before showing money-relevant numbers.
- Build **pool identity from the Seer `Market.wrappedOutcome(i)` token** plus `factory.poolByPair` or CREATE2 from the deployer. Never derive it from token names or symbols (see §4.3).
- Show the customer's own positions separately from third-party liquidity. Third-party LPs can withdraw at any time.

---

## 4. Conditional Tokens and the Seer router

### 4.1 Outcome structure
- Seer `createCategoricalMarket` uses `outcomeSlotCount = outcomes.length + 1`. The extra slot is INVALID.
- A YES/NO market therefore has **3 positions**: indexSets 1, 2, 4. A real split showed `partition = [1, 2, 4]`.
- `RealityProxy.resolveCategoricalMarket` (deployed source identical to the repo):
  - If the answer is invalid or out of range, payouts are `[0, 0, 1]` and **only the INVALID token pays**.
  - Otherwise payouts are `[1, 0, 0]` or `[0, 1, 0]`.
- Wrapper data: `toString31(tokenName) ‖ toString31(tokenName) ‖ uint8(18)`. INVALID is named "SER-INVALID".

### 4.2 CTF functions and events
- **Functions** (V-src):
  - `splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)`
  - `mergePositions(...)` (same parameters)
  - `redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)`, which requires `payoutDenominator > 0`
  - `reportPayouts(bytes32 questionId, uint256[] payouts)`; the oracle is `msg.sender`
  - `prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount)`
  - `getConditionId`, `getCollectionId`, `getPositionId`, `getOutcomeSlotCount`, `payoutNumerators(bytes32,uint256)`, `payoutDenominator(bytes32)`
- **Event indexing gotchas:**
  - `PositionSplit` and `PositionsMerge`: `collateralToken` is **not indexed**.
  - `PayoutRedemption`: `collateralToken` **is indexed** and `conditionId` is **not**.

### 4.3 Wrapped1155Factory (V-src, full match)
- `onERC1155Received` mints the ERC20 to the **`operator`** (the caller of `safeTransferFrom`), not to `from`.
- `data` must be exactly 65 bytes: name (bytes32), symbol (bytes32), decimals (uint8).
- `unwrap(address multiToken, uint256 tokenId, uint256 amount, address recipient, bytes data)` burns the ERC20 and sends the 1155 token.
- Address derivation: `CREATE2(deployer = factory, salt = uint256(1155), initcode = getWrapped1155DeployBytecode(multiToken, tokenId, data))`. The wrapper is an EIP-1167-style minimal proxy, the "More-Minimal Proxy", to `erc20Implementation`.
  - **Consequence:** the same CTF position can have many wrappers with different `data`, and fake look-alike tokens can exist.
  - The canonical Seer wrapper is the one returned by `Market.wrappedOutcome(i)`, which returns `(IERC20 wrapped1155, bytes data)`.
  - `getWrapped1155(multiToken, tokenId, data)` returns the expected address as a view. `requireWrapped1155` creates it and emits `Wrapped1155Creation`.

### 4.4 Seer Router and GnosisRouter
Source checked against the deployed dump. Selectors were computed with `cast sig`, and `splitPosition` was seen in real txs to GnosisRouter.

- **`splitPosition(address collateralToken, address market, uint256 amount)`** (`0xd5f82280`)
  1. It pulls `amount` collateral from the user (root markets only).
  2. It splits the full partition in the CTF.
  3. It wraps each position by `safeTransferFrom` to the Wrapped1155Factory with the market's `data`, so the Router is the operator and receives the ERC20.
  4. It transfers each ERC20 to the user.
  - For a child market, it instead pulls and unwraps the parent outcome ERC20 first.
- **`mergePositions(address collateralToken, address market, uint256 amount)`** (`0x7abef8d1`) is the inverse. It requires an equal amount of every outcome token, including INVALID.
- **`redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)`** (`0x865955a0`)
  - It pulls each ERC20, unwraps it, and calls CTF `redeemPositions` with `indexSets[j] = 1 << outcomeIndexes[j]`.
  - It sends the collateral delta back. For a child market it sends wrapped parent tokens instead.
  - The user must `approve` the Router on each wrapper ERC20.
- **GnosisRouter, xDAI entry and exit:**
  - `splitFromBase(address market) payable` (`0x50d9991c`) deposits xDAI into sDAI, then splits.
  - `mergeToBase(address market, uint256 amount)` (`0xd6d150d1`)
  - `redeemToBase(address market, uint256[] outcomeIndexes, uint256[] amounts)` (`0x9fe603e8`)

---

## 5. Costs (gas measured from real Gnosis transactions)

| Action | Gas observed | Sample |
|---|---|---|
| Seer `createCategoricalMarket` (Yes/No + Invalid) | **1.59M–1.71M** | 7 direct txs to MarketFactory in this range. One is decoded: `0x0e9a1e2f…b08c`, "Will oddsflow win ETHGlobal Tokyo 2026?", outcomes [Yes, No], minBond 10 xDAI. Three other `createCategoricalMarket` txs used 14.6M–15.3M gas; I did not decode them (probably many outcomes). |
| Split via `GnosisRouter.splitPosition`, 3 slots | **0.49M–0.63M** (typical about 0.52M) | about 20 direct txs, e.g. `0x86564463…48f3`. The sample includes child-market splits. |
| NPM `createAndInitializePoolIfNecessary` | **~6.77M** per pool | 6 txs, e.g. `0x0a052aa5…37fc` |
| NPM `mint` (new position) | **~0.40M** | many txs, e.g. `0x880c94a1…` |
| SwapRouter `exactInputSingle` | **0.26M–0.36M** (one 0.63M, likely crossing many ticks) | 7 direct txs, e.g. `0x02d21e38…bce0` |
| ERC20 `approve` | not measured (**UNVERIFIED**; typically tens of thousands of gas) | — |

**Gas price.**
- At the time of reading, the base fee was ~1.6e5 wei (0.00016 gwei). Median priority tips vary from about 1e4 wei to 3e7 wei.
- Many wallets and scripts pay **1 gwei**; Seer's script default `--priority-fee` is 1 gwei.
- Cost of the full YES-ladder setup (create market 1.65M, 1 pool 6.77M, split 0.55M, approvals, mint 0.40M; about 9.5M gas in total):

| Gas price | Total setup cost |
|---|---|
| 0.00016 gwei (current base fee) | about 1.5e-6 xDAI |
| 1 gwei | about 0.0095 xDAI |
| 10 gwei (stress case) | about 0.095 xDAI |

- With both YES and NO pools, add one more ~6.77M-gas pool creation and one more mint.
- **Gas is immaterial even for the $5 budget.**

**Swap fees.**
- Dynamic between 0.01% and 1.5% under the current config, but **governance-changeable up to 6.55%**.
- 10% of fees go to the Swapr vault, so LPs receive 90%.
- Liquidity is quoted in sDAI, and 1 sDAI is about 1.26 xDAI. Convert all amounts shown to users.

**Not covered here, but they dominate small budgets:** Reality.eth answer bonds (the sample market used minBond = 10 xDAI) and arbitration costs. See the oracle research.

---

## 6. Liquidity commitment

### 6.1 Withdrawability today
- The NPM lets the NFT owner or an approved operator call `decreaseLiquidity`, then `collect`, then `burn`, at any time.
- The only on-chain brake is the pool `liquidityCooldown` (0 now; the owner Safe can set up to 1 day). It only delays withdrawals after a recent add.
- **Default LP positions therefore commit nothing**, as spec §7 says.
- The NPM is not a proxy: its verified source sits directly at the address and the code size is consistent. Algebra v1.9 core and periphery have no upgrade hooks.
- Governance can still change fees, community fee, tick spacing, cooldown and incentives per pool. **I found no admin path to move LP principal in the reviewed source**, but the FarmingCenter and vault sources were not reviewed.

### 6.2 Existing lockers
- I did not find a **verified, audited locker for Algebra-v1 (Swapr) position NFTs on Gnosis** in primary sources within the time box. Treat this as **UNVERIFIED / none found**.
- Do not assume third-party v3 lockers support Algebra's NPM: its ABI differs (`positions()` layout, `MintParams` without fee, the `IncreaseLiquidity` event).
- The Algebra `FarmingCenter` takes custody of NFTs, but it is a farming contract, not a time lock.

### 6.3 Minimal lock contract requirements
1. **Immutable constructor parameters:** `NPM = 0x91fD…7834`, and optionally `pool`/`token` allow-lists. No owner, no admin, no upgrade path, no arbitrary call, no `selfdestruct`.
2. **Deposit by pull, not push.** `lock(tokenId, beneficiary, unlockTime)` calls `NPM.safeTransferFrom(msg.sender, address(this), tokenId)` after the owner approves.
   - `onERC721Received` must `require(msg.sender == NPM)` and accept only while a `lock` call is in progress, using a transient flag. Otherwise it reverts.
   - Record `{beneficiary, unlockTime}` per tokenId.
   - Validate on deposit through `NPM.positions(tokenId)`: token pair, ticks, `liquidity > 0`, and that `unlockTime` is after the evidence deadline and below a maximum.
3. **Fee passthrough:** `collectFees(tokenId)` is callable by anyone. It calls `NPM.collect({tokenId, recipient: beneficiary, amount0Max: type(uint128).max, amount1Max: type(uint128).max})`, so fees can only ever go to the beneficiary.
   - It uses no `decreaseLiquidity`, so principal cannot move.
   - With no `decreaseLiquidity`, `collect` returns only accrued fees: tokens owed from previous burns are zero while locked.
4. **Unlock:** after `unlockTime`, `withdraw(tokenId)` is callable only by the beneficiary. It deletes the record first, then `safeTransferFrom(this, beneficiary, tokenId)`.
5. Use `nonReentrant` on all external functions and checks-effects-interactions.
6. Emit `Locked(tokenId, beneficiary, unlockTime)`, `FeesCollected(tokenId, amount0, amount1)` and `Withdrawn(tokenId)`.
7. No `increaseLiquidity` passthrough is needed. Anyone can add to an NPM position they do not own, and that would only add value.

### 6.4 Lock contract risks
- **Stuck NFTs.** NFTs sent by plain `transferFrom` bypass `onERC721Received`, so the contract cannot record them. Either accept that and document it, or add a narrowly scoped `rescue`. A rescue needs an owner or proof of the previous owner, so the cleaner choice is "no rescue, documented".
  - A beneficiary that is a contract unable to receive ERC721 makes `safeTransferFrom` revert on withdraw. Either validate the beneficiary as an EOA or ERC721Receiver, or let the beneficiary pass a `to` address at withdraw.
- **Reentrancy.** `collect` transfers outcome-token ERC20s (OpenZeppelin ERC20, no hooks) and sDAI (ERC-4626, no hooks). Low risk, but keep `nonReentrant`, because a pool may pair with arbitrary tokens if allow-lists are not enforced.
- **Governance and parameter risk** outside the locker (§2.3):
  - fee up to 6.55%;
  - community fee up to 25%;
  - a 1-day cooldown, which a locker does not mind;
  - tick-spacing changes, which do not affect existing positions;
  - an incentive virtual pool hooked into swaps, which can only DoS swaps, not move principal. This is UNVERIFIED for FarmingCenter code.
- **Economic risk.** A lock keeps liquidity *available*, not *valuable*.
  - Locked sDAI proceeds from sales stay inside the position until unlock, so the customer cannot withdraw them early.
  - The lock prevents the customer from pulling liquidity when evidence appears. That is the point of the commitment, but it is irreversible.
- **Audit.** Even a small contract that custodies customer funds needs an independent review and invariant tests. Write tests for: no path transfers the NFT before `unlockTime`; fees only go to the beneficiary; there are no admin functions.

---

## 7. Economics: who is subsidised and what the customer can lose

**Notation**
- `S` = complete sets split (sDAI). Budget B ≈ S·R + gas, where R = sDAI→xDAI ≈ 1.2599.
- `f` = swap fee; `c` = 0.10 community share.
- A single-sided **sell ladder** of `S` outcome tokens over price range `[a, b]` (outcome priced in sDAI, current price ≤ a) has:
  ```
  L         = S·√a·√b / (√b − √a)
  tokens sold up to price p:   x(p) = L·(1/√a − 1/√p)
  sDAI received (net of fee):  y(p) = L·(√p − √a)
  average sell price over full range = √(a·b)
  LP fee income = y·f/(1−f)·(1−c)
  ```

**Design A — YES-only sell ladder (recommended default for "investigate a claim").**
1. Split S sDAI into S YES + S NO + S INVALID.
2. Create the YES/sDAI pool initialised at `a`, and mint YES-only liquidity over `[a, b]`, with b < 1, for example 0.95–0.98.
3. Keep the NO and INVALID tokens. Optionally hold them in a lock contract until resolution, then redeem.

| Outcome | What happens to the customer |
|---|---|
| **YES resolves** | Informed buyers lift the whole ladder. Customer proceeds = `S·√(ab)·(1 + (1−c)·f/(1−f))`. Max loss = `S·(1 − √(ab)) − fees` (+ gas). |
| **NO resolves** | The customer redeems S NO for S sDAI. Net is about −gas, **plus** any sDAI paid by wrong-way YES buyers. |
| **INVALID** | The customer redeems S INVALID for S. Same as NO. |

- Researcher's maximum gross profit if YES = `S − S·√(ab)/(1−f)`, minus gas. It needs `S·√(ab)/(1−f)` of capital up front, tied up until resolution, and the researcher carries oracle and INVALID risk.
- **Setting `a` (initial price).** `a` is the customer's offered YES price, so it is also the knob for the subsidy size. Lower `a` means a bigger payout to whoever proves YES and less capital needed by the researcher. Prices are quoted in sDAI, and ticks round to 0.6% steps (spacing 60).

**Design B — symmetric YES and NO ladders from 0.5.** The same formula gives a worst case of about 29–30%. Do not use it by default:
- The **NO ladder gets drained by whoever buys NO once no counterexample shows up**, usually just after the deadline. That pays latecomers, not researchers.
- The two starting prices must satisfy `a_YES + a_NO ≥ 1` (minus a margin for INVALID risk). If they sum to less than 1, anyone can buy YES + NO for less than 1 and get a near-risk-free leak.

**Design C — full-range two-sided positions at 0.5 in both pools (comparison).**
- Per unit of liquidity: budget = 1/√0.5 + 2·√0.5 ≈ 2.828·L.
- If YES wins: the YES pool ends at about L YES + L sDAI (worth 2L). The NO pool's sDAI is fully drained by sellers of NO, who can mint complete sets for 1 and dump NO. INVALID tokens are worthless.
- Loss ≈ **29.3%** of budget, about the same as Design B.
- But it gives **~7× less liquidity per dollar** near relevant prices: L per sDAI is 0.354 versus 2.475 for a [0.5, 0.98] ladder.
- Its loss is paid to whoever trades after the truth becomes public, not only to researchers.
- In a binary 0/1 market a two-sided position's collateral side buys the token all the way down if it loses, so **concentrated, single-sided ladders below 1 dominate full range** for a subsidy.

### Worked examples (Design A, R = 1.2599 xDAI/sDAI, gas $0.01 at 1 gwei)

| Budget | [a, b] | fee | S (sets) | L | **Max loss if YES** | Researcher max gross | Researcher capital needed | Depth: $ to move YES a→1.1a | $ to move a→min(2a, b) |
|---|---|---|---|---|---|---|---|---|---|
| $100 | [0.50, 0.98] | 0.35% | 79.37 | 196.4 | **$29.79 (29.8%)** | $29.75 | $70.24 | $8.57 | $70.24 |
| $100 | [0.50, 0.98] | 1.5% | 79.37 | 196.4 | $29.05 | $28.93 | $71.06 | $8.67 | $71.06 |
| $100 | [0.20, 0.95] | 0.35% | 79.37 | 65.6 | **$56.28 (56.3%)** | $56.25 | $43.74 | $1.81 | $15.36 |
| $100 | [0.05, 0.95] | 0.35% | 79.37 | 23.0 | **$78.14 (78.1%)** | $78.12 | $21.87 | $0.32 | $2.70 |
| $5 | [0.50, 0.98] | 0.35% | 3.96 | 9.80 | **$1.50 (29.9%)** | $1.49 | $3.51 | $0.43 | $3.51 |
| $5 | [0.20, 0.95] | 0.35% | 3.96 | 3.27 | **$2.82 (56.4%)** | $2.81 | $2.18 | $0.09 | $0.77 |
| $5 | [0.05, 0.95] | 0.35% | 3.96 | 1.15 | **$3.91 (78.2%)** | $3.90 | $1.09 | $0.016 | $0.14 |

**Notes on the table**
- In every row, the loss if NO or INVALID resolves is only gas, about $0.01 at 1 gwei. LP fees appear only in the YES case, and they are already netted.
- Excluded: Reality.eth bonds and arbitration (the sampled market's minBond is 10 xDAI, more than the whole $5 budget), and the opportunity cost of locked capital. Because collateral is sDAI, yield accrues to outcome-token redeemers.
- **$5 reading:** gas is not the obstacle; it costs less than $0.02 even at 1 gwei. The obstacle is that the *maximum* researcher profit is about $1.5–$3.9, before oracle bonds or effort. Depth is tiny: $0.016–$0.43 moves the price 10%. A $5 budget cannot fund a meaningful investigation incentive, and the UI should say so.

### Liquidity is not a bounty
State this explicitly to customers and in the UI:
1. The subsidy is captured by **whoever buys first**. That can be a front-runner who copies a public evidence submission or watches the mempool, an insider, or a bot after resolution. It is not necessarily the person who did the work. Researchers must buy before disclosing evidence, which interacts with responsible-disclosure policy in spec §6.
2. It pays only if the market **resolves correctly**. The oracle and arbitration path, plus INVALID risk, sit on the researcher.
3. Researchers must commit their own capital (see the table).
4. Default LP positions can be **withdrawn by the customer at any time**. Only a lock contract (§6.3) makes the offer firm until a stated time.
5. Third-party liquidity in the same pool can appear or vanish, and it changes the displayed depth.
6. The amount at risk is the customer's maximum loss. It is not a promised reward and there is no minimum payout. That matches the "no promised fixed researcher reward" boundary in spec §7.

---

## 8. Exact ABI (viem `parseAbi` strings)

Status key: **V-chain** means the selector is in deployed bytecode, the topic was seen in a real log, or a call was decoded. **V-src** means verified source only.

```ts
// AlgebraFactory 0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766
'function poolByPair(address, address) view returns (address)',                        // V-chain (call)
'function poolDeployer() view returns (address)',                                      // V-chain (call)
'function owner() view returns (address)',                                             // V-chain (call)
'function farmingAddress() view returns (address)',                                    // V-chain (call)
'function vaultAddress() view returns (address)',                                      // V-chain (call)
'function defaultCommunityFee() view returns (uint8)',                                 // V-chain (call)
'function baseFeeConfiguration() view returns (uint16 alpha1, uint16 alpha2, uint32 beta1, uint32 beta2, uint16 gamma1, uint16 gamma2, uint32 volumeBeta, uint16 volumeGamma, uint16 baseFee)', // V-chain (call)
'function createPool(address tokenA, address tokenB) returns (address pool)',          // V-src (selector 0xe3433615 present)
'event Pool(address indexed token0, address indexed token1, address pool)',            // V-chain (topic 0x91ccaa7a…)
'event Owner(address indexed newOwner)',                                               // V-src
'event VaultAddress(address indexed newVaultAddress)',                                 // V-src
'event FarmingAddress(address indexed newFarmingAddress)',                             // V-src
'event DefaultCommunityFee(uint8 newDefaultCommunityFee)',                             // V-src
'event FeeConfiguration(uint16 alpha1, uint16 alpha2, uint32 beta1, uint32 beta2, uint16 gamma1, uint16 gamma2, uint32 volumeBeta, uint16 volumeGamma, uint16 baseFee)', // V-src

// AlgebraPool (per pool)
'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)', // V-chain (call)
'function liquidity() view returns (uint128)',                                         // V-chain
'function tickSpacing() view returns (int24)',                                         // V-chain
'function token0() view returns (address)',                                            // V-chain
'function token1() view returns (address)',                                            // V-chain
'function factory() view returns (address)',                                           // V-chain
'function dataStorageOperator() view returns (address)',                               // V-chain
'function liquidityCooldown() view returns (uint32)',                                  // V-chain
'function activeIncentive() view returns (address)',                                   // V-chain
'function ticks(int24 tick) view returns (uint128 liquidityTotal, int128 liquidityDelta, uint256 outerFeeGrowth0Token, uint256 outerFeeGrowth1Token, int56 outerTickCumulative, uint160 outerSecondsPerLiquidity, uint32 outerSecondsSpent, bool initialized)', // V-src
'function tickTable(int16 wordPosition) view returns (uint256)',                       // V-src (word = tick >> 8, uncompressed)
'function totalFeeGrowth0Token() view returns (uint256)',                              // V-src
'function totalFeeGrowth1Token() view returns (uint256)',                              // V-src
'event Initialize(uint160 price, int24 tick)',                                         // V-chain (topic 0x98636036…)
'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick)', // V-chain (0xc42079f9…)
'event Mint(address sender, address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1)', // V-chain (0x7a53080b…)
'event Burn(address indexed owner, int24 indexed bottomTick, int24 indexed topTick, uint128 liquidityAmount, uint256 amount0, uint256 amount1)', // V-chain (0x0c396cd9…)
'event Collect(address indexed owner, address recipient, int24 indexed bottomTick, int24 indexed topTick, uint128 amount0, uint128 amount1)', // V-chain (0x70935338…)
'event Fee(uint16 fee)',                                                               // V-chain (0x598b9f04…)
'event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)', // V-src
'event CommunityFee(uint8 communityFee0New, uint8 communityFee1New)',                  // V-src
'event TickSpacing(int24 newTickSpacing)',                                             // V-src
'event Incentive(address indexed virtualPoolAddress)',                                 // V-src
'event LiquidityCooldown(uint32 liquidityCooldown)',                                   // V-src
// Note: in pool Mint/Burn/Collect, `owner` is the NonfungiblePositionManager for NPM positions; attribute to users via NPM events + ERC721 Transfer.

// NonfungiblePositionManager 0x91fD594c46D8B01E62dBDeBed2401dde01817834
'function createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96) payable returns (address pool)', // V-chain (0x51246d6e, real txs)
'function mint((address token0, address token1, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)', // V-chain (0x9cc1a283, real txs)
'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)', // V-src (0x219f5d17 present)
'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)', // V-src (0x0c49ccbe present)
'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)', // V-src (0xfc6f7865 present)
'function burn(uint256 tokenId) payable',                                              // V-src (0x42966c68 present)
'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)', // V-src (0x99fbab88 present)
'function multicall(bytes[] data) payable returns (bytes[] results)',                  // V-chain (0xac9650d8, real txs)
'function factory() view returns (address)',                                           // V-chain
'function poolDeployer() view returns (address)',                                      // V-chain
'function WNativeToken() view returns (address)',                                      // V-chain
'function safeTransferFrom(address from, address to, uint256 tokenId)',                // V-src (OZ ERC721)
'function ownerOf(uint256 tokenId) view returns (address)',                            // V-src
'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint128 actualLiquidity, uint256 amount0, uint256 amount1, address pool)', // V-chain (0x8a82de7f…) — differs from Uniswap v3!
'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)', // V-chain (0x26f6a048…)
'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)', // V-chain (0x40d0efd1…)
'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',   // V-chain (ERC721)

// SwapRouter 0xfFB643E73f280B97809A8b41f7232AB401a04ee1
'function exactInputSingle((address tokenIn, address tokenOut, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 limitSqrtPrice) params) payable returns (uint256 amountOut)', // V-chain (0xbc651188, real txs)
'function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)', // V-chain (0xc04b8d59, real txs)
'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 limitSqrtPrice) params) payable returns (uint256 amountIn)', // V-src (0xdb3e2198 present; note vestigial `fee` field)

// Quoter 0xcBaD9FDf0D2814659Eb26f600EFDeAF005Eda0F7  — non-view; eth_call only
'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 fee)',   // V-chain (live eth_call)
'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint256 amountOut, uint160 limitSqrtPrice) returns (uint256 amountIn, uint16 fee)', // V-src (0x9e73c81d present)
'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint16[] fees)',    // V-src
'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint16[] fees)',   // V-src

// ConditionalTokens 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce
'event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount)', // V-chain (0xab3760c3…)
'event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)', // V-src (topic 0xb44d84d3…)
'event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)', // V-chain (0x2e6bb91f…)
'event PositionsMerge(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)', // V-src (0x6f13ca62…)
'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)', // V-src (0x2682012a…)
'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)', // V-chain (0xc3d58168…)
'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)', // V-chain (0x4a39dc06…)
'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)', // V-src
'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)', // V-src
'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)', // V-src
'function payoutNumerators(bytes32, uint256) view returns (uint256)',                 // V-src
'function payoutDenominator(bytes32) view returns (uint256)',                         // V-src
'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',           // V-src
'function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)', // V-src
'function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)', // V-src
'function balanceOf(address owner, uint256 id) view returns (uint256)',               // V-src

// Wrapped1155Factory 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f
'event Wrapped1155Creation(address indexed multiToken, uint256 indexed tokenId, address indexed wrappedToken)', // V-chain (0x5cf3a400…)
'function getWrapped1155(address multiToken, uint256 tokenId, bytes data) view returns (address)', // V-src
'function requireWrapped1155(address multiToken, uint256 tokenId, bytes data) returns (address)', // V-src
'function unwrap(address multiToken, uint256 tokenId, uint256 amount, address recipient, bytes data)', // V-src
'function batchUnwrap(address multiToken, uint256[] tokenIds, uint256[] amounts, address recipient, bytes data)', // V-src

// Seer Router / GnosisRouter 0xeC9048b59b3467415b1a38F63416407eA0c70fB8
'function splitPosition(address collateralToken, address market, uint256 amount)',   // V-chain (0xd5f82280, real txs)
'function mergePositions(address collateralToken, address market, uint256 amount)',  // V-src (0x7abef8d1)
'function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)', // V-src (0x865955a0)
'function splitFromBase(address market) payable',                                     // V-src (0x50d9991c)
'function mergeToBase(address market, uint256 amount)',                               // V-src (0xd6d150d1)
'function redeemToBase(address market, uint256[] outcomeIndexes, uint256[] amounts)', // V-src (0x9fe603e8)

// Seer Market (per market) — used for canonical wrapper lookup
'function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)', // V-src (repo Market.sol; not called by me)
'function conditionId() view returns (bytes32)',                                       // V-src
'function parentCollectionId() view returns (bytes32)',                                // V-src

// Seer MarketFactory 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1
'event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)', // V-chain (0x109e5ac0…)
'function createCategoricalMarket((string marketName, string[] outcomes, string questionStart, string questionEnd, string outcomeType, uint256 parentOutcome, address parentMarket, string category, string lang, uint256 lowerBound, uint256 upperBound, uint256 minBond, uint32 openingTime, string[] tokenNames) params) returns (address)', // V-chain (0x8770b180, decoded real tx)

// sDAI 0xaf204776c7245bF4147c2612BF6e5972Ee483701
'function convertToAssets(uint256 shares) view returns (uint256)',                    // V-chain
```

---

## 9. Risks

1. **Pool-initialisation and price griefing.** An attacker can pre-create or initialise the outcome/sDAI pool at a bad price. `createAndInitializePoolIfNecessary` then silently keeps it.
   - *Mitigation:* read the price at the latest block, use an `amount*Min` derived from the expected price, re-price empty pools with seed + limited swap, and abort otherwise.
2. **Wrong-token pools.** Look-alike wrappers or tokens can exist. Use only `Market.wrappedOutcome(i)` addresses, and compute pools from them.
3. **Dynamic and governance-controlled fees.** The fee can jump to 1.5% under the current config and up to 6.55% by governance, and the community share can rise to 25%. Show the fee as a range, and quote through the Quoter.
4. **Thin liquidity.** The sampled pool's price impact was huge at 1–5 sDAI. Always show size-dependent quotes; never a headline price alone.
5. **INVALID outcome.** YES and NO both go to 0. Positions and researcher holdings in YES/NO lose everything. The customer's INVALID tokens recover the budget.
6. **Front-running and copy-trading of researchers** on a public mempool. This includes evidence front-running.
7. **Withdrawable LP.** Without a lock, the commitment is not credible. A lock adds contract risk and irreversibility.
8. **RPC integrity.** Use pinned blocks, multi-RPC agreement, and never act on a single provider's response.
9. **sDAI ≠ $1.** Convert with `convertToAssets`. Yield accrues to redeemers of outcome tokens.
10. **Quoter semantics.** The Quoter is non-view and revert-based. Treat failures as "no route" or "insufficient liquidity", and never broadcast to it.

## 10. Recommendations

1. **Default product structure:**
   1. Split the budget into complete sets via `GnosisRouter.splitFromBase` or `Router.splitPosition`.
   2. Create or verify the **YES/sDAI** Algebra pool.
   3. Mint one **single-sided YES sell ladder** `[a, b]`, with `b` around 0.95–0.98 and `a` set from the customer's chosen max loss: `maxLoss ≈ S·(1 − √(ab))`.
   4. Hold the NO and INVALID tokens, optionally in the locker, and redeem after resolution.
   5. Show: max loss in the YES case, roughly 0 loss in the NO/INVALID cases, researcher capital needed, and depth at several sizes.
2. **No default NO-side subsidy.** If a two-sided market is needed for a price signal, keep it small, require `a_YES + a_NO ≥ 1`, and disclose that it leaks to post-deadline buyers.
3. **Backend pricing:** spot from `globalState`, executable amounts from the Quoter via `eth_call` at a pinned block, depth curves from tick traversal (uncompressed `tickTable`) cross-checked against the Quoter.
4. **Indexing:** use the events in §8. Attribute LP ownership through NPM `IncreaseLiquidity`/`DecreaseLiquidity`/`Collect` plus ERC721 `Transfer`, not pool `Mint.owner`, which is the NPM. Watch governance events: `Fee`, `CommunityFee`, `TickSpacing`, `LiquidityCooldown`, `Incentive`.
5. **Locker:** if commitment is advertised, build the minimal immutable locker in §6.3 and get it audited. Until then, label positions "withdrawable at any time".
6. **Small budgets:** for budgets below about $20, warn that the maximum researcher profit is a few dollars and depth is cents. Oracle bonds (10 xDAI in the sampled market) exceed the budget. A $5 budget is not a meaningful incentive.

## 11. Unverified or open items
- No QuoterV2 address on Gnosis was found or verified. QuoterV2-style multi-return quoting is unavailable; use the verified v1 `Quoter`.
- No audited Algebra-NFT locker on Gnosis was found. FarmingCenter and vault sources were not reviewed.
- Gas for ERC20 `approve` and for a root-market (non-child) split was not separately measured.
- `ConditionResolution`, `PositionsMerge` and `PayoutRedemption` topics were checked from source only, not seen in logs.
- Seer `ConditionalRouter` and `MarketView` addresses come only from repo deployments files; I did not verify them on-chain.
- The xDAI ≈ $1 peg is assumed for the USD figures.
