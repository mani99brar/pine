// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERBase} from "./ERBase.sol";

/// @notice SEC-SC-11: commit and reveal cost does not grow with the number of prior submissions. The 1st commit pays
/// the 0->1 counter write and is excluded; the 2nd and the 501st commit (500 prior submissions) are compared, each in
/// its own call, and likewise the reveals of ids 2 and 501.
contract ERGasTest is ERBase {
    uint256 internal constant TOLERANCE = 2_000;
    uint256 internal constant PRIOR = 500;

    function test_gas_commitAndRevealConstantAfter500Submissions() public {
        _commit(alice, DIGEST, SALT);

        (uint256 id2, uint256 commitGas2) = _measuredCommit(_salt(2));
        assertEq(id2, 2);
        uint256 revealGas2 = _measuredReveal(id2, _salt(2));

        for (uint256 i = 3; i <= PRIOR; ++i) {
            _commit(alice, DIGEST, _salt(i));
        }
        assertEq(registry.submissionCount(), PRIOR);

        (uint256 id501, uint256 commitGas501) = _measuredCommit(_salt(PRIOR + 1));
        assertEq(id501, PRIOR + 1);
        uint256 revealGas501 = _measuredReveal(id501, _salt(PRIOR + 1));

        assertApproxEqAbs(commitGas501, commitGas2, TOLERANCE, "commit gas grows with submissions");
        assertApproxEqAbs(revealGas501, revealGas2, TOLERANCE, "reveal gas grows with submissions");
    }

    function _salt(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", i));
    }

    function _measuredCommit(bytes32 salt) internal returns (uint256 id, uint256 gasUsed) {
        bytes32 commitment = _commitment(alice, DIGEST, salt);
        vm.prank(alice);
        uint256 before = gasleft();
        id = registry.commitEvidence(market, commitment);
        gasUsed = before - gasleft();
    }

    function _measuredReveal(uint256 id, bytes32 salt) internal returns (uint256 gasUsed) {
        vm.prank(alice);
        uint256 before = gasleft();
        registry.revealEvidence(id, DIGEST, salt);
        gasUsed = before - gasleft();
    }
}
