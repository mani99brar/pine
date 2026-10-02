// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {ISeerMarket} from "../../src/interfaces/external/ISeer.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {CRMockSeerFactory, CRReentrantSeerFactory} from "./mocks/CRMockSeer.sol";
import {CRTestBase} from "./CRTestBase.sol";

contract CRCreateTest is CRTestBase {
    string internal constant HEX8 = "e3b0c442"; // first 4 bytes of _params().claimDocumentSha256

    function _nextMarket() internal view returns (address) {
        return vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
    }

    function _expectedClaim(IClaimRegistry.CreateClaimParams memory p, address creator, string memory question)
        internal
        view
        returns (IClaimRegistry.Claim memory c)
    {
        (bytes32 questionId, bytes32 conditionId, address[3] memory tokens) =
            factory.idsFor(_expectedMarketParams(p, question, HEX8));
        c = IClaimRegistry.Claim({
            creator: creator,
            createdAt: uint64(block.timestamp),
            evidenceDeadline: p.evidenceDeadline,
            revealDeadline: p.revealDeadline,
            repositoryId: p.repositoryId,
            commit: p.commit,
            claimDocumentSha256: p.claimDocumentSha256,
            policyDocumentSha256: p.policyDocumentSha256,
            questionId: questionId,
            conditionId: conditionId,
            marketNameHash: keccak256(bytes(question)),
            minBond: p.minBond,
            yesToken: tokens[0],
            noToken: tokens[1],
            invalidToken: tokens[2]
        });
    }

    function _assertClaimEq(IClaimRegistry.Claim memory a, IClaimRegistry.Claim memory b) internal pure {
        assertEq(abi.encode(a), abi.encode(b), "claim record");
    }

    // ---- Happy path: record, event, exact Seer parameters ----

    function test_createClaim_recordsEmitsAndPassesExactSeerParams() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        string memory question = registry.renderQuestion(p);
        IClaimRegistry.Claim memory expected = _expectedClaim(p, alice, question);
        address predicted = _nextMarket();

        vm.expectEmit(true, true, true, true, address(registry));
        emit IClaimRegistry.ClaimCreated(predicted, alice, p.claimDocumentSha256, expected, p.title, question);
        vm.prank(alice);
        address market = registry.createClaim(p);

        assertEq(market, predicted);
        // Seer received exactly the composed question and the frozen market shape.
        assertEq(factory.createCount(), 1);
        assertEq(factory.lastMarketName(), question);
        assertEq(factory.lastParamsHash(), keccak256(abi.encode(_expectedMarketParams(p, question, HEX8))));
        assertEq(ISeerMarket(market).marketName(), question);

        _assertClaimEq(registry.getClaim(market), expected);
        assertEq(registry.getClaim(market).marketNameHash, keccak256(bytes(question)));
        assertTrue(registry.isRegistered(market));
        assertEq(registry.marketOf(alice, p.claimDocumentSha256), market);
        assertEq(registry.marketOf(bob, p.claimDocumentSha256), address(0));
        assertEq(registry.claimCount(), 1);
        assertEq(address(registry).balance, 0);
    }

    function test_createClaim_tokenNamesAndOpeningTime() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.claimDocumentSha256 = 0x1111111111111111111111111111111111111111111111111111111111111111;
        p.revealDeadline = p.evidenceDeadline + 7 days;
        p.minBond = 123 ether;
        string memory question = registry.renderQuestion(p);
        vm.prank(alice);
        registry.createClaim(p);
        // PY_/PN_ names from TOKEN_NAME_VECTORS[0]; openingTime = revealDeadline; minBond forwarded.
        assertEq(factory.lastParamsHash(), keccak256(abi.encode(_expectedMarketParams(p, question, "11111111"))));
    }

    function test_getClaim_unknownMarket_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnknownMarket.selector, address(0xBEEF)));
        registry.getClaim(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnknownMarket.selector, address(0)));
        registry.getClaim(address(0));
        assertFalse(registry.isRegistered(address(0xBEEF)));
        assertEq(registry.claimCount(), 0);
    }

    function test_createClaim_notPayable() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(registry).call{value: 1}(abi.encodeCall(IClaimRegistry.createClaim, (_params())));
        assertFalse(ok);
        assertEq(address(registry).balance, 0);
    }

    // ---- Duplicates per (creator, claimDocumentSha256) ----

    function test_duplicate_sameCreator_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        vm.prank(alice);
        address first = registry.createClaim(p);

        // Even with different deadlines/bond/title, the same creator and digest is a duplicate.
        p.title = "another title";
        p.minBond = 2 ether;
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.DuplicateClaim.selector, first));
        vm.prank(alice);
        registry.createClaim(p);
        assertEq(registry.claimCount(), 1);
    }

    /// Another creator may publish the same digest: a distinct market sharing the question, condition and tokens.
    function test_sameDigest_otherCreator_succeeds() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        vm.prank(alice);
        address first = registry.createClaim(p);
        vm.prank(bob);
        address second = registry.createClaim(p);

        assertTrue(first != second);
        assertEq(registry.marketOf(alice, p.claimDocumentSha256), first);
        assertEq(registry.marketOf(bob, p.claimDocumentSha256), second);
        assertEq(registry.claimCount(), 2);
        IClaimRegistry.Claim memory a = registry.getClaim(first);
        IClaimRegistry.Claim memory b = registry.getClaim(second);
        assertEq(a.creator, alice);
        assertEq(b.creator, bob);
        assertEq(a.questionId, b.questionId);
        assertEq(a.conditionId, b.conditionId);
        assertEq(a.yesToken, b.yesToken);
        assertEq(a.noToken, b.noToken);
        assertEq(a.invalidToken, b.invalidToken);
    }

    // ---- UnexpectedMarketShape for each malformed market ----

    function _expectShapeRevert(CRMockSeerFactory.Mode mode) internal {
        factory.setMode(mode);
        address predicted = _nextMarket();
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnexpectedMarketShape.selector, predicted));
        vm.prank(alice);
        registry.createClaim(_params());
        assertEq(registry.claimCount(), 0);
        assertEq(registry.marketOf(alice, _params().claimDocumentSha256), address(0));
    }

    function test_shape_template3_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.Template3);
    }

    function test_shape_threeOutcomes_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.ThreeOutcomes);
    }

    function test_shape_twoQuestions_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.TwoQuestions);
    }

    function test_shape_wrongName_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.WrongName);
    }

    function test_shape_wrongEncodedQuestion_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.WrongEncodedQuestion);
    }

    function test_shape_zeroQuestionId_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.ZeroQuestionId);
    }

    function test_shape_zeroConditionId_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.ZeroConditionId);
    }

    function test_shape_zeroToken_reverts() public {
        _expectShapeRevert(CRMockSeerFactory.Mode.ZeroToken);
    }

    function test_shape_marketWithoutCode_reverts() public {
        factory.setMode(CRMockSeerFactory.Mode.ReturnNoCode);
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnexpectedMarketShape.selector, address(0xdead)));
        vm.prank(alice);
        registry.createClaim(_params());
    }

    function test_shape_alreadyRecordedMarket_reverts() public {
        vm.prank(alice);
        address first = registry.createClaim(_params());
        factory.setMode(CRMockSeerFactory.Mode.ReturnPrevious);
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.claimDocumentSha256 = keccak256("other document");
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnexpectedMarketShape.selector, first));
        vm.prank(bob);
        registry.createClaim(p);
        assertEq(registry.getClaim(first).creator, alice);
        assertEq(registry.claimCount(), 1);
    }

    // ---- Reentrancy (SEC-SC-12) ----

    function test_reentrancy_factoryCallbackIntoCreateClaim_reverts() public {
        CRReentrantSeerFactory evil = new CRReentrantSeerFactory(_expected());
        (, ClaimRegistry reg) = _deployPair(address(evil), FLOOR, _expected());
        IClaimRegistry.CreateClaimParams memory inner = _params();
        inner.claimDocumentSha256 = keccak256("inner document");
        evil.setReentryCalldata(abi.encodeCall(IClaimRegistry.createClaim, (inner)));

        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        reg.createClaim(_params());
        assertEq(reg.claimCount(), 0);
    }

    function test_reentrancy_guardReleasedAfterCall() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        vm.prank(alice);
        registry.createClaim(p);
        p.claimDocumentSha256 = keccak256("second document");
        vm.prank(alice);
        registry.createClaim(p);
        assertEq(registry.claimCount(), 2);
    }
}
