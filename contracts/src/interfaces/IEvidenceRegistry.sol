// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IEvidenceRegistry
/// @notice FROZEN interface. Durable, timestamped evidence submissions for claims of one ClaimRegistry:
/// constructor(address claimRegistry) stores it immutably (the deploy script passes the registry's predicted address;
/// the registry verifies the binding in its own constructor). Claim deadlines are read from the registry
/// (IClaimRegistry.getClaim), which reverts for markets it did not create.
/// @dev Two paths:
///  - commit-reveal: commitEvidence before the evidence deadline records a binding commitment (timestamp proof without
///    disclosing content); revealEvidence before the reveal deadline discloses the content digest.
///  - public: publishEvidence before the evidence deadline discloses immediately.
/// Content is identified only by the SHA-256 digest of the exact evidence-manifest bytes (<= 256 KiB, a single raw
/// IPFS block, so its CIDv1 raw/sha2-256 locator is derivable from the digest). No URI or other free text is stored
/// or emitted. The commitment binds chain id, this registry, the market, the submitter and the content digest, so a
/// copied commitment is useless to anyone else, and submissions are keyed by a sequential id, so copying cannot block
/// the original. There is no owner, no pause and no upgrade path.
///
/// Timing (frozen operators, SEC-SC-07), using the claim's deadlines from the ClaimRegistry:
///  - commitEvidence and publishEvidence succeed iff block.timestamp < evidenceDeadline;
///  - revealEvidence succeeds iff block.timestamp < revealDeadline.
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
        uint64 committedAt,
        uint64 revealedAt
    );
    event EvidencePublished(
        uint256 indexed submissionId, address indexed market, address indexed submitter, bytes32 contentSha256, uint64 publishedAt
    );

    error NotClaimRegistry();
    error UnknownMarket(address market);
    error EvidenceWindowClosed(address market, uint64 evidenceDeadline);
    error RevealWindowClosed(address market, uint64 revealDeadline);
    error ZeroValue();
    error UnknownSubmission(uint256 submissionId);
    error NotSubmitter(uint256 submissionId);
    error WrongStatus(uint256 submissionId, Status status);
    error CommitmentMismatch(uint256 submissionId);

    /// @notice Domain-separated commitment the submitter computes off-chain before committing:
    /// keccak256(abi.encode(COMMITMENT_TYPEHASH, block.chainid, address(this), market, submitter, contentSha256, salt))
    /// with COMMITMENT_TYPEHASH = keccak256("PineEvidenceCommitment(uint256 chainId,address registry,address market,address submitter,bytes32 contentSha256,bytes32 salt)").
    /// The salt is >= 128 bits of client-side randomness (32 bytes recommended) and never leaves the client before reveal.
    function COMMITMENT_TYPEHASH() external view returns (bytes32);

    /// @notice Requires a registered market, block.timestamp < evidenceDeadline and a nonzero commitment.
    function commitEvidence(address market, bytes32 commitment) external returns (uint256 submissionId);

    /// @notice Only the original submitter, only once, only while block.timestamp < revealDeadline, and only when the
    /// recomputed commitment matches. salt and contentSha256 must be nonzero.
    function revealEvidence(uint256 submissionId, bytes32 contentSha256, bytes32 salt) external;

    /// @notice Immediate disclosure. Requires a registered market, block.timestamp < evidenceDeadline and a nonzero digest.
    function publishEvidence(address market, bytes32 contentSha256) external returns (uint256 submissionId);

    function computeCommitment(address market, address submitter, bytes32 contentSha256, bytes32 salt)
        external
        view
        returns (bytes32);

    /// @notice Reverts with UnknownSubmission for an id that was never issued.
    function getSubmission(uint256 submissionId) external view returns (Submission memory);

    /// @notice Number of submissions issued; ids are 1..submissionCount.
    function submissionCount() external view returns (uint256);

    function claimRegistry() external view returns (address);
}
