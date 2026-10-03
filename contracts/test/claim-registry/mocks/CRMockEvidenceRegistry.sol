// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Test-local stand-in for the EvidenceRegistry (written by another lane): only the binding getter the
/// ClaimRegistry constructor reads. The binding is an immutable, so `vm.etch` of the runtime code keeps it.
contract CRMockEvidenceRegistry {
    address public immutable claimRegistry;

    constructor(address claimRegistry_) {
        claimRegistry = claimRegistry_;
    }
}
