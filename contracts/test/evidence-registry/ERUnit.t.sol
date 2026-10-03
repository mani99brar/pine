// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {IEvidenceRegistry} from "../../src/interfaces/IEvidenceRegistry.sol";
import {ERBase} from "./ERBase.sol";
import {ERRevertingClaimRegistry, ERWritingClaimRegistry} from "./mocks/ERMockClaimRegistry.sol";

contract ERConstructorTest is ERBase {
    function test_constructor_acceptsAddressWithoutCode() public {
        address predicted = makeAddr("predictedClaimRegistry");
        assertEq(predicted.code.length, 0);
        EvidenceRegistry deployed = new EvidenceRegistry(predicted);
        assertEq(deployed.claimRegistry(), predicted);
        assertEq(deployed.submissionCount(), 0);
    }

    function test_constructor_neverCallsTheRegistry() public {
        ERRevertingClaimRegistry reverting = new ERRevertingClaimRegistry();
        vm.expectCall(address(reverting), bytes(""), uint64(0));
        EvidenceRegistry deployed = new EvidenceRegistry(address(reverting));
        assertEq(deployed.claimRegistry(), address(reverting));
    }

    function test_constructor_revertsOnZeroAddress() public {
        vm.expectRevert(IEvidenceRegistry.ZeroValue.selector);
        new EvidenceRegistry(address(0));
    }

    function test_typehash_matchesInterfaceNatSpec() public view {
        assertEq(
            registry.COMMITMENT_TYPEHASH(),
            keccak256(
                "PineEvidenceCommitment(uint256 chainId,address registry,address market,address submitter,bytes32 contentSha256,bytes32 salt)"
            )
        );
    }

    function test_registryReads_areStaticcalls() public {
        ERWritingClaimRegistry writing = new ERWritingClaimRegistry();
        EvidenceRegistry bound = new EvidenceRegistry(address(writing));
        // A plain CALL may write; inside a STATICCALL the write reverts, so every path that reads the registry reverts.
        writing.isRegistered(market);
        assertEq(writing.calls(), 1);
        vm.expectRevert();
        bound.commitEvidence(market, bytes32(uint256(1)));
        vm.expectRevert();
        bound.publishEvidence(market, DIGEST);
        assertEq(writing.calls(), 1);
    }
}

contract ERCommitTest is ERBase {
    function test_commit_recordsSubmissionAndEmits() public {
        bytes32 commitment = _commitment(alice, DIGEST, SALT);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IEvidenceRegistry.EvidenceCommitted(1, market, alice, commitment, START);
        vm.prank(alice);
        uint256 id = registry.commitEvidence(market, commitment);

        assertEq(id, 1);
        assertEq(registry.submissionCount(), 1);
        _assertSubmission(1, market, alice, START, 0, IEvidenceRegistry.Status.Committed, commitment, bytes32(0));
    }

    function test_commit_idsAreSequentialFromOne() public {
        assertEq(_commit(alice, DIGEST, SALT), 1);
        vm.prank(bob);
        assertEq(registry.publishEvidence(market, DIGEST), 2);
        assertEq(_commit(bob, DIGEST, SALT), 3);
        assertEq(registry.submissionCount(), 3);
    }

    function test_commit_sameCommitmentTwiceGetsDistinctIds() public {
        bytes32 commitment = _commitment(alice, DIGEST, SALT);
        vm.startPrank(alice);
        assertEq(registry.commitEvidence(market, commitment), 1);
        assertEq(registry.commitEvidence(market, commitment), 2);
        vm.stopPrank();
    }

    function test_commit_boundary_deadlineMinusOneSucceeds() public {
        vm.warp(EVIDENCE_DEADLINE - 1);
        uint256 id = _commit(alice, DIGEST, SALT);
        assertEq(registry.getSubmission(id).committedAt, EVIDENCE_DEADLINE - 1);
    }

    function test_commit_boundary_atDeadlineReverts() public {
        vm.warp(EVIDENCE_DEADLINE);
        bytes32 commitment = _commitment(alice, DIGEST, SALT);
        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.EvidenceWindowClosed.selector, market, EVIDENCE_DEADLINE)
        );
        vm.prank(alice);
        registry.commitEvidence(market, commitment);
    }

    function test_commit_boundary_deadlinePlusOneReverts() public {
        vm.warp(EVIDENCE_DEADLINE + 1);
        bytes32 commitment = _commitment(alice, DIGEST, SALT);
        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.EvidenceWindowClosed.selector, market, EVIDENCE_DEADLINE)
        );
        vm.prank(alice);
        registry.commitEvidence(market, commitment);
    }

    function test_commit_revertsOnZeroCommitment() public {
        vm.expectRevert(IEvidenceRegistry.ZeroValue.selector);
        vm.prank(alice);
        registry.commitEvidence(market, bytes32(0));
    }

    function test_commit_revertsOnUnknownMarket() public {
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownMarket.selector, unknownMarket));
        vm.prank(alice);
        registry.commitEvidence(unknownMarket, bytes32(uint256(1)));
        assertEq(registry.submissionCount(), 0);
    }
}

