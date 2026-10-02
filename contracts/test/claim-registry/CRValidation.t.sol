// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {CRTestBase} from "./CRTestBase.sol";

/// @notice Every createClaim validation error with exact boundary values (SEC-SC-07, SEC-SC-18, SEC-CLAIM-05,
/// SEC-CLAIM-07). renderQuestion shares the validation; a sample of cases runs through it too.
contract CRValidationTest is CRTestBase {
    function _create(IClaimRegistry.CreateClaimParams memory p) internal returns (address) {
        vm.prank(alice);
        return registry.createClaim(p);
    }

    function _expectRevertBoth(IClaimRegistry.CreateClaimParams memory p, bytes memory err) internal {
        vm.expectRevert(err);
        registry.renderQuestion(p);
        vm.expectRevert(err);
        vm.prank(alice);
        registry.createClaim(p);
    }

    function test_constants() public view {
        assertEq(registry.MIN_EVIDENCE_WINDOW(), 1 days);
        assertEq(registry.MAX_EVIDENCE_WINDOW(), 90 days);
        assertEq(registry.MIN_REVEAL_WINDOW(), 12 hours);
        assertEq(registry.MAX_REVEAL_WINDOW(), 7 days);
        assertEq(registry.MAX_TITLE_BYTES(), 120);
        assertEq(registry.MAX_MIN_BOND(), 10_000 ether);
        assertEq(registry.minimumMinBond(), FLOOR);
        assertEq(registry.seerMarketFactory(), address(factory));
        assertEq(registry.evidenceRegistry(), address(evidence));
        assertEq(registry.deploymentChainId(), block.chainid);
    }

    // ---- ZeroValue ----

    function test_zeroClaimDocumentSha256_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.claimDocumentSha256 = bytes32(0);
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
    }

    function test_zeroPolicyDocumentSha256_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.policyDocumentSha256 = bytes32(0);
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
    }

    function test_zeroRepositoryId_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = 0;
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
    }

    function test_zeroCommit_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.commit = bytes20(0);
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
    }

    // ---- repositoryId: 1..2^53 - 1 (RepositoryIdOutOfRange is declared in ClaimRegistry, not the interface) ----

    function _repositoryIdErr(uint64 value) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(ClaimRegistry.RepositoryIdOutOfRange.selector, value);
    }

    function test_repositoryId_oneAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = 1;
        _create(p);
    }

    function test_repositoryId_maxSafeIntegerAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = 2 ** 53 - 1;
        assertEq(p.repositoryId, 9_007_199_254_740_991);
        registry.renderQuestion(p);
        address market = _create(p);
        assertEq(registry.getClaim(market).repositoryId, 2 ** 53 - 1);
    }

    function test_repositoryId_2pow53_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = 2 ** 53;
        _expectRevertBoth(p, _repositoryIdErr(2 ** 53));
    }

    function test_repositoryId_uint64Max_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = type(uint64).max;
        _expectRevertBoth(p, _repositoryIdErr(type(uint64).max));
    }

    function testFuzz_repositoryId_range(uint64 value) public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = value;
        if (value == 0) vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
        else if (value > 2 ** 53 - 1) vm.expectRevert(_repositoryIdErr(value));
        registry.renderQuestion(p);
    }

    // ---- Evidence window: block.timestamp + 1 days <= evidenceDeadline <= block.timestamp + 90 days ----

    function _evidenceErr(uint64 value) internal view returns (bytes memory) {
        uint64 nowTs = uint64(block.timestamp);
        return abi.encodeWithSelector(
            IClaimRegistry.EvidenceDeadlineOutOfRange.selector, value, nowTs + 1 days, nowTs + 90 days
        );
    }

    function _withEvidence(uint64 evidenceDeadline) internal view returns (IClaimRegistry.CreateClaimParams memory p) {
        p = _params();
        p.evidenceDeadline = evidenceDeadline;
        p.revealDeadline = evidenceDeadline + 1 days;
    }

    function test_evidenceDeadline_earliestAccepted() public {
        _create(_withEvidence(uint64(block.timestamp) + 1 days));
    }

    function test_evidenceDeadline_oneSecondBeforeEarliest_reverts() public {
        uint64 value = uint64(block.timestamp) + 1 days - 1;
        _expectRevertBoth(_withEvidence(value), _evidenceErr(value));
    }

    function test_evidenceDeadline_latestAccepted() public {
        _create(_withEvidence(uint64(block.timestamp) + 90 days));
    }

    function test_evidenceDeadline_oneSecondAfterLatest_reverts() public {
        uint64 value = uint64(block.timestamp) + 90 days + 1;
        _expectRevertBoth(_withEvidence(value), _evidenceErr(value));
    }

    function test_evidenceDeadline_inThePast_reverts() public {
        uint64 value = uint64(block.timestamp) - 1;
        _expectRevertBoth(_withEvidence(value), _evidenceErr(value));
    }

    function testFuzz_evidenceDeadline_window(uint64 value) public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.evidenceDeadline = value;
        uint64 nowTs = uint64(block.timestamp);
        if (value < nowTs + 1 days || value > nowTs + 90 days) {
            vm.expectRevert(_evidenceErr(value));
            registry.renderQuestion(p);
        } else {
            p.revealDeadline = value + 12 hours;
            registry.renderQuestion(p);
        }
    }

    // ---- Reveal window: evidenceDeadline + 12 hours <= revealDeadline <= min(evidenceDeadline + 7 days, 2^32 - 1) ----

    function _revealErr(uint64 value, uint64 earliest, uint64 latest) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IClaimRegistry.RevealDeadlineOutOfRange.selector, value, earliest, latest);
    }

    function test_revealDeadline_earliestAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.revealDeadline = p.evidenceDeadline + 12 hours;
        _create(p);
    }

    function test_revealDeadline_oneSecondBeforeEarliest_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.revealDeadline = p.evidenceDeadline + 12 hours - 1;
        _expectRevertBoth(p, _revealErr(p.revealDeadline, p.evidenceDeadline + 12 hours, p.evidenceDeadline + 7 days));
    }

    function test_revealDeadline_equalToEvidenceDeadline_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.revealDeadline = p.evidenceDeadline;
        _expectRevertBoth(p, _revealErr(p.revealDeadline, p.evidenceDeadline + 12 hours, p.evidenceDeadline + 7 days));
    }

    function test_revealDeadline_latestAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.revealDeadline = p.evidenceDeadline + 7 days;
        _create(p);
    }

    function test_revealDeadline_oneSecondAfterLatest_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.revealDeadline = p.evidenceDeadline + 7 days + 1;
        _expectRevertBoth(p, _revealErr(p.revealDeadline, p.evidenceDeadline + 12 hours, p.evidenceDeadline + 7 days));
    }

    /// Near 2106 the uint32 cap is the effective latest bound.
    function test_revealDeadline_uint32Cap_acceptedAtCap_rejectedAbove() public {
        uint64 cap = type(uint32).max;
        vm.warp(cap - 1 days - 3 days); // evidence deadline 3 days before the cap: + 7 days would exceed it
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.evidenceDeadline = uint64(block.timestamp) + 1 days;
        p.revealDeadline = cap;
        _create(p);

        p.claimDocumentSha256 = keccak256("another document");
        p.revealDeadline = cap + 1;
        _expectRevertBoth(p, _revealErr(cap + 1, p.evidenceDeadline + 12 hours, cap));
    }

    /// When evidenceDeadline + 12 hours > 2^32 - 1, earliest > latest and every value reverts with those bounds.
    function test_revealDeadline_emptyRangeNear2106_everyValueReverts() public {
        uint64 cap = type(uint32).max;
        vm.warp(cap - 1 days - 6 hours); // evidence deadline = cap - 6 hours
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.evidenceDeadline = uint64(block.timestamp) + 1 days;
        uint64 earliest = p.evidenceDeadline + 12 hours;
        assertGt(earliest, cap);

        uint64[5] memory values = [p.evidenceDeadline, cap - 1, cap, earliest, earliest + 7 days];
        for (uint256 i = 0; i < values.length; ++i) {
            p.revealDeadline = values[i];
            _expectRevertBoth(p, _revealErr(values[i], earliest, cap));
        }
    }

    function testFuzz_revealDeadline_window(uint64 evidenceOffset, uint64 value) public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.evidenceDeadline = uint64(block.timestamp) + uint64(bound(evidenceOffset, 1 days, 90 days));
        p.revealDeadline = value;
        uint64 earliest = p.evidenceDeadline + 12 hours;
        uint64 latest = p.evidenceDeadline + 7 days;
        if (value < earliest || value > latest) {
            vm.expectRevert(_revealErr(value, earliest, latest));
        }
        registry.renderQuestion(p);
    }

    // ---- Min bond: minimumMinBond <= minBond <= MAX_MIN_BOND ----

    function test_minBond_floorAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.minBond = FLOOR;
        _create(p);
    }

    function test_minBond_belowFloor_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.minBond = FLOOR - 1;
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.MinBondTooLow.selector, FLOOR - 1, FLOOR));
        p.minBond = 0;
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.MinBondTooLow.selector, 0, FLOOR));
    }

    function test_minBond_capAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.minBond = 10_000 ether;
        _create(p);
    }

    function test_minBond_aboveCap_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.minBond = 10_000 ether + 1;
        _expectRevertBoth(
            p, abi.encodeWithSelector(IClaimRegistry.MinBondTooHigh.selector, 10_000 ether + 1, 10_000 ether)
        );
        p.minBond = type(uint256).max;
        _expectRevertBoth(
            p, abi.encodeWithSelector(IClaimRegistry.MinBondTooHigh.selector, type(uint256).max, 10_000 ether)
        );
    }

    // ---- Title: 1..120 bytes of 0x20..0x7E except '"', '\', '[' and ']' ----

    function _repeat(bytes1 b, uint256 n) internal pure returns (string memory) {
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = b;
        }
        return string(out);
    }

    function test_title_empty_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "";
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.TitleLength.selector, 0));
    }

    function test_title_oneByteAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "x";
        _create(p);
    }

    function test_title_120BytesAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = _repeat("a", 120);
        _create(p);
    }

    function test_title_121Bytes_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = _repeat("a", 121);
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.TitleLength.selector, 121));
    }

    function test_title_printableBoundariesAccepted() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = " ~!#$%&'()*+,-./0123456789:;<=>?@^_`{|}"; // 0x20 and 0x7E included
        _create(p);
    }

    function _titleByteErr(uint256 index) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IClaimRegistry.TitleForbiddenByte.selector, index);
    }

    function test_title_controlBytes_revert() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = string(hex"00");
        _expectRevertBoth(p, _titleByteErr(0));
        p.title = string(abi.encodePacked("abc", hex"0a"));
        _expectRevertBoth(p, _titleByteErr(3));
        p.title = string(abi.encodePacked("ab", hex"09", "c"));
        _expectRevertBoth(p, _titleByteErr(2));
        p.title = string(abi.encodePacked("a", hex"1f"));
        _expectRevertBoth(p, _titleByteErr(1));
    }

    function test_title_del_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = string(abi.encodePacked("abcd", hex"7f"));
        _expectRevertBoth(p, _titleByteErr(4));
    }

    function test_title_doubleQuote_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = 'say "yes"';
        _expectRevertBoth(p, _titleByteErr(4));
    }

    function test_title_backslash_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "a\\nb";
        _expectRevertBoth(p, _titleByteErr(1));
    }

    function test_title_openingBracket_revertsAtFirstMiddleAndLastIndex() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "[abc";
        _expectRevertBoth(p, _titleByteErr(0));
        p.title = "ab[cd";
        _expectRevertBoth(p, _titleByteErr(2));
        p.title = "abcd[";
        _expectRevertBoth(p, _titleByteErr(4));
    }

    function test_title_closingBracket_revertsAtFirstMiddleAndLastIndex() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "]abc";
        _expectRevertBoth(p, _titleByteErr(0));
        p.title = "ab]cd";
        _expectRevertBoth(p, _titleByteErr(2));
        p.title = "abcd]";
        _expectRevertBoth(p, _titleByteErr(4));
    }

    /// A 120-byte title ending in ']' (the delimiter-closing attempt at the longest length) still reverts at index 119.
    function test_title_closingBracketAtMaxLength_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = string.concat(_repeat("a", 119), "]");
        _expectRevertBoth(p, _titleByteErr(119));
    }

    function test_title_utf8Multibyte_reverts() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = unicode"café";
        _expectRevertBoth(p, _titleByteErr(3));
        // U+241F (Seer's separator) is rejected at its first byte.
        p.title = string(abi.encodePacked("x", hex"e2909f", "y"));
        _expectRevertBoth(p, _titleByteErr(1));
    }

    function testFuzz_title_singleByteClass(uint8 b, uint8 position) public {
        uint256 index = bound(position, 0, 9);
        bytes memory title = bytes("0123456789");
        title[index] = bytes1(b);
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = string(title);
        bool allowed = b >= 0x20 && b <= 0x7e && b != 0x22 && b != 0x5c && b != 0x5b && b != 0x5d;
        if (!allowed) vm.expectRevert(_titleByteErr(index));
        registry.renderQuestion(p);
    }

    /// Validation order: the first failing rule reports (zero values before windows before bond before title).
    function test_validationOrder() public {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.title = "";
        p.minBond = 0;
        p.commit = bytes20(0);
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.ZeroValue.selector));
        p.commit = bytes20(uint160(1));
        _expectRevertBoth(p, abi.encodeWithSelector(IClaimRegistry.MinBondTooLow.selector, 0, FLOOR));
    }
}
