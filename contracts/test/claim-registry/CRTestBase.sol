// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {ISeerMarketFactory} from "../../src/interfaces/external/ISeer.sol";
import {CRMockEvidenceRegistry} from "./mocks/CRMockEvidenceRegistry.sol";
import {CRMockSeerFactory} from "./mocks/CRMockSeer.sol";

/// @notice Shared fixture: mock Seer factory, mock evidence registry deployed first with the registry's predicted
/// address (the real deployment order), and a ClaimRegistry bound to both.
abstract contract CRTestBase is Test {
    uint256 internal constant FLOOR = 1 ether;
    uint64 internal constant START = 1_790_000_000; // 2026-09-21

    CRMockSeerFactory internal factory;
    CRMockEvidenceRegistry internal evidence;
    ClaimRegistry internal registry;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual {
        vm.warp(START);
        factory = new CRMockSeerFactory(_expected());
        (evidence, registry) = _deployPair(address(factory), FLOOR, _expected());
    }

    function _expected() internal pure returns (ClaimRegistry.ExpectedSeer memory) {
        return ClaimRegistry.ExpectedSeer({
            realitio: 0xE78996A233895bE74a66F451f1019cA9734205cc,
            arbitrator: 0x68154EA682f95BF582b80Dd6453FA401737491Dc,
            realityProxy: 0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C,
            conditionalTokens: 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce,
            wrapped1155Factory: 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f,
            collateralToken: 0xaf204776c7245bF4147c2612BF6e5972Ee483701,
            questionTimeout: 302_400
        });
    }

    /// @dev EvidenceRegistry first (nonce n) with the ClaimRegistry's predicted address (nonce n + 1).
    function _deployPair(address seerFactory, uint256 floor, ClaimRegistry.ExpectedSeer memory expected)
        internal
        returns (CRMockEvidenceRegistry ev, ClaimRegistry reg)
    {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        ev = new CRMockEvidenceRegistry(predicted);
        reg = new ClaimRegistry(seerFactory, address(ev), floor, expected);
        assertEq(address(reg), predicted, "prediction");
    }

    function _params() internal view returns (IClaimRegistry.CreateClaimParams memory p) {
        p.claimDocumentSha256 = 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855;
        p.policyDocumentSha256 = 0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc;
        p.repositoryId = 427_016_914;
        p.commit = bytes20(hex"ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12");
        p.evidenceDeadline = uint64(block.timestamp) + 14 days;
        p.revealDeadline = p.evidenceDeadline + 2 days;
        p.minBond = 10 ether;
        p.title = "Reporter deposits never use arbitration funds";
    }

    /// @dev The CreateMarketParams ClaimRegistry must send to Seer, built independently of the registry.
    function _expectedMarketParams(
        IClaimRegistry.CreateClaimParams memory p,
        string memory question,
        string memory hex8
    ) internal pure returns (ISeerMarketFactory.CreateMarketParams memory m) {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        string[] memory names = new string[](2);
        names[0] = string.concat("PY_", hex8);
        names[1] = string.concat("PN_", hex8);
        m = ISeerMarketFactory.CreateMarketParams({
            marketName: question,
            outcomes: outcomes,
            questionStart: "",
            questionEnd: "",
            outcomeType: "",
            parentOutcome: 0,
            parentMarket: address(0),
            category: "misc",
            lang: "en_US",
            lowerBound: 0,
            upperBound: 0,
            minBond: p.minBond,
            openingTime: uint32(p.revealDeadline),
            tokenNames: names
        });
    }
}
