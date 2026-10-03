// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";
import {ISeerMarket, ISeerMarketFactory} from "./interfaces/external/ISeer.sol";
import {QuestionText} from "./libraries/QuestionText.sol";

/// @title ClaimRegistry
/// @notice Immutable, ownerless registry: validates claim parameters, composes the market question on-chain, creates the
/// Seer categorical Yes/No market and records the claim in one transaction (docs/prd/PRD-01-chain.md section 2).
/// @dev No owner, pause, upgrade path or configurable state (SEC-SC-01, SEC-SC-02). Never holds or forwards tokens or
/// native value: Seer's createCategoricalMarket asks the Reality question with value 0 and mints nothing.
contract ClaimRegistry is IClaimRegistry, ReentrancyGuardTransient {
    /// @notice Seer MarketFactory immutables the deployer expects; the constructor refuses any mismatch.
    struct ExpectedSeer {
        address realitio;
        address arbitrator;
        address realityProxy;
        address conditionalTokens;
        address wrapped1155Factory;
        address collateralToken;
        uint32 questionTimeout;
    }

    error NoCode(address account);
    error EvidenceRegistryNotBound(address boundClaimRegistry);
    error SeerConfigMismatch(string getter);
    error InvalidMinimumMinBond(uint256 minimumMinBond);
    /// @notice repositoryId above 2^53 - 1: the TypeScript decoders accept only safe integers (0 reverts ZeroValue).
    error RepositoryIdOutOfRange(uint64 repositoryId);

    uint64 public constant MIN_EVIDENCE_WINDOW = 1 days;
    uint64 public constant MAX_EVIDENCE_WINDOW = 90 days;
    uint64 public constant MIN_REVEAL_WINDOW = 12 hours;
    uint64 public constant MAX_REVEAL_WINDOW = 7 days;
    uint256 public constant MAX_TITLE_BYTES = 120;
    uint256 public constant MAX_MIN_BOND = 10_000 ether;

    /// Seer's Reality template for categorical (single-select) markets.
    uint256 private constant CATEGORICAL_TEMPLATE_ID = 2;
    /// Largest repositoryId accepted: Number.MAX_SAFE_INTEGER, so every recorded value fits the TypeScript decoders.
    uint64 private constant MAX_REPOSITORY_ID = 2 ** 53 - 1;

    address public immutable seerMarketFactory;
    address public immutable evidenceRegistry;
    uint256 public immutable minimumMinBond;
    /// @notice block.chainid at deployment (informational; the question names Gnosis).
    uint256 public immutable deploymentChainId;

    mapping(address market => Claim) private _claims;
    mapping(address creator => mapping(bytes32 claimDocumentSha256 => address market)) private _marketOf;
    uint256 private _claimCount;

    constructor(
        address seerMarketFactory_,
        address evidenceRegistry_,
        uint256 minimumMinBond_,
        ExpectedSeer memory expected
    ) {
        if (seerMarketFactory_.code.length == 0) revert NoCode(seerMarketFactory_);
        if (evidenceRegistry_.code.length == 0) revert NoCode(evidenceRegistry_);
        address bound = IEvidenceRegistry(evidenceRegistry_).claimRegistry();
        if (bound != address(this)) revert EvidenceRegistryNotBound(bound);
        _checkSeer(ISeerMarketFactory(seerMarketFactory_), expected);
        if (minimumMinBond_ == 0 || minimumMinBond_ > MAX_MIN_BOND) revert InvalidMinimumMinBond(minimumMinBond_);

        seerMarketFactory = seerMarketFactory_;
        evidenceRegistry = evidenceRegistry_;
        minimumMinBond = minimumMinBond_;
        deploymentChainId = block.chainid;
    }

    /// @inheritdoc IClaimRegistry
    function createClaim(CreateClaimParams calldata params) external nonReentrant returns (address market) {
        _validate(params);
        address existing = _marketOf[msg.sender][params.claimDocumentSha256];
        if (existing != address(0)) revert DuplicateClaim(existing);

        string memory marketName = QuestionText.composeQuestion(evidenceRegistry, params);
        market = ISeerMarketFactory(seerMarketFactory).createCategoricalMarket(_marketParams(marketName, params));

        Claim memory claim = _readMarket(market, marketName);
        claim.creator = msg.sender;
        claim.createdAt = SafeCast.toUint64(block.timestamp);
        claim.evidenceDeadline = params.evidenceDeadline;
        claim.revealDeadline = params.revealDeadline;
        claim.repositoryId = params.repositoryId;
        claim.commit = params.commit;
        claim.claimDocumentSha256 = params.claimDocumentSha256;
        claim.policyDocumentSha256 = params.policyDocumentSha256;
        claim.minBond = params.minBond;

        _claims[market] = claim;
        _marketOf[msg.sender][params.claimDocumentSha256] = market;
        ++_claimCount;
        emit ClaimCreated(market, msg.sender, params.claimDocumentSha256, claim, params.title, marketName);
    }

    /// @inheritdoc IClaimRegistry
    function renderQuestion(CreateClaimParams calldata params) external view returns (string memory) {
        _validate(params);
        return QuestionText.composeQuestion(evidenceRegistry, params);
    }

    /// @inheritdoc IClaimRegistry
    function getClaim(address market) external view returns (Claim memory claim) {
        claim = _claims[market];
        if (claim.creator == address(0)) revert UnknownMarket(market);
    }

    /// @inheritdoc IClaimRegistry
    function isRegistered(address market) external view returns (bool) {
        return _claims[market].creator != address(0);
    }

    /// @inheritdoc IClaimRegistry
    function marketOf(address creator, bytes32 claimDocumentSha256) external view returns (address) {
        return _marketOf[creator][claimDocumentSha256];
    }

    /// @inheritdoc IClaimRegistry
    function claimCount() external view returns (uint256) {
        return _claimCount;
    }

    function _checkSeer(ISeerMarketFactory factory, ExpectedSeer memory expected) private view {
        if (factory.realitio() != expected.realitio) revert SeerConfigMismatch("realitio");
        if (factory.arbitrator() != expected.arbitrator) revert SeerConfigMismatch("arbitrator");
        if (factory.realityProxy() != expected.realityProxy) revert SeerConfigMismatch("realityProxy");
        if (factory.conditionalTokens() != expected.conditionalTokens) revert SeerConfigMismatch("conditionalTokens");
        if (factory.wrapped1155Factory() != expected.wrapped1155Factory) {
            revert SeerConfigMismatch("wrapped1155Factory");
        }
        if (factory.collateralToken() != expected.collateralToken) revert SeerConfigMismatch("collateralToken");
        if (factory.questionTimeout() != expected.questionTimeout) revert SeerConfigMismatch("questionTimeout");
    }

    /// @dev Full parameter validation shared by createClaim and renderQuestion (SEC-SC-07, SEC-CLAIM-05, SEC-SC-18).
    function _validate(CreateClaimParams calldata params) private view {
        if (
            params.claimDocumentSha256 == bytes32(0) || params.policyDocumentSha256 == bytes32(0)
                || params.repositoryId == 0 || params.commit == bytes20(0)
        ) revert ZeroValue();
        if (params.repositoryId > MAX_REPOSITORY_ID) revert RepositoryIdOutOfRange(params.repositoryId);

        uint64 now64 = SafeCast.toUint64(block.timestamp);
        uint64 evidenceEarliest = now64 + MIN_EVIDENCE_WINDOW;
        uint64 evidenceLatest = now64 + MAX_EVIDENCE_WINDOW;
        if (params.evidenceDeadline < evidenceEarliest || params.evidenceDeadline > evidenceLatest) {
            revert EvidenceDeadlineOutOfRange(params.evidenceDeadline, evidenceEarliest, evidenceLatest);
        }

        // evidenceDeadline <= block.timestamp + 90 days here, so neither sum can overflow uint64.
        uint64 revealEarliest = params.evidenceDeadline + MIN_REVEAL_WINDOW;
        uint64 revealLatest = params.evidenceDeadline + MAX_REVEAL_WINDOW;
        if (revealLatest > type(uint32).max) revealLatest = type(uint32).max;
        // When revealEarliest > revealLatest (evidence deadline within 12 h of 2^32 - 1) every value is rejected.
        if (params.revealDeadline < revealEarliest || params.revealDeadline > revealLatest) {
            revert RevealDeadlineOutOfRange(params.revealDeadline, revealEarliest, revealLatest);
        }

        if (params.minBond < minimumMinBond) revert MinBondTooLow(params.minBond, minimumMinBond);
        if (params.minBond > MAX_MIN_BOND) revert MinBondTooHigh(params.minBond, MAX_MIN_BOND);

        bytes calldata title = bytes(params.title);
        if (title.length == 0 || title.length > MAX_TITLE_BYTES) revert TitleLength(title.length);
        for (uint256 i = 0; i < title.length; ++i) {
            bytes1 b = title[i];
            // '[' and ']' are refused so a title can never close the "Pine claim [<title>]" delimiter.
            if (b < 0x20 || b > 0x7e || b == 0x22 || b == 0x5c || b == 0x5b || b == 0x5d) revert TitleForbiddenByte(i);
        }
    }

    function _marketParams(string memory marketName, CreateClaimParams calldata params)
        private
        pure
        returns (ISeerMarketFactory.CreateMarketParams memory p)
    {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        string[] memory names = new string[](2);
        (names[0], names[1]) = QuestionText.tokenNames(params.claimDocumentSha256);

        p.marketName = marketName;
        p.outcomes = outcomes;
        // questionStart, questionEnd, outcomeType: empty; parentOutcome, parentMarket, lowerBound, upperBound: zero.
        p.category = "misc";
        p.lang = "en_US";
        p.minBond = params.minBond;
        p.openingTime = SafeCast.toUint32(params.revealDeadline);
        p.tokenNames = names;
    }

    /// @dev Verifies the market Seer returned has the expected shape and reads the ids and tokens into a new Claim.
    function _readMarket(address market, string memory marketName) private view returns (Claim memory claim) {
        if (market.code.length == 0 || _claims[market].creator != address(0)) revert UnexpectedMarketShape(market);
        ISeerMarket m = ISeerMarket(market);
        if (m.templateId() != CATEGORICAL_TEMPLATE_ID || m.numOutcomes() != 2) revert UnexpectedMarketShape(market);
        bytes32[] memory questionsIds = m.questionsIds();
        if (questionsIds.length != 1) revert UnexpectedMarketShape(market);

        bytes32 marketNameHash = keccak256(bytes(marketName));
        if (
            keccak256(bytes(m.marketName())) != marketNameHash
                || keccak256(bytes(m.encodedQuestions(0))) != keccak256(bytes(QuestionText.encodedQuestion(marketName)))
        ) revert UnexpectedMarketShape(market);

        claim.questionId = questionsIds[0];
        claim.conditionId = m.conditionId();
        claim.marketNameHash = marketNameHash;
        (claim.yesToken,) = m.wrappedOutcome(0);
        (claim.noToken,) = m.wrappedOutcome(1);
        (claim.invalidToken,) = m.wrappedOutcome(2);
        if (
            claim.questionId == bytes32(0) || claim.conditionId == bytes32(0) || claim.yesToken == address(0)
                || claim.noToken == address(0) || claim.invalidToken == address(0)
        ) revert UnexpectedMarketShape(market);
    }
}
