// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEvidenceRegistry} from "../../src/interfaces/IEvidenceRegistry.sol";
import {E2EScenarioBase} from "./E2EScenarioBase.sol";
import {E2EIGnosisRouter, E2EIRealityETH, E2EIRealityProxy} from "./E2EInterfaces.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";
import {PlanVectors, VectorPlan} from "./generated/PlanVectors.sol";

/// @notice Scenario A on the Gnosis fork (block 48550000, REAL pair, REAL Seer/Reality/CTF/Algebra): createClaim
/// (setUp) → commitEvidence → (warp) revealEvidence → (warp to the reveal deadline) Reality answers Yes, No and Invalid
/// from one claim via state snapshots → finalization after 302400 s → RealityProxy.resolve → CTF payouts; plus the
/// funding round inherited from E2EScenarioBase (YES = token1 orientation). Every Pine transaction is replayed from
/// the TypeScript plan calldata byte for byte.
contract E2ELifecycleATest is E2EScenarioBase {
    address internal holder = makeAddr("pine-e2e-holder");

    function _scenario() internal pure override returns (Scenario memory s) {
        s.market = PlanVectors.A_MARKET;
        s.yesToken = PlanVectors.A_YES_TOKEN;
        s.noToken = PlanVectors.A_NO_TOKEN;
        s.invalidToken = PlanVectors.A_INVALID_TOKEN;
        s.questionId = PlanVectors.A_QUESTION_ID;
        s.conditionId = PlanVectors.A_CONDITION_ID;
        s.sdaiShares = PlanVectors.A_SDAI_SHARES;
        s.question = PlanVectors.A_QUESTION;
        s.yesIsToken0 = PlanVectors.A_YES_IS_TOKEN0;
        s.token0 = PlanVectors.A_TOKEN0;
        s.token1 = PlanVectors.A_TOKEN1;
        s.tickLower = PlanVectors.A_TICK_LOWER;
        s.tickUpper = PlanVectors.A_TICK_UPPER;
        s.initSqrtPriceX96 = PlanVectors.A_INIT_SQRT_PRICE_X96;
        s.mintAmount = PlanVectors.A_MINT_AMOUNT;
        s.mintAmountMin = PlanVectors.A_MINT_AMOUNT_MIN;
        s.mintDeadline = PlanVectors.A_MINT_DEADLINE;
        s.params = _claimParamsA(PlanVectors.FORK_TIMESTAMP);
        s.create = PlanVectors.planACreateClaim();
        s.funding = PlanVectors.planAFunding();
        assert(s.params.evidenceDeadline == PlanVectors.A_EVIDENCE_DEADLINE);
        assert(s.params.revealDeadline == PlanVectors.A_REVEAL_DEADLINE);
    }

    function test_scenarioA_isTheYesToken1Orientation() public pure {
        assertFalse(PlanVectors.A_YES_IS_TOKEN0);
    }

    /// commit (before the evidence deadline) → reveal (after it, before the reveal deadline), both replayed.
    function test_replayedEvidence_commitThenReveal() public {
        _replayCommit();
        _replayReveal();
    }

    /// Reality answers Yes, No and Invalid on the same claim (snapshots), each finalized and resolved through
    /// RealityProxy; a complete-set holder's redemption pays exactly the winning slot (Invalid pays only INVALID).
    function test_lifecycle_answersYesNoInvalid_resolveAndPay() public {
        Scenario memory s = _scenario();
        _replayCommit();
        _replayReveal();

        // A complete set held through resolution (after createClaim; unrelated to the funding vectors).
        uint256 sets = 3 ether;
        vm.deal(holder, sets);
        vm.prank(holder);
        E2EIGnosisRouter(GNOSIS_ROUTER).splitFromBase{value: sets}(market);
        uint256 h = IERC20(s.yesToken).balanceOf(holder);
        assertGt(h, 0);

        // The question opens exactly at the reveal deadline (frozen: Reality opening time = revealDeadline).
        E2EIRealityETH reality = E2EIRealityETH(REALITIO);
        vm.warp(s.params.revealDeadline - 1);
        vm.deal(answerer, s.params.minBond);
        vm.prank(answerer);
        vm.expectRevert(bytes("opening date must have passed"));
        reality.submitAnswer{value: s.params.minBond}(s.questionId, ANSWER_YES, 0);
        vm.warp(s.params.revealDeadline);
        vm.expectRevert(bytes(NOT_FINALIZED));
        E2EIRealityProxy(REALITY_PROXY).resolve(market);

        uint256 opened = vm.snapshotState();
        _resolveAndRedeem(s, ANSWER_YES, 0, h);
        vm.revertToState(opened);
        _resolveAndRedeem(s, ANSWER_NO, 1, h);
        vm.revertToState(opened);
        _resolveAndRedeem(s, ANSWER_INVALID, 2, h);
    }

    function _resolveAndRedeem(Scenario memory s, bytes32 answer, uint256 winningIndex, uint256 h) internal {
        _answerAndResolve(s, answer);
        _assertPayoutNumerators(s.conditionId, winningIndex);
        _redeem(s, holder, [h, h, h], winningIndex);
        assertEq(IERC20(s.yesToken).balanceOf(holder), 0);
        assertEq(IERC20(s.noToken).balanceOf(holder), 0);
        assertEq(IERC20(s.invalidToken).balanceOf(holder), 0);
    }

    function _replayCommit() internal {
        VectorPlan memory plan = PlanVectors.planACommit();
        assertEq(plan.account, submitter);
        assertEq(plan.steps.length, 1);
        bytes32 commitment =
            evidence.computeCommitment(market, submitter, PlanInputs.EVIDENCE_CONTENT_SHA256, PlanInputs.EVIDENCE_SALT);
        assertEq(commitment, PlanVectors.EVIDENCE_COMMITMENT, "TypeScript commitment = EvidenceRegistry.computeCommitment");
        assertEq(plan.steps[0].to, address(evidence));
        assertEq(plan.steps[0].value, 0);
        assertEq(plan.steps[0].data, abi.encodeCall(IEvidenceRegistry.commitEvidence, (market, commitment)));

        uint256 id = abi.decode(_replay(plan, 0, "commit"), (uint256));
        assertEq(id, PlanInputs.EVIDENCE_SUBMISSION_ID);
        IEvidenceRegistry.Submission memory sub = evidence.getSubmission(id);
        assertEq(sub.market, market);
        assertEq(sub.submitter, submitter);
        assertEq(uint8(sub.status), uint8(IEvidenceRegistry.Status.Committed));
        assertEq(sub.commitment, commitment);
        assertEq(sub.committedAt, uint64(block.timestamp));
        assertEq(sub.contentSha256, bytes32(0));
    }

    function _replayReveal() internal {
        VectorPlan memory plan = PlanVectors.planAReveal();
        assertEq(plan.account, submitter);
        assertEq(
            plan.steps[0].data,
            abi.encodeCall(
                IEvidenceRegistry.revealEvidence,
                (PlanInputs.EVIDENCE_SUBMISSION_ID, PlanInputs.EVIDENCE_CONTENT_SHA256, PlanInputs.EVIDENCE_SALT)
            )
        );
        uint64 committedAt = evidence.getSubmission(PlanInputs.EVIDENCE_SUBMISSION_ID).committedAt;

        // At the evidence deadline the commit window is closed (strict `<`) and the reveal window open.
        vm.warp(PlanVectors.A_EVIDENCE_DEADLINE);
        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(
                IEvidenceRegistry.EvidenceWindowClosed.selector, market, PlanVectors.A_EVIDENCE_DEADLINE
            )
        );
        evidence.commitEvidence(market, keccak256("late"));

        // The same reveal calldata from anyone but the submitter is refused.
        vm.prank(creator);
        (bool ok, bytes memory err) = plan.steps[0].to.call(plan.steps[0].data);
        assertFalse(ok);
        assertEq(
            err, abi.encodeWithSelector(IEvidenceRegistry.NotSubmitter.selector, PlanInputs.EVIDENCE_SUBMISSION_ID)
        );

        _replay(plan, 0, "reveal");
        IEvidenceRegistry.Submission memory sub = evidence.getSubmission(PlanInputs.EVIDENCE_SUBMISSION_ID);
        assertEq(uint8(sub.status), uint8(IEvidenceRegistry.Status.Revealed));
        assertEq(sub.contentSha256, PlanInputs.EVIDENCE_CONTENT_SHA256);
        assertEq(sub.revealedAt, PlanVectors.A_EVIDENCE_DEADLINE);
        assertEq(sub.committedAt, committedAt);
        assertEq(evidence.submissionCount(), 1);
    }
}
