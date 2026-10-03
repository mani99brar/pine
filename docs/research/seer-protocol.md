# Research: Seer prediction-market protocol integration on Gnosis Chain (chainId 100)

Collected 2026-10-02 by a research agent for architecture decisions; verified against primary sources and Gnosis/Ethereum state with Foundry cast. Facts marked unverified must not be relied on without checking.

## Summary

Research is based on the seer-pm/demo repo at HEAD 60423441 (2026-10-01), its hardhat-deploy artifacts in contracts/deployments/gnosis, and live checks with cast against https://rpc.gnosischain.com.
- The source is the deployed code. Bytecode for MarketFactory, Market, RealityProxy, GnosisRouter and MarketView equals the deployment artifacts, and every difference is in an immutable slot. The Solidity sources embedded in the artifact metadata match repo HEAD, apart from whitespace and one added IERC20.symbol() line in Interfaces.sol.
- MarketFactory 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1. It has 1600 markets and is in active use (the latest NewMarket event was at block 48519981). Its immutables:
  - market implementation 0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a
  - arbitrator 0x68154EA682f95BF582b80Dd6453FA401737491Dc (Kleros RealitioHomeArbitrationProxy)
  - realitio 0xE78996A233895bE74a66F451f1019cA9734205cc (Reality.eth v3.0)
  - CTF 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce
  - Wrapped1155Factory 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f
  - collateral sDAI 0xaf204776c7245bF4147c2612BF6e5972Ee483701 ("Savings xDAI", ERC4626 over WXDAI)
  - RealityProxy 0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C
  - questionTimeout 302400 s (3.5 days, fixed)
- GnosisRouter 0xeC9048b59b3467415b1a38F63416407eA0c70fB8 is a Router with xDAI helpers: splitFromBase, mergeToBase and redeemToBase go through SavingsXDaiAdapter 0xD499b51f…. Gnosis has no separately deployed plain Router; GnosisRouter inherits the Router functions. MarketView is at 0x010Bc82218C4857CBF5639B0046E0E05a678D8D4.
- Creation is permissionless. There is no access control, no protocol fee and no msg.value (the factory passes value 0 to Reality, and arbitrator_question_fees for the Kleros proxy is 0). The cost is gas only: about 1.65M gas for a 2-outcome categorical market (real transaction 0xe7a04b27…).
- A binary YES/NO market is createCategoricalMarket with outcomes ["Yes","No"]:
  - It uses Reality template 2 (single-select). The question string is `title␟"Yes","No"␟category␟lang`, separated by U+241F; the SDK uses category "misc" and lang "en_US".
  - The CTF condition gets outcomes.length+1 slots, so 3 ERC20 tokens are created: YES, NO and "SER-INVALID".
  - The content hash, CTF questionId and conditionId derivations were reproduced on-chain for a live market.
- There is no on-chain length limit on the question. Token names must be non-empty and under 32 bytes (the UI caps them at 11 characters). Strings are pasted raw into Reality's JSON template, so the caller must JSON-escape them and must never include U+241F. Otherwise a parameter can inject keys into the question JSON, and the SDK has a hasInjectedParameters() check that flags this.
- Payouts (RealityProxy, categorical):
  - An answer of 0xff..ff, or any index ≥ numOutcomes, gives payouts [0,0,1]: only SER-INVALID holders are paid. Invalid is not a refund, except for wallets that still hold a full set of all three tokens.
  - "Answered too soon" (0xff..fe) makes resultForOnceSettled revert, so the market cannot resolve until someone calls Reality.reopenQuestion and the reopened question finalizes.
  - reportPayouts is one-shot, and anyone can call resolve().
- Arbitration goes from the Gnosis home proxy to the Ethereum foreign proxy 0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68, which uses KlerosLiquid 0x988b3A53… with court 0 and 31 jurors. The current dispute fee is 0.1674 ETH, paid on Ethereum mainnet. The arbitrator's on-chain terms of service is "Seer's Markets Resolution Policy" (ipfs QmPmRkXF…/seer-markets-resolution-policy.pdf).
- Curation: verification is an optional Kleros Curate (LightGeneralizedTCR) listing at 0x5aAF9E23A11440F8C1Ad6D2E2e5109C7e52CC672. It needs a 100 xDAI base deposit plus a 21.6 xDAI arbitration cost, has a 16-hour challenge period, and requires square images and English text. Its "Verified Markets Policy" is stricter than the resolution policy (clarity, uncertainty, opening-date sanity, DD-MM-YYYY dates). Unverified markets are shown with a warning.
- Liquidity: outcome tokens trade on Swapr v3 (Algebra concentrated liquidity) against sDAI. The Algebra factory is 0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766, the poolDeployer (CREATE2 origin) 0xC1b576AC…, and the position NFT manager 0x91fd594c…. In the UI, LPs mint outcome tokens with split, then add liquidity on the Swapr site.

## Verified addresses

