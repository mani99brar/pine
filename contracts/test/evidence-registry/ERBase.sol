// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {IEvidenceRegistry} from "../../src/interfaces/IEvidenceRegistry.sol";
import {ERMockClaimRegistry} from "./mocks/ERMockClaimRegistry.sol";

/// @notice Shared fixture: an EvidenceRegistry bound to a test-local mock claim registry with one registered market.
abstract contract ERBase is Test {
    uint64 internal constant START = 1_790_000_000;
    uint64 internal constant EVIDENCE_DEADLINE = START + 14 days;
    uint64 internal constant REVEAL_DEADLINE = EVIDENCE_DEADLINE + 2 days;

    ERMockClaimRegistry internal claims;
    EvidenceRegistry internal registry;

    address internal market = makeAddr("market");
    address internal unknownMarket = makeAddr("unknownMarket");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant DIGEST = keccak256("evidence manifest");
    bytes32 internal constant SALT = keccak256("client salt");

    function setUp() public virtual {
        vm.warp(START);
        claims = new ERMockClaimRegistry();
        registry = new EvidenceRegistry(address(claims));
        claims.setClaim(market, EVIDENCE_DEADLINE, REVEAL_DEADLINE);
    }

    function _commitment(address submitter, bytes32 digest, bytes32 salt) internal view returns (bytes32) {
        return registry.computeCommitment(market, submitter, digest, salt);
    }

    function _commit(address submitter, bytes32 digest, bytes32 salt) internal returns (uint256 id) {
        bytes32 commitment = _commitment(submitter, digest, salt);
        vm.prank(submitter);
        id = registry.commitEvidence(market, commitment);
    }

    function _assertSubmission(
        uint256 id,
        address expectedMarket,
        address submitter,
        uint64 committedAt,
        uint64 revealedAt,
        IEvidenceRegistry.Status status,
        bytes32 commitment,
        bytes32 contentSha256
    ) internal view {
        IEvidenceRegistry.Submission memory s = registry.getSubmission(id);
        assertEq(s.market, expectedMarket, "market");
        assertEq(s.submitter, submitter, "submitter");
        assertEq(s.committedAt, committedAt, "committedAt");
        assertEq(s.revealedAt, revealedAt, "revealedAt");
        assertEq(uint8(s.status), uint8(status), "status");
        assertEq(s.commitment, commitment, "commitment");
        assertEq(s.contentSha256, contentSha256, "contentSha256");
    }
}
