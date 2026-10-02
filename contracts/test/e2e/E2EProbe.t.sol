// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {console} from "forge-std/console.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {E2EFork} from "./E2EFork.sol";
import {E2EIAlgebraFactory, E2EIGnosisRouter} from "./E2EInterfaces.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";

/// @notice Captures the fork-dependent values the plan vectors need (PRD-06 section 2) by running exactly the sequence
/// of the e2e tests: deploy the pair (E2EFork), then per scenario createClaim and splitFromBase{FUNDING_BUDGET_WEI}
/// with no warp in between. Scenario B runs from a state snapshot taken after the deployment, as it does in its own
/// test contract. Imports only PlanInputs.sol (operator clarification 1), so it compiles before PlanVectors.sol
/// exists. Its log is the content of scripts/fixtures/fork-observations.json:
///   cd contracts && forge test --match-contract E2EProbeTest -vv
/// then save the printed JSON line (keys sorted by the vector script on regeneration) and run the vector script.
contract E2EProbeTest is E2EFork {
    struct Probe {
        address market;
        address yesToken;
        address noToken;
        address invalidToken;
        bytes32 questionId;
        bytes32 conditionId;
        uint256 sdaiShares;
        address yesPoolBefore;
    }

    function setUp() public {
        _selectFork();
        _deployPair();
    }

    function test_probe_forkObservations() public {
        uint256 afterDeploy = vm.snapshotState();
        Probe memory a = _probe(_claimParamsA(block.timestamp));
        vm.revertToState(afterDeploy);
        Probe memory b = _probe(_claimParamsB(block.timestamp));

        // The two scenarios must cover both YES/sDAI orientations (otherwise pick another claim B digest).
        assertTrue((a.yesToken < COLLATERAL_TOKEN) != (b.yesToken < COLLATERAL_TOKEN), "scenarios cover both orientations");

        string memory json = string.concat("{", _kv("chainId", vm.toString(block.chainid), false));
        json = string.concat(json, _kv("forkBlock", _quoted(vm.toString(block.number)), true));
        json = string.concat(json, _kv("blockTimestamp", _quoted(vm.toString(block.timestamp)), true));
        json = string.concat(json, _kv("deployer", _addr(deployer), true));
        json = string.concat(json, _kv("deployerNonce", _quoted(vm.toString(uint256(deployment.deployerNonce))), true));
        json = string.concat(json, _kv("evidenceRegistry", _addr(address(evidence)), true));
        json = string.concat(json, _kv("claimRegistry", _addr(address(registry)), true));
        json = string.concat(json, _kv("creator", _addr(creator), true));
        json = string.concat(json, _kv("submitter", _addr(submitter), true));
        json = string.concat(json, _kv("funder", _addr(funder), true));
        string memory scenarios = string.concat("{", _kv("a", _probeJson(a), false), _kv("b", _probeJson(b), true), "}");
        json = string.concat(json, _kv("scenarios", scenarios, true), "}");
        console.log(json);
    }

    function _probe(IClaimRegistry.CreateClaimParams memory params) internal returns (Probe memory p) {
        vm.prank(creator);
        p.market = registry.createClaim(params);
        IClaimRegistry.Claim memory c = registry.getClaim(p.market);
        p.yesToken = c.yesToken;
        p.noToken = c.noToken;
        p.invalidToken = c.invalidToken;
        p.questionId = c.questionId;
        p.conditionId = c.conditionId;
        p.yesPoolBefore = E2EIAlgebraFactory(ALGEBRA_FACTORY).poolByPair(c.yesToken, COLLATERAL_TOKEN);

        vm.deal(funder, PlanInputs.FUNDING_BUDGET_WEI);
        vm.prank(funder);
        E2EIGnosisRouter(GNOSIS_ROUTER).splitFromBase{value: PlanInputs.FUNDING_BUDGET_WEI}(p.market);
        p.sdaiShares = IERC20(c.yesToken).balanceOf(funder);
        assertGt(p.sdaiShares, 0, "split minted shares");
        assertEq(IERC20(c.noToken).balanceOf(funder), p.sdaiShares, "complete set: NO");
        assertEq(IERC20(c.invalidToken).balanceOf(funder), p.sdaiShares, "complete set: INVALID");
    }

    function _probeJson(Probe memory p) internal pure returns (string memory) {
        string memory json = string.concat("{", _kv("market", _addr(p.market), false));
        json = string.concat(json, _kv("yesToken", _addr(p.yesToken), true));
        json = string.concat(json, _kv("noToken", _addr(p.noToken), true));
        json = string.concat(json, _kv("invalidToken", _addr(p.invalidToken), true));
        json = string.concat(json, _kv("questionId", _quoted(vm.toString(p.questionId)), true));
        json = string.concat(json, _kv("conditionId", _quoted(vm.toString(p.conditionId)), true));
        json = string.concat(json, _kv("sdaiShares", _quoted(vm.toString(p.sdaiShares)), true));
        return string.concat(json, _kv("yesPoolBefore", _addr(p.yesPoolBefore), true), "}");
    }

    function _kv(string memory key, string memory value, bool comma) internal pure returns (string memory) {
        return string.concat(comma ? "," : "", '"', key, '":', value);
    }

    function _quoted(string memory value) internal pure returns (string memory) {
        return string.concat('"', value, '"');
    }

    /// @dev Lowercase hex (vm.toString(address) is EIP-55 checksummed).
    function _addr(address account) internal pure returns (string memory) {
        return _quoted(vm.toString(abi.encodePacked(account)));
    }
}
