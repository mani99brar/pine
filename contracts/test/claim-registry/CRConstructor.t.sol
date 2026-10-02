// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {CRMockEvidenceRegistry} from "./mocks/CRMockEvidenceRegistry.sol";
import {CRTestBase} from "./CRTestBase.sol";

/// @notice Constructor refusals (SEC-SC-02): Seer immutables must equal the expected values, both dependencies must
/// have code, the evidence registry must be bound to this registry, and the min-bond floor must be in (0, MAX_MIN_BOND].
contract CRConstructorTest is CRTestBase {
    /// Deploys a mock evidence registry bound to the next CREATE address, then expects the constructor to revert.
    function _expectConstructorRevert(
        address seerFactory,
        uint256 floor,
        ClaimRegistry.ExpectedSeer memory expected,
        bytes memory err
    ) internal {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        CRMockEvidenceRegistry ev = new CRMockEvidenceRegistry(predicted);
        vm.expectRevert(err);
        new ClaimRegistry(seerFactory, address(ev), floor, expected);
    }

    function _mismatch(string memory getter) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ClaimRegistry.SeerConfigMismatch.selector, getter);
    }

    function test_validConfiguration_deploys() public {
        (CRMockEvidenceRegistry ev, ClaimRegistry reg) = _deployPair(address(factory), FLOOR, _expected());
        assertEq(ev.claimRegistry(), address(reg));
        assertEq(reg.evidenceRegistry(), address(ev));
        assertEq(reg.seerMarketFactory(), address(factory));
        assertEq(reg.minimumMinBond(), FLOOR);
    }

    function test_realitioMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.realitio = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("realitio"));
    }

    function test_arbitratorMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.arbitrator = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("arbitrator"));
    }

    function test_realityProxyMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.realityProxy = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("realityProxy"));
    }

    function test_conditionalTokensMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.conditionalTokens = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("conditionalTokens"));
    }

    function test_wrapped1155FactoryMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.wrapped1155Factory = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("wrapped1155Factory"));
    }

    function test_collateralTokenMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.collateralToken = address(1);
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("collateralToken"));
    }

    function test_questionTimeoutMismatch_reverts() public {
        ClaimRegistry.ExpectedSeer memory e = _expected();
        e.questionTimeout = 302_401;
        _expectConstructorRevert(address(factory), FLOOR, e, _mismatch("questionTimeout"));
    }

    function test_factoryWithoutCode_reverts() public {
        address eoa = makeAddr("not a factory");
        _expectConstructorRevert(eoa, FLOOR, _expected(), abi.encodeWithSelector(ClaimRegistry.NoCode.selector, eoa));
    }

    function test_evidenceRegistryWithoutCode_reverts() public {
        address empty = makeAddr("predicted but not deployed");
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NoCode.selector, empty));
        new ClaimRegistry(address(factory), empty, FLOOR, _expected());
    }

    function test_evidenceRegistryBoundElsewhere_reverts() public {
        address other = makeAddr("other registry");
        CRMockEvidenceRegistry ev = new CRMockEvidenceRegistry(other);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.EvidenceRegistryNotBound.selector, other));
        new ClaimRegistry(address(factory), address(ev), FLOOR, _expected());
    }

    /// A registry bound to the address one nonce too far (deployment order mistake) is refused.
    function test_evidenceRegistryBoundToWrongNonce_reverts() public {
        address wrong = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        CRMockEvidenceRegistry ev = new CRMockEvidenceRegistry(wrong);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.EvidenceRegistryNotBound.selector, wrong));
        new ClaimRegistry(address(factory), address(ev), FLOOR, _expected());
    }

    function test_evidenceRegistryWithoutClaimRegistryGetter_reverts() public {
        // The Seer factory has code but no claimRegistry() function.
        vm.expectRevert();
        new ClaimRegistry(address(factory), address(factory), FLOOR, _expected());
    }

    function test_zeroMinimumMinBond_reverts() public {
        _expectConstructorRevert(
            address(factory), 0, _expected(), abi.encodeWithSelector(ClaimRegistry.InvalidMinimumMinBond.selector, 0)
        );
    }

    function test_minimumMinBondAboveCap_reverts() public {
        _expectConstructorRevert(
            address(factory),
            10_000 ether + 1,
            _expected(),
            abi.encodeWithSelector(ClaimRegistry.InvalidMinimumMinBond.selector, 10_000 ether + 1)
        );
    }

    function test_minimumMinBondAtCap_deploys() public {
        (, ClaimRegistry reg) = _deployPair(address(factory), 10_000 ether, _expected());
        assertEq(reg.minimumMinBond(), 10_000 ether);
    }
}
