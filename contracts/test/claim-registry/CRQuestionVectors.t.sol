// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {QuestionText} from "../../src/libraries/QuestionText.sol";
import {RawCid} from "../../src/libraries/RawCid.sol";
import {UtcTime} from "../../src/libraries/UtcTime.sol";
import {CRMockEvidenceRegistry} from "./mocks/CRMockEvidenceRegistry.sol";
import {CRTestBase} from "./CRTestBase.sol";
import {CRVectors} from "./CRVectors.sol";

/// @notice Exposes the pure library functions so tests can call them with arbitrary inputs (no validation, no clock).
contract CRQuestionHarness {
    function composeQuestion(address evidenceRegistry, IClaimRegistry.CreateClaimParams memory params)
        external
        pure
        returns (string memory)
    {
        return QuestionText.composeQuestion(evidenceRegistry, params);
    }

    function encodedQuestion(string memory marketName) external pure returns (string memory) {
        return QuestionText.encodedQuestion(marketName);
    }

    function formatUtc(uint64 timestamp) external pure returns (string memory) {
        return UtcTime.formatUtc(timestamp);
    }

    function rawCid(bytes32 digest) external pure returns (string memory) {
        return RawCid.rawCid(digest);
    }

    function tokenNames(bytes32 digest) external pure returns (string memory, string memory) {
        return QuestionText.tokenNames(digest);
    }
}

