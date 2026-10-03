// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";

/// @notice Transcription of the FROZEN cross-language vectors in packages/shared/src/testing/vectors.ts
/// (QUESTION_VECTORS, UTC_FORMAT_VECTORS, RAW_CID_VECTORS, TOKEN_NAME_VECTORS). Solidity tests cannot read files
/// (fs_permissions = []), so the values are copied verbatim; addresses and commits are written as hex literals.
library CRVectors {
    struct QuestionVector {
        address evidenceRegistry;
        IClaimRegistry.CreateClaimParams params;
        string question;
    }

    struct UtcVector {
        uint64 timestamp;
        string text;
    }

    struct CidVector {
        bytes32 digest;
        string cid;
    }

    struct TokenNameVector {
        bytes32 claimDocumentSha256;
        string yes;
        string no;
    }

    /// minBond is not part of the question; vectors use 1 ether (any value within the bounds).
    function questionVectors() internal pure returns (QuestionVector[] memory v) {
        v = new QuestionVector[](3);
        v[0] = QuestionVector({
            evidenceRegistry: address(bytes20(hex"00000000000000000000000000000000000e01de")),
            params: IClaimRegistry.CreateClaimParams({
                claimDocumentSha256: bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111"),
                policyDocumentSha256: bytes32(hex"9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc"),
                repositoryId: 427016914,
                commit: bytes20(hex"ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12"),
                evidenceDeadline: 1791158400,
                revealDeadline: 1791331200,
                minBond: 1 ether,
                title: "Reporter deposits never use arbitration funds or the operator gas reserve"
            }),
            question: "Pine claim [Reporter deposits never use arbitration funds or the operator gas reserve]: was a reproducible counterexample submitted to evidence registry 0x00000000000000000000000000000000000e01de on Gnosis, recorded before 2026-10-05 00:00:00 UTC and disclosed before 2026-10-07 00:00:00 UTC, for GitHub repository id 427016914 at commit ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12? Terms: claim document ipfs://bafkreiarceirceirceirceirceirceirceirceirceirceirceirceirce (sha256 0x1111111111111111111111111111111111111111111111111111111111111111), policy ipfs://bafkreieuas4qw7vchkv4istyw5vrtz5rk3uor75oy2m32evu3k63fwrm7q (sha256 0x9404b90b7ea23aabc44a78b76b19e7b156e8e8ffaec699bd12b4dabdb2da2cfc). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
        });
        v[1] = QuestionVector({
            evidenceRegistry: address(bytes20(hex"ffffffffffffffffffffffffffffffffffffffff")),
            params: IClaimRegistry.CreateClaimParams({
                claimDocumentSha256: bytes32(hex"0000000000000000000000000000000000000000000000000000000000000001"),
                policyDocumentSha256: bytes32(hex"ff00000000000000000000000000000000000000000000000000000000000000"),
                repositoryId: 1,
                commit: bytes20(hex"0000000000000000000000000000000000000001"),
                evidenceDeadline: 4294880895,
                revealDeadline: 4294967295,
                minBond: 1 ether,
                title: "x"
            }),
            question: "Pine claim [x]: was a reproducible counterexample submitted to evidence registry 0xffffffffffffffffffffffffffffffffffffffff on Gnosis, recorded before 2106-02-06 06:28:15 UTC and disclosed before 2106-02-07 06:28:15 UTC, for GitHub repository id 1 at commit 0000000000000000000000000000000000000001? Terms: claim document ipfs://bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae (sha256 0x0000000000000000000000000000000000000000000000000000000000000001), policy ipfs://bafkreih7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (sha256 0xff00000000000000000000000000000000000000000000000000000000000000). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
        });
        v[2] = QuestionVector({
            evidenceRegistry: address(bytes20(hex"1234567890abcdef1234567890abcdef12345678")),
            params: IClaimRegistry.CreateClaimParams({
                claimDocumentSha256: bytes32(hex"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
                policyDocumentSha256: bytes32(hex"95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7"),
                repositoryId: 9007199254740991,
                commit: bytes20(hex"ffffffffffffffffffffffffffffffffffffffff"),
                evidenceDeadline: 1709164800,
                revealDeadline: 1709251200,
                minBond: 1 ether,
                title: " ~!#$%&'()*+,-./0123456789:;<=>?@^_`{|}"
            }),
            question: "Pine claim [ ~!#$%&'()*+,-./0123456789:;<=>?@^_`{|}]: was a reproducible counterexample submitted to evidence registry 0x1234567890abcdef1234567890abcdef12345678 on Gnosis, recorded before 2024-02-29 00:00:00 UTC and disclosed before 2024-03-01 00:00:00 UTC, for GitHub repository id 9007199254740991 at commit ffffffffffffffffffffffffffffffffffffffff? Terms: claim document ipfs://bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku (sha256 0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855), policy ipfs://bafkreievo4wckp4t23rwz2dd7uodottyh3q725poympfkiujxlazko7f64 (sha256 0x95772c253f93d6e36ce863fd1c374e783ee1fd75eec31e552289bac1953be5f7). Yes = at least one timely admissible counterexample; No = none; admissibility per the policy."
        });
    }

    function utcVectors() internal pure returns (UtcVector[] memory v) {
        v = new UtcVector[](14);
        v[0] = UtcVector(0, "1970-01-01 00:00:00");
        v[1] = UtcVector(59, "1970-01-01 00:00:59");
        v[2] = UtcVector(86399, "1970-01-01 23:59:59");
        v[3] = UtcVector(86400, "1970-01-02 00:00:00");
        v[4] = UtcVector(951782399, "2000-02-28 23:59:59");
        v[5] = UtcVector(951782400, "2000-02-29 00:00:00");
        v[6] = UtcVector(1709164799, "2024-02-28 23:59:59");
        v[7] = UtcVector(1709164800, "2024-02-29 00:00:00");
        v[8] = UtcVector(1709251200, "2024-03-01 00:00:00");
        v[9] = UtcVector(1791158400, "2026-10-05 00:00:00");
        v[10] = UtcVector(1893455999, "2029-12-31 23:59:59");
        v[11] = UtcVector(4107542399, "2100-02-28 23:59:59");
        v[12] = UtcVector(4107542400, "2100-03-01 00:00:00");
        v[13] = UtcVector(4294967295, "2106-02-07 06:28:15");
    }

    function rawCidVectors() internal pure returns (CidVector[] memory v) {
        v = new CidVector[](4);
        v[0] = CidVector(
            bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111"),
            "bafkreiarceirceirceirceirceirceirceirceirceirceirceirceirce"
        );
        v[1] = CidVector(
            bytes32(hex"0000000000000000000000000000000000000000000000000000000000000001"),
            "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae"
        );
        v[2] = CidVector(
            bytes32(hex"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        );
        v[3] = CidVector(
            bytes32(hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
            "bafkreih777777777777777777777777777777777777777777777777774"
        );
    }

    function tokenNameVectors() internal pure returns (TokenNameVector[] memory v) {
        v = new TokenNameVector[](2);
        v[0] = TokenNameVector(
            bytes32(hex"1111111111111111111111111111111111111111111111111111111111111111"), "PY_11111111", "PN_11111111"
        );
        v[1] = TokenNameVector(
            bytes32(hex"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "PY_e3b0c442", "PN_e3b0c442"
        );
    }
}
