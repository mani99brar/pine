// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ISeerMarketFactory} from "../../../src/interfaces/external/ISeer.sol";
import {ClaimRegistry} from "../../../src/ClaimRegistry.sol";

/// @notice Fields of a mock market, possibly malformed on purpose.
struct CRMarketFields {
    string name;
    string encoded;
    uint256 templateId;
    uint256 numOutcomes;
    bytes32 conditionId;
    bytes32[] questionsIds;
    address[3] tokens;
}

/// @notice Seer Market stand-in exposing the getters ClaimRegistry reads. The factory writes every field.
contract CRMockSeerMarket {
    string public marketName;
    uint256 public templateId;
    uint256 public numOutcomes;
    bytes32 public conditionId;
    bytes32[] internal _questionsIds;
    string internal _encodedQuestion;
    address[3] internal _wrapped;

    function init(CRMarketFields memory f) external {
        marketName = f.name;
        templateId = f.templateId;
        numOutcomes = f.numOutcomes;
        conditionId = f.conditionId;
        _questionsIds = f.questionsIds;
        _encodedQuestion = f.encoded;
        _wrapped = f.tokens;
    }

    function questionsIds() external view returns (bytes32[] memory) {
        return _questionsIds;
    }

    function encodedQuestions(uint256 index) external view returns (string memory) {
        require(index < _questionsIds.length, "index");
        return _encodedQuestion;
    }

    function wrappedOutcome(uint256 index) external view returns (address wrapped1155, bytes memory data) {
        return (_wrapped[index], "");
    }
}

/// @notice Seer MarketFactory stand-in. Encodes the question exactly like Seer (`name ␟ "o1","o2" ␟ category ␟ lang`),
/// derives question/condition/token ids deterministically from the creation parameters (so identical parameters share
/// them, like the real factory), records the parameters it received, and can return malformed markets.
contract CRMockSeerFactory {
    enum Mode {
        Normal,
        Template3,
        ThreeOutcomes,
        TwoQuestions,
        WrongName,
        WrongEncodedQuestion,
        ZeroQuestionId,
        ZeroConditionId,
        ZeroToken,
        ReturnNoCode,
        ReturnPrevious
    }

    string internal constant SEPARATOR = hex"e2909f";

    address public realitio;
    address public arbitrator;
    address public realityProxy;
    address public conditionalTokens;
    address public wrapped1155Factory;
    address public collateralToken;
    uint32 public questionTimeout;
    address public market = address(0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a);

    Mode public mode;
    uint256 public createCount;
    bytes32 public lastParamsHash;
    string public lastMarketName;
    address public lastMarket;

    constructor(ClaimRegistry.ExpectedSeer memory config) {
        realitio = config.realitio;
        arbitrator = config.arbitrator;
        realityProxy = config.realityProxy;
        conditionalTokens = config.conditionalTokens;
        wrapped1155Factory = config.wrapped1155Factory;
        collateralToken = config.collateralToken;
        questionTimeout = config.questionTimeout;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function createCategoricalMarket(ISeerMarketFactory.CreateMarketParams memory params)
        external
        virtual
        returns (address)
    {
        ++createCount;
        lastParamsHash = keccak256(abi.encode(params));
        lastMarketName = params.marketName;

        if (mode == Mode.ReturnNoCode) return address(0xdead);
        if (mode == Mode.ReturnPrevious) return lastMarket;

        address created = _deployMarket(params);
        lastMarket = created;
        return created;
    }

    function _deployMarket(ISeerMarketFactory.CreateMarketParams memory params) internal returns (address) {
        CRMarketFields memory f;
        f.name = params.marketName;
        f.encoded = encodeQuestion(params.marketName, params.outcomes, params.category, params.lang);
        bytes32 questionId;
        (questionId, f.conditionId, f.tokens) = idsFor(params);
        f.numOutcomes = params.outcomes.length;
        f.questionsIds = new bytes32[](mode == Mode.TwoQuestions ? 2 : 1);
        f.questionsIds[0] = questionId;
        f.templateId = 2;

        if (mode == Mode.Template3) f.templateId = 3;
        else if (mode == Mode.ThreeOutcomes) f.numOutcomes = 3;
        else if (mode == Mode.TwoQuestions) f.questionsIds[1] = questionId;
        else if (mode == Mode.WrongName) f.name = string.concat(f.name, " ");
        else if (mode == Mode.WrongEncodedQuestion) f.encoded = _swappedOutcomes(params);
        else if (mode == Mode.ZeroQuestionId) f.questionsIds[0] = bytes32(0);
        else if (mode == Mode.ZeroConditionId) f.conditionId = bytes32(0);
        else if (mode == Mode.ZeroToken) f.tokens[1] = address(0);

        CRMockSeerMarket m = new CRMockSeerMarket();
        m.init(f);
        return address(m);
    }

    function _swappedOutcomes(ISeerMarketFactory.CreateMarketParams memory params)
        internal
        pure
        returns (string memory)
    {
        string[] memory swapped = new string[](2);
        swapped[0] = "No";
        swapped[1] = "Yes";
        return encodeQuestion(params.marketName, swapped, params.category, params.lang);
    }

    function encodeQuestion(string memory name, string[] memory outcomes, string memory category, string memory lang)
        internal
        pure
        returns (string memory)
    {
        string memory joined;
        for (uint256 i = 0; i < outcomes.length; ++i) {
            joined = string.concat(joined, i == 0 ? "" : ",", '"', outcomes[i], '"');
        }
        return
            string.concat(string.concat(name, SEPARATOR, joined), string.concat(SEPARATOR, category, SEPARATOR, lang));
    }

    /// @notice Deterministic ids: shared by any two markets created with the same question, bond, opening time and token names.
    function idsFor(ISeerMarketFactory.CreateMarketParams memory params)
        public
        pure
        returns (bytes32 questionId, bytes32 conditionId, address[3] memory tokens)
    {
        string memory encoded = encodeQuestion(params.marketName, params.outcomes, params.category, params.lang);
        questionId = keccak256(abi.encode("question", encoded, params.minBond, params.openingTime));
        conditionId = keccak256(abi.encode("condition", questionId, params.outcomes.length + 1));
        for (uint256 i = 0; i < 3; ++i) {
            string memory tokenName = i < 2 ? params.tokenNames[i] : "SER-INVALID";
            tokens[i] = address(uint160(uint256(keccak256(abi.encode("token", conditionId, i, tokenName)))));
        }
    }
}

/// @notice A factory that re-enters ClaimRegistry.createClaim from inside createCategoricalMarket and bubbles the revert.
contract CRReentrantSeerFactory is CRMockSeerFactory {
    bytes public reentryCalldata;

    constructor(ClaimRegistry.ExpectedSeer memory config) CRMockSeerFactory(config) {}

    function setReentryCalldata(bytes calldata data) external {
        reentryCalldata = data;
    }

    function createCategoricalMarket(ISeerMarketFactory.CreateMarketParams memory params)
        external
        override
        returns (address)
    {
        (bool ok, bytes memory ret) = msg.sender.call(reentryCalldata);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        // Unreachable when the guard works; returning keeps the mock well-formed.
        params;
        return abi.decode(ret, (address));
    }
}
