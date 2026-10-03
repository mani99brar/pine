// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title UtcTime
/// @notice Renders unix seconds as "YYYY-MM-DD HH:MM:SS" (UTC, zero-padded, 24-hour clock), byte-identical to
/// formatUtc() in packages/shared/src/question.ts for every value in [0, 2^32). Years above 9999 (only reachable
/// with inputs far beyond 2^32) are rendered with all their digits.
library UtcTime {
    uint256 private constant SECONDS_PER_DAY = 86_400;

    function formatUtc(uint64 timestamp) internal pure returns (string memory) {
        (uint256 year, uint256 month, uint256 day) = civilFromDays(uint256(timestamp) / SECONDS_PER_DAY);
        uint256 secondOfDay = uint256(timestamp) % SECONDS_PER_DAY;
        return string(
            bytes.concat(
                _year(year),
                "-",
                _twoDigits(month),
                "-",
                _twoDigits(day),
                " ",
                _twoDigits(secondOfDay / 3600),
                ":",
                _twoDigits((secondOfDay % 3600) / 60),
                ":",
                _twoDigits(secondOfDay % 60)
            )
        );
    }

    /// @notice Proleptic Gregorian date of the given number of days since 1970-01-01 (H. Hinnant's civil_from_days,
    /// restricted to non-negative day counts so every intermediate value is non-negative).
    function civilFromDays(uint256 daysSinceEpoch) internal pure returns (uint256 year, uint256 month, uint256 day) {
        uint256 z = daysSinceEpoch + 719_468;
        uint256 era = z / 146_097;
        uint256 dayOfEra = z - era * 146_097; // [0, 146096]
        uint256 yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365; // [0, 399]
        uint256 dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100); // [0, 365], March-based
        uint256 monthIndex = (5 * dayOfYear + 2) / 153; // [0, 11], 0 = March
        day = dayOfYear - (153 * monthIndex + 2) / 5 + 1;
        month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
        year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
    }

    function _twoDigits(uint256 value) private pure returns (bytes memory out) {
        out = new bytes(2);
        out[0] = bytes1(uint8(48 + value / 10));
        out[1] = bytes1(uint8(48 + value % 10));
    }

    /// @dev At least four digits, zero-padded.
    function _year(uint256 value) private pure returns (bytes memory out) {
        uint256 digits = 4;
        for (uint256 rest = value / 10_000; rest != 0; rest /= 10) {
            ++digits;
        }
        out = new bytes(digits);
        for (uint256 i = digits; i != 0; --i) {
            out[i - 1] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
    }
}
