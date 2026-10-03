// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run
// the script (CI runs it with --check).
// FROZEN. Human-readable ABIs of the external protocols, transcribed from verified source:
//   Seer: seer-pm/demo contracts/src (MarketFactory.sol, Market.sol, Router.sol, GnosisRouter.sol, RealityProxy.sol)
//   Reality.eth v3: RealityETH-3.0.sol
//   Conditional Tokens: gnosis/conditional-tokens-contracts ConditionalTokens.sol
//   Kleros home proxy (Gnosis): RealitioHomeArbitrationProxy (kleros/cross-chain-realitio-proxy)
// Event signatures here are what the indexers decode; a mismatch silently drops events, so the indexer lanes must
// verify topic0 values against real logs in their tests (fixtures captured from Gnosis).

import { parseAbi } from "viem";

export const seerMarketFactoryAbi = parseAbi([
  "struct CreateMarketParams { string marketName; string[] outcomes; string questionStart; string questionEnd; string outcomeType; uint256 parentOutcome; address parentMarket; string category; string lang; uint256 lowerBound; uint256 upperBound; uint256 minBond; uint32 openingTime; string[] tokenNames; }",
  "function createCategoricalMarket(CreateMarketParams params) returns (address)",
  "function questionTimeout() view returns (uint32)",
  "function arbitrator() view returns (address)",
  "function realitio() view returns (address)",
  "function conditionalTokens() view returns (address)",
  "function collateralToken() view returns (address)",
  "function realityProxy() view returns (address)",
  "function wrapped1155Factory() view returns (address)",
  "function market() view returns (address)",
  "event NewMarket(address indexed market, string marketName, address parentMarket, bytes32 conditionId, bytes32 questionId, bytes32[] questionsIds)",
]);

export const seerMarketAbi = parseAbi([
  "function marketName() view returns (string)",
  "function outcomes(uint256 index) view returns (string)",
  "function templateId() view returns (uint256)",
  "function questionsIds() view returns (bytes32[])",
  "function encodedQuestions(uint256 index) view returns (string)",
  "function questionId() view returns (bytes32)",
  "function conditionId() view returns (bytes32)",
  "function parentCollectionId() view returns (bytes32)",
  "function parentMarket() view returns (address)",
  "function numOutcomes() view returns (uint256)",
  "function wrappedOutcome(uint256 index) view returns (address wrapped1155, bytes data)",
  "function resolve()",
]);

export const seerRouterAbi = parseAbi([
  "function splitPosition(address collateralToken, address market, uint256 amount)",
  "function mergePositions(address collateralToken, address market, uint256 amount)",
  "function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)",
  "function getWinningOutcomes(bytes32 conditionId) view returns (bool[])",
]);

export const seerGnosisRouterAbi = parseAbi([
  "function splitFromBase(address market) payable",
  "function mergeToBase(address market, uint256 amount)",
  "function redeemToBase(address market, uint256[] outcomeIndexes, uint256[] amounts)",
  "function splitPosition(address collateralToken, address market, uint256 amount)",
  "function mergePositions(address collateralToken, address market, uint256 amount)",
  "function redeemPositions(address collateralToken, address market, uint256[] outcomeIndexes, uint256[] amounts)",
]);

export const seerRealityProxyAbi = parseAbi(["function resolve(address market)"]);

export const realityV3Abi = parseAbi([
  "function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable",
  "function submitAnswerCommitment(bytes32 question_id, bytes32 answer_hash, uint256 max_previous, address _answerer) payable",
  "function submitAnswerReveal(bytes32 question_id, bytes32 answer, uint256 nonce, uint256 bond)",
  "function fundAnswerBounty(bytes32 question_id) payable",
  "function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)",
  "function withdraw()",
  "function balanceOf(address) view returns (uint256)",
  "function getFinalizeTS(bytes32 question_id) view returns (uint32)",
  "function getOpeningTS(bytes32 question_id) view returns (uint32)",
  "function getTimeout(bytes32 question_id) view returns (uint32)",
  "function getBond(bytes32 question_id) view returns (uint256)",
  "function getMinBond(bytes32 question_id) view returns (uint256)",
  "function getBestAnswer(bytes32 question_id) view returns (bytes32)",
  "function getHistoryHash(bytes32 question_id) view returns (bytes32)",
  "function getBounty(bytes32 question_id) view returns (uint256)",
  "function getArbitrator(bytes32 question_id) view returns (address)",
  "function isFinalized(bytes32 question_id) view returns (bool)",
  "function isPendingArbitration(bytes32 question_id) view returns (bool)",
  "function isSettledTooSoon(bytes32 question_id) view returns (bool)",
  "function resultFor(bytes32 question_id) view returns (bytes32)",
  "function resultForOnceSettled(bytes32 question_id) view returns (bytes32)",
  "function reopenQuestion(uint256 template_id, string question, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 min_bond, bytes32 reopens_question_id) payable returns (bytes32)",
  "function reopened_questions(bytes32 question_id) view returns (bytes32)",
  "event LogNewQuestion(bytes32 indexed question_id, address indexed user, uint256 template_id, string question, bytes32 indexed content_hash, address arbitrator, uint32 timeout, uint32 opening_ts, uint256 nonce, uint256 created)",
  "event LogMinimumBond(bytes32 indexed question_id, uint256 min_bond)",
  "event LogFundAnswerBounty(bytes32 indexed question_id, uint256 bounty_added, uint256 bounty, address indexed user)",
  "event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)",
  "event LogAnswerReveal(bytes32 indexed question_id, address indexed user, bytes32 indexed answer_hash, bytes32 answer, uint256 nonce, uint256 bond)",
  "event LogNotifyOfArbitrationRequest(bytes32 indexed question_id, address indexed user)",
  "event LogCancelArbitration(bytes32 indexed question_id)",
  "event LogFinalize(bytes32 indexed question_id, bytes32 indexed answer)",
  "event LogClaim(bytes32 indexed question_id, address indexed user, uint256 amount)",
  "event LogReopenQuestion(bytes32 indexed question_id, bytes32 indexed reopened_question_id)",
]);

export const conditionalTokensAbi = parseAbi([
  "function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
  "function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
  "event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount)",
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
  "event PositionSplit(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)",
  "event PositionsMerge(address indexed stakeholder, address collateralToken, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256 amount)",
  "event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)",
]);

/** Kleros RealitioHomeArbitrationProxy on Gnosis: arbitration lifecycle as seen on the home chain. */
export const klerosHomeProxyAbi = parseAbi([
  // Permissionless relay steps (selectors verified in deployed bytecode 2026-10-02).
  "function handleNotifiedRequest(bytes32 _questionID, address _requester)",
  "function handleRejectedRequest(bytes32 _questionID, address _requester)",
  "function reportArbitrationAnswer(bytes32 _questionID, bytes32 _lastHistoryHash, bytes32 _lastAnswerOrCommitmentID, address _lastAnswerer)",
  "event RequestNotified(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious)",
  "event RequestRejected(bytes32 indexed _questionID, address indexed _requester, uint256 _maxPrevious, string _reason)",
  "event RequestAcknowledged(bytes32 indexed _questionID, address indexed _requester)",
  "event RequestCanceled(bytes32 indexed _questionID, address indexed _requester)",
  "event ArbitrationFailed(bytes32 indexed _questionID, address indexed _requester)",
  "event ArbitratorAnswered(bytes32 indexed _questionID, bytes32 _answer)",
  "event ArbitrationFinished(bytes32 indexed _questionID)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