contract ERPublishTest is ERBase {
    function test_publish_recordsSubmissionAndEmits() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit IEvidenceRegistry.EvidencePublished(1, market, bob, DIGEST, START);
        vm.prank(bob);
        uint256 id = registry.publishEvidence(market, DIGEST);

        assertEq(id, 1);
        _assertSubmission(1, market, bob, START, START, IEvidenceRegistry.Status.Published, bytes32(0), DIGEST);
    }

    function test_publish_boundary_deadlineMinusOneSucceeds() public {
        vm.warp(EVIDENCE_DEADLINE - 1);
        vm.prank(bob);
        uint256 id = registry.publishEvidence(market, DIGEST);
        _assertSubmission(
            id,
            market,
            bob,
            EVIDENCE_DEADLINE - 1,
            EVIDENCE_DEADLINE - 1,
            IEvidenceRegistry.Status.Published,
            bytes32(0),
            DIGEST
        );
    }

    function test_publish_boundary_atDeadlineReverts() public {
        vm.warp(EVIDENCE_DEADLINE);
        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.EvidenceWindowClosed.selector, market, EVIDENCE_DEADLINE)
        );
        vm.prank(bob);
        registry.publishEvidence(market, DIGEST);
    }

    function test_publish_boundary_deadlinePlusOneReverts() public {
        vm.warp(EVIDENCE_DEADLINE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.EvidenceWindowClosed.selector, market, EVIDENCE_DEADLINE)
        );
        vm.prank(bob);
        registry.publishEvidence(market, DIGEST);
    }

    function test_publish_revertsOnZeroDigest() public {
        vm.expectRevert(IEvidenceRegistry.ZeroValue.selector);
        vm.prank(bob);
        registry.publishEvidence(market, bytes32(0));
    }

    function test_publish_revertsOnUnknownMarket() public {
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownMarket.selector, unknownMarket));
        vm.prank(bob);
        registry.publishEvidence(unknownMarket, DIGEST);
        assertEq(registry.submissionCount(), 0);
    }
}

