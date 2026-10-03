// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {ISeerMarket} from "../../src/interfaces/external/ISeer.sol";
import {CRMockEvidenceRegistry} from "../claim-registry/mocks/CRMockEvidenceRegistry.sol";
import {CRForkBase} from "./CRForkBase.sol";

interface CRIRealityETHView {
    function getTimeout(bytes32 questionId) external view returns (uint32);
    function getOpeningTS(bytes32 questionId) external view returns (uint32);
    function getMinBond(bytes32 questionId) external view returns (uint256);
    function getArbitrator(bytes32 questionId) external view returns (address);
    function getContentHash(bytes32 questionId) external view returns (bytes32);
}

interface CRIConditionalTokensView {
    function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
}

/// @notice ClaimRegistry against the REAL Seer MarketFactory on a Gnosis fork pinned at block 48550000 (CRForkBase).
/// At most one createClaim per test function (public-RPC budget, features/chain/decisions.md), except the twin-market
/// test, which makes two by operator decision.
contract CRForkTest is CRForkBase {
    function test_fork_createClaim_createsRealSeerMarket() public {
        vm.prank(alice);
        address marketA = registry.createClaim(params);
        IClaimRegistry.Claim memory c = registry.getClaim(marketA);
        ISeerMarket m = ISeerMarket(marketA);
        string memory question = registry.renderQuestion(params);

        // Market shape and the exact question.
        assertEq(m.marketName(), question);
        assertEq(c.marketNameHash, keccak256(bytes(question)));
        string memory encoded =
            string.concat(question, hex"e2909f", '"Yes","No"', hex"e2909f", "misc", hex"e2909f", "en_US");
        assertEq(m.encodedQuestions(0), encoded);
        assertEq(m.templateId(), 2);
        assertEq(m.numOutcomes(), 2);
        assertEq(m.parentMarket(), address(0));
        bytes32[] memory qids = m.questionsIds();
        assertEq(qids.length, 1);
        assertEq(c.questionId, qids[0]);
        assertEq(c.conditionId, m.conditionId());

        // Reality.eth question: Seer's fixed timeout, opening at the reveal deadline, our min bond, Kleros arbitrator.
        CRIRealityETHView reality = CRIRealityETHView(REALITIO);
        assertEq(reality.getTimeout(c.questionId), 302_400);
        assertEq(reality.getOpeningTS(c.questionId), params.revealDeadline);
        assertEq(reality.getMinBond(c.questionId), params.minBond);
        assertEq(reality.getArbitrator(c.questionId), ARBITRATOR);
        assertEq(
            reality.getContentHash(c.questionId),
            keccak256(abi.encodePacked(uint256(2), uint32(params.revealDeadline), encoded))
        );

        // CTF condition with Yes, No and Invalid slots.
        assertEq(CRIConditionalTokensView(CONDITIONAL_TOKENS).getOutcomeSlotCount(c.conditionId), 3);

        // Wrapped outcome tokens.
        (address yes,) = m.wrappedOutcome(0);
        (address no,) = m.wrappedOutcome(1);
        (address invalid,) = m.wrappedOutcome(2);
        assertEq(c.yesToken, yes);
        assertEq(c.noToken, no);
        assertEq(c.invalidToken, invalid);
        assertEq(IERC20Metadata(yes).name(), "PY_e3b0c442");
        assertEq(IERC20Metadata(yes).symbol(), "PY_e3b0c442");
        assertEq(IERC20Metadata(no).name(), "PN_e3b0c442");
        assertEq(IERC20Metadata(no).symbol(), "PN_e3b0c442");
        assertEq(IERC20Metadata(invalid).symbol(), "SER-INVALID");

        // Record.
        assertEq(c.creator, alice);
        assertEq(c.createdAt, uint64(block.timestamp));
        assertEq(c.evidenceDeadline, params.evidenceDeadline);
        assertEq(c.revealDeadline, params.revealDeadline);
        assertEq(c.minBond, params.minBond);
        assertEq(registry.marketOf(alice, params.claimDocumentSha256), marketA);
        assertEq(registry.claimCount(), 1);

        // The registry holds nothing.
        assertEq(address(registry).balance, 0);
        assertEq(IERC20Metadata(yes).balanceOf(address(registry)), 0);
        assertEq(IERC20Metadata(no).balanceOf(address(registry)), 0);
        assertEq(IERC20Metadata(invalid).balanceOf(address(registry)), 0);
    }

    /// Same document from a second creator, same params struct, same block: a distinct market that shares the Reality
    /// question, the CTF condition and all three wrapped outcome tokens (Seer reuses them). The one test with two
    /// createClaim calls (operator-settled exception).
    function test_fork_twinMarket_sharesQuestionConditionAndTokens() public {
        vm.prank(alice);
        address marketA = registry.createClaim(params);
        vm.prank(bob);
        address marketB = registry.createClaim(params);

        assertTrue(marketB != marketA);
        IClaimRegistry.Claim memory a = registry.getClaim(marketA);
        IClaimRegistry.Claim memory b = registry.getClaim(marketB);
        assertEq(b.creator, bob);
        assertEq(a.questionId, b.questionId);
        assertEq(a.conditionId, b.conditionId);
        assertEq(a.yesToken, b.yesToken);
        assertEq(a.noToken, b.noToken);
        assertEq(a.invalidToken, b.invalidToken);
        assertEq(a.marketNameHash, b.marketNameHash);
        assertEq(registry.marketOf(alice, params.claimDocumentSha256), marketA);
        assertEq(registry.marketOf(bob, params.claimDocumentSha256), marketB);
        assertEq(registry.claimCount(), 2);
    }

    /// The constructor reads the real factory's immutables and refuses a mismatched expectation.
    function test_fork_constructor_refusesMismatchedSeerConfig() public {
        ClaimRegistry.ExpectedSeer memory wrong = _expected();
        wrong.questionTimeout = 86_400;
        _expectConstructorRevert(wrong, "questionTimeout");

        wrong = _expected();
        wrong.collateralToken = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d; // WXDAI, not sDAI
        _expectConstructorRevert(wrong, "collateralToken");
    }

    function _expectConstructorRevert(ClaimRegistry.ExpectedSeer memory expected, string memory getter) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        CRMockEvidenceRegistry ev = new CRMockEvidenceRegistry(predicted);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.SeerConfigMismatch.selector, getter));
        new ClaimRegistry(MARKET_FACTORY, address(ev), 1 ether, expected);
    }
}