| Name | Chain | Address | Verified | Evidence |
|---|---|---|---|---|
| Seer MarketFactory (default sDAI profile) | 100 | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | True | cast code len 19669; marketCount()=1600; immutables read: collateralToken/arbitrator/realitio/conditionalTokens/wrapped1155Factory/realityProxy/market/questionTimeout; bytecode == deployments/gnosis/MarketFactory.json except immutable slots; listed in repo docs deployed-contracts.mdx |
| Seer Market implementation (EIP-1167 clone target) | 100 | `0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a` | True | MarketFactory.market() returns it; bytecode identical to artifact; market 0xFe1216d6... code is 1167 proxy to it. Note initialized()=false on the implementation itself |
| Seer RealityProxy (CTF oracle) | 100 | `0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C` | True | MarketFactory.realityProxy(); conditionalTokens()=0xCeAf..., realitio()=0xE789...; CTF.getConditionId(realityProxy,questionId,3) reproduces live market conditionId |
| Seer GnosisRouter (Router + xDAI helpers) | 100 | `0xeC9048b59b3467415b1a38F63416407eA0c70fB8` | True | code len 22479; sDAI()=0xaf20..., savingsXDaiAdapter()=0xD499..., conditionalTokens()=0xCeAf..., wrapped1155Factory()=0xD194...; bytecode matches artifact modulo immutables |
| Seer ConditionalRouter | 100 | `0x774284d5cDFeC3A0a0eBc7283aD4d5b33013c29c` | True | code len 25151; deployment artifact args (CTF, Wrapped1155Factory); docs table. Functions not inspected in detail |
| Seer MarketView (read helper) | 100 | `0x010Bc82218C4857CBF5639B0046E0E05a678D8D4` | True | bytecode identical to artifact; getMarket(factory, market) call decoded successfully for live market |
| Gnosis ConditionalTokens (CTF) | 100 | `0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce` | True | MarketFactory.conditionalTokens(); getConditionId/getOutcomeSlotCount calls succeed (slot count 3 for binary market) |
| Wrapped1155Factory | 100 | `0xD194319D1804C1051DD21Ba1Dc931cA72410B79f` | True | MarketFactory.wrapped1155Factory(); emits Wrapped1155Creation(address,uint256,address) (topic 0x5cf3a400...) 3x per binary market creation |
| sDAI (Savings xDAI) - Seer default collateral | 100 | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | True | MarketFactory.collateralToken(); symbol()=sDAI, name()=Savings xDAI, decimals 18, asset()=0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d (WXDAI) |
| SavingsXDaiAdapter (used by GnosisRouter) | 100 | `0xD499b51fcFc66bd31248ef4b28d656d67E591A94` | True | GnosisRouter.savingsXDaiAdapter() constant; code len 10665 |
| Reality.eth v3.0 | 100 | `0xE78996A233895bE74a66F451f1019cA9734205cc` | True | MarketFactory.realitio(); questions(qid) decoded; templates 0-4 read from LogNewTemplate logs at block 17997262; selectors resultForOnceSettled/reopenQuestion/fundAnswerBounty present in bytecode |
| Kleros RealitioHomeArbitrationProxy (arbitrator passed to Reality) | 100 | `0x68154EA682f95BF582b80Dd6453FA401737491Dc` | True | MarketFactory.arbitrator(); realitio()=0xE789...; foreignProxy()=0xFe0eb5fC...; foreignChainId=1; metadata() tos=ipfs QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf |
| Kleros RealitioForeignProxy (Ethereum side of Seer arbitration) | 1 | `0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68` | True | homeProxy()=0x68154EA6..., homeChainId=100, arbitrator()=0x988b3A53..., arbitratorExtraData court 0 / 31 jurors, getDisputeFee=0.1674 ETH; requestArbitration(bytes32,uint256) selector present |
| KlerosLiquid (mainnet arbitrator behind foreign proxy) | 1 | `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069` | True | foreignProxy.arbitrator(); courts(0) feeForJuror=0.0054 ETH (x31 = 0.1674 ETH) |
| Seer Verified Markets Curate list (LightGeneralizedTCR proxy) | 100 | `0x5aAF9E23A11440F8C1Ad6D2E2e5109C7e52CC672` | True | EIP-1167 clone; submissionBaseDeposit=100 xDAI, challengePeriodDuration=57600s, arbitrator 0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002 arbitrationCost=21.6 xDAI; listed in deployments/gnosis/LightGeneralizedTCR.json |
| Swapr v3 Algebra factory | 100 | `0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766` | True | NonfungiblePositionManager(0x91fd...).factory(); poolDeployer()=0xC1b576AC... |
| Swapr v3 Algebra poolDeployer (CREATE2 'from' for pool address) | 100 | `0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47` | True | factory.poolDeployer(); SDK POOL_FACTORY_ADDRESSES[100] uses it with init code hash 0xbce37a54...7e7 |
| Swapr v3 NonfungiblePositionManager (Algebra Positions NFT-V1) | 100 | `0x91fd594c46d8b01e62dbdebed2401dde01817834` | True | name()='Algebra Positions NFT-V1'; referenced in web/src/lib/config.ts SWAPR_CONFIG |
| Seer QuestionsFactory (paginated market creation helper) | 100 | `0x42cE29eA4C658577295561f8e0d03314d7d845c9` | False | code exists (len 18497) and artifact args reference MarketFactory; purpose/ABI not reviewed - not needed for binary markets |
| Seer CirclesMarketFactory (alt collateral profile) | 100 | `0x2e3937cefF8e0AC5563B5D212Bbe8f6CB8ECB68E` | False | present in deployments/gnosis and SDK factory map; not inspected with cast; not for sDAI markets |

## Signatures