contract ERRevealTest is ERBase {
    function test_reveal_recordsDigestAndEmits() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        bytes32 commitment = _commitment(alice, DIGEST, SALT);
        uint64 revealAt = EVIDENCE_DEADLINE + 1 hours;
        vm.warp(revealAt);

        vm.expectEmit(true, true, true, true, address(registry));
        emit IEvidenceRegistry.EvidenceRevealed(id, market, alice, DIGEST, START, revealAt);
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);

        _assertSubmission(id, market, alice, START, revealAt, IEvidenceRegistry.Status.Revealed, commitment, DIGEST);
    }

    function test_reveal_boundary_deadlineMinusOneSucceeds() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.warp(REVEAL_DEADLINE - 1);
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
        assertEq(registry.getSubmission(id).revealedAt, REVEAL_DEADLINE - 1);
    }

    function test_reveal_boundary_atDeadlineReverts() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.warp(REVEAL_DEADLINE);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.RevealWindowClosed.selector, market, REVEAL_DEADLINE));
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
    }

    function test_reveal_boundary_deadlinePlusOneReverts() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.warp(REVEAL_DEADLINE + 1);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.RevealWindowClosed.selector, market, REVEAL_DEADLINE));
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
    }

    function test_reveal_beforeEvidenceDeadlineSucceeds() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.warp(START + 1);
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
        assertEq(uint8(registry.getSubmission(id).status), uint8(IEvidenceRegistry.Status.Revealed));
    }

    function test_reveal_doubleRevealReverts() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.startPrank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.WrongStatus.selector, id, IEvidenceRegistry.Status.Revealed)
        );
        registry.revealEvidence(id, DIGEST, SALT);
        vm.stopPrank();
    }

    function test_reveal_byAnotherAddressReverts() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.NotSubmitter.selector, id));
        vm.prank(bob);
        registry.revealEvidence(id, DIGEST, SALT);
    }

    function test_reveal_ofPublishedIdReverts() public {
        vm.prank(bob);
        uint256 id = registry.publishEvidence(market, DIGEST);

        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.WrongStatus.selector, id, IEvidenceRegistry.Status.Published)
        );
        vm.prank(bob);
        registry.revealEvidence(id, DIGEST, SALT);

        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.NotSubmitter.selector, id));
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, SALT);
        _assertSubmission(id, market, bob, START, START, IEvidenceRegistry.Status.Published, bytes32(0), DIGEST);
    }

    function test_reveal_zeroSaltReverts() public {
        uint256 id = _commit(alice, DIGEST, bytes32(0));
        vm.expectRevert(IEvidenceRegistry.ZeroValue.selector);
        vm.prank(alice);
        registry.revealEvidence(id, DIGEST, bytes32(0));
    }

    function test_reveal_zeroDigestReverts() public {
        uint256 id = _commit(alice, bytes32(0), SALT);
        vm.expectRevert(IEvidenceRegistry.ZeroValue.selector);
        vm.prank(alice);
        registry.revealEvidence(id, bytes32(0), SALT);
    }

    function test_reveal_unknownIdReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, 0));
        vm.prank(alice);
        registry.revealEvidence(0, DIGEST, SALT);

        uint256 id = _commit(alice, DIGEST, SALT);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, id + 1));
        vm.prank(alice);
        registry.revealEvidence(id + 1, DIGEST, SALT);
    }

    function test_reveal_wrongDigestOrSaltReverts() public {
        uint256 id = _commit(alice, DIGEST, SALT);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.CommitmentMismatch.selector, id));
        registry.revealEvidence(id, keccak256("other manifest"), SALT);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.CommitmentMismatch.selector, id));
        registry.revealEvidence(id, DIGEST, keccak256("other salt"));
        vm.stopPrank();
        assertEq(uint8(registry.getSubmission(id).status), uint8(IEvidenceRegistry.Status.Committed));
    }

    function test_reveal_commitmentForAnotherMarketReverts() public {
        address otherMarket = makeAddr("otherMarket");
        claims.setClaim(otherMarket, EVIDENCE_DEADLINE, REVEAL_DEADLINE);
        // A commitment bound to otherMarket, committed under market, cannot be revealed.
        bytes32 commitment = registry.computeCommitment(otherMarket, alice, DIGEST, SALT);
        vm.startPrank(alice);
        uint256 id = registry.commitEvidence(market, commitment);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.CommitmentMismatch.selector, id));
        registry.revealEvidence(id, DIGEST, SALT);
        vm.stopPrank();
    }

    function test_reveal_usesTheSubmissionsMarketDeadline() public {
        address lateMarket = makeAddr("lateMarket");
        claims.setClaim(lateMarket, EVIDENCE_DEADLINE + 30 days, REVEAL_DEADLINE + 30 days);
        bytes32 commitment = registry.computeCommitment(lateMarket, alice, DIGEST, SALT);
        vm.prank(alice);
        uint256 lateId = registry.commitEvidence(lateMarket, commitment);
        uint256 id = _commit(alice, DIGEST, SALT);

        vm.warp(REVEAL_DEADLINE);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.RevealWindowClosed.selector, market, REVEAL_DEADLINE));
        registry.revealEvidence(id, DIGEST, SALT);
        registry.revealEvidence(lateId, DIGEST, SALT);
        vm.stopPrank();
    }
}

