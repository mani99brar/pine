// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title RawCid
/// @notice CIDv1 (raw codec 0x55, sha2-256 multihash 0x12 0x20) of a SHA-256 digest in multibase base32-lower:
/// "b" + base32(0x01 0x55 0x12 0x20 || digest) without padding, 59 characters. Matches rawCidFromSha256() in
/// packages/shared/src/canonical.ts (RAW_CID_VECTORS).
library RawCid {
    bytes32 private constant ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

    function rawCid(bytes32 digest) internal pure returns (string memory) {
        // 36 input bytes = 288 bits = 7 groups of 40 bits (8 characters each) + 1 trailing byte (2 characters).
        bytes memory input = abi.encodePacked(bytes4(0x01551220), digest);
        bytes memory out = new bytes(59);
        out[0] = "b";
        uint256 cursor = 1;
        for (uint256 group = 0; group < 7; ++group) {
            uint256 chunk;
            for (uint256 j = 0; j < 5; ++j) {
                chunk = (chunk << 8) | uint8(input[group * 5 + j]);
            }
            for (uint256 k = 8; k != 0; --k) {
                out[cursor + k - 1] = ALPHABET[chunk & 31];
                chunk >>= 5;
            }
            cursor += 8;
        }
        uint8 last = uint8(input[35]);
        out[57] = ALPHABET[last >> 3];
        out[58] = ALPHABET[(last & 7) << 2];
        return string(out);
    }
}