- **MarketFactory** (struct, verified): `struct CreateMarketParams { string marketName; string[] outcomes; string questionStart; string questionEnd; string outcomeType; uint256 parentOutcome; address parentMarket; string category; string lang; uint256 lowerBound; uint256 upperBound; uint256 minBond; uint32 openingTime; string[] tokenNames; }` — Field order from source and deployment ABI; ABI tuple type (string,string[],string,string,string,uint256,address,string,string,uint256,uint256,uint256,uint32,string[])
- **MarketFactory** (function, verified): `function createCategoricalMarket(CreateMarketParams params) returns (address)` — selector 0x8770b180 (present in deployed bytecode; used by live tx 0xe7a04b27...). Requires outcomes.length>=2; outcomeSlotCount=outcomes.length+1; template 2
- **MarketFactory** (function, verified): `function createMultiCategoricalMarket(CreateMarketParams params) returns (address)` — selector 0x3412a3f9; template 3
- **MarketFactory** (function, verified): `function createScalarMarket(CreateMarketParams params) returns (address)` — selector 0x7ca5cb3e; template 1; outcomes.length==2; upperBound>lowerBound; upperBound<uint256.max-2
- **MarketFactory** (function, verified): `function createMultiScalarMarket(CreateMarketParams params) returns (address)` — selector 0xff08d88f; one Reality question per outcome built as questionStart+outcome+questionEnd
- **MarketFactory** (event, verified): `event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)` — topic0 0x109e5ac06d4835cca9a97d9014f7bb1bfafb85a2de6d4af1ad22aa8730e12c87 confirmed in live logs; only market is indexed
- **MarketFactory** (function, verified): `function markets(uint256) view returns (address)`
- **MarketFactory** (function, verified): `function allMarkets() view returns (address[])`
- **MarketFactory** (function, verified): `function marketCount() view returns (uint256)`
- **MarketFactory** (function, verified): `function market() view returns (address)`
- **MarketFactory** (function, verified): `function arbitrator() view returns (address)`
- **MarketFactory** (function, verified): `function realitio() view returns (address)`
- **MarketFactory** (function, verified): `function conditionalTokens() view returns (address)`
- **MarketFactory** (function, verified): `function collateralToken() view returns (address)`
- **MarketFactory** (function, verified): `function realityProxy() view returns (address)`
- **MarketFactory** (function, verified): `function wrapped1155Factory() view returns (address)`
- **MarketFactory** (function, verified): `function questionTimeout() view returns (uint32)` — returns 302400 on Gnosis
- **Market** (function, verified): `function marketName() view returns (string)`
- **Market** (function, verified): `function outcomes(uint256) view returns (string)` — excludes the invalid outcome
- **Market** (function, verified): `function numOutcomes() view returns (uint256)` — excludes invalid; CTF slot count = numOutcomes+1
- **Market** (function, verified): `function questionId() view returns (bytes32)` — CTF questionId = keccak256(abi.encode(questionsIds, numOutcomes, templateId, lowerBound, upperBound))
- **Market** (function, verified): `function questionsIds() view returns (bytes32[])` — Reality question ids
- **Market** (function, verified): `function conditionId() view returns (bytes32)`
- **Market** (function, verified): `function templateId() view returns (uint256)`
- **Market** (function, verified): `function parentCollectionId() view returns (bytes32)`
- **Market** (function, verified): `function parentMarket() view returns (address)`
- **Market** (function, verified): `function parentOutcome() view returns (uint256)`
- **Market** (function, verified): `function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)` — index numOutcomes = SER-INVALID token
- **Market** (function, verified): `function parentWrappedOutcome() view returns (address wrapped1155, bytes data)`
- **Market** (function, verified): `function encodedQuestions(uint256 index) view returns (string)`
- **Market** (function, verified): `function lowerBound() view returns (uint256)`
- **Market** (function, verified): `function upperBound() view returns (uint256)`
- **Market** (function, verified): `function realityProxy() view returns (address)`
- **Market** (function, verified): `function initialized() view returns (bool)`
- **Market** (function, verified): `function resolve()` — calls realityProxy.resolve(this); permissionless
- **RealityProxy** (function, verified): `function resolve(address market)` — selector 0x55ea6c47; reverts until Reality question finalized (and reopened replacement finalized if answered too soon); CTF reportPayouts is one-shot
- **GnosisRouter** (function, verified): `function splitPosition(address collateralToken, address market, uint256 amount)` — selector 0xd5f82280; pulls collateral via transferFrom (approve router first), sends all N+1 wrapped ERC20s to msg.sender
- **GnosisRouter** (function, verified): `function mergePositions(address collateralToken, address market, uint256 amount)` — selector 0x7abef8d1; requires approval of every wrapped outcome incl. SER-INVALID
- **GnosisRouter** (function, verified): `function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)` — selector 0x865955a0
- **GnosisRouter** (function, verified): `function splitFromBase(address market) payable` — selector 0x50d9991c; xDAI -> sDAI via adapter, split amount = sDAI shares minted
- **GnosisRouter** (function, verified): `function mergeToBase(address market, uint256 amount)` — selector 0xd6d150d1; amount in sDAI shares
- **GnosisRouter** (function, verified): `function redeemToBase(address market, uint256[] outcomeIndexes, uint256[] amounts)` — selector 0x9fe603e8
- **GnosisRouter** (function, verified): `function getTokenId(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (uint256)`
- **GnosisRouter** (function, verified): `function getWinningOutcomes(bytes32 conditionId) view returns (bool[])`
- **GnosisRouter** (function, verified): `function sDAI() view returns (address)`
- **MarketView** (function, verified): `function getMarket(address marketFactory, address market) view returns ((address id, string marketName, string[] outcomes, (address id, string marketName, string[] outcomes, address[] wrappedTokens, bytes32 conditionId, bool payoutReported, uint256[] payoutNumerators) parentMarket, uint256 parentOutcome, address collateralToken, address[] wrappedTokens, uint256 outcomesSupply, uint256 lowerBound, uint256 upperBound, bytes32 parentCollectionId, address collateralToken1, address collateralToken2, bytes32 conditionId, bytes32 questionId, uint256 templateId, (bytes32 content_hash, address arbitrator, uint32 opening_ts, uint32 timeout, uint32 finalize_ts, bool is_pending_arbitration, uint256 bounty, bytes32 best_answer, bytes32 history_hash, uint256 bond, uint256 min_bond)[] questions, bytes32[] questionsIds, bytes32[] baseQuestionsIds, string[] encodedQuestions, bool payoutReported, uint256[] payoutNumerators))` — selector 0x714af34b; returned outcomes include 'Invalid result'; decoded live
- **MarketView** (function, UNVERIFIED): `function getMarkets(uint256 count, address marketFactory) view returns (MarketInfo[])` — selector 0x118cdf61 from artifact ABI (getMarkets(uint256,address)); return type assumed MarketInfo[] - not called
- **RealityETH_v3_0** (function, verified): `function askQuestionWithMinBond(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond) payable returns (bytes32)` — called by MarketFactory with nonce 0, value 0
- **RealityETH_v3_0** (function, verified): `function resultForOnceSettled(bytes32 question_id) view returns (bytes32)` — reverts on UNRESOLVED_ANSWER (0xff..fe) unless reopened replacement settled
- **RealityETH_v3_0** (function, verified): `function reopenQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond, bytes32 reopens_question_id) payable returns (bytes32)` — selector present in bytecode; params must match original exactly; Seer UI uses nonce 0 (sender differs so id differs)
- **RealityETH_v3_0** (function, verified): `function fundAnswerBounty(bytes32 question_id) payable` — only when question is open (after opening_ts, before finalization)
- **RealityETH_v3_0** (function, verified): `function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable`
- **RealityETH_v3_0** (function, verified): `function questions(bytes32) view returns (bytes32 content_hash, address arbitrator, uint32 opening_ts, uint32 timeout, uint32 finalize_ts, bool is_pending_arbitration, uint256 bounty, bytes32 best_answer, bytes32 history_hash, uint256 bond, uint256 min_bond)` — decoded live
- **RealityETH_v3_0** (function, verified): `function isFinalized(bytes32 question_id) view returns (bool)`
- **RealityETH_v3_0** (function, verified): `function isSettledTooSoon(bytes32 question_id) view returns (bool)`
- **RealityETH_v3_0** (event, verified): `event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)` — topic0 0xfe2dac156a3890636ce13f65f4fdf41dcaee11526e4a5374531572d92194796c seen in creation receipt
- **RealityETH_v3_0** (event, verified): `event LogMinimumBond(bytes32 indexed question_id, uint256 min_bond)` — topic0 0x9641ca9d53af3bead658ffcc6c7d8c35e7dae9938367bd8eb45bee35d5c62504
- **RealityETH_v3_0** (event, verified): `event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)` — from v3 source; topic not checked on-chain
- **RealityETH_v3_0** (event, verified): `event LogFinalize(bytes32 indexed question_id, bytes32 indexed answer)` — from v3 source
- **RealityETH_v3_0** (event, verified): `event LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id)` — from v3 source
- **ConditionalTokens** (event, verified): `event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount)` — topic0 0xab3760c3bd2bb38b5bcf54dc79802ed67338b4cf29f3054ded67ed24661e4177 seen in creation receipt
- **Wrapped1155Factory** (event, verified): `event Wrapped1155Creation(address indexed multiToken, uint256 indexed tokenId, address indexed wrappedToken)` — topic0 0x5cf3a4006b0dcb221517555192a3e5df5e19783c22ea769c1ef46dd421ae2d32; 3 per binary market
- **Wrapped1155Factory** (function, verified): `function requireWrapped1155(address multiToken, uint256 tokenId, bytes data) returns (address)` — from Seer Interfaces.sol; data = toString31(name)||toString31(symbol)||uint8(18)
- **Wrapped1155Factory** (function, verified): `function unwrap(address multiToken, uint256 tokenId, uint256 amount, address recipient, bytes data)`
- **KlerosRealitioForeignProxy (Ethereum)** (function, verified): `function requestArbitration(bytes32 questionID, uint256 maxPrevious) payable` — selector a829c3d1 present in 0xFe0eb5fC... bytecode; fee = getDisputeFee(bytes32) (0.1674 ETH at research time)
- **KlerosRealitioForeignProxy (Ethereum)** (function, verified): `function getDisputeFee(bytes32 questionID) view returns (uint256)`

