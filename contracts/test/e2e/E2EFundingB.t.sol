// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {E2EScenarioBase} from "./E2EScenarioBase.sol";
import {PlanVectors} from "./generated/PlanVectors.sol";

/// @notice Scenario B: a second claim whose YES token sorts below sDAI (YES = token0), with its own fork observations,
/// covering the other ladder orientation. Runs the same sequence before createClaim as the probe and scenario A
/// (operator clarification 2) and inherits the replayed createClaim and funding tests.
contract E2EFundingBTest is E2EScenarioBase {
    function _scenario() internal pure override returns (Scenario memory s) {
        s.market = PlanVectors.B_MARKET;
        s.yesToken = PlanVectors.B_YES_TOKEN;
        s.noToken = PlanVectors.B_NO_TOKEN;
        s.invalidToken = PlanVectors.B_INVALID_TOKEN;
        s.questionId = PlanVectors.B_QUESTION_ID;
        s.conditionId = PlanVectors.B_CONDITION_ID;
        s.sdaiShares = PlanVectors.B_SDAI_SHARES;
        s.question = PlanVectors.B_QUESTION;
        s.yesIsToken0 = PlanVectors.B_YES_IS_TOKEN0;
        s.token0 = PlanVectors.B_TOKEN0;
        s.token1 = PlanVectors.B_TOKEN1;
        s.tickLower = PlanVectors.B_TICK_LOWER;
        s.tickUpper = PlanVectors.B_TICK_UPPER;
        s.initSqrtPriceX96 = PlanVectors.B_INIT_SQRT_PRICE_X96;
        s.mintAmount = PlanVectors.B_MINT_AMOUNT;
        s.mintAmountMin = PlanVectors.B_MINT_AMOUNT_MIN;
        s.mintDeadline = PlanVectors.B_MINT_DEADLINE;
        s.params = _claimParamsB(PlanVectors.FORK_TIMESTAMP);
        s.create = PlanVectors.planBCreateClaim();
        s.funding = PlanVectors.planBFunding();
        assert(s.params.evidenceDeadline == PlanVectors.B_EVIDENCE_DEADLINE);
        assert(s.params.revealDeadline == PlanVectors.B_REVEAL_DEADLINE);
    }

    function test_scenarioB_isTheYesToken0Orientation() public pure {
        assertTrue(PlanVectors.B_YES_IS_TOKEN0);
    }
}
