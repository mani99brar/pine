# Seer / Reality.eth / Kleros / Envio — Integration Reference

Status: research reference for the Pine frontend (see `SPEC.md`). It is not an approved design. All values were collected on **2026-10-03**.

## How to read this document

Each fact carries a tag that says where it came from:

| Tag | Meaning |
|---|---|
| **[CHAIN]** | Read live with `cast call` against a public RPC on 2026-10-03. This is the strongest evidence. |
| **[REPO]** | Taken from source code or a hardhat-deploy JSON at the pinned commit below. |
| **[DOCS]** | Taken from published documentation. |
| **UNVERIFIED** | Not confirmed. The note says where to check. |

Pinned sources:

| Source | Ref |
|---|---|
| `seer-pm/demo` (contracts, SDK, web, docs) | `60423441a71dd4eead5a026a4cff93fbd4c6f4f3` (2026-10-01). Deployments are in `contracts/deployments/<chain>/*.json`, and `@seer-pm/sdk` generates its addresses from these files (`packages/seer-pm-sdk/wagmi.config.ts`). |
| `seer-pm/seer-indexer` (Seer's own Envio HyperIndex v3 indexer) | `cc3b6b65d78e4d88ee063f158b61c6d3284c9bb8` (2026-09-07), `envio@3.10.0` |
| `@seer-pm/lens` (npm) | 1.5.1 |
| `kleros/cross-chain-realitio-proxy` | `07a63a4393a73c1cb4db2f7b751f5ed871097e87` (2026-10-01) |
| `kleros/realitio-proxy` (`Realitio_v2_1_ArbitratorWithAppeals`) | `b9585971172d394dfd9d97e38b842ac18316b3f4` |
| `RealityETH/reality-eth-monorepo` | `36298dd056a2af82111fa2f65bea77aa0e096630` (2026-09-30). The deployed version is `packages/contracts/flat/RealityETH-3.0.sol`. |
| `enviodev/hyperindex` | latest release v3.13.0 (2026-09-23). Docs at docs.envio.dev (`*.md` variants). |
| Seer docs | https://docs.seer.pm (Mintlify, sourced from `seer-pm/demo/docs`). The older GitBook at https://seer-3.gitbook.io/seer-documentation is partly stale; for example, it lists old `MarketView` addresses. |

---

## Summary: addresses per chain

The production Seer app supports Gnosis (100), Ethereum (1), Optimism (10) and Base (8453). Sepolia (11155111) is served only by Seer's testnet site (`VITE_TESTNET_WEBSITE=1`; see `web/src/lib/chains.ts`) and is **not** indexed by Seer's production HyperIndex endpoint [CHAIN: `_meta` returns chains 1, 10, 100 and 8453 only].

All MarketFactory immutables in this table were read on-chain with `arbitrator()`, `realitio()`, `collateralToken()`, `conditionalTokens()`, `realityProxy()`, `wrapped1155Factory()`, `market()` and `questionTimeout()` [CHAIN]. Router, MarketView and other periphery addresses are [REPO], and their code existence was spot-checked on Gnosis [CHAIN].

> Identical addresses on different chains are not necessarily the same contract. For example, `0x8bdC504d…` is the Market implementation on Ethereum but ConditionalTokens on Optimism and Sepolia. Always key addresses by chain.

| Contract | Gnosis (100) | Ethereum (1) | Optimism (10) | Base (8453) | Sepolia (11155111) |
|---|---|---|---|---|---|
| **MarketFactory** (official) | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | `0x1F728c2fD6a3008935c1446a965a313E657b7904` | `0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6` | `0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6` | `0x221456ACFD185EE168052B3DA899939303775C7a` |
| MarketFactory deploy block | 36404701 | 20894990 | 140163863 | 34781185 | 6992825 |
| `marketCount()` on 2026-10-03 | 1600 | 14 | 731 | 157 | 20 |
| Market (clone implementation) | `0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a` | `0x8bdC504dC3A05310059c1c67E0A2667309D27B93` | `0xAb797C4C6022A401c31543E316D3cd04c67a87fC` | `0xC72f738e331b6B7A5d77661277074BB60Ca0Ca9E` | `0xf9369c0F7a84CAC3b7Ef78c837cF7313309D3678` |
| **Router for split/merge/redeem** | GnosisRouter `0xeC9048b59b3467415b1a38F63416407eA0c70fB8` | MainnetRouter `0x886Ef0A78faBbAE942F1dA1791A8ed02a5aF8BC6` | Router `0x179d8F8c811B8C759c33809dbc6c5ceDc62D05DD` | Router `0x3124e97ebF4c9592A17d40E54623953Ff3c77a73` | Router `0xdEB5dC052e55bf81C6d75CD47C961e0b280B3791` |
| ConditionalRouter (conditional markets only) | `0x774284d5cDFeC3A0a0eBc7283aD4d5b33013c29c` | `0x1BA2dB142a69B2D0b0EDbe666A9Bd457E344D9b5` | `0x3124e97ebF4c9592A17d40E54623953Ff3c77a73` | `0xF5ccbf74121edBa492725F325D55356D517723B9` | `0x73f98977ba13ad71275ba5bBA0189E9dC2dc42B5` |
| MarketView (current, per repo) | `0x010Bc82218C4857CBF5639B0046E0E05a678D8D4` | `0xcBBbABD15895ae7b2e28BE6f250729098F1c69FA` | `0xDd193f64dbe184891f0beb3510AD69b5DC849BD1` | `0xDd193f64dbe184891f0beb3510AD69b5DC849BD1` | `0x14662A441C72cBE609155A02A5B433FC0D4C1443` |
| RealityProxy (CTF oracle) | `0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C` | `0xC72f738e331b6B7A5d77661277074BB60Ca0Ca9E` | `0xfE8bF5140F00de6F75BAFa3Ca0f4ebf2084A46B2` | `0xfE8bF5140F00de6F75BAFa3Ca0f4ebf2084A46B2` | `0xAc9Bf8EbA6Bd31f8E8c76f8E8B2AAd0BD93f98Dc` |
| ConditionalTokens | `0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce` | `0xC59b0e4De5F1248C1140964E0fF287B192407E0C` | `0x8bdC504dC3A05310059c1c67E0A2667309D27B93` | `0xAb797C4C6022A401c31543E316D3cd04c67a87fC` | `0x8bdC504dC3A05310059c1c67E0A2667309D27B93` |
| Wrapped1155Factory | `0xD194319D1804C1051DD21Ba1Dc931cA72410B79f` | same | same | same | same |
| **Collateral** (factory `collateralToken()`) | sDAI (Savings xDAI) `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | sDAI `0x83F20F44975D03b1b09e64809B757c47f942BEeA` | sUSDS `0xb5B2dc7fd34C249F4be7fB1fCea07950784229e0` | sUSDS `0x5875eEE11Cf8398102FdAd704C9E96607675467a` | test "DAI" `0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357` |
| Convenience base asset | xDAI (native) via GnosisRouter + SavingsXDaiAdapter `0xD499b51fcFc66bd31248ef4b28d656d67E591A94`; wxDAI `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d` | DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F` via MainnetRouter | USDS `0x4f13a96ec5c4cf34e442b46bbd98a0791f20edc3`, USDC `0x0b2c639c533813f4aa9d7837caf62653d097ff85` (PSM3 `0xe0F9978b907853F354d79188A3dEfbD41978af62`) | USDS `0x820c137fa70c8691f0e44dc420a5e53c168921dc`, USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (PSM3 `0x1601843c5E9bC251A3272907010AFa41Fa18347E`) | — |
| **Reality.eth v3.0** (native-token bonds) | `0xE78996A233895bE74a66F451f1019cA9734205cc` (bonds in xDAI) | `0x5b7dD1E86623548AF054A4985F7fc8Ccbb554E2c` (ETH) | `0x0eF940F7f053a2eF5D6578841072488aF0c7d89A` (ETH) | `0x2F39f464d16402Ca3D8527dA89617b73DE2F60e8` (ETH) | `0xaf33DcB6E8c5c4D9dDF579f53031b514d19449CA` (SepETH) |
| **Arbitrator in the Reality question** (factory `arbitrator()`) | RealitioHomeArbitrationProxy `0x68154EA682f95BF582b80Dd6453FA401737491Dc` | Realitio_v2_1_ArbitratorWithAppeals `0x2018038203aEE8e7a29dABd73771b0355D4F85ad` | RealitioHomeProxyOptimism `0x5AFa42b30955f137e10f89dfb5EF1542a186F90e` | RealitioHomeProxy (OP-stack) `0x5AFa42b30955f137e10f89dfb5EF1542a186F90e` | Realitio_v2_1_ArbitratorWithAppeals `0xa638F22cDD13013494971b0e1325718AA45280dc` |
| **Where arbitration is requested and paid** (always L1) | Ethereum: RealitioForeignArbitrationProxyWithAppeals `0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68` | Ethereum: `0x2018038203aEE8e7a29dABd73771b0355D4F85ad` | Ethereum: RealitioForeignProxyOptimism `0xd8b33e3F5426dB753D1C6c78b43d5151970cd928` | Ethereum: RealitioForeignProxyBase `0x54811E1157CCc2BE68Ce4CC850e5ab3382fe627F` | Sepolia: `0xa638F22cDD13013494971b0e1325718AA45280dc` |
| Kleros arbitrator | KlerosLiquid (Kleros v1 Court, Ethereum) `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069` | same | same | same | KlerosLiquid (Sepolia) `0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879` |
| Court / min jurors (`arbitratorExtraData`) | General Court (0) / 31 | General Court (0) / 31 | Oracle Court (24) / 15 | Oracle Court (24) / 15 | court 0 / 31 |
| `arbitrationCost` on 2026-10-03 | 0.1674 ETH | 0.1674 ETH | 0.081 ETH | 0.081 ETH | 0.31 SepETH |
| Reality `questionTimeout` (factory immutable) | 302400 s (3.5 days) | 302400 s | 302400 s | 302400 s | 302400 s |
| Seer UI default `minBond` (`web/src/lib/config.ts`) | 10 xDAI | 0.02 ETH | 0.0005 ETH | 0.0005 ETH | 0.000001 ETH |
| Verified-markets Curate (LightGeneralizedTCR) | `0x5aAF9E23A11440F8C1Ad6D2E2e5109C7e52CC672` | `0x4A9f8e73b3c4c9d7fA0210b9de457b1c493a3AdA` | none (verification is disabled on OP-stack chains) | none | `0x06140fb869486363818196B61704493a8790F73C` |

Verification of the arbitrator wiring:

- **Gnosis** [CHAIN]. Home `0x68154…` has `realitio()` = `0xE78996…` and `foreignProxy()` = `0xFe0eb5…`. Foreign `0xFe0eb5…` has `homeProxy()` = `0x68154…`.
- **Optimism** [CHAIN]. Home `0x5AFa42…` has `realitio()` = `0x0eF940…` and `foreignProxy()` = `0xd8b33e…`. Foreign `0xd8b33e…` has `homeProxy()` = `0x5AFa42…`.
- **Base** [CHAIN]. Home `0x5AFa42…` has `realitio()` = `0x2F39f4…` and `foreignProxy()` = `0x54811E…`. Foreign `0x54811E…` has `homeProxy()` = `0x5AFa42…`.
- **Terms of service.** All Seer arbitrators expose `metadata()` with the ToS `ipfs://QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf` [CHAIN].

---

## 1. Seer deployments

**Chains.** Seer runs on Gnosis, Ethereum, Optimism and Base. Sepolia is a test deployment.

**Sources.** All addresses are in the summary table above [REPO `contracts/deployments/*`; CHAIN where noted]. The deployment JSON also includes the hardhat-deploy constructor `args`. For each MarketFactory they are, in order: `market`, `arbitrator`, `realitio`, `wrapped1155Factory`, `conditionalTokens`, `collateralToken`, `realityProxy`, `questionTimeout = 302400`.

### Other factories on Gnosis

These are not needed for Pine:

| Factory | Address | Notes |
|---|---|---|
| `CirclesMarketFactory` | `0x2e3937cefF8e0AC5563B5D212Bbe8f6CB8ECB68E` | Collateral profile `circles`: s-gCRC `0xeef7b1f06b092625228c835dd5d5b14641d1e54a` per `packages/seer-pm-sdk/src/collateral.ts`. The trading guide lists a different s-gCRC address (`0x548c…4bC1`), so this is a doc inconsistency. |
| `FutarchyFactory` | `0xa6cb18fcdc17a2b44e5cad2d80a6d5942d30a345` [REPO] | The docs and GitBook list `0xe789e4A2…`. |
| Unofficial factory | `0x1246c7e5ac59ba73a45a62e3081b548f02f58e90` | Seer's indexer indexes it, but it is **not** in `isOfficialMarketFactory` (`packages/seer-pm-sdk/src/create-market.ts`). [CHAIN]: `questionTimeout()` = **60 s**, same arbitrator `0x68154…`. It hosts real "Will PR #… merge before …?" GitHub markets, for example `100:0x3c2e4b1b909f2e45d18500f8f0068430083ff442`. Seer's market page shows "This market was not created through an official Seer factory…" for any non-official factory (`web/src/pages/markets/@chainId/@id/+Page.tsx`). A 60 s timeout leaves almost no time to challenge an answer. Pine should use the **official** factory. |

### Router selection

The Seer SDK picks the router with `getRouterAddress()` (`packages/seer-pm-sdk/src/router-addresses.ts`):

- Gnosis: GnosisRouter
- Ethereum: MainnetRouter
- Optimism, Base and Sepolia: generic Router

All three types inherit the generic `Router` functions.

### LiquidityManager

`LiquidityManager` on Gnosis is at `0x031778c7A1c08787aba7a2e0B5149fEb5DECabD7`. It is a legacy, internal helper; see §4.

---

## 2. MarketFactory: creating a categorical market

Source: `contracts/src/MarketFactory.sol` [REPO]. The struct layout is identical in the deployed ABI on all five chains [REPO deployment ABIs compared].

```solidity
struct CreateMarketParams {
    string   marketName;     // question text (categorical/multi-categorical/scalar)
    string[] outcomes;       // WITHOUT the invalid outcome (added automatically)
    string   questionStart;  // multi-scalar only
    string   questionEnd;    // multi-scalar only
    string   outcomeType;    // multi-scalar only
    uint256  parentOutcome;  // conditional markets only
    address  parentMarket;   // conditional markets only (address(0) for none) — UNTRUSTED
    string   category;       // Reality category, e.g. "misc"
    string   lang;           // Reality language, e.g. "en_US"
    uint256  lowerBound;     // scalar only
    uint256  upperBound;     // scalar only
    uint256  minBond;        // Reality min bond (native token wei)
    uint32   openingTime;    // Reality opening_ts (unix seconds)
    string[] tokenNames;     // ERC20 name+symbol per outcome (must be < 32 bytes each)
}
function createCategoricalMarket(CreateMarketParams calldata params) external returns (address);
event NewMarket(address indexed market, string marketName, address parentMarket,
                bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds);
```

### Values for a categorical YES/NO market

These follow the Seer SDK `getCreateMarketParams` (`packages/seer-pm-sdk/src/create-market.ts`):

| Field | Value |
|---|---|
| `marketName` | `escapeJson(question)` = `JSON.stringify(txt)` with the outer quotes stripped. **The contract does not escape anything.** |
| `outcomes` | `["Yes","No"]`, each passed through `escapeJson`. At least 2 are required (`require(params.outcomes.length >= 2)`). Seer's UI rejects an outcome named "Invalid" and duplicate outcomes. |
| `questionStart`, `questionEnd`, `outcomeType` | `""` |
| `parentOutcome` | `0` |
| `parentMarket` | `0x0000000000000000000000000000000000000000` |
| `category` | Seer's list: `elections`, `politics`, `business`, `science`, `crypto`, `pop_culture`, `sports`, `doge`, `misc`, `weather`. The SDK default is `"misc"`. |
| `lang` | `"en_US"` (hard-coded by the SDK) |
| `lowerBound`, `upperBound` | `0` |
| `minBond` | Per chain (see the summary table). |
| `openingTime` | The earliest time Reality accepts answers. |
| `tokenNames` | One per outcome. The contract enforces `< 32` bytes (`toString31` reverts "string too long") and that the name is non-empty for non-invalid outcomes. Seer's UI caps names at 11 characters and auto-generates them with `generateTokenName`: uppercase, `[A-Z0-9_]`, ≤ 11 chars. |

### What the call does

All of this happens on-chain in `createMarket` and `createNewMarketParams`:

1. **Builds the Reality question string.** It is `marketName ␟ "Yes","No" ␟ category ␟ lang` (see §5), using `templateId = 2` (single-select).
2. **Asks the Reality question.** It calls `askQuestionWithMinBond(2, encoded, arbitrator, questionTimeout, openingTime, 0 /*nonce*/, minBond)`. If a question with the same id already exists, it reuses it rather than reverting. Identical text, opening time and min bond on the same factory therefore share one Reality question.
3. **Derives the CTF ids.**
   - `questionId = keccak256(abi.encode(questionsIds, outcomes.length, templateId, lowerBound, upperBound))`
   - `conditionId = CTF.getConditionId(realityProxy, questionId, outcomes.length + 1)`
   - It prepares the condition if needed.
4. **Deploys `outcomes.length + 1` wrapped ERC20 tokens.** It uses `Wrapped1155Factory.requireWrapped1155` with 18 decimals. The **last token is always named and symbolized `SER-INVALID`**.
5. **Clones the Market and emits `NewMarket`.** It clones `market` with EIP-1167, initializes it, and emits `NewMarket`.

**Fees.** None. The function is `nonpayable`, and the arbitrators' Reality question fee is 0 on every chain [CHAIN: `arbitrator_question_fees(arbitrator)` = 0].

**Gas** [CHAIN, Gnosis receipt `0xe7a04b27…`]. A 2-outcome categorical market (3 wrapped tokens) used **1,654,645 gas**. An 80-outcome market used about 15.3M. On Ethereum, multiply by the L1 gas price.

**Getting the new market address.** Simulate the call and use the return value, or read `topics[1]` of the `NewMarket` log in the receipt. `topic0` = `keccak256("NewMarket(address,string,address,bytes32,bytes32,bytes32[])")`.

### Minimal ABI (JSON)

```json
[
  {"type":"function","name":"createCategoricalMarket","stateMutability":"nonpayable",
   "inputs":[{"name":"params","type":"tuple","components":[
     {"name":"marketName","type":"string"},
     {"name":"outcomes","type":"string[]"},
     {"name":"questionStart","type":"string"},
     {"name":"questionEnd","type":"string"},
     {"name":"outcomeType","type":"string"},
     {"name":"parentOutcome","type":"uint256"},
     {"name":"parentMarket","type":"address"},
     {"name":"category","type":"string"},
     {"name":"lang","type":"string"},
     {"name":"lowerBound","type":"uint256"},
     {"name":"upperBound","type":"uint256"},
     {"name":"minBond","type":"uint256"},
     {"name":"openingTime","type":"uint32"},
     {"name":"tokenNames","type":"string[]"}]}],
   "outputs":[{"name":"","type":"address"}]},
  {"type":"event","name":"NewMarket","anonymous":false,"inputs":[
     {"indexed":true,"name":"market","type":"address"},
     {"indexed":false,"name":"marketName","type":"string"},
     {"indexed":false,"name":"parentMarket","type":"address"},
     {"indexed":false,"name":"conditionId","type":"bytes32"},
     {"indexed":false,"name":"questionId","type":"bytes32"},
     {"indexed":false,"name":"questionsIds","type":"bytes32[]"}]},
  {"type":"function","name":"marketCount","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint256"}]},
  {"type":"function","name":"allMarkets","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address[]"}]},
  {"type":"function","name":"arbitrator","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"collateralToken","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"address"}]},
  {"type":"function","name":"questionTimeout","stateMutability":"view","inputs":[],"outputs":[{"name":"","type":"uint32"}]}
]
```

### Market contract reads

Each market is an EIP-1167 clone. The useful reads are, in human-readable ABI form:

```
function marketName() view returns (string)
function outcomes(uint256) view returns (string)          // excludes the invalid outcome
function numOutcomes() view returns (uint256)             // excludes the invalid outcome
function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)  // index numOutcomes() = SER-INVALID
function questionsIds() view returns (bytes32[])          // Reality question ids (1 for categorical)
function encodedQuestions(uint256 index) view returns (string)
function templateId() view returns (uint256)
function conditionId() view returns (bytes32)
function questionId() view returns (bytes32)               // CTF questionId (not the Reality id)
function parentCollectionId() view returns (bytes32)
function resolve()                                         // permissionless; calls RealityProxy.resolve(this)
```

`MarketView.getMarket(address marketFactory, address market)` returns a single struct with these fields:

- `id`, `marketName`
- `outcomes` — the last entry is replaced by the label `"Invalid result"`
- `wrappedTokens`, `outcomesSupply`, `lowerBound`, `upperBound`
- `parentCollectionId`, `conditionId`, `questionId`, `templateId`
- `questions` — the Reality `questions()` structs
- `questionsIds` — follows reopened questions
- `baseQuestionsIds`
- `encodedQuestions`
- `payoutReported`, `payoutNumerators`

[REPO `contracts/src/MarketView.sol`; CHAIN call succeeded on Gnosis `0x010Bc822…`]

---

## 3. Router: split, merge and redeem

Source: `contracts/src/Router.sol`, `GnosisRouter.sol`, `MainnetRouter.sol` [REPO]. The function lists were confirmed in each chain's deployed ABI.

```solidity
// Router (all chains; GnosisRouter and MainnetRouter inherit it)
function splitPosition(IERC20 collateralToken, Market market, uint256 amount) external;
function mergePositions(IERC20 collateralToken, Market market, uint256 amount) external;
function redeemPositions(IERC20 collateralToken, Market market, uint256[] calldata outcomeIndexes, uint256[] calldata amounts) external;
function getWinningOutcomes(bytes32 conditionId) external view returns (bool[] memory);
function getTokenId(IERC20 collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (uint256);

// GnosisRouter only (xDAI <-> sDAI via SavingsXDaiAdapter 0xD499b51fcFc66bd31248ef4b28d656d67E591A94)
function splitFromBase(Market market) external payable;                      // msg.value xDAI -> sDAI shares -> split
function mergeToBase(Market market, uint256 amount) external;               // merge -> sDAI -> xDAI to caller
function redeemToBase(Market market, uint256[] calldata outcomeIndexes, uint256[] calldata amounts) external;

// MainnetRouter only (DAI <-> sDAI 0x83F2…BEeA)
function splitFromDai(Market market, uint256 amount) external;
function mergeToDai(Market market, uint256 amount) external;
function redeemToDai(Market market, uint256[] calldata outcomeIndexes, uint256[] calldata amounts) external;

// ConditionalRouter only (conditional markets; not needed for Pine)
function redeemConditionalToCollateral(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] parentOutcomeIndexes, uint256[] amounts) external;
```

### Semantics

The Seer docs page `developers/guides/split-merge-and-redeem.mdx` [DOCS] agrees with the code below [REPO].

**split**

- **Inputs.** `collateralToken` must be the market's collateral (sDAI on Gnosis and Ethereum, sUSDS on Optimism and Base). The caller must first `approve(router, amount)` on the collateral.
- **Output.** It mints `amount` of **every** outcome token, including `SER-INVALID`, to the caller. A YES/NO market therefore yields `amount` YES + `amount` NO + `amount` SER-INVALID.
- **`splitFromBase`.** It splits the **sDAI shares** obtained from `msg.value`, not the xDAI amount. sDAI is an ERC-4626 share whose price is above 1.

**merge**

- **Inputs.** The caller needs `amount` of **all** outcome tokens, including SER-INVALID, and must `approve` the router on each wrapped ERC20.
- **Output.** It returns `amount` collateral.
- **Timing.** The CTF allows a merge at any time, before or after resolution.

**redeem**

- **When.** Only after `Market.resolve()` has reported payouts.
- **Inputs.** `outcomeIndexes` selects which wrapped tokens to burn; the invalid outcome's index is `numOutcomes()`. `amounts` is per index. The caller must `approve` the router on each redeemed token.
- **Output.** Collateral is paid as `amount * payoutNumerator / payoutDenominator`. Redeeming a losing token simply yields 0.
- **Helpers.** Use `getWinningOutcomes(conditionId)` to show which outcomes are redeemable.

**Indexing caveat.** CTF `PositionSplit`, `PositionsMerge` and `PayoutRedemption` events record the **Router** as `stakeholder`/`redeemer`. Attribute the action to a user with `tx.from`; Seer's indexer selects `transaction.from` for these events.

### Minimal ABI (JSON)

```json
[
  {"type":"function","name":"splitPosition","stateMutability":"nonpayable","inputs":[{"name":"collateralToken","type":"address"},{"name":"market","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"mergePositions","stateMutability":"nonpayable","inputs":[{"name":"collateralToken","type":"address"},{"name":"market","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"redeemPositions","stateMutability":"nonpayable","inputs":[{"name":"collateralToken","type":"address"},{"name":"market","type":"address"},{"name":"outcomeIndexes","type":"uint256[]"},{"name":"amounts","type":"uint256[]"}],"outputs":[]},
  {"type":"function","name":"getWinningOutcomes","stateMutability":"view","inputs":[{"name":"conditionId","type":"bytes32"}],"outputs":[{"name":"","type":"bool[]"}]},
  {"type":"function","name":"splitFromBase","stateMutability":"payable","inputs":[{"name":"market","type":"address"}],"outputs":[]},
  {"type":"function","name":"mergeToBase","stateMutability":"nonpayable","inputs":[{"name":"market","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"redeemToBase","stateMutability":"nonpayable","inputs":[{"name":"market","type":"address"},{"name":"outcomeIndexes","type":"uint256[]"},{"name":"amounts","type":"uint256[]"}],"outputs":[]},
  {"type":"function","name":"splitFromDai","stateMutability":"nonpayable","inputs":[{"name":"market","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"mergeToDai","stateMutability":"nonpayable","inputs":[{"name":"market","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
  {"type":"function","name":"redeemToDai","stateMutability":"nonpayable","inputs":[{"name":"market","type":"address"},{"name":"outcomeIndexes","type":"uint256[]"},{"name":"amounts","type":"uint256[]"}],"outputs":[]}
]
```

---

## 4. Liquidity, trading, price and depth

### Venues per chain

Sources:

- `@seer-pm/lens` 1.5.1 `CHAINS` constant and README
- `packages/seer-pm-sdk/src/explorer-urls.ts`
- `web/src/lib/config.ts`
- Docs page `developers/guides/trading.mdx`

| Chain | Venue Seer uses | Pool pair | Addresses |
|---|---|---|---|
| **Gnosis** | **Swapr v3 = Algebra v1** concentrated liquidity. The NonfungiblePositionManager `name()` is "Algebra Positions NFT-V1" [CHAIN]. | outcome token / sDAI | AlgebraFactory `0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766` [CHAIN via NPM `factory()`]; PoolDeployer `0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47` [CHAIN]; NonfungiblePositionManager `0x91fd594c46d8b01e62dbdebed2401dde01817834` [REPO + CHAIN]; SwapRouter `0xfFB643E73f280B97809A8b41f7232AB401a04ee1` [lens; CHAIN `factory()` matches]; FarmingCenter `0xde51ddf1ae7d5bbd7bf1a0e40aaa1f6c12579106` [REPO]; Seer LensQuoter `0x82150d38288e53AfcF20a5eEee47682c5Ef796d8` [lens]. A standalone Algebra Quoter is UNVERIFIED (check Swapr docs or gnosisscan). |
| **Ethereum** | Uniswap v4 via **Bunni v2**: Seer's "add liquidity" link goes to `bunni.pro`, and its pool explorer links to `bunni.pro/pools/ethereum/{id}`. Uniswap v3 is also quoted by Lens. | outcome / sDAI | Uniswap v3 Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`; NPM `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`; SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`; QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` [all CHAIN: `factory()` checks]. Lens `v4Router` `0x00000000000044a361Ae3cAc094c9D1b14Eece97` and LensQuoter `0xaCE2C61E250c2d019b9Ed7FEf6A441022D6Ec7d2` [lens]. Bunni contracts are UNVERIFIED. |
| **Optimism** | Uniswap v3 and v4. Seer's create-position link uses fee tier **100 (0.01%)** with tickSpacing 1. | outcome / sUSDS | Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`; NPM `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`; SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`; QuoterV2 `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` [CHAIN]; v4Router `0x00000000000044a361Ae3cAc094c9D1b14Eece97`; LensQuoter `0x591aF101cAf2b7351C74c25F5E64bC2E062D2843` [lens] |
| **Base** | Uniswap v3 and v4, same link format as Optimism | outcome / sUSDS | Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`; NPM `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`; SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`; QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` [CHAIN]; v4Router `0x00000000000044a361Ae3cAc094c9D1b14Eece97`; LensQuoter `0x591aF101cAf2b7351C74c25F5E64bC2E062D2843` [lens] |

**CoW.** CoW is **not** used for Seer outcome trading in the current code. `@cowprotocol/cow-sdk` is a web dependency, but the only usage found is CoW token-list logo URLs (`web/src/lib/paths.ts`).

**Limit orders.** Seer also indexes a Uniswap v4 limit-order hook (`LimitOrderHook`) on Ethereum, Optimism and Base, plus an `orderBook` subgraph on Base. This is out of scope for Pine.

### How Seer's UI adds liquidity

[DOCS `app/provide-liquidity.mdx`; REPO `explorer-urls.ts`]

1. **Mint.** The user splits collateral into outcome tokens (§3).
2. **Open the DEX.** Seer's "Add liquidity" button redirects to the external DEX UI. Seer does not mint the LP position itself.
   - Gnosis: `https://v3.swapr.eth.limo/#/add/{token0}/{token1}/enter-amounts`
   - Ethereum: `https://bunni.pro/add/ethereum?tokenA={token0}&tokenB={token1}&fee=3000`
   - Optimism and Base: `https://app.uniswap.org/positions/create/v3?…&chain={optimism|base}&…fee={"feeAmount":100,"tickSpacing":1,…}` (full range by default)
3. **Supply both tokens.** The LP sets the initial price and range, then supplies both the outcome token and the collateral. There is one pool per outcome token, and `getMarketPoolsPairs` includes the SER-INVALID token's pair.

**Legacy helper.** `LiquidityManager.addIndexLiquidityToMarket(market, liquidityAmount)` on Gnosis splits sDAI and adds **Uniswap-V2-style** liquidity on SushiSwap V2: router `0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506`, whose `factory()` is `0xc35DADB65012eC5796536bD9864eD8773aBc74C4` [CHAIN]. Seer's backend function `add-liquidity-background` uses it with 0.01 sDAI per outcome. It is not the user-facing path.

**Programmatic LP on Gnosis** would call the Algebra NPM `createAndInitializePoolIfNecessary(token0, token1, sqrtPriceX96)` and then `mint(MintParams)`. In Algebra v1, `MintParams` has no `fee` field: `(token0, token1, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline)`. **UNVERIFIED:** check against the verified NPM source on gnosisscan before use. Uniswap v3 `MintParams` includes `uint24 fee`.

**LP withdrawal.** LP positions are ordinary NFTs and can be withdrawn at any time. Nothing in Seer locks them, which matters for SPEC §7 ("withdrawable LP").

### Reading price and depth

Options, roughly from simplest to most precise:

1. **Seer API.** `POST https://app.seer.pm/.netlify/functions/get-market` with `{chainId, id}` returns:
   - `odds` (per outcome, may be empty)
   - `hasLiquidity`, `liquidityUSD`
   - `poolBalance[]` (token0/token1 balances)
   - `volumeUSD`, `openInterestUSD`
   
   [DOCS `developers/api.mdx`; CHAIN-tested 2026-10-03.] This is Seer's own infrastructure, with no SLA or rate limit published (UNVERIFIED).
2. **Swapr Algebra subgraph (Gnosis).** The Goldsky endpoint is public and needed no key in testing: `https://api.goldsky.com/api/public/project_cmair7jgkzena01x58241cqow/subgraphs/swapr-algebra/latest/gn`. Farming is at `…/swapr-algebra-farming/latest/gn`. Example (tested):
   ```graphql
   { pools(first: 5, orderBy: liquidity, orderDirection: desc,
           where: { token0: "<outcome lowercased>", token1: "0xaf204776c7245bf4147c2612bf6e5972ee483701" }) {
       id fee tick sqrtPrice liquidity token0Price token1Price
       totalValueLockedToken0 totalValueLockedToken1 volumeUSD } }
   ```
   `token0`/`token1` follow address sort order (`getToken0Token1`), so query both orientations. For depth, query the `ticks` entity (`liquidityNet` per tick) of the pool (UNVERIFIED that the field names match Algebra's schema; introspect first).
3. **Uniswap subgraphs (Ethereum, Optimism, Base).** These are on The Graph gateway and need **your own API key**; Seer's SDK embeds Seer's key. Subgraph IDs:
   - Ethereum: `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`
   - Optimism: `49LkWjoVKd3bM9ZrMdFgYkjaCuVj4ExZttQi6XfbcPpG`
   - Base: `96eJ9Go8gFjySRGnndG7EYxThaiwVDV8BYPp1TMDcoYh`

   Seer also proxies all of these at `https://app.seer.pm/subgraph?_subgraph={uniswap|algebra|algebrafarming|reality|curate|tokens|orderBook|seer}&_chainId={id}`.
4. **On-chain pool state.**
   - **Algebra v1 pool.** `globalState()` returns `(uint160 price /*sqrtPriceX96*/, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)`, alongside `liquidity()` and `tickSpacing()` [CHAIN: tested on pool `0xa44211cb…`, tickSpacing 60, dynamic fee 100].
   - **Uniswap v3 pool.** `slot0()` and `liquidity()`.
   - **Price.** price(token1 per token0) = (sqrtPriceX96 / 2^96)^2; both tokens have 18 decimals.
   - **Finding the pool.** Use `AlgebraFactory.poolByPair(tokenA, tokenB)`, or compute the CREATE2 address: deployer `0xC1b576…`, salt `keccak256(abi.encode(token0, token1))`, init-code hash `0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7` (`packages/seer-pm-sdk/src/pool-address.ts`).
5. **Executable price and price impact** (recommended for the SPEC §7 "executable depth" display). Quote real sizes with `@seer-pm/lens` (`new Lens(publicClient, chainId).quote({tokenIn, tokenOut, amount, recipient, slippageBps, exactOut?})`) or with `@seer-pm/sdk` `fetchAmmQuote`.
   - The quote returns `amountIn`/`amountOut` and router calldata (`target`, `data`, `msgValue`).
   - It throws `InsufficientLiquidityError` when the pool is too thin.
   - Quoting a ladder of sizes, such as 1, 10 and 100 collateral, gives a depth curve.

---

## 5. Reality.eth (v3.0) as used by Seer

### Templates

Templates 0–4 are built into the constructor of `RealityETH-3.0.sol` [REPO]:

| ID | Template |
|---|---|
| 0 | `{"title": "%s", "type": "bool", "category": "%s", "lang": "%s"}` |
| 1 | `{"title": "%s", "type": "uint", "decimals": 18, "category": "%s", "lang": "%s"}` — Seer scalar and multi-scalar |
| **2** | `{"title": "%s", "type": "single-select", "outcomes": [%s], "category": "%s", "lang": "%s"}` — **Seer categorical** |
| 3 | `{"title": "%s", "type": "multiple-select", "outcomes": [%s], "category": "%s", "lang": "%s"}` — Seer multi-categorical |
| 4 | `{"title": "%s", "type": "datetime", "category": "%s", "lang": "%s"}` |

### Encoding

The separator is **U+241F "␟"**, encoded in UTF-8 as `0xE2 0x90 0x9F`.

```
<title>␟"<outcome0>","<outcome1>"␟<category>␟<lang>
```

A real on-chain example is `encodedQuestions(0)` of Gnosis market `0xfe1216…` [CHAIN]:

```
Which party will win the Senate in 2026?␟"Democratic Party","Republican Party"␟misc␟en_US
```

Every field is pasted verbatim into the JSON template, so each must be a valid JSON string body. Escape `"`, `\` and control characters (the SDK's `escapeJson`), and never include `␟`. Seer flags any market whose parameters alter the JSON as unreliable (`hasInjectedParameters` / `isMarketReliable` in the SDK). Do **not** list an "Invalid" outcome; Reality adds `0xff…ff` automatically [DOCS reality `contracts.md`].

### IDs

Version 3 hashing [REPO RealityETH-3.0.sol]:

- `content_hash = keccak256(abi.encodePacked(template_id, opening_ts, question))`
- `question_id = keccak256(abi.encodePacked(content_hash, arbitrator, timeout, min_bond, address(reality), msg.sender /*= MarketFactory*/, nonce /*= 0*/))`

### Answer encoding (bytes32)

| Value | Meaning |
|---|---|
| `0x…00` | outcome index 0, e.g. "Yes" |
| `0x…01` | outcome index 1, e.g. "No" |
| `0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | **INVALID** |
| `0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe` | **"Answered too soon"** (`UNRESOLVED_ANSWER`) |

### Timing and bonds

[REPO; CHAIN for the values]

**Opening time.** Answers revert before `opening_ts`.

**Timeout.** It is 302,400 s (3.5 days) for official Seer factories. Each new answer sets `finalize_ts = now + timeout`, and the question finalizes when `finalize_ts <= now` with no pending arbitration.

**Bonds.**

- The first answer needs `bond >= min_bond`; each later answer needs `bond >= 2 × current bond`.
- Bonds are paid in the chain's **native token**: xDAI on Gnosis, ETH elsewhere.
- Seer UI defaults: 10 xDAI on Gnosis, 0.02 ETH on Ethereum, 0.0005 ETH on Optimism and Base. Some Gnosis markets observed via the indexer use `min_bond` 1 or 0.01 xDAI.
- Seer's UI computes the next bond as `bond == 0 ? min_bond : bond*2` (`getCurrentBond`).

**Claims.** When winnings are claimed, 1/40 (2.5%) of each non-final bond is burned (`BOND_CLAIM_FEE_PROPORTION = 40`). A correct final answerer receives their bond back plus the earlier wrong bonds.

**Commit–reveal.** It is available through `submitAnswerCommitment` and `submitAnswerReveal`. The reveal window is `timeout/8`.

**Anti-front-running.** `submitAnswer(question_id, answer, max_previous)` reverts if a higher bond landed first.

**Question fee.** The arbitrator's question fee is 0 for every Seer arbitrator [CHAIN].

### Events

[REPO deployed ABI, identical on all chains]

```solidity
event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created);
event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment);
event LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user);
event LogFinalize(bytes32 indexed question_id, bytes32 indexed answer);         // emitted when the ARBITRATOR answers (submitAnswerByArbitrator), not on timeout finalization
event LogCancelArbitration(bytes32 indexed question_id);
event LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id);
event LogMinimumBond(bytes32 indexed question_id, uint256 min_bond);
event LogAnswerReveal(bytes32 indexed question_id, address indexed user, bytes32 indexed answer_hash, bytes32 answer, uint256 nonce, uint256 bond);
event LogClaim(bytes32 indexed question_id, address indexed user, uint256 amount);
```

- **Finalization has no event.** Normal finalization by timeout emits nothing. Derive it from `finalize_ts` and `isFinalized()`.
- **Filtering Pine's questions.** In `LogNewQuestion`, `user` is `msg.sender`, which is the MarketFactory. That makes it a cheap topic filter for Pine's questions.

### Reads

```solidity
function questions(bytes32) view returns (bytes32 content_hash, address arbitrator, uint32 opening_ts, uint32 timeout, uint32 finalize_ts, bool is_pending_arbitration, uint256 bounty, bytes32 best_answer, bytes32 history_hash, uint256 bond, uint256 min_bond);
function getBestAnswer(bytes32 question_id) view returns (bytes32);   // current (possibly non-final) answer
function getBond(bytes32 question_id) view returns (uint256);         // current highest bond
function getMinBond(bytes32 question_id) view returns (uint256);
function getFinalizeTS(bytes32 question_id) view returns (uint32);    // 0 = unanswered
function getOpeningTS(bytes32 question_id) view returns (uint32);
function getTimeout(bytes32 question_id) view returns (uint32);
function getHistoryHash(bytes32 question_id) view returns (bytes32);
function isFinalized(bytes32 question_id) view returns (bool);        // !pending && finalize_ts > 0 && finalize_ts <= now
function isPendingArbitration(bytes32 question_id) view returns (bool);
function getFinalAnswer(bytes32 question_id) view returns (bytes32);  // (deprecated) reverts unless finalized
function resultFor(bytes32 question_id) view returns (bytes32);       // reverts unless finalized
function isSettledTooSoon(bytes32 question_id) view returns (bool);   // resultFor == 0xff..fe
function resultForOnceSettled(bytes32 question_id) view returns (bytes32); // what Seer's RealityProxy uses; reverts if too-soon and not reopened; follows ONE reopen level
function reopened_questions(bytes32) view returns (bytes32);
function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable;
function reopenQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond, bytes32 reopens_question_id) payable returns (bytes32);
```

### Answered too soon

1. **Resolution blocks.** If the final answer is `0xff…fe`, `RealityProxy.resolve` reverts.
2. **Reopen.** Someone must call `reopenQuestion` with the identical template, question, arbitrator, timeout, `opening_ts` and `min_bond`, and a new nonce. Seer's UI has `useReopenQuestion`.
3. **Re-finalize.** The new question must then finalize.
4. **Follow-through.** `MarketView` and `resultForOnceSettled` follow `reopened_questions` automatically.

### Market name length

- **Text.** Neither the contracts nor Seer's form impose a limit on `marketName` or outcome text. Long strings cost gas, because they are stored in the Market clone and emitted in two events.
- **Token names.** The hard limit is **token names < 32 bytes** on-chain; Seer's UI allows ≤ 11 chars.

### Resolution policy

Both policies come from Seer and should be confirmed with Seer before launch:

| Policy | Where it appears | Notes |
|---|---|---|
| **Seer Markets Resolution Policy** `QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ` | ToS in every Seer arbitrator's `metadata()`, so Reality.eth and Kleros jurors see it | 8 pages [CHAIN + PDF fetched]. It covers invalid categories (relative dates, moral questions, no valid answer, multiple answers, prohibited questions), "answered too soon" for early answers, default UTC, sources of truth, and similar. |
| "Seer - Markets Policy" `QmW6npv4J3jvF87WVCEaQQ6f2PK1T9ytX2eYg86XkT9ScK` | Seer docs | Wording differs slightly. |
| "Verified Markets Policy" `QmfGcodBzG53DBxS2Uxu5jug9YiHUpJ5tKFqhP6Z2HjscU` | Curate verification | Applies to optional verification on Gnosis and Ethereum. |

Which of the first two policies governs, and whether Pine's technical-counterexample questions are "verifiable facts" under it, is a launch gate.

---

## 6. Kleros arbitration for Seer markets

### Topology

All Seer arbitration resolves in **Kleros v1 Court (`KlerosLiquid` on Ethereum)**. Kleros v2 is not used.

| Market chain | Requester pays on | Contract to call | Ruling path back to Reality |
|---|---|---|---|
| Ethereum | Ethereum | `Realitio_v2_1_ArbitratorWithAppeals` `0x2018…85ad` | Anyone calls `reportAnswer(questionID, lastHistoryHash, lastAnswerOrCommitmentID, lastAnswerer)` once the status is `Ruled`. |
| Gnosis | **Ethereum** (ETH) | `RealitioForeignArbitrationProxyWithAppeals` `0xFe0e…Aa68` (v1.1.2, Solidity 0.7) | AMB bridge. `rule()` relays automatically, then anyone calls `reportArbitrationAnswer(...)` on the Gnosis home proxy. |
| Optimism | **Ethereum** | `RealitioForeignProxyOptimism` `0xd8b3…d928` (0.8) | Anyone calls `relayRule(questionID, requester)` on L1, then `reportArbitrationAnswer` on the L2 home proxy. |
| Base | **Ethereum** | `RealitioForeignProxyBase` `0x5481…627F` (0.8, OP-stack) | Same as Optimism. |

Sources: [REPO `kleros/cross-chain-realitio-proxy` README sequence diagram, sources in `contracts/src/0.7` and `contracts/src/0.8`; Seer web `useRaiseDispute.ts`, `useArbitrationCost.ts`, `useArbitrationRequest.ts`].

Cross-chain flow:

1. **Request.** On L1, `requestArbitration{value ≥ cost}`. The proxy stores the request and emits `ArbitrationRequested`.
2. **Notify Reality.** A bridge message reaches the home proxy, which calls `reality.notifyOfArbitrationRequest`. Reality freezes the question (`is_pending_arbitration = true`) and emits `LogNotifyOfArbitrationRequest`. If this fails, for example because the question is already final or `maxPrevious` was exceeded, the request becomes `Rejected`. Someone must then call `handleRejectedRequest` so the deposit is refunded on L1.
3. **Acknowledge.** Anyone calls `handleNotifiedRequest(questionID, requester)` on the home chain. That sends an L2→L1 acknowledgement. **On Optimism and Base this crosses the 7-day optimistic bridge** (per the Kleros README diagram). On Gnosis it uses the AMB; its latency is UNVERIFIED.
4. **Create the dispute.** The L1 proxy creates the KlerosLiquid dispute (`ArbitrationCreated`, ERC-1497 `Dispute`) and refunds any excess deposit. If the cost rose above the deposit, the request becomes `Failed` and the deposit is recoverable via `handleFailedDisputeCreation`.
5. **Rule and report.** The ruling is relayed back. Reality is then answered via `assignWinnerAndSubmitAnswerByArbitrator`, which emits `LogFinalize` and finalizes immediately.

**Kleros bots.** Kleros runs bots (`bots/` in the repo, every 20 min) that call the permissionless home-chain steps. Whether they service Seer's proxies is **UNVERIFIED**. Pine should be able to call these steps itself.

### Court parameters

[CHAIN on KlerosLiquid]

| Setting | Gnosis and Ethereum | Optimism and Base |
|---|---|---|
| Court | General Court (0) | Oracle Court (24) |
| `extraData` | `0x…00` + `0x…1f` (31 jurors) | `0x…18` + `0x…0f` (15 jurors) |
| `feeForJuror` | 0.0054 ETH | 0.0054 ETH |
| `hiddenVotes` | false (commit period skipped) | false (commit period skipped) |
| Periods | evidence 3.25 d, vote 6.75 d, appeal 4.5 d | same |

Seer's docs give ~14.5 days to a ruling, plus ~11 days for each appeal round [DOCS `app/raise-a-dispute.mdx`].

Appeal multipliers on the proxies: winner 3000/10000, loser 7000/10000, loser appeal period 5000/10000.

### Reading the arbitration cost

```solidity
function getDisputeFee(bytes32 questionID) view returns (uint256);           // on any of the 3 foreign proxies and on Realitio_v2_1 (ignores the id)
// equivalently:
function arbitrator() view returns (address);                                // 0x988b…8069
function arbitratorExtraData() view returns (bytes);
function arbitrationCost(bytes _extraData) view returns (uint256);           // on KlerosLiquid
```

Seer's UI reads `arbitrator()` and `arbitratorExtraData()` on the L1 contract, then `arbitrationCost(extraData)` on Ethereum. The fee is always shown in **ETH**.

### Requesting arbitration

```solidity
// Cross-chain foreign proxies (Ethereum):
function requestArbitration(bytes32 _questionID, uint256 _maxPrevious) external payable;   // msg.value >= cost; excess refunded when the dispute is created
// Realitio_v2_1_ArbitratorWithAppeals (Ethereum-native markets, Sepolia):
function requestArbitration(bytes32 _questionID, uint256 _maxPrevious) external payable returns (uint256 disputeID);
// CAUTION: v2_1 forwards ALL msg.value to createDispute; overpaying buys extra jurors and is not refunded.
```

- **What `_maxPrevious` does.** The request reverts or rejects if the Reality bond has risen above `_maxPrevious` (0 disables the check). Seer passes `getCurrentBond(...)`.
- **Precondition.** A question can be disputed only after it has an answer and before it finalizes.

### Evidence (ERC-1497)

- **Call.** Use `submitEvidence(uint256 _arbitrationID, string _evidenceURI)` on the **Ethereum** arbitrable contract: the foreign proxy, or `Realitio_v2_1` for Ethereum markets.
- **Ids.** `_arbitrationID = uint256(questionID)`. This is also the ERC-1497 `_evidenceGroupID` used in `Dispute(…, _metaEvidenceID = 0, _evidenceGroupID = uint256(questionID))`.
- **Permissions and timing.** `submitEvidence` is **permissionless and has no status check**: it simply emits the event and can be called before any dispute exists. It costs Ethereum gas.
- **Juror visibility.** Whether Kleros v1 court UIs show evidence emitted before dispute creation is UNVERIFIED.

```solidity
event Evidence(address indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence);
event Dispute(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _metaEvidenceID, uint256 _evidenceGroupID);
event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence);
```

**Evidence JSON** [DOCS EIP-1497, ethereum/EIPs#1497]. `_evidence` is a URI to JSON shaped like `{ "name": "...", "description": "...", "fileURI": "...", "fileHash": "<multihash>", "fileTypeExtension": "pdf" }`. Kleros tooling conventionally uses `/ipfs/<cid>/<file>.json` URIs, served via `https://cdn.kleros.link`. That exact path convention for resolve.kleros.io is UNVERIFIED.

Reality.eth itself has no evidence channel; answerers judge off-chain.

### Reading dispute and ruling status

**Foreign proxies** (Gnosis, Optimism, Base markets; on Ethereum):

```solidity
function arbitrationIDToRequester(uint256 arbitrationID) view returns (address);  // arbitrationID = uint256(questionID); zero address = no dispute yet
function arbitrationRequests(uint256 arbitrationID, address requester) view returns (uint8 status, uint248 deposit, uint256 disputeID, uint256 answer);
```

Status values:

- Gnosis proxy (0.7): `0 None, 1 Requested, 2 Created, 3 Ruled, 4 Failed`
- Optimism and Base proxies (0.8): `0 None, 1 Requested, 2 Created, 3 Ruled, 4 Relayed, 5 Failed`

```solidity
event ArbitrationRequested(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious);
event ArbitrationCreated(bytes32 indexed _questionID, address indexed _requester, uint256 indexed _disputeID);
event ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester);
event ArbitrationCanceled(bytes32 indexed _questionID, address indexed _requester);
event Ruling(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling);
event RulingRelayed(bytes32 _questionID, bytes32 _ruling);   // 0.8 (OP/Base) only
```

**`Realitio_v2_1`** (Ethereum markets):

```solidity
function arbitrationRequests(uint256 questionID) view returns (uint8 status /*0 None,1 Disputed,2 Ruled,3 Reported*/, address requester, uint256 disputeID, uint256 ruling);
event DisputeIDToQuestionID(uint256 indexed _disputeID, bytes32 _questionID);
```

**Home proxies** (Gnosis `0x68154…`, Optimism and Base `0x5AFa42…`):

```solidity
function questionIDToRequester(bytes32) view returns (address);
function requests(bytes32 questionID, address requester) view returns (uint8 status /*0 None,1 Rejected,2 Notified,3 AwaitingRuling,4 Ruled,5 Finished*/, bytes32 arbitratorAnswer);
event RequestNotified(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious);
event RequestRejected(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious, string _reason);
event RequestAcknowledged(bytes32 indexed _questionID, address indexed _requester);
event RequestCanceled(bytes32 indexed _questionID, address indexed _requester);
event ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester);
event ArbitratorAnswered(bytes32 indexed _questionID, bytes32 _answer);
event ArbitrationFinished(bytes32 indexed _questionID);
// permissionless actions: handleNotifiedRequest(bytes32,address), handleRejectedRequest(bytes32,address),
// reportArbitrationAnswer(bytes32 questionID, bytes32 lastHistoryHash, bytes32 lastAnswerOrCommitmentID, address lastAnswerer)
```

**KlerosLiquid** `0x988b…8069` [CHAIN-tested]:

```solidity
function disputeStatus(uint256 disputeID) view returns (uint8);   // 0 Waiting, 1 Appealable, 2 Solved
function currentRuling(uint256 disputeID) view returns (uint256);
function disputes(uint256) view returns (uint96 subcourtID, address arbitrated, uint256 numberOfChoices, uint8 period /*0 evidence,1 commit,2 vote,3 appeal,4 execution*/, uint256 lastPeriodChange, uint256 drawsInRound, uint256 commitsInRound, bool ruled);
function appealPeriod(uint256 disputeID) view returns (uint256 start, uint256 end);
function appealCost(uint256 disputeID, bytes extraData) view returns (uint256);
```

**Ruling to answer mapping.** The Reality answer is the Kleros ruling minus 1. Ruling 0, "Refuse to arbitrate", becomes `0xff…ff`, which is **INVALID**. For a YES/NO market, ruling 1 means answer 0 ("Yes") and ruling 2 means answer 1 ("No").

---

## 7. Payout semantics, including invalid

Source: `contracts/src/RealityProxy.sol`, `MarketFactory.sol` [REPO]. Verified on a live market [CHAIN].

- **Invalid outcome.** Seer **always adds an "Invalid result" outcome automatically**. `outcomeSlotCount = outcomes.length + 1`, and the extra wrapped ERC20 is `SER-INVALID`. For example, Gnosis market `0xfe1216…` has tokens `DEMOCRATIC_`, `REPUBLICAN_` and `SER-INVALID` [CHAIN]. Indexers and MarketView label the last outcome `"Invalid result"`.
- **Categorical resolution** (`resolveCategoricalMarket`) works with `answer = resultForOnceSettled(questionId)`:

  | Reality answer | Payout vector | Redeems |
  |---|---|---|
  | valid index `k < n` | `[0…1@k…0, 0]` | only outcome `k` pays 1 collateral per token |
  | `0xff…ff` (invalid), **or any index `>= n`** | `[0,…,0, 1]` | **only `SER-INVALID`** pays 1 per token; YES and NO pay 0 |
  | `0xff…fe` (too soon) | — | `resolve()` reverts until the question is reopened and the replacement finalizes |
  | never answered | — | never finalizes, so it cannot resolve; full sets can still be merged |

- **Invalid is not a refund.** On invalid, holders of YES or NO tokens lose their position value. Collateral goes to whoever holds SER-INVALID, for example a splitter or LP who kept the invalid tokens, or traders who bought them. Pine must present this explicitly (SPEC §5).
- **Resolving.** Anyone calls `Market.resolve()` or `RealityProxy.resolve(market)` after the Reality question is finalized. Seer's UI exposes this as "Report Answer". The call executes `ConditionalTokens.reportPayouts`, which emits `ConditionResolution(conditionId, oracle, questionId, outcomeSlotCount, payoutNumerators)`.
- **Redeeming.** After resolution, call `Router.redeemPositions(collateral, market, [idx…], [amount…])`. On Gnosis, `redeemToBase` pays in xDAI. Payouts come in collateral (sDAI or sUSDS shares), which keep accruing savings yield until redeemed.
- **Kleros Refuse to Arbitrate.** It maps to INVALID (§6).

---

## 8. Envio HyperIndex (v3)

Sources:

- docs.envio.dev pages: configuration-file, schema, multichain-indexing, migrate-to-v3, navigating-hasura, observability, wildcard-indexing
- `enviodev/hyperindex` templates
- Seer's production indexer `seer-pm/seer-indexer` (envio 3.10.0), a near-exact precedent for Pine

### config.yaml (v3)

V2's `networks:` was renamed to **`chains:`** in V3. `unordered_multichain_mode`, `preload_handlers` and `loaders` were removed, and `rpc_config` became `rpc` [DOCS migrate-to-v3].

```yaml
# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
name: pine-indexer
description: Pine claim markets (Seer/Reality/Kleros)
address_format: lowercase          # default is checksum; Seer uses lowercase
# disable_default_cross_chain: true  # v3.6+: per-chain entity tables, composite (id, chainId) PK — see note below

contracts:                          # global contract definitions (ABI + events)
  - name: MarketFactory
    abi_file_path: ./abis/MarketFactory.json   # optional; signatures alone are enough
    events:
      - event: NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)
        field_selection:            # older style; v3.7+ prefers handler-level `fields`
          transaction_fields: [hash, from]
  - name: Reality
    events:
      - event: LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)
      - event: LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)
      - event: LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user)
      - event: LogFinalize(bytes32 indexed question_id, bytes32 indexed answer)
      - event: LogCancelArbitration(bytes32 indexed question_id)
      - event: LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id)
  - name: ConditionalTokens
    events:
      - event: ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)
  - name: ForeignProxy                # Ethereum-side Kleros proxy
    events:
      - event: ArbitrationRequested(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious)
      - event: ArbitrationCreated(bytes32 indexed _questionID, address indexed _requester, uint256 indexed _disputeID)
      - event: ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester)
      - event: Ruling(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling)
      - event: Evidence(address indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence)

chains:
  - id: 100                         # Gnosis
    start_block: 36404701           # MarketFactory deploy block (use Pine's first market block in prod)
    contracts:
      - name: MarketFactory
        address: 0x83183da839ce8228e31ae41222ead9edbb5cdcf1
      - name: Reality
        address: 0xe78996a233895be74a66f451f1019ca9734205cc
      - name: ConditionalTokens
        address: 0xceafdd6bc0bef976fdcd1112955828e00543c0ce
  - id: 1                           # Ethereum (arbitration side for Gnosis markets)
    start_block: 20922529           # 0xFe0e…Aa68 deploy block per kleros/cross-chain-realitio-proxy deployments JSON
    contracts:
      - name: ForeignProxy
        address: 0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68
```

Further config notes:

- `address` accepts a single address or a list.
- Per-contract `start_block` overrides the chain's value.
- `start_block: latest` is allowed since v3.11.
- `rpc:` accepts a URL or a list with `for: sync|realtime|fallback`.
- `${ENV_VAR}` interpolation works anywhere.
- HyperSync, the default data source, needs `ENVIO_API_TOKEN`.

Contracts created at runtime, such as Seer's wrapped outcome ERC20s, are registered dynamically. Seer does this in its config with `address: null` plus `indexer.contractRegister(...)`. Seer's indexer does not index `LogNewQuestion`; it reads market and question state through RPC "effects" (`createEffect`, `context.effect`) inside the `NewMarket` handler.

### Handlers (v3 API)

```ts
import { indexer } from "envio";
indexer.onEvent({ contract: "MarketFactory", event: "NewMarket" }, async ({ event, context }) => {
  context.Market.set({ id: `${event.chainId}:${event.params.market.toLowerCase()}`, /* ... */ });
});
// topic filter on indexed params (formerly eventFilters):
indexer.onEvent({ contract: "Reality", event: "LogNewQuestion",
  where: ({ chain }) => ({ params: [{ user: FACTORY_BY_CHAIN[chain.id] }] }) }, async ({ event, context }) => { /* ... */ });
indexer.contractRegister({ contract: "Factory", event: "Created" }, async ({ event, context }) => {
  context.chain.Child.add(event.params.child);
});
```

### schema.graphql conventions

[DOCS schema]

- **Scalars and TypeScript types.**

  | GraphQL | TypeScript |
  |---|---|
  | `ID` | `string` |
  | `String` | `string` |
  | `Int` | `number` |
  | `Float` | `number` |
  | `Boolean` | `boolean` |
  | `BigInt` | `bigint` |
  | `BigDecimal` | `BigDecimal` (exported by `envio`) |
  | `Bytes` | `string` (hex) |
  | `Timestamp` | `Date` |
  | `Json` | `Json` |

  Enums and scalar arrays such as `[String!]!` are also supported.
- **Ids.** Every entity needs `id: ID!`. Since v3.5 the id may also be `String!`, `Int!` or `BigInt!`.
- **Entity declarations.** No `@entity` directive is needed; every `type` is an entity.
- **Relations.** Declare `field: Other!` and set it in handlers as `field_id`. Reverse lists use `[Child!]! @derivedFrom(field: "parent")`; they are virtual and resolved at query time.
- **Directives.**
  - `@index` on a field.
  - `@config(precision: 76)` for `BigInt`.
  - `@config(precision: 10, scale: 2)` for `BigDecimal`.
  - `@internal` hides an entity from GraphQL.
  - `@crossChain` is only valid together with `disable_default_cross_chain: true`.
- **Per-chain mode.** `disable_default_cross_chain: true` gives entity tables a composite `(id, chainId)` primary key and reserves the `chainId` column.
- **Seer's id convention.** Seer does **not** use per-chain mode. It namespaces ids as `${chainId}:${lowercaseHex}` (`src/entityIds.ts`), so `Market_by_pk(id:)` takes a single string.

An excerpt of Seer's schema, useful as a model:

```graphql
type Market {
  id: ID!                     # "100:0xmarket"
  chainId: BigInt!
  address: Bytes!
  factory: Bytes!
  creator: Bytes!
  marketName: String!
  outcomes: [String!]!        # includes "Invalid result"
  wrappedTokens: [Bytes!]!
  collateralToken: Bytes!
  conditionId: Bytes!
  questionId: Bytes!
  templateId: BigInt!
  encodedQuestions: [String!]!
  payoutReported: Boolean!
  payoutNumerators: [BigInt!]!
  openingTs: BigInt!
  finalizeTs: BigInt!
  questionsInArbitration: BigInt!
  blockTimestamp: BigInt!
  questions: [MarketQuestion!]! @derivedFrom(field: "market")
}
type Question {
  id: ID!                     # "100:0xquestionId"
  questionId: Bytes!
  arbitrator: Bytes!
  opening_ts: BigInt!
  timeout: BigInt!
  finalize_ts: BigInt!
  is_pending_arbitration: Boolean!
  best_answer: Bytes!
  bond: BigInt!
  min_bond: BigInt!
}
type MarketQuestion { id: ID!  market: Market!  baseQuestion: Question!  question: Question!  index: Int! }
```

### Querying the hosted GraphQL endpoint (Hasura)

**Endpoints.**

- Hosted: `https://indexer.hyperindex.xyz/<deployment-hash>/v1/graphql`. For example, Seer's production indexer is at `https://indexer.hyperindex.xyz/798eb82/v1/graphql`.
- Local: `http://localhost:8080/v1/graphql`, with Hasura console password `testing`.

**Request format.** Send a POST with `{"query": "...", "variables": {...}}`. No auth is required for public deployments. Envio Cloud can whitelist IPs or domains.

**Root fields per entity.**

- `Entity(where:, order_by:, limit:, offset:, distinct_on:)`
- `Entity_by_pk(id:)`
- `_meta` (indexing status per chain)
- `chain_metadata`
- `raw_events`

All of these were confirmed by introspecting Seer's endpoint.

**Filter operators.** These follow Hasura: `_eq, _neq, _in, _nin, _gt, _gte, _lt, _lte, _like, _ilike, _is_null, _and, _or, _not`. Nested object filters work on relations.

**Ordering.** `order_by: [{blockTimestamp: desc}]`.

**Value types.** `BigInt` and `numeric` values are compared and returned as **strings**, for example `templateId: {_eq: "2"}`.

**No aggregates on Envio Cloud.** `*_aggregate` is intentionally not exposed. Precompute counters in handlers [DOCS navigating-hasura].

**Rate limits.** They depend on the plan [DOCS]. Seer's backend throttles itself to stay under "Envio's ~250 req/min" (`web/netlify/functions/utils/envioClient.ts`).

**Example queries.** These were tested against Seer's endpoint on 2026-10-03:

```graphql
# Sync status (wait until progressBlock >= tx block before trusting data)
{ _meta { chainId progressBlock sourceBlock isReady } }

# One market by primary key
query GetMarket($id: String!) {           # "100:0x3c2e4b1b909f2e45d18500f8f0068430083ff442"
  Market_by_pk(id: $id) {
    marketName outcomes wrappedTokens payoutReported payoutNumerators finalizeTs
    questions { question { questionId best_answer bond finalize_ts is_pending_arbitration } }
  }
}

# Filter + order + paginate
{
  Market(
    where: { chainId: { _eq: 100 }, templateId: { _eq: "2" },
             factory: { _eq: "0x83183da839ce8228e31ae41222ead9edbb5cdcf1" },
             marketName: { _ilike: "%github%" } },
    order_by: [{ blockTimestamp: desc }], limit: 20, offset: 0
  ) { id marketName outcomes finalizeTs questionsInArbitration }
}

# Questions currently in arbitration
{ Question(where: { is_pending_arbitration: { _eq: true } }, limit: 50) { id questionId arbitrator bond } }
```

---

## 9. Endpoints and URL formats

| Purpose | URL / format | Source |
|---|---|---|
| Seer market page | `https://app.seer.pm/markets/{chainId}/{marketAddress}`. It redirects to a slug such as `/markets/100/will-pr-4859-…`. | [REPO `web/src/lib/paths.ts`; CHAIN-tested 200] |
| Seer market verify page | `https://app.seer.pm/markets/{chainId}/{marketAddress}/verify` | [REPO] |
| Seer API (Netlify functions) | `https://app.seer.pm/.netlify/functions/{name}`. `get-market` (POST `{chainId, id}` or `{chainId, url}`) and `markets-search` (POST filters: `chainsList`, `creator`, `marketName`, `orderBy`, `limit`, `page`, …) are the useful ones. Others: `get-transactions`, `get-portfolio`, `get-portfolio-value`, `get-portfolio-pl`, `get-token-transactions`, `markets-charts`, `get-pnl-leaderboard`, `get-market-pnl-leaderboard`. | [DOCS `developers/api.mdx`; get-market CHAIN-tested] |
| Seer subgraph proxy | `https://app.seer.pm/subgraph?_subgraph={seer\|curate\|uniswap\|algebra\|algebrafarming\|reality\|tokens\|orderBook}&_chainId={id}` (POST GraphQL) | [REPO `subgraph/app-subgraph.ts`; tested] |
| Seer markets HyperIndex (direct) | `https://indexer.hyperindex.xyz/798eb82/v1/graphql`. The hash changes on redeploy; Seer exports it as `SEER_MARKETS_SUBGRAPH`. It covers chains 1, 10, 100 and 8453. | [REPO `subgraph-endpoints.ts`; tested] |
| Seer legacy The Graph subgraph ID | `B4vyRqJaSHD8dRDb3BFRoAzuBK18c1QQcXq94JbxDxWH` (Curate `2hP3hyWreJSK8uvYwC4WMKi2qFXbPcnp7pCx7EzW24sp`). It is likely superseded by Envio; its status is UNVERIFIED. | [DOCS `developers/subgraph/subgraph-id.mdx`] |
| Curate (Gnosis, Ethereum) HyperIndex | `https://indexer.hyperindex.xyz/1a2f51c/v1/graphql` | [REPO] |
| Reality subgraph (Gnosis) | The Graph gateway ID `E7ymrCnNcQdAAgLbdFWzGE5mvr5Mb5T9VfT43FqA7bNh` (needs an API key) | [REPO] |
| Swapr Algebra subgraph (Gnosis) | `https://api.goldsky.com/api/public/project_cmair7jgkzena01x58241cqow/subgraphs/swapr-algebra/latest/gn` | [REPO; tested, no key] |
| Reality.eth question | `https://reality.eth.limo/app/#!/network/{chainId}/question/{realityContract}-{questionId}` | [REPO `getRealityLink`; DOCS reality `dapp_links.md`] |
| Kleros case | `https://resolve.kleros.io/cases/{disputeId}?requiredChainId=1`. The dispute id comes from the proxy's `arbitrationRequests(...).disputeID`. `https://court.kleros.io/cases/{disputeId}` is the court UI equivalent (UNVERIFIED format). | [REPO `paths.klerosDispute`] |
| Pool pages | Gnosis `https://v3.swapr.eth.limo/#/info/pools/{pool}`; Ethereum `https://bunni.pro/pools/ethereum/{pool}`; Optimism and Base `https://app.uniswap.org/explore/pools/{optimism\|base}/{pool}` | [REPO `explorer-urls.ts`] |
| Explorers | gnosisscan.io (now a Blockscout instance), etherscan.io, optimistic.etherscan.io, basescan.org | [REPO] |
| Curate verified-markets list | `https://curate.kleros.io/tcr/{chainId}/{lightGeneralizedTcr}/{itemId?}` | [REPO] |
| Docs | https://docs.seer.pm (current); GitBook mirror https://seer-3.gitbook.io/seer-documentation (partly stale) | [CHAIN-tested 200] |

**Precedent.** GitHub-PR markets already exist on Seer Gnosis, for example "Will PR #4859 … in NousResearch/hermes-agent repository merge before 2026-04-17 20:50:53.422Z?". They were created via the **non-official** factory `0x1246c7e5…` with a 60 s Reality timeout and 0.01 xDAI min bond, and resolved NO [CHAIN]. They show that the market shape works. They do not show adequate dispute windows.

---

## Confidence / launch-gate notes

Re-verify each of these before mainnet use.

1. **Re-read the immutables at launch.** Do not hard-code addresses from this document blindly. For the chosen chain, call `MarketFactory.{arbitrator,realitio,collateralToken,conditionalTokens,realityProxy,wrapped1155Factory,questionTimeout}()`. For the arbitrator, check `foreignProxy()` and `homeProxy()` both ways. Seer redeploys periphery: MarketView changed between the GitBook and the repo, and FutarchyFactory addresses differ between the docs and the repo.
2. **Arbitration needs ETH on Ethereum for every chain.** Costs on 2026-10-03 were 0.1674 ETH for Gnosis and Ethereum markets and 0.081 ETH for Optimism and Base markets. The cost floats with Kleros juror fees, so read `getDisputeFee` live. Decide who funds escalation (SPEC §10.7). On Ethereum-native markets, overpaying `Realitio_v2_1` buys extra jurors and is not refunded.
3. **Arbitration latency.**
   - The Kleros General and Oracle courts take about 14.5 days to a first ruling, plus about 11 days per appeal.
   - Optimism and Base add an L2→L1 7-day bridge delay before the dispute is even created.
   - Gnosis AMB round-trip latency is UNVERIFIED.

   The proposed 72-hour window (SPEC §10.6) covers only the evidence deadline, not resolution.
4. **Permissionless relay steps.** These are `handleNotifiedRequest`, `handleRejectedRequest`, `reportArbitrationAnswer`, `relayRule` and `handleFailedDisputeCreation`. Whether Kleros bots service Seer's proxies is UNVERIFIED. Pine or its keeper must be able to call them.
5. **The Reality timeout is fixed at 3.5 days per official factory**, and each new answer restarts it. A market cannot choose a different timeout without a different factory. Non-official factories, such as the 60 s one, are flagged in Seer's UI and should not be used.
6. **Invalid is not a refund.** Only `SER-INVALID` pays on invalid. An answer index `>= n` is also treated as invalid. "Answered too soon" blocks resolution until the question is reopened. An unanswered question never resolves.
7. **Policy compatibility.** There are two Seer resolution-policy PDFs; the arbitrator ToS is `QmPmRk…` and the docs link `QmW6np…`. Confirm which binds jurors and whether "Was a reproducible counterexample … submitted through [mechanism] before [UTC]" is an answerable fact under it. Also check that questions that depend on off-chain technical evaluation are not "Invalid".
8. **The evidence channel is a design gap.** The ERC-1497 `submitEvidence` on the Ethereum proxy is permissionless and timestamped, and it works before any dispute exists. It costs Ethereum gas, and whether pre-dispute evidence is shown to jurors is UNVERIFIED. Reality.eth answerers have no evidence channel.
9. **Liquidity specifics.**
   - Gnosis uses Algebra v1. Its `MintParams` and a standalone Algebra quoter address are UNVERIFIED.
   - Ethereum LP goes through Bunni v2 / Uniswap v4; those contracts are UNVERIFIED.
   - Uniswap subgraphs need Pine's own The Graph API key; do not use Seer's embedded key.
   - LP positions are freely withdrawable.
10. **Indexing.**
    - Seer's HyperIndex URL is hash-versioned and Seer-operated, with no SLA. Pine should run its own Envio indexer, using `seer-pm/seer-indexer` as the reference.
    - With `disable_default_cross_chain: true`, the shape of `_by_pk` with a composite `(id, chainId)` key is UNVERIFIED. Namespaced string ids, as Seer uses, avoid the issue.
    - Envio Cloud has no aggregates and plan-based rate limits.
11. **Gas and cost.** Creating a binary market costs about 1.65M gas: trivial on Gnosis, material on Ethereum. Creating it requires no xDAI or ETH beyond gas. Liquidity, bonds and arbitration are separate costs.
12. **Seer API terms.** Third-party use of `app.seer.pm/.netlify/functions/*` and `/subgraph` (rate limits, stability, ToS) is UNVERIFIED. Treat it as a convenience, not a dependency.
13. **Sepolia.** It is suitable for contract-flow tests (factory `0x2214…`, Router `0xdEB5…`, collateral test DAI `0xFF34…`). It is not indexed by Seer's production HyperIndex, and Seer's own arbitration-cost code reads mainnet for Sepolia, which is an apparent bug. Expect gaps.
14. **Things not checked in this research.** Audits of Seer contracts (see `docs/resources/audit-reports.mdx`), the sDAI and sUSDS savings-rate mechanics, and any legal or regulatory question.
