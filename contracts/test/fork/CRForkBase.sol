// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {CRMockEvidenceRegistry} from "../claim-registry/mocks/CRMockEvidenceRegistry.sol";

/// @notice Shared setUp of the ClaimRegistry fork tests: a Gnosis fork pinned at block 48550000 (read-only: nothing is
/// broadcast, no key is used), a test-local mock EvidenceRegistry deployed first and bound to the registry's predicted
/// address, then the ClaimRegistry against the REAL Seer MarketFactory. One fork per test contract (RPC budget,
/// features/chain/decisions.md).
abstract contract CRForkBase is Test {
    uint256 internal constant FORK_BLOCK = 48_550_000;

    // GNOSIS_EXTERNAL (packages/shared/src/deployment.ts).
    address internal constant MARKET_FACTORY = 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1;
    address internal constant REALITIO = 0xE78996A233895bE74a66F451f1019cA9734205cc;
    address internal constant ARBITRATOR = 0x68154EA682f95BF582b80Dd6453FA401737491Dc;
    address internal constant REALITY_PROXY = 0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C;
    address internal constant CONDITIONAL_TOKENS = 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce;
    address internal constant WRAPPED_1155_FACTORY = 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f;
    address internal constant COLLATERAL = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    uint32 internal constant QUESTION_TIMEOUT = 302_400;

    ClaimRegistry internal registry;
    CRMockEvidenceRegistry internal evidence;
    IClaimRegistry.CreateClaimParams internal params;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com")), FORK_BLOCK);
        assertEq(block.number, FORK_BLOCK);
        assertEq(block.chainid, 100);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        evidence = new CRMockEvidenceRegistry(predicted);
        registry = new ClaimRegistry(MARKET_FACTORY, address(evidence), 1 ether, _expected());
        assertEq(address(registry), predicted);

        params = IClaimRegistry.CreateClaimParams({
            claimDocumentSha256: 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855,
            policyDocumentSha256: 0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc,
            repositoryId: 427_016_914,
            commit: bytes20(hex"ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"),
            evidenceDeadline: uint64(block.timestamp) + 14 days,
            revealDeadline: uint64(block.timestamp) + 16 days,
            minBond: 5 ether,
            title: "Reporter deposits never use arbitration funds"
        });
    }

    function _expected() internal pure returns (ClaimRegistry.ExpectedSeer memory) {
        return ClaimRegistry.ExpectedSeer({
            realitio: REALITIO,
            arbitrator: ARBITRATOR,
            realityProxy: REALITY_PROXY,
            conditionalTokens: CONDITIONAL_TOKENS,
            wrapped1155Factory: WRAPPED_1155_FACTORY,
            collateralToken: COLLATERAL,
            questionTimeout: QUESTION_TIMEOUT
        });
    }
}
