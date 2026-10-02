// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";

/// @notice Cross-language vector: EVIDENCE_COMMITMENT_VECTOR in packages/shared/src/testing/vectors.ts (FROZEN).
contract ERVectorTest is Test {
    bytes32 internal constant TYPEHASH = 0x39252baa9e1d793d1e7c90d6eb7a5cbde75f900e250ba793859fdd5c8e567865;
    uint256 internal constant CHAIN_ID = 100;
    address internal constant REGISTRY = 0x1111111111111111111111111111111111111111;
    address internal constant MARKET = 0x2222222222222222222222222222222222222222;
    address internal constant SUBMITTER = 0x3333333333333333333333333333333333333333;
    bytes32 internal constant CONTENT_SHA256 = 0x4444444444444444444444444444444444444444444444444444444444444444;
    bytes32 internal constant SALT = 0x5555555555555555555555555555555555555555555555555555555555555555;
    bytes32 internal constant COMMITMENT = 0xabb073d23ecc75cb6f84541dac5b614ded2b1c1fad1f8ab83823245b3313d18b;

    function test_commitmentVector() public {
        deployCodeTo("EvidenceRegistry.sol:EvidenceRegistry", abi.encode(makeAddr("claimRegistry")), REGISTRY);
        vm.chainId(CHAIN_ID);
        EvidenceRegistry registry = EvidenceRegistry(REGISTRY);

        assertEq(registry.COMMITMENT_TYPEHASH(), TYPEHASH, "typehash");
        assertEq(registry.computeCommitment(MARKET, SUBMITTER, CONTENT_SHA256, SALT), COMMITMENT, "commitment");
    }

    function test_commitmentVector_otherChainDiffers() public {
        deployCodeTo("EvidenceRegistry.sol:EvidenceRegistry", abi.encode(makeAddr("claimRegistry")), REGISTRY);
        vm.chainId(CHAIN_ID + 1);
        assertNotEq(EvidenceRegistry(REGISTRY).computeCommitment(MARKET, SUBMITTER, CONTENT_SHA256, SALT), COMMITMENT);
    }
}
