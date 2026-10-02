// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice FROZEN. Minimal interfaces of the deployed Seer contracts (seer-pm/demo, contracts/src, solc 0.8.20),
/// transcribed from source. Only what the registry calls or tests read.

interface ISeerMarketFactory {
    struct CreateMarketParams {
        string marketName;
        string[] outcomes;
        string questionStart;
        string questionEnd;
        string outcomeType;
        uint256 parentOutcome;
        address parentMarket;
        string category;
        string lang;
        uint256 lowerBound;
        uint256 upperBound;
        uint256 minBond;
        uint32 openingTime;
        string[] tokenNames;
    }

    event NewMarket(
        address indexed market,
        string marketName,
        address parentMarket,
        bytes32 conditionId,
        bytes32 questionId,
        bytes32[] questionsIds
    );

    /// @dev Permissionless. Asks (or reuses an identical existing) Reality.eth question with template 2 and
    /// encoded question `marketName <U+241F> "o1","o2" <U+241F> category <U+241F> lang`, prepares (or reuses) the CTF condition with
    /// outcomes.length + 1 slots (last slot = invalid), deploys (or reuses) the wrapped ERC20 outcome tokens and
    /// clones a new Market. Each tokenNames entry must be 1..31 bytes.
    function createCategoricalMarket(CreateMarketParams calldata params) external returns (address);

    function questionTimeout() external view returns (uint32);
    function arbitrator() external view returns (address);
    function realitio() external view returns (address);
    function conditionalTokens() external view returns (address);
    function collateralToken() external view returns (address);
    function realityProxy() external view returns (address);
    function wrapped1155Factory() external view returns (address);
    function market() external view returns (address);
}

interface ISeerMarket {
    function marketName() external view returns (string memory);
    function outcomes(uint256 index) external view returns (string memory);
    function templateId() external view returns (uint256);
    function questionsIds() external view returns (bytes32[] memory);
    function encodedQuestions(uint256 index) external view returns (string memory);
    function questionId() external view returns (bytes32);
    function conditionId() external view returns (bytes32);
    function parentCollectionId() external view returns (bytes32);
    function parentMarket() external view returns (address);
    function numOutcomes() external view returns (uint256);
    function wrappedOutcome(uint256 index) external view returns (address wrapped1155, bytes memory data);
    function resolve() external;
}