/// @notice Byte-exact agreement with the frozen TypeScript vectors (SEC-SC-05, SEC-CLAIM-05) plus fuzzed references.
contract CRQuestionVectorsTest is CRTestBase {
    CRQuestionHarness internal harness;

    function setUp() public override {
        super.setUp();
        harness = new CRQuestionHarness();
    }

    // ---- QUESTION_VECTORS ----

    function test_composeQuestion_matchesEveryQuestionVector() public view {
        CRVectors.QuestionVector[] memory v = CRVectors.questionVectors();
        for (uint256 i = 0; i < v.length; ++i) {
            assertEq(harness.composeQuestion(v[i].evidenceRegistry, v[i].params), v[i].question, vm.toString(i));
        }
    }

    /// Each vector through the deployed renderQuestion: a registry bound to the vector's evidence-registry address
    /// (mock runtime code etched there) at a block time where the vector's deadlines are valid.
    function test_renderQuestion_deployed_matchesEveryQuestionVector() public {
        CRVectors.QuestionVector[] memory v = CRVectors.questionVectors();
        for (uint256 i = 0; i < v.length; ++i) {
            vm.warp(v[i].params.evidenceDeadline - 2 days);
            ClaimRegistry reg = _registryBoundTo(v[i].evidenceRegistry);
            assertEq(reg.renderQuestion(v[i].params), v[i].question, vm.toString(i));
        }
    }

    /// createClaim passes the identical string to Seer and records its keccak256.
    function test_createClaim_vector0_sendsExactQuestionToSeer() public {
        CRVectors.QuestionVector memory v = CRVectors.questionVectors()[0];
        vm.warp(v.params.evidenceDeadline - 2 days);
        ClaimRegistry reg = _registryBoundTo(v.evidenceRegistry);

        vm.recordLogs();
        vm.prank(alice);
        address market = reg.createClaim(v.params);

        assertEq(factory.lastMarketName(), v.question);
        assertEq(reg.getClaim(market).marketNameHash, keccak256(bytes(v.question)));
        assertEq(
            factory.lastParamsHash(), keccak256(abi.encode(_expectedMarketParams(v.params, v.question, "11111111")))
        );

        // The event carries the same question and title.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = IClaimRegistry.ClaimCreated.selector;
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(reg) || logs[i].topics[0] != topic) continue;
            (, string memory title, string memory marketName) =
                abi.decode(logs[i].data, (IClaimRegistry.Claim, string, string));
            assertEq(marketName, v.question);
            assertEq(title, v.params.title);
            found = true;
        }
        assertTrue(found, "ClaimCreated");
    }

    function _registryBoundTo(address evidenceAddress) internal returns (ClaimRegistry reg) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        CRMockEvidenceRegistry template = new CRMockEvidenceRegistry(predicted);
        vm.etch(evidenceAddress, address(template).code);
        reg = new ClaimRegistry(address(factory), evidenceAddress, FLOOR, _expected());
        assertEq(address(reg), predicted);
        assertEq(reg.evidenceRegistry(), evidenceAddress);
    }

    /// The largest accepted repositoryId (2^53 - 1) renders in decimal; above it renderQuestion reverts
    /// RepositoryIdOutOfRange (decisions.md), covered in CRValidation.
    function test_renderQuestion_repositoryIdMaxSafeInteger() public view {
        IClaimRegistry.CreateClaimParams memory p = _params();
        p.repositoryId = 2 ** 53 - 1;
        string memory q = registry.renderQuestion(p);
        assertTrue(_contains(q, "for GitHub repository id 9007199254740991 at commit "));
    }

    // ---- Encoded question (what Seer stores in Market.encodedQuestions(0)) ----

    function test_encodedQuestion_usesU241FSeparators() public view {
        assertEq(
            bytes(harness.encodedQuestion("Q")),
            abi.encodePacked("Q", hex"e2909f", '"Yes","No"', hex"e2909f", "misc", hex"e2909f", "en_US")
        );
    }

    // ---- UTC_FORMAT_VECTORS ----

    function test_formatUtc_matchesEveryVector() public view {
        CRVectors.UtcVector[] memory v = CRVectors.utcVectors();
        for (uint256 i = 0; i < v.length; ++i) {
            assertEq(harness.formatUtc(v[i].timestamp), v[i].text, vm.toString(v[i].timestamp));
        }
    }

    function testFuzz_formatUtc_matchesNaiveReference(uint32 timestamp) public view {
        assertEq(harness.formatUtc(timestamp), _naiveUtc(timestamp));
    }

    function test_formatUtc_naiveReferenceAgreesOnYearBoundaries() public view {
        // 1972-01-01, 2000-01-01, 2000-12-31 23:59:59, 2100-01-01, 2104-02-29.
        uint32[5] memory ts = [uint32(63_072_000), 946_684_800, 978_307_199, 4_102_444_800, 4_233_686_400];
        for (uint256 i = 0; i < ts.length; ++i) {
            assertEq(harness.formatUtc(ts[i]), _naiveUtc(ts[i]));
        }
        assertEq(harness.formatUtc(4_233_686_400), "2104-02-29 00:00:00");
    }

    /// Naive reference: subtract whole years and months day by day count, then format with vm.toString.
    function _naiveUtc(uint256 t) internal pure returns (string memory) {
        uint256 dayCount = t / 86_400;
        uint256 rem = t % 86_400;
        uint256 year = 1970;
        while (true) {
            uint256 len = _isLeap(year) ? 366 : 365;
            if (dayCount < len) break;
            dayCount -= len;
            ++year;
        }
        uint8[12] memory monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (_isLeap(year)) monthLengths[1] = 29;
        uint256 month = 0;
        while (dayCount >= monthLengths[month]) {
            dayCount -= monthLengths[month];
            ++month;
        }
        return string.concat(
            vm.toString(year),
            "-",
            _pad2(month + 1),
            "-",
            _pad2(dayCount + 1),
            " ",
            _pad2(rem / 3600),
            ":",
            _pad2((rem / 60) % 60),
            ":",
            _pad2(rem % 60)
        );
    }

    function _isLeap(uint256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    function _pad2(uint256 x) internal pure returns (string memory) {
        return x < 10 ? string.concat("0", vm.toString(x)) : vm.toString(x);
    }

    // ---- RAW_CID_VECTORS ----

    function test_rawCid_matchesEveryVector() public view {
        CRVectors.CidVector[] memory v = CRVectors.rawCidVectors();
        for (uint256 i = 0; i < v.length; ++i) {
            assertEq(harness.rawCid(v[i].digest), v[i].cid, vm.toString(v[i].digest));
            assertEq(bytes(v[i].cid).length, 59);
        }
    }

    function testFuzz_rawCid_matchesBitByBitReference(bytes32 digest) public view {
        assertEq(harness.rawCid(digest), _referenceCid(digest));
    }

    /// Bit-by-bit RFC 4648 base32 (lowercase, no padding) of 0x01 0x55 0x12 0x20 || digest, prefixed "b".
    function _referenceCid(bytes32 digest) internal pure returns (string memory) {
        bytes memory input = abi.encodePacked(hex"01551220", digest);
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        uint256 totalBits = input.length * 8; // 288
        uint256 chars = (totalBits + 4) / 5; // 58
        bytes memory out = new bytes(chars + 1);
        out[0] = "b";
        for (uint256 c = 0; c < chars; ++c) {
            uint256 value = 0;
            for (uint256 b = 0; b < 5; ++b) {
                uint256 bitIndex = c * 5 + b;
                uint256 bit = bitIndex < totalBits ? (uint8(input[bitIndex / 8]) >> (7 - (bitIndex % 8))) & 1 : 0;
                value = (value << 1) | bit;
            }
            out[c + 1] = alphabet[value];
        }
        return string(out);
    }

    // ---- TOKEN_NAME_VECTORS ----

    function test_tokenNames_matchEveryVector() public view {
        CRVectors.TokenNameVector[] memory v = CRVectors.tokenNameVectors();
        for (uint256 i = 0; i < v.length; ++i) {
            (string memory yes, string memory no) = harness.tokenNames(v[i].claimDocumentSha256);
            assertEq(yes, v[i].yes);
            assertEq(no, v[i].no);
        }
    }

    function testFuzz_tokenNames_prefixIsFirstFourDigestBytes(bytes32 digest) public view {
        (string memory yes, string memory no) = harness.tokenNames(digest);
        string memory hex8 = _lowerHex(abi.encodePacked(bytes4(digest)));
        assertEq(yes, string.concat("PY_", hex8));
        assertEq(no, string.concat("PN_", hex8));
    }

    function _lowerHex(bytes memory data) internal pure returns (string memory) {
        bytes memory s = bytes(vm.toString(data)); // "0x" + lowercase hex
        bytes memory out = new bytes(s.length - 2);
        for (uint256 i = 2; i < s.length; ++i) {
            out[i - 2] = s[i];
        }
        return string(out);
    }

    // ---- Injection safety (SEC-CLAIM-05): no '"', '\' or control characters in any valid question, and the only
    // brackets are the template's title delimiters ----

    function testFuzz_question_neverContainsJsonBreakingBytes(
        bytes32 claimSha,
        bytes32 policySha,
        uint64 repositoryId,
        bytes20 commit,
        address evidenceAddress,
        bytes memory rawTitle,
        uint32 evidenceDeadline,
        uint32 revealDeadline
    ) public view {
        IClaimRegistry.CreateClaimParams memory p;
        p.claimDocumentSha256 = claimSha;
        p.policyDocumentSha256 = policySha;
        p.repositoryId = repositoryId;
        p.commit = commit;
        p.evidenceDeadline = evidenceDeadline;
        p.revealDeadline = revealDeadline;
        p.title = _validTitle(rawTitle);
        bytes memory q = bytes(harness.composeQuestion(evidenceAddress, p));
        uint256 titleEnd = 12 + bytes(p.title).length; // "Pine claim [" is 12 bytes
        for (uint256 i = 0; i < q.length; ++i) {
            bytes1 b = q[i];
            assertTrue(b >= 0x20 && b <= 0x7e && b != 0x22 && b != 0x5c, "forbidden byte in question");
            if (b == 0x5b) assertEq(i, 11, "'[' outside the title delimiter");
            if (b == 0x5d) assertEq(i, titleEnd, "']' outside the title delimiter");
        }
        assertEq(bytes(harness.encodedQuestion(string(q))).length, q.length + 3 * 3 + 10 + 4 + 5);
    }

    /// Maps arbitrary bytes onto the accepted title alphabet (printable ASCII minus '"', '\', '[' and ']'), 1..120 bytes.
    function _validTitle(bytes memory raw) internal pure returns (string memory) {
        uint256 n = raw.length == 0 ? 1 : (raw.length > 120 ? 120 : raw.length);
        bytes memory t = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            uint8 c = uint8(0x20 + (i < raw.length ? uint8(raw[i]) : 0) % 95);
            if (c == 0x22 || c == 0x5c || c == 0x5b || c == 0x5d) c = 0x5f;
            t[i] = bytes1(c);
        }
        return string(t);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        for (uint256 i = 0; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