## Facts

- [verified] Deployed MarketFactory/Market/RealityProxy/GnosisRouter/MarketView bytecode matches seer-pm/demo deployment artifacts (diffs only in immutable slots), and artifact-embedded sources equal repo HEAD sources (modulo whitespace; Interfaces.sol HEAD adds IERC20.symbol()). (source: cast code vs contracts/deployments/gnosis/*.json deployedBytecode + metadata.sources diff, repo commit 60423441)
- [verified] Market creation is permissionless (no access control in MarketFactory) and requires no msg.value; Reality arbitrator_question_fees for the Kleros proxy is 0. (source: MarketFactory.sol; cast call Reality.arbitrator_question_fees(0x68154e...)=0; live tx 0xe7a04b27... value 0 from EOA)
- [verified] A 2-outcome categorical market creation used 1,654,645 gas. (source: cast receipt 0xe7a04b2796922ea801669075ad15ed4e58f7b58e73278b6c4f292d9e592f3e3e)
- [verified] Reality question timeout for all Seer markets from this factory is fixed at 302400 s (3.5 days). (source: MarketFactory.questionTimeout(); Reality.questions(qid).timeout)
- [verified] Seer UI default minBond on Gnosis is 10 xDAI (parseUnits('10',18)); live market min_bond = 1e19. (source: web/src/lib/config.ts MIN_BOND; Reality.questions() on live question)
- [verified] Categorical encoded question = marketName + U+241F + '"o1","o2"' + U+241F + category + U+241F + lang; content_hash = keccak256(abi.encodePacked(uint256 templateId, uint32 openingTime, string encodedQuestion)). (source: MarketFactory.encodeRealityQuestionWithOutcomes/askRealityQuestion; reproduced live content hash 0xaf77f9a3...)
- [verified] Reality question_id from factory = keccak256(abi.encodePacked(content_hash, arbitrator, uint32 timeout, uint256 minBond, address realitio, address factory, uint256 0)); if it already exists the factory reuses it (no revert). (source: MarketFactory.askRealityQuestion)
- [verified] CTF questionId = keccak256(abi.encode(bytes32[] questionsIds, uint256 numOutcomes, uint256 templateId, uint256 lowerBound, uint256 upperBound)); conditionId = CTF.getConditionId(RealityProxy, questionId, numOutcomes+1). (source: MarketFactory.createNewMarketParams; reproduced live values with cast)
- [verified] Seer appends an extra INVALID outcome slot; its wrapped ERC20 is always named/symbol 'SER-INVALID' (18 decimals); MarketView reports its outcome label as 'Invalid result'. (source: MarketFactory.deployERC20Positions; cast name()/symbol() on live wrapped token 0x204a1691...; MarketView.getMarket output)
- [verified] Categorical resolution: answer==0xff..ff or answer>=numOutcomes => payouts[numOutcomes]=1 (only INVALID token redeems); else payouts[answer]=1. (source: RealityProxy.resolveCategoricalMarket)
- [verified] Answered-too-soon (0xff..fe) final answer makes Reality.resultForOnceSettled revert until reopenQuestion creates a replacement that finalizes with a non-0xff..fe answer; RealityProxy.resolve reverts meanwhile. (source: RealityETH-3.0.sol resultForOnceSettled/reopenQuestion; RealityProxy.resolve)
- [verified] Reality templates on Gnosis Reality v3: 0 bool, 1 uint(decimals 18), 2 single-select, 3 multiple-select, 4 datetime; template 2 has no description field (title, type, outcomes, category, lang only). (source: LogNewTemplate logs at block 17997262 on 0xE78996A2...)
- [verified] Kleros arbitration for Seer Gnosis markets is cross-chain: home proxy 0x68154EA6 on Gnosis, foreign proxy 0xFe0eb5fC on Ethereum, KlerosLiquid court 0, 31 jurors, dispute fee currently 0.1674 ETH paid on Ethereum. (source: cast calls on both proxies and KlerosLiquid.courts(0))
- [verified] The arbitrator's on-chain ToS (binding policy for jurors) is Seer's Markets Resolution Policy at ipfs QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf; the docs link a different file (QmW6npv4.../Seer - Markets Policy.pdf, different sha256). (source: HomeProxy.metadata(), ForeignProxy.termsOfService(); docs/app/create-a-market.mdx; downloaded both)
- [verified] Market Resolution Policy invalid cases: relative dates, moral questions, no valid answer, multiple valid answers in single-select, repeated answers, prohibited violence-incentivizing questions; 'Answered too soon' if answer unknown at first answer time; default UTC; objective interpretation; equal-interpretation ambiguity => invalid. (source: policy PDF QmPmRkXF...)
- [verified] Verification is optional Kleros Curate listing (LightGTCR 0x5aAF9E23...): base deposit 100 xDAI + arbitration cost 21.6 xDAI, challenge period 57600 s; Verified Markets Policy requires English, clarity, uncertainty at request time, sensible opening date, DD-MM-YYYY numeric dates, square images, specified sources expected to publish around opening date. (source: cast calls on LightGTCR; Verified Markets Policy PDF QmfGcodBz...)
- [high] Seer UI shows unverified markets with a warning (not hidden) and supports filtering by verification status (verified/verifying/challenged/not_verified). (source: docs/app/create-a-market.mdx; packages/seer-pm-sdk/src/market-types.ts, markets-fetch.ts)
- [verified] Liquidity for Gnosis Seer outcome tokens is provided on Swapr v3 (Algebra concentrated liquidity) pools outcomeToken/sDAI; UI redirects LPs to Swapr after minting via split. (source: docs/app/provide-liquidity.mdx; SDK pool-address.ts; cast checks of Algebra factory/poolDeployer/NFT manager)
- [high] There is no plain 'Router' deployment on Gnosis; GnosisRouter inherits Router and exposes splitPosition/mergePositions/redeemPositions plus xDAI variants. (source: contracts/deployments/gnosis listing; GnosisRouter.sol; docs deployed-contracts.mdx)
- [verified] The Market implementation contract 0x8F76... itself is uninitialized (initialized()=false), so anyone can initialize it; markets must be indexed only from MarketFactory NewMarket events / markets(). (source: cast call initialized() on implementation)
- [verified] Docs table lists FutarchyFactory at 0xe789e4A2... while deployments/gnosis/FutarchyFactory.json says 0xa6cb18fc...; irrelevant for binary markets but shows docs can lag. (source: docs/developers/contracts/deployed-contracts.mdx vs deployment JSON)

## Risks

- Invalid does not refund YES/NO holders. Under an invalid result, only SER-INVALID holders (or wallets holding complete sets) recover collateral. A sponsor who split collateral and sold YES/NO while keeping INVALID gets paid; LPs in YES/sDAI or NO/sDAI pools lose. The UI must disclose this, and our liquidity design must decide who holds the INVALID tokens.
- Answered too soon locks resolution. The market cannot resolve until someone calls Reality.reopenQuestion and the new question finalizes, which adds another 3.5-day timeout plus any arbitration. We need a keeper to reopen, and the UI needs a 'stuck' state.
- Question/JSON injection. MarketFactory pastes marketName, outcomes, category and lang into Reality's JSON template without escaping. An unescaped quote or a U+241F character can change the outcomes or title that Reality, jurors and UIs display, while CTF pays on the factory-side outcomes. The orchestrator must build the question off-chain with strict escaping and verify keccak(Market.encodedQuestions(0)) after creation.
- Shared state between duplicate markets. Identical (templateId, openingTime, encodedQuestion, minBond) produces the same Reality question, CTF condition and positions. A second Market clone with different tokenNames creates different ERC20 wrappers over the same ERC1155 positions. A front-runner or copycat can create look-alike Market addresses, so we must key our records on our own Market address plus conditionId and verify wrappedOutcome addresses.
- Fake markets. Market.initialize is public: the implementation is uninitialized and anyone can deploy look-alike contracts. Trust only addresses emitted in NewMarket by the official MarketFactory 0x83183DA8… (or present in factory.markets()), and never accept user-supplied market addresses without that check.
- Arbitration is expensive and cross-chain. A dispute costs about 0.17 ETH on Ethereum mainnet (court 0, 31 jurors) plus Reality bond escalation in xDAI on Gnosis. Customers and investigators must understand who funds escalation, and jurors judge under the Seer Markets Resolution Policy, not our policy file.
- The question has no description field. Template 2 carries only title, outcomes, category and lang, so the policy reference, commit hash and evidence rules must fit into marketName. Long technical titles may conflict with the Verified Markets Policy's clarity rule, and jurors must be able to fetch referenced documents. Curation rejection does not block trading, but it does leave an 'unverified' warning in the Seer UI.
- Policy compatibility. A question such as 'Was a reproducible counterexample submitted through mechanism X before T?' depends on an off-chain evidence system. Ambiguity about admissibility can trigger rule 19 of the resolution policy (no interpretation clearly more reasonable, so invalid), or answered-too-soon if adjudication is still pending at openingTime. openingTime must be set after the adjudication window, not at the evidence deadline.
- Low default minBond (10 xDAI) and no answer bounty (the factory passes value 0) may leave questions unanswered or answered cheaply. fundAnswerBounty only works after openingTime.
- Collateral is sDAI (ERC4626 shares), not xDAI. Amounts are in shares, and splitFromBase converts xDAI at the current share price. The SavingsXDaiAdapter and sDAI are external dependencies, and sDAI is not upgrade-reviewed here.
- Docs can lag deployments, as the FutarchyFactory address mismatch shows. Always pin addresses from deployment JSON and on-chain immutables, not from the docs table.

## Recommendations

- Create binary markets with createCategoricalMarket using outcomes ['Yes','No'] (index 0 = YES, 1 = NO, 2 = SER-INVALID), category 'misc', lang 'en_US', lowerBound/upperBound 0, parentMarket 0x0, parentOutcome 0, questionStart/questionEnd/outcomeType '', and tokenNames such as ['YES','NO'] (1–31 bytes, keep 11 or fewer for UI parity).
- From a Solidity orchestrator: (1) call MarketFactory.createCategoricalMarket and read the returned address. (2) Assert market.questionId(), conditionId() and keccak256(bytes(market.encodedQuestions(0))) against a commitment computed off-chain and passed in by the caller. (3) sDAI.approve(GnosisRouter), then GnosisRouter.splitPosition(sDAI, market, amount). (4) Add Swapr Algebra liquidity, which is a separate design covered by the pool-math researcher. Store market→claim/commit linkage in our own event.
- From a user's wallet: send the same calldata to MarketFactory (the SDK's getCreateMarketExecution produces it, value 0), then GnosisRouter.splitFromBase{value: xDAI}(market) or splitPosition with sDAI. Batch with EIP-5792/7702 where available.
- Escape strings exactly like the Seer SDK: escapeJson(s) = JSON.stringify(s) with the outer quotes stripped. Reject any input containing U+241F or control characters, and run the SDK's hasInjectedParameters() logic as a server-side gate before signing.
- Choose openingTime = evidence deadline + adjudication window + margin, as an absolute UTC timestamp written in the title. Write dates in the title as DD-MM-YYYY or as 'Month D, YYYY' to stay compatible with the Verified Markets Policy.
- Set minBond above the 10 xDAI UI default for high-value markets, and consider funding a Reality answer bounty after openingTime with fundAnswerBounty so that a timely answer happens.
- Index from NewMarket logs on MarketFactory 0x83183DA8… (topic0 0x109e5ac0…), filtered by our orchestrator's tx sender or our own event. Join with Reality LogNewAnswer, LogFinalize and LogReopenQuestion by questionsIds[0], and with CTF ConditionResolution by conditionId. Use MarketView.getMarket(factory, market) for snapshot reads and recovery.
- Run a keeper that calls Market.resolve() after finalization, and Reality.reopenQuestion(original params, nonce 0, base question id) when isSettledTooSoon is true.
- Treat Curate verification (about 121.6 xDAI deposit, refundable if unchallenged, 16-hour challenge window, images required) as an optional, separately costed step. Validate claim templates against the Verified Markets Policy before offering it.
- Put the policy document hash or CID and the commit hash in marketName, since Reality template 2 has no description field. Make sure the referenced documents stay durable (IPFS pinning) so that Reality answerers and Kleros jurors can retrieve them.

## Open questions

- Does the Seer subgraph (ID B4vyRqJaSHD8dRDb3BFRoAzuBK18c1QQcXq94JbxDxWH) record creator as tx.from or msg.sender? This matters when markets are created through our orchestrator contract. The subgraph mapping was not in the repo and was not checked.
- Will Seer or Kleros jurors accept technical counterexample questions whose resolution depends on an off-chain evidence and adjudication mechanism? It should be confirmed with Seer/Kleros before launch, possibly through a test Curate submission.
- The full text of the docs-linked 'Seer - Markets Policy.pdf' (QmW6npv4…) was not compared with the on-chain ToS PDF (QmPmRkXF…). The hashes differ, and only the on-chain one was read in full.
- The Kleros Gnosis court used by the Curate arbitrator (extraData court 19, 3 jurors) was not identified by name.
- Whether SavingsXDaiAdapter or sDAI on Gnosis have upgrade or admin risks was not reviewed here.
- The behaviour of QuestionsFactory 0x42cE29eA… (paginated creation) and ConditionalRouter beyond existence checks was not reviewed. Neither is needed for root binary markets.

## Detailed notes

# Seer on Gnosis (chainId 100): integration notes

## Sources and how they were verified
- Repo: github.com/seer-pm/demo, HEAD `60423441a71dd4eead5a026a4cff93fbd4c6f4f3` (2026-10-01). Cloned to `/tmp/claude-1000/-home-agentops-dev-pine/3bdbf7d8-eaa9-4ef4-bb24-f4ee398ebcc1/scratchpad/research/seer-demo`.
- Deployment artifacts: `contracts/deployments/gnosis/*.json` (hardhat-deploy; `.chainId` = 100).
- **Bytecode check.** `cast code` for MarketFactory, Market, RealityProxy, GnosisRouter and MarketView equals each artifact's `deployedBytecode`. Every differing nibble is at a position where the artifact has zeros (immutable slots); Market and MarketView match byte for byte.
- **Source check.** The `metadata.sources[*].content` embedded in the artifacts was diffed against repo HEAD `contracts/src/*.sol`. The only differences are a trailing newline, CRLF line endings, and one added `IERC20.symbol()` in HEAD `Interfaces.sol`. **The repo source is the deployed source.**
- Seer policy PDFs were downloaded from cdn.kleros.link IPFS. The resolution-policy CID was read from the arbitrator's on-chain `metadata()`.
- Reality.eth v3 source: `RealityETH/reality-eth-monorepo/packages/contracts/flat/RealityETH-3.0.sol`. Selectors were cross-checked in the bytecode at 0xE789…, and the template strings were read from on-chain `LogNewTemplate` logs.

## 1. Addresses (Gnosis, all checked with cast)
| Role | Address | Check |
|---|---|---|
| MarketFactory (sDAI) | `0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` | marketCount()=1600 |
| Market implementation (1167 clone target) | `0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a` | `factory.market()`; live markets are `363d3d37…8f76bc35…` minimal proxies |
| RealityProxy (CTF oracle) | `0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C` | `factory.realityProxy()` |
| GnosisRouter (Router + xDAI) | `0xeC9048b59b3467415b1a38F63416407eA0c70fB8` | `sDAI()`, `savingsXDaiAdapter()`=0xD499b51fcFc66bd31248ef4b28d656d67E591A94 |
| ConditionalRouter | `0x774284d5cDFeC3A0a0eBc7283aD4d5b33013c29c` | code only |
| ConditionalTokens | `0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce` | `factory.conditionalTokens()` |
| Wrapped1155Factory | `0xD194319D1804C1051DD21Ba1Dc931cA72410B79f` | `factory.wrapped1155Factory()` |
| MarketView | `0x010Bc82218C4857CBF5639B0046E0E05a678D8D4` | `getMarket()` decoded |
| Collateral sDAI | `0xaf204776c7245bF4147c2612BF6e5972Ee483701` | symbol sDAI, "Savings xDAI", asset WXDAI 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d |
| Reality.eth v3.0 | `0xE78996A233895bE74a66F451f1019cA9734205cc` | `factory.realitio()` |
| Arbitrator passed to Reality | `0x68154EA682f95BF582b80Dd6453FA401737491Dc` | Kleros RealitioHomeArbitrationProxy; foreignProxy 0xFe0eb5fC686f929Eb26D541D75Bb59F816c0Aa68 on Ethereum; AMB 0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59 |
| Ethereum KlerosLiquid | `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069` | court 0, 31 jurors, 0.0054 ETH per juror, dispute fee 0.1674 ETH |
| Verified-markets Curate (LightGTCR) | `0x5aAF9E23A11440F8C1Ad6D2E2e5109C7e52CC672` | deposit 100 xDAI + arbitration cost 21.6 xDAI; challenge period 57600 s; arbitrator 0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002 |
| Swapr v3 (Algebra) factory | `0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766` | `NFPM.factory()` |
| Algebra poolDeployer (CREATE2 origin) | `0xC1b576AC6Ec749d5Ace1787bF9Ec6340908ddB47` | init code hash `0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7` (from the SDK) |
| Algebra NonfungiblePositionManager | `0x91fd594c46d8b01e62dbdebed2401dde01817834` | "Algebra Positions NFT-V1" |

Gnosis has no standalone plain `Router` deployment; GnosisRouter *is* a Router. Seer has other Gnosis factories (CirclesMarketFactory 0x2e3937ce…, FutarchyFactory, QuestionsFactory 0x42cE29eA…), but they are not used for sDAI binary markets.

## 2. ABI (human-readable, works with viem `parseAbi` and Solidity interfaces)
```
struct CreateMarketParams { string marketName; string[] outcomes; string questionStart; string questionEnd; string outcomeType; uint256 parentOutcome; address parentMarket; string category; string lang; uint256 lowerBound; uint256 upperBound; uint256 minBond; uint32 openingTime; string[] tokenNames; }
function createCategoricalMarket(CreateMarketParams params) returns (address)       // 0x8770b180
function createMultiCategoricalMarket(CreateMarketParams params) returns (address)  // 0x3412a3f9
function createScalarMarket(CreateMarketParams params) returns (address)            // 0x7ca5cb3e
function createMultiScalarMarket(CreateMarketParams params) returns (address)       // 0xff08d88f
event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)
//   topic0 0x109e5ac06d4835cca9a97d9014f7bb1bfafb85a2de6d4af1ad22aa8730e12c87
function markets(uint256) view returns (address)
function allMarkets() view returns (address[])
function marketCount() view returns (uint256)
function market() view returns (address)
function arbitrator() view returns (address)
function realitio() view returns (address)
function conditionalTokens() view returns (address)
function collateralToken() view returns (address)
function realityProxy() view returns (address)
function wrapped1155Factory() view returns (address)
function questionTimeout() view returns (uint32)
```
There is no public generic `createMarket`; it is internal.

Market (clone):
```
function marketName() view returns (string)
function outcomes(uint256) view returns (string)        // excludes INVALID
function numOutcomes() view returns (uint256)           // excludes INVALID
function questionId() view returns (bytes32)            // CTF questionId
function questionsIds() view returns (bytes32[])        // Reality ids
function encodedQuestions(uint256) view returns (string)
function conditionId() view returns (bytes32)
function templateId() view returns (uint256)
function parentCollectionId() view returns (bytes32)
function parentMarket() view returns (address)
function parentOutcome() view returns (uint256)
function lowerBound() view returns (uint256)
function upperBound() view returns (uint256)
function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)
function parentWrappedOutcome() view returns (address wrapped1155, bytes data)
function realityProxy() view returns (address)
function initialized() view returns (bool)
function resolve()
```
RealityProxy: `function resolve(address market)` (0x55ea6c47).

GnosisRouter:
```
function splitPosition(address collateralToken, address market, uint256 amount)                          // 0xd5f82280
function mergePositions(address collateralToken, address market, uint256 amount)                         // 0x7abef8d1
function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts) // 0x865955a0
function splitFromBase(address market) payable                                                           // 0x50d9991c
function mergeToBase(address market, uint256 amount)                                                     // 0xd6d150d1
function redeemToBase(address market, uint256[] outcomeIndexes, uint256[] amounts)                       // 0x9fe603e8
function getTokenId(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (uint256)
function getWinningOutcomes(bytes32 conditionId) view returns (bool[])
function sDAI() view returns (address)
function savingsXDaiAdapter() view returns (address)
```
Router semantics:
- **splitPosition** pulls `amount` of collateral with transferFrom from msg.sender (approve first). It splits into all N+1 slots, wraps each slot through Wrapped1155Factory, and transfers every ERC20 to msg.sender.
- **merge** and **redeem** pull the wrapped ERC20s with transferFrom, so each outcome token, including SER-INVALID for merge, needs an approval.
- **xDAI variants** convert through the SavingsXDaiAdapter. The amounts are sDAI *shares*.

MarketView: `getMarket(address marketFactory, address market)`. The full tuple type is in the signatures list; it was decoded live. Its outcomes array includes "Invalid result", and it returns the Reality `questions[]`, `baseQuestionsIds`, `payoutReported` and `payoutNumerators`.

Reality v3 (used here): `askQuestionWithMinBond`, `resultForOnceSettled`, `reopenQuestion(uint256,string,address,uint32,uint32,uint256,uint256,bytes32)`, `fundAnswerBounty(bytes32) payable` (only while the question is open, i.e. after opening_ts), `submitAnswer(bytes32,bytes32,uint256) payable`, `questions(bytes32)`, `isFinalized`, `isSettledTooSoon`. Event topics seen in the creation receipt:
- LogNewQuestion `0xfe2dac15…796c`
- LogMinimumBond `0x9641ca9d…2504`
- CTF ConditionPreparation `0xab3760c3…4177`
- Wrapped1155Creation(address indexed multiToken, uint256 indexed tokenId, address indexed wrappedToken) `0x5cf3a400…2d32`, emitted once per outcome slot.

## 3. Question encoding (categorical / binary)
- Template ids are fixed constants in the factory: 1 uint (scalar), 2 single-select (categorical), 3 multiple-select.
- On-chain template 2: `{"title": "%s", "type": "single-select", "outcomes": [%s], "category": "%s", "lang": "%s"}`. There is **no description field**.
- `encodedQuestion = marketName ␟ "o1","o2" ␟ category ␟ lang`, where ␟ is U+241F (UTF-8 e2 90 9f). Live example: `Which party will win the Senate in 2026?␟"Democratic Party","Republican Party"␟misc␟en_US`.
- The SDK defaults are `category="misc"` and `lang="en_US"`. SDK categories are elections, politics, business, science, crypto, pop_culture, sports, doge, misc and weather.
- `content_hash = keccak256(abi.encodePacked(uint256 templateId, uint32 openingTime, string encodedQuestion))`. This was reproduced for a live question.
- `reality question_id = keccak256(abi.encodePacked(content_hash, arbitrator, uint32 questionTimeout, uint256 minBond, realitio, factory, uint256 0))`. If the id already exists, the factory reuses it.
- The factory calls `askQuestionWithMinBond(templateId, encodedQuestion, arbitrator, 302400, openingTime, 0, minBond)` with value 0, so there is no answer bounty.
- `questionTimeout` is an immutable 302400 s (3.5 days); you cannot choose it.
- `minBond` is free. The UI default on Gnosis is 10 xDAI (`web/src/lib/config.ts`), and bonds are paid in native xDAI. `openingTime` is the earliest time an answer can be submitted (Reality `stateOpen`).
- CTF:
  - `questionId = keccak256(abi.encode(questionsIds, numOutcomes, templateId, lowerBound, upperBound))`
  - `conditionId = getConditionId(RealityProxy, questionId, numOutcomes+1)`
  - Both were reproduced on-chain.
- **INVALID slot:** `outcomeSlotCount = outcomes.length + 1`. The last slot is wrapped as ERC20 with name and symbol "SER-INVALID" and 18 decimals. Other wrappers use `tokenNames[j]` for both name and symbol.
- Wrapper data is `toString31(name) ‖ toString31(symbol) ‖ uint8(18)`. The live 3-token market had wrappers at `0xAc33daea…`, `0xe8dFE4Cc…` and `0x204a1691…` (INVALID).

Constraints:
- **On-chain:**
  - categorical needs `outcomes.length >= 2`
  - `tokenNames.length >= outcomes.length`, each name non-empty and under 32 bytes; otherwise "Missing token name" / "string too long" / out-of-bounds revert
  - Reality requires `0 < timeout < 365 days`
  - there is no length cap on marketName
- **SDK/UI validation (off-chain only):**
  - non-empty name
  - at least 2 outcomes, none named "Invalid", no duplicates (case-insensitive)
  - token names of 11 characters or fewer and not duplicated
  - `generateTokenName` = uppercase alphanumerics and underscores, truncated to 11
- **Escaping:** the caller must escape. The SDK uses `escapeJson(s) = JSON.stringify(s).replace(/^"|"$/g,"")` on marketName, outcomes, category and question parts. The SDK's `hasInjectedParameters(templateId, encodedQuestion)` detects quotes or ␟ that rewrite the JSON (later duplicate keys win, so displayed outcomes can differ from the outcomes that pay).

## 4. Costs and permissions
- Creation is permissionless: no owner, no fee, value 0, and the arbitrator question fee is 0.
- Gas is about 1.65M for a 2-outcome categorical market (tx 0xe7a04b27…). Gnosis gas price was about 5k wei at research time, so this is negligible.
- Other costs live elsewhere:
  - collateral to split (sDAI)
  - AMM liquidity
  - Reality answer bonds (at least minBond, doubling on each challenge)
  - Kleros arbitration on Ethereum: currently 0.1674 ETH through the foreign proxy's `requestArbitration(bytes32,uint256) payable`, plus appeal funding (multipliers winner 3000, loser 7000, loserAppealPeriod 5000 basis points)
  - optional Curate verification: 100 xDAI base deposit + 21.6 xDAI arbitration cost, refunded if unchallenged

## 5. Policies (they can make a technical question invalid or unlisted)
**Arbitrator ToS (binding for Reality answerers and Kleros jurors):** Seer's Markets Resolution Policy, `ipfs://QmPmRkXFUmzP4rq2YfD3wNwL8bg3WDxkYuvTP9A9UZm9gJ/seer-markets-resolution-policy.pdf`.
- **Questions that resolve INVALID:**
  - relative dates
  - moral questions
  - no valid outcome
  - multiple valid outcomes in a single-select question (unless rule 20 applies)
  - repeated answers
  - questions that incentivize violence
- **Questions that resolve ANSWERED TOO SOON:** the answer was unknown when first given but is expected to become known later.
- **Default assumptions:** UTC with a 24h clock; MM/DD/YYYY when the format is ambiguous; "." as the decimal separator; event date = opening date when none is given; the most obvious entity; the usual units; rounding to the nearest value.
- **Interpretation rules:** objective reasonable-person reading, with the creator's motives ignored; grammar mistakes and incorrect assumptions are disregarded when the meaning is clear; the most credible sources decide; if interpretations differ and none is clearly more reasonable, the result is INVALID (rule 19).
- **Consequence for us:** the admissibility and "submitted through [mechanism]" criteria must be objective and publicly checkable by jurors, or rule 19 can produce INVALID. openingTime must fall after adjudication so the question is not answered too soon.

**Docs-linked copy:** the docs point to `QmW6npv4…/Seer - Markets Policy.pdf`, a different file (different sha256) that was not read in full. The on-chain ToS is the authoritative one.

**Verified Markets Policy** (`QmfGcodBzG53DBxS2Uxu5jug9YiHUpJ5tKFqhP6Z2HjscU`) is optional and governs Curate listing:
- English only, with no offensive content
- clear, with no grammar errors, wrong assumptions or ambiguity
- the answer must not be known with certainty when the listing is requested
- the market must not be expected or likely to resolve invalid
- numeric dates as DD-MM-YYYY, or the month spelled out with an unabbreviated year
- an opening date by which the answer will be known but not long after
- units given; "," as the thousand separator
- any named source must be expected to publish around the opening date
- square images for the market and its outcomes

Unverified markets still appear in the Seer UI, with a warning, and can be filtered by verification status.

## 6. Payout semantics (RealityProxy, categorical/binary)
```
answer = realitio.resultForOnceSettled(questionsIds[0])   // reverts if not finalized or settled-too-soon & not reopened
payouts = new uint[](numOutcomes+1)
if answer == 0xff..ff || answer >= numOutcomes: payouts[numOutcomes] = 1   // INVALID slot only
else payouts[answer] = 1
CTF.reportPayouts(questionId, payouts)   // one-shot
```
- In a binary market, YES (index 0) or NO (index 1) wins with payout 1. INVALID means only SER-INVALID redeems (1:1 sDAI); YES and NO become worthless.
- Holding a complete set (YES+NO+INVALID) always redeems or merges to full collateral.
- "Answered too soon" (0xff..fe) makes `resultForOnceSettled` revert ("Question was settled too soon and has not been reopened"). Anyone can call `Reality.reopenQuestion(templateId, encodedQuestion, arbitrator, timeout, opening_ts, nonce, min_bond, original_qid)`; the parameters must match exactly, and the Seer UI uses nonce 0 because the new sender makes the id unique. Once the replacement finalizes, `resolve()` works. Reality only follows the replacement chain one level down.
- For other market types: multi-categorical uses a bitmask, and all zeroes or 0xff..ff means INVALID. Scalar uses a linear split between bounds, and 0xff..ff means INVALID.

## 7. Liquidity (high level)
- Outcome ERC20s trade against sDAI on **Swapr v3 (Algebra concentrated liquidity)**.
- **LP flow in the UI:**
  1. Split collateral into YES/NO/INVALID (GnosisRouter).
  2. Click "Add liquidity", which goes to the Swapr site (v3.swapr.eth.limo).
  3. Set the initial price, pick a range or full range, and deposit both tokens of the outcome/sDAI pair.
  4. Optional farming goes through FarmingCenter `0xde51ddf1ae7d5bbd7bf1a0e40aaa1f6c12579106`; it is not verified with cast.
- **Pool addresses** come from CREATE2 with deployer 0xC1b576AC…, salt `keccak(abi.encode(token0, token1))`, and init hash 0xbce37a54…7e7.
- **Legacy:** LiquidityManager `0x031778c7…` adds V2 liquidity through Swapr V2 router `0x1b02dA8C…`. It is not the current UI path.
- Pool math is covered by another researcher.

## 8. Implementation sketch
**Off-chain (backend)**
1. Build the CreateMarketParams. Escape every string with escapeJson and reject U+241F.
2. Compute the commitments:
   - `expectedEncoded = name␟"Yes","No"␟misc␟en_US`
   - `contentHash`
   - `realityQid = keccak256(abi.encodePacked(contentHash, 0x68154EA6…, uint32(302400), minBond, 0xE78996A2…, 0x83183DA8…, uint256(0)))`
   - `ctfQuestionId = keccak256(abi.encode([realityQid], 2, 2, 0, 0))`
   - `conditionId = keccak256(abi.encodePacked(RealityProxy, ctfQuestionId, uint256(3)))`; this is the CTF getConditionId formula, which can also be checked with cast.

**Orchestrator (Solidity)**
```solidity
address m = IMarketFactory(F).createCategoricalMarket(p);
require(IMarket(m).conditionId() == expectedConditionId);
require(keccak256(bytes(IMarket(m).encodedQuestions(0))) == expectedEncodedHash);
IERC20(sDAI).approve(GNOSIS_ROUTER, amt);
IRouter(GNOSIS_ROUTER).splitPosition(sDAI, m, amt);   // YES, NO, SER-INVALID now held by the orchestrator
emit ClaimMarketCreated(claimHash, commit, m, conditionId, realityQid);
```
If the orchestrator calls CTF directly instead of going through the Router, it must implement ERC1155Receiver.

**Indexer**
- Read `NewMarket` from the factory (fromBlock 36404701, the factory deployment block) and only trust those markets.
- Join with Reality events by `questionsIds[0]` and with CTF `ConditionResolution` by conditionId.
- Use `MarketView.getMarket` for reconciliation.

**Keeper**
- Call `Market.resolve()` once `Reality.isFinalized(qid)` is true.
- Call `reopenQuestion` when `isSettledTooSoon` is true.
- Optionally call `fundAnswerBounty` after openingTime.

Useful cast checks:
```
cast call 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1 "marketCount()(uint256)" --rpc-url https://rpc.gnosischain.com
cast call <market> "encodedQuestions(uint256)(string)" 0 --rpc-url ...
cast call 0xE78996A233895bE74a66F451f1019cA9734205cc "questions(bytes32)(bytes32,address,uint32,uint32,uint32,bool,uint256,bytes32,bytes32,uint256,uint256)" <qid> --rpc-url ...
```
Subgraph IDs (from the docs, not verified against the gateway): Seer `B4vyRqJaSHD8dRDb3BFRoAzuBK18c1QQcXq94JbxDxWH`, Curate `2hP3hyWreJSK8uvYwC4WMKi2qFXbPcnp7pCx7EzW24sp`, Swapr Algebra `AAA1vYjxwFHzbt6qKwLHNcDSASyr1J1xVViDH8gTMFMR`.

Scratch files (deployed-source extracts and PDFs) are in `/tmp/claude-1000/-home-agentops-dev-pine/3bdbf7d8-eaa9-4ef4-bb24-f4ee398ebcc1/scratchpad/research/`.
