// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IClaimRegistry} from "../interfaces/IClaimRegistry.sol";
import {RawCid} from "./RawCid.sol";
import {UtcTime} from "./UtcTime.sol";

/// @title QuestionText
/// @notice Pure composition of the market question, the Seer encoded question and the outcome token names. Performs no
/// validation: ClaimRegistry validates the parameters before composing. Byte-identical to renderQuestion() and
/// tokenNames() in packages/shared/src/question.ts (QUESTION_VECTORS, TOKEN_NAME_VECTORS).
library QuestionText {
    bytes16 private constant HEX_DIGITS = "0123456789abcdef";
    /// U+241F SYMBOL FOR UNIT SEPARATOR, the field separator of Seer's Reality template-2 encoding.
    string internal constant SEPARATOR = hex"e2909f";

    /// @notice The market question (see IClaimRegistry.renderQuestion).
    function composeQuestion(address evidenceRegistry, IClaimRegistry.CreateClaimParams memory params)
        internal
        pure
        returns (string memory)
    {
        return string.concat(_header(evidenceRegistry, params), _target(params), _terms(params));
    }

    /// @notice What Seer stores as Market.encodedQuestions(0) for a ["Yes","No"] market in category "misc", lang "en_US":
    /// `marketName ␟ "Yes","No" ␟ misc ␟ en_US`.
    function encodedQuestion(string memory marketName) internal pure returns (string memory) {
        return string.concat(marketName, SEPARATOR, '"Yes","No"', SEPARATOR, "misc", SEPARATOR, "en_US");
    }

    /// @notice ["PY_" + hex8, "PN_" + hex8], hex8 = first 4 bytes of the claim-document digest as lowercase hex.
    function tokenNames(bytes32 claimDocumentSha256) internal pure returns (string memory yes, string memory no) {
        string memory prefix = toHexLower(uint256(claimDocumentSha256) >> 224, 4);
        yes = string.concat("PY_", prefix);
        no = string.concat("PN_", prefix);
    }

    /// @notice `byteLength` bytes of `value` (low-order) as 2 * byteLength lowercase hex characters, no prefix.
    function toHexLower(uint256 value, uint256 byteLength) internal pure returns (string memory) {
        bytes memory out = new bytes(2 * byteLength);
        for (uint256 i = 2 * byteLength; i != 0; --i) {
            out[i - 1] = HEX_DIGITS[value & 0xf];
            value >>= 4;
        }
        return string(out);
    }

    function _header(address evidenceRegistry, IClaimRegistry.CreateClaimParams memory params)
        private
        pure
        returns (string memory)
    {
        return string.concat(
            "Pine claim [",
            params.title,
            "]: was a reproducible counterexample submitted to evidence registry 0x",
            toHexLower(uint160(evidenceRegistry), 20),
            " on Gnosis, recorded before ",
            UtcTime.formatUtc(params.evidenceDeadline),
            " UTC and disclosed before ",
            UtcTime.formatUtc(params.revealDeadline),
            " UTC, "
        );
    }

    function _target(IClaimRegistry.CreateClaimParams memory params) private pure returns (string memory) {
        return string.concat(
            "for GitHub repository id ",
            Strings.toString(params.repositoryId),
            " at commit ",
            toHexLower(uint160(params.commit), 20),
            "? Terms: claim document ipfs://",
            RawCid.rawCid(params.claimDocumentSha256),
            " (sha256 0x",
            toHexLower(uint256(params.claimDocumentSha256), 32),
            "), "
        );
    }

    function _terms(IClaimRegistry.CreateClaimParams memory params) private pure returns (string memory) {
        return string.concat(
            "policy ipfs://",
            RawCid.rawCid(params.policyDocumentSha256),
            " (sha256 0x",
            toHexLower(uint256(params.policyDocumentSha256), 32),
            "). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
        );
    }
}
