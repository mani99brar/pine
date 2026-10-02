// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IEvidenceRegistry
/// @notice FROZEN interface. Durable, timestamped evidence submissions for claims of one ClaimRegistry.
/// @dev Two paths:
///  - commit-reveal: commitEvidence before the evidence deadline records a binding commitment (timestamp proof without
///    disclosing content); revealEvidence before the reveal deadline discloses the content hash and a locator.
///  - public: publishEvidence before the evidence deadline discloses immediately.
/// The commitment binds chain id, this registry, the market, the submitter and the content hash, so a copied commitment
/// is useless to anyone else and cannot block the original (submissions are keyed by a sequential id, not by hash).
/// Content is identified by SHA-256 of the exact evidence-manifest bytes; URIs are locators only.
/// There is no owner, no pause and no upgrade path.
interface IEvidenceRegistry {
    enum Status {
        None,
        Committed,
        Revealed,
        Published
    }

    struct Submission {
        address market;
        address submitter;
        /// Block timestamp of commitEvidence, or of publishEvidence.
        uint64 committedAt;
        /// Block timestamp of revealEvidence; equals committedAt for published submissions; 0 while only committed.
        uint64 revealedAt;
        Status status;
        /// Zero for published submissions.
        bytes32 commitment;
        /// Zero while only committed.
        bytes32 contentSha256;
    }

    event EvidenceCommitted(
        uint256 indexed submissionId, address indexed market, address indexed submitter, bytes32 commitment, uint64 committedAt
    );
    event EvidenceRevealed(
        uint256 indexed submissionId,
        address indexed market,
        address indexed submitter,
        bytes32 contentSha256,
        string uri,
        uint64 committedAt,
        uint64 revealedAt
    );
    event EvidencePublished(
        uint256 indexed submissionId,
        address indexed market,
        address indexed submitter,
        bytes32 contentSha256,
        string uri,
        uint64 publishedAt
    );
    /// @notice An additional locator for already disclosed content, posted by the original submitter.
    event EvidenceMirrorAdded(uint256 indexed submissionId, address indexed submitter, string uri);

    error UnknownMarket(address market);
    error EvidenceWindowClosed(address market, uint64 evidenceDeadline);
    error RevealWindowClosed(address market, uint64 revealDeadline);
    error ZeroValue();
    error UriLength(uint256 length);
    error UnknownSubmission(uint256 submissionId);
    error NotSubmitter(uint256 submissionId);
    error WrongStatus(uint256 submissionId, Status status);
    error CommitmentMismatch(uint256 submissionId);

    /// @notice Domain-separated commitment the submitter computes off-chain before committing:
    /// keccak256(abi.encode(COMMITMENT_TYPEHASH, block.chainid, address(this), market, submitter, contentSha256, salt)).
    function COMMITMENT_TYPEHASH() external view returns (bytes32);

    /// @notice Requires a registered market and block.timestamp < evidenceDeadline. Commitment and salt must be nonzero.
    function commitEvidence(address market, bytes32 commitment) external returns (uint256 submissionId);

    /// @notice Only the original submitter, only once, only while block.timestamp < revealDeadline, and only when the
    /// recomputed commitment matches. salt and contentSha256 must be nonzero; uri length 1..MAX_URI_BYTES.
    function revealEvidence(uint256 submissionId, bytes32 contentSha256, bytes32 salt, string calldata uri) external;

    /// @notice Immediate disclosure. Requires a registered market and block.timestamp < evidenceDeadline.
    function publishEvidence(address market, bytes32 contentSha256, string calldata uri) external returns (uint256 submissionId);

    /// @notice Only the submitter of a Revealed or Published submission; the uri is a locator for the same content.
    function addMirror(uint256 submissionId, string calldata uri) external;

    function computeCommitment(address market, address submitter, bytes32 contentSha256, bytes32 salt)
        external
        view
        returns (bytes32);

    /// @notice Reverts with UnknownSubmission for an id that was never issued.
    function getSubmission(uint256 submissionId) external view returns (Submission memory);

    /// @notice Number of submissions issued; ids are 1..submissionCount.
    function submissionCount() external view returns (uint256);

    function claimRegistry() external view returns (address);

    function MAX_URI_BYTES() external view returns (uint256);
}
