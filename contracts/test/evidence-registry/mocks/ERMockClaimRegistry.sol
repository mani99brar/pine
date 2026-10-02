// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IClaimRegistry} from "../../../src/interfaces/IClaimRegistry.sol";

/// @notice Test-local stand-in for the parts of IClaimRegistry the EvidenceRegistry reads (isRegistered, getClaim).
/// getClaim reverts IClaimRegistry.UnknownMarket for unregistered markets, like the real registry.
contract ERMockClaimRegistry {
    mapping(address market => IClaimRegistry.Claim) private _claims;
    mapping(address market => bool) public isRegistered;

    function setClaim(address market, uint64 evidenceDeadline, uint64 revealDeadline) external {
        IClaimRegistry.Claim storage claim = _claims[market];
        claim.creator = msg.sender;
        claim.createdAt = uint64(block.timestamp);
        claim.evidenceDeadline = evidenceDeadline;
        claim.revealDeadline = revealDeadline;
        isRegistered[market] = true;
    }

    function getClaim(address market) external view returns (IClaimRegistry.Claim memory) {
        if (!isRegistered[market]) revert IClaimRegistry.UnknownMarket(market);
        return _claims[market];
    }
}

/// @notice A registry whose reads try to write storage: any call that is not a STATICCALL succeeds and records it, a
/// STATICCALL reverts. Used to prove the EvidenceRegistry only staticcalls its registry.
contract ERWritingClaimRegistry {
    uint256 public calls;

    function isRegistered(address) external returns (bool) {
        ++calls;
        return true;
    }

    function getClaim(address) external returns (IClaimRegistry.Claim memory claim) {
        ++calls;
        claim.evidenceDeadline = type(uint64).max;
        claim.revealDeadline = type(uint64).max;
    }
}

/// @notice Reverts on every call; the EvidenceRegistry constructor must not call its registry.
contract ERRevertingClaimRegistry {
    fallback() external {
        revert("called");
    }
}
