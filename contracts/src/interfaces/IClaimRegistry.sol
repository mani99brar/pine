// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IClaimRegistry
/// @notice FROZEN interface. Creates a Seer categorical Yes/No market for a verification claim and records an immutable
/// link between the market and the claim's content-addressed documents, in one transaction.
/// @dev There is no owner, no pause and no upgrade path. All configuration is immutable and set at deployment.
/// The registry cannot verify off-chain documents: it records what the creator asserts. Indexers and the API must
/// verify that `marketName` equals the canonical rendering of the claim document whose SHA-256 is recorded, and
/// treat any mismatch as a non-canonical claim.
interface IClaimRegistry {
    /// @param claimDocumentSha256 SHA-256 of the RFC 8785 canonical claim document bytes.
    /// @param policyDocumentSha256 SHA-256 of the exact policy text bytes the claim is bound to.
    /// @param repositoryCommit Git object id of the target commit; a 20-byte SHA-1 id is left-aligned (bytes32(bytes20)).
    /// @param evidenceDeadline Unix seconds. Evidence commitments count only if recorded at block.timestamp < evidenceDeadline.
    /// @param revealDeadline Unix seconds. Reveals count only if recorded at block.timestamp < revealDeadline. Also the
    /// Reality.eth opening time: no answer can be given before every timely commitment could have been revealed.
    /// @param minBond Reality.eth minimum bond for the question, in native wei (xDAI on Gnosis).
    /// @param marketName The question text. Printable text only: no '"', '\', control characters or U+241F.
    /// @param claimDocumentUri Locator of the claim document (for example ipfs://<cid>); emitted, not stored.
    struct CreateClaimParams {
        bytes32 claimDocumentSha256;
        bytes32 policyDocumentSha256;
        bytes32 repositoryCommit;
        uint64 evidenceDeadline;
        uint64 revealDeadline;
        uint256 minBond;
        string marketName;
        string claimDocumentUri;
    }

    struct Claim {
        address creator;
        uint64 createdAt;
        uint64 evidenceDeadline;
        uint64 revealDeadline;
        bytes32 claimDocumentSha256;
        bytes32 policyDocumentSha256;
        bytes32 repositoryCommit;
        /// Reality.eth question id (Market.questionsIds()[0]).
        bytes32 questionId;
        /// Conditional Tokens condition id (Market.conditionId()).
        bytes32 conditionId;
        /// keccak256(bytes(marketName)).
        bytes32 marketNameHash;
        uint256 minBond;
    }

    /// @notice Emitted once per market, in the same transaction that created the Seer market.
    event ClaimCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed claimDocumentSha256,
        bytes32 policyDocumentSha256,
        bytes32 repositoryCommit,
        bytes32 questionId,
        bytes32 conditionId,
        uint64 evidenceDeadline,
        uint64 revealDeadline,
        uint256 minBond,
        string marketName,
        string claimDocumentUri
    );

    error ZeroHash();
    error EvidenceDeadlineOutOfRange(uint64 evidenceDeadline, uint64 earliest, uint64 latest);
    error RevealWindowOutOfRange(uint64 revealDeadline, uint64 earliest, uint64 latest);
    error MinBondTooLow(uint256 minBond, uint256 minimum);
    error MarketNameLength(uint256 length);
    error MarketNameForbiddenByte(uint256 index);
    error UriLength(uint256 length);
    error UnexpectedMarketShape(address market);
    error AlreadyRegistered(address market);
    error UnknownMarket(address market);

    /// @notice Creates the Seer market (outcomes "Yes", "No"; Seer appends "Invalid result") and records the claim.
    /// @return market The new Seer market address, which is also the claim's identifier.
    function createClaim(CreateClaimParams calldata params) external returns (address market);

    /// @notice Reverts with UnknownMarket for a market this registry did not create.
    function getClaim(address market) external view returns (Claim memory);

    function isRegistered(address market) external view returns (bool);

    /// @notice Number of claims created by this registry.
    function claimCount() external view returns (uint256);

    /// @notice Seer MarketFactory used to create markets (immutable).
    function seerMarketFactory() external view returns (address);

    /// @notice Smallest accepted Reality.eth minimum bond (immutable).
    function minimumMinBond() external view returns (uint256);

    function MIN_EVIDENCE_WINDOW() external view returns (uint64);
    function MAX_EVIDENCE_WINDOW() external view returns (uint64);
    function MIN_REVEAL_WINDOW() external view returns (uint64);
    function MAX_REVEAL_WINDOW() external view returns (uint64);
    function MAX_MARKET_NAME_BYTES() external view returns (uint256);
    function MAX_URI_BYTES() external view returns (uint256);
}
