// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";

/// @notice Deploy.s.sol transcribes the GNOSIS_EXTERNAL constants (packages/shared/src/deployment.ts) it relies on; the
/// vector script emits the same values from GNOSIS_EXTERNAL into PlanInputs.sol (its --check keeps them current), so a
/// drift between the script and the shared manifest the API builds plans from fails here. No fork: constants only.
contract E2EDeployConstantsTest is Test, Deploy {
    function test_deployScriptConstants_equalGnosisExternal() public pure {
        assertEq(GNOSIS_CHAIN_ID, PlanInputs.GNOSIS_CHAIN_ID, "chain id");
        assertEq(SEER_MARKET_FACTORY, PlanInputs.SEER_MARKET_FACTORY, "seer.marketFactory");
        assertEq(SEER_MARKET_IMPLEMENTATION, PlanInputs.SEER_MARKET_IMPLEMENTATION, "seer.marketImplementation");
        assertEq(REALITIO, PlanInputs.REALITIO, "seer.realitio");
        assertEq(ARBITRATOR, PlanInputs.ARBITRATOR, "seer.arbitrator");
        assertEq(REALITY_PROXY, PlanInputs.REALITY_PROXY, "seer.realityProxy");
        assertEq(CONDITIONAL_TOKENS, PlanInputs.CONDITIONAL_TOKENS, "seer.conditionalTokens");
        assertEq(WRAPPED_1155_FACTORY, PlanInputs.WRAPPED_1155_FACTORY, "seer.wrapped1155Factory");
        assertEq(COLLATERAL_TOKEN, PlanInputs.COLLATERAL_TOKEN, "seer.collateralToken");
        assertEq(GNOSIS_ROUTER, PlanInputs.GNOSIS_ROUTER, "seer.gnosisRouter");
        assertEq(ALGEBRA_FACTORY, PlanInputs.ALGEBRA_FACTORY, "amm.factory");
        assertEq(POSITION_MANAGER, PlanInputs.POSITION_MANAGER, "amm.positionManager");
        assertEq(QUESTION_TIMEOUT, PlanInputs.QUESTION_TIMEOUT, "seer.questionTimeoutSeconds");
    }

    /// The external contracts the script checks for code and the Seer immutables it passes to the ClaimRegistry
    /// constructor are the GNOSIS_EXTERNAL values.
    function test_deployScriptExternalContracts_areTheGnosisExternalOnes() public pure {
        address[10] memory externals = _externalContracts();
        address[10] memory expected = [
            PlanInputs.REALITIO,
            PlanInputs.ARBITRATOR,
            PlanInputs.REALITY_PROXY,
            PlanInputs.CONDITIONAL_TOKENS,
            PlanInputs.WRAPPED_1155_FACTORY,
            PlanInputs.COLLATERAL_TOKEN,
            PlanInputs.GNOSIS_ROUTER,
            PlanInputs.ALGEBRA_FACTORY,
            PlanInputs.POSITION_MANAGER,
            PlanInputs.SEER_MARKET_IMPLEMENTATION
        ];
        for (uint256 i = 0; i < externals.length; ++i) {
            assertEq(externals[i], expected[i]);
        }
        ClaimRegistry.ExpectedSeer memory e = _expectedSeer();
        assertEq(e.realitio, PlanInputs.REALITIO);
        assertEq(e.arbitrator, PlanInputs.ARBITRATOR);
        assertEq(e.realityProxy, PlanInputs.REALITY_PROXY);
        assertEq(e.conditionalTokens, PlanInputs.CONDITIONAL_TOKENS);
        assertEq(e.wrapped1155Factory, PlanInputs.WRAPPED_1155_FACTORY);
        assertEq(e.collateralToken, PlanInputs.COLLATERAL_TOKEN);
        assertEq(e.questionTimeout, PlanInputs.QUESTION_TIMEOUT);
    }
}