/// @notice SEC-SC-06 / SEC-SC-10: copying a commitment or a revealed digest gains nothing.
contract ERFrontRunningTest is ERBase {
    address internal attacker = makeAddr("attacker");

    function test_frontRunning_copiedCommitmentNeitherBlocksNorReveals() public {
        bytes32 victimCommitment = _commitment(alice, DIGEST, SALT);

        // The attacker sees the victim's pending commit and lands the same hash first.
        vm.prank(attacker);
        uint256 attackerId = registry.commitEvidence(market, victimCommitment);
        assertEq(attackerId, 1);

        // The victim's commit still succeeds with its own id.
        vm.prank(alice);
        uint256 victimId = registry.commitEvidence(market, victimCommitment);
        assertEq(victimId, 2);

        // After learning the preimage (e.g. from the victim's pending reveal), the attacker cannot reveal it.
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.CommitmentMismatch.selector, attackerId));
        vm.prank(attacker);
        registry.revealEvidence(attackerId, DIGEST, SALT);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.NotSubmitter.selector, victimId));
        vm.prank(attacker);
        registry.revealEvidence(victimId, DIGEST, SALT);

        // The victim's reveal succeeds and keeps the victim's commit time.
        vm.warp(EVIDENCE_DEADLINE + 1);
        vm.prank(alice);
        registry.revealEvidence(victimId, DIGEST, SALT);
        _assertSubmission(
            victimId,
            market,
            alice,
            START,
            EVIDENCE_DEADLINE + 1,
            IEvidenceRegistry.Status.Revealed,
            victimCommitment,
            DIGEST
        );
        assertEq(uint8(registry.getSubmission(attackerId).status), uint8(IEvidenceRegistry.Status.Committed));
    }

    function test_frontRunning_copiedRevealCannotBePublishedAfterDeadline() public {
        uint256 victimId = _commit(alice, DIGEST, SALT);
        vm.warp(EVIDENCE_DEADLINE + 1);
        vm.prank(alice);
        registry.revealEvidence(victimId, DIGEST, SALT);

        vm.expectRevert(
            abi.encodeWithSelector(IEvidenceRegistry.EvidenceWindowClosed.selector, market, EVIDENCE_DEADLINE)
        );
        vm.prank(attacker);
        registry.publishEvidence(market, DIGEST);
    }
}

contract ERViewsTest is ERBase {
    function test_getSubmission_unknownIdsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, 0));
        registry.getSubmission(0);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, 1));
        registry.getSubmission(1);

        _commit(alice, DIGEST, SALT);
        registry.getSubmission(1);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, 2));
        registry.getSubmission(2);
        vm.expectRevert(abi.encodeWithSelector(IEvidenceRegistry.UnknownSubmission.selector, type(uint256).max));
        registry.getSubmission(type(uint256).max);
    }

    function testFuzz_computeCommitment_matchesFormula(
        address anyMarket,
        address submitter,
        bytes32 digest,
        bytes32 salt,
        uint64 chainId
    ) public {
        vm.chainId(chainId);
        bytes32 expected = keccak256(
            abi.encode(
                registry.COMMITMENT_TYPEHASH(), uint256(chainId), address(registry), anyMarket, submitter, digest, salt
            )
        );
        assertEq(registry.computeCommitment(anyMarket, submitter, digest, salt), expected);
    }

    function testFuzz_computeCommitment_bindsSubmitter(address other) public view {
        vm.assume(other != alice);
        assertNotEq(_commitment(alice, DIGEST, SALT), _commitment(other, DIGEST, SALT));
    }

    function test_computeCommitment_bindsChainAndRegistry() public {
        bytes32 here = _commitment(alice, DIGEST, SALT);
        EvidenceRegistry twin = new EvidenceRegistry(address(claims));
        assertNotEq(twin.computeCommitment(market, alice, DIGEST, SALT), here);
        vm.chainId(block.chainid + 1);
        assertNotEq(_commitment(alice, DIGEST, SALT), here);
    }
}
