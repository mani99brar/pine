// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {CRForkBase} from "./CRForkBase.sol";

/// @notice Regression bound for the largest claim the registry accepts (docs/prd/PRD-07-hardening.md section 2): a
/// 120-byte title, repositoryId 2^53 - 1, the maximum evidence and reveal windows and the 10,000 xDAI min bond. The
/// creation stays below 5M gas, intrinsic transaction cost included (PRD-07 measured 3.37M; the twin, which reuses
/// Seer's question, condition and wrappers, is cheaper at 2.70M and is not repeated here). Every account it touches is
/// cold, as in a real transaction. RPC budget: one createClaim, in the only test of this contract.
contract CRForkMaxSizeTest is CRForkBase {
    uint256 internal constant GAS_BOUND = 5_000_000;
    uint256 internal constant TX_BASE_GAS = 21_000;
    /// A creation that measures below this did not run Seer's market creation: the measurement itself is broken.
    uint256 internal constant MEASUREMENT_FLOOR = 1_000_000;

    function test_fork_maxSizeCreateClaim_staysBelow5MGas() public {
        IClaimRegistry.CreateClaimParams memory p = _maxSizeParams();

        // Cold start: setUp ran in another transaction; cool the pair and the Seer stack anyway.
        vm.cool(address(registry));
        vm.cool(address(evidence));
        vm.cool(MARKET_FACTORY);
        vm.cool(REALITIO);
        vm.cool(REALITY_PROXY);
        vm.cool(CONDITIONAL_TOKENS);
        vm.cool(WRAPPED_1155_FACTORY);
        vm.cool(COLLATERAL);

        (address market, uint256 gasUsed) = _measuredCreate(alice, p);
        emit log_named_uint("max-size createClaim gas", gasUsed);
        assertLt(gasUsed, GAS_BOUND, "max-size creation within 5M gas");
        assertGt(gasUsed, MEASUREMENT_FLOOR, "max-size creation measured");

        // A real, recorded maximum-size creation.
        IClaimRegistry.Claim memory c = registry.getClaim(market);
        assertEq(c.creator, alice);
        assertEq(c.repositoryId, 2 ** 53 - 1);
        assertEq(c.minBond, registry.MAX_MIN_BOND());
        assertEq(c.evidenceDeadline, block.timestamp + registry.MAX_EVIDENCE_WINDOW());
        assertEq(c.revealDeadline, c.evidenceDeadline + registry.MAX_REVEAL_WINDOW());
        assertEq(registry.claimCount(), 1);
    }

    function _maxSizeParams() internal view returns (IClaimRegistry.CreateClaimParams memory p) {
        p = params;
        p.title = "Max-size claim: the longest title the registry accepts: 120 bytes of printable ASCII";
        while (bytes(p.title).length < registry.MAX_TITLE_BYTES()) {
            p.title = string.concat(p.title, ".");
        }
        assertEq(bytes(p.title).length, 120);
        p.repositoryId = 2 ** 53 - 1;
        p.evidenceDeadline = uint64(block.timestamp) + registry.MAX_EVIDENCE_WINDOW();
        p.revealDeadline = p.evidenceDeadline + registry.MAX_REVEAL_WINDOW();
        p.minBond = registry.MAX_MIN_BOND();
        assertEq(p.minBond, 10_000 ether);
    }

    /// @dev Gas of one createClaim transaction: execution measured around the call, plus the 21,000 base cost and the
    /// calldata at 16 gas per byte (every byte priced as nonzero; the EIP-7623 floor is far below this execution cost).
    function _measuredCreate(address creator, IClaimRegistry.CreateClaimParams memory p)
        internal
        returns (address market, uint256 gasUsed)
    {
        bytes memory data = abi.encodeCall(IClaimRegistry.createClaim, (p));
        vm.prank(creator);
        uint256 before = gasleft();
        (bool ok, bytes memory result) = address(registry).call(data);
        uint256 execution = before - gasleft();
        assertTrue(ok, "createClaim succeeded");
        market = abi.decode(result, (address));
        gasUsed = execution + TX_BASE_GAS + 16 * data.length;
    }
}
