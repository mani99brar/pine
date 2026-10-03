// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IClaimRegistry} from "./interfaces/IClaimRegistry.sol";
import {IEvidenceRegistry} from "./interfaces/IEvidenceRegistry.sol";

/// @title EvidenceRegistry
/// @notice Immutable commit-reveal and direct-publication evidence submissions for the claims of one ClaimRegistry
/// (docs/prd/PRD-01-chain.md section 3). No owner, no pause, no upgrade path, no token handling.
/// @dev The only external calls are view calls (STATICCALL) to the immutable claim registry, made before any state
/// change; a STATICCALL context cannot modify state, so no reentrancy guard is needed. Submissions are keyed by a
/// sequential id (1..submissionCount); a commitment hash is never a storage key, so a copied commitment cannot block
/// the original. No function loops.
contract EvidenceRegistry is IEvidenceRegistry {
    /// @inheritdoc IEvidenceRegistry
    bytes32 public constant override COMMITMENT_TYPEHASH = keccak256(
        "PineEvidenceCommitment(uint256 chainId,address registry,address market,address submitter,bytes32 contentSha256,bytes32 salt)"
    );

    /// @inheritdoc IEvidenceRegistry
    address public immutable override claimRegistry;

    /// @inheritdoc IEvidenceRegistry
    uint256 public override submissionCount;

    mapping(uint256 submissionId => Submission) private _submissions;

    /// @param claimRegistry_ The ClaimRegistry's (predicted) address. Neither called nor required to hold code here:
    /// the EvidenceRegistry is deployed first, and the ClaimRegistry constructor verifies the binding.
    constructor(address claimRegistry_) {
        if (claimRegistry_ == address(0)) revert ZeroValue();
        claimRegistry = claimRegistry_;
    }

    /// @inheritdoc IEvidenceRegistry
    function commitEvidence(address market, bytes32 commitment) external override returns (uint256 submissionId) {
        IClaimRegistry.Claim memory claim = _registeredClaim(market);
        if (block.timestamp >= claim.evidenceDeadline) revert EvidenceWindowClosed(market, claim.evidenceDeadline);
        if (commitment == bytes32(0)) revert ZeroValue();

        // block.timestamp < evidenceDeadline <= type(uint64).max: SafeCast cannot revert (narrowing rule).
        uint64 committedAt = SafeCast.toUint64(block.timestamp);
        submissionId = ++submissionCount;
        Submission storage submission = _submissions[submissionId];
        submission.market = market;
        submission.submitter = msg.sender;
        submission.committedAt = committedAt;
        submission.status = Status.Committed;
        submission.commitment = commitment;

        emit EvidenceCommitted(submissionId, market, msg.sender, commitment, committedAt);
    }

    /// @inheritdoc IEvidenceRegistry
    function revealEvidence(uint256 submissionId, bytes32 contentSha256, bytes32 salt) external override {
        Submission storage submission = _issued(submissionId);
        if (msg.sender != submission.submitter) revert NotSubmitter(submissionId);
        if (submission.status != Status.Committed) revert WrongStatus(submissionId, submission.status);

        address market = submission.market;
        uint64 revealDeadline = IClaimRegistry(claimRegistry).getClaim(market).revealDeadline;
        if (block.timestamp >= revealDeadline) revert RevealWindowClosed(market, revealDeadline);
        if (contentSha256 == bytes32(0) || salt == bytes32(0)) revert ZeroValue();
        if (_commitment(market, msg.sender, contentSha256, salt) != submission.commitment) {
            revert CommitmentMismatch(submissionId);
        }

        // block.timestamp < revealDeadline <= type(uint64).max: SafeCast cannot revert (narrowing rule).
        uint64 revealedAt = SafeCast.toUint64(block.timestamp);
        submission.status = Status.Revealed;
        submission.revealedAt = revealedAt;
        submission.contentSha256 = contentSha256;

        emit EvidenceRevealed(submissionId, market, msg.sender, contentSha256, submission.committedAt, revealedAt);
    }

    /// @inheritdoc IEvidenceRegistry
    function publishEvidence(address market, bytes32 contentSha256) external override returns (uint256 submissionId) {
        IClaimRegistry.Claim memory claim = _registeredClaim(market);
        if (block.timestamp >= claim.evidenceDeadline) revert EvidenceWindowClosed(market, claim.evidenceDeadline);
        if (contentSha256 == bytes32(0)) revert ZeroValue();

        // block.timestamp < evidenceDeadline <= type(uint64).max: SafeCast cannot revert (narrowing rule).
        uint64 publishedAt = SafeCast.toUint64(block.timestamp);
        submissionId = ++submissionCount;
        Submission storage submission = _submissions[submissionId];
        submission.market = market;
        submission.submitter = msg.sender;
        submission.committedAt = publishedAt;
        submission.revealedAt = publishedAt;
        submission.status = Status.Published;
        submission.contentSha256 = contentSha256;

        emit EvidencePublished(submissionId, market, msg.sender, contentSha256, publishedAt);
    }

    /// @inheritdoc IEvidenceRegistry
    function computeCommitment(address market, address submitter, bytes32 contentSha256, bytes32 salt)
        external
        view
        override
        returns (bytes32)
    {
        return _commitment(market, submitter, contentSha256, salt);
    }

    /// @inheritdoc IEvidenceRegistry
    function getSubmission(uint256 submissionId) external view override returns (Submission memory) {
        return _issued(submissionId);
    }

    /// @dev Reads the claim from the registry, reverting UnknownMarket (this interface's error) for unregistered markets.
    function _registeredClaim(address market) private view returns (IClaimRegistry.Claim memory) {
        IClaimRegistry registry = IClaimRegistry(claimRegistry);
        if (!registry.isRegistered(market)) revert UnknownMarket(market);
        return registry.getClaim(market);
    }

    function _issued(uint256 submissionId) private view returns (Submission storage) {
        if (submissionId == 0 || submissionId > submissionCount) revert UnknownSubmission(submissionId);
        return _submissions[submissionId];
    }

    function _commitment(address market, address submitter, bytes32 contentSha256, bytes32 salt)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(COMMITMENT_TYPEHASH, block.chainid, address(this), market, submitter, contentSha256, salt)
        );
    }
}
