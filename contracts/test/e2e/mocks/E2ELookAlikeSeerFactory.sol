// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice A look-alike of the Seer MarketFactory: every getter the deploy script and the ClaimRegistry constructor
/// read returns the real factory's value, but the code is different (a hostile factory could create markets that
/// do not use them).
/// The deploy-script test etches it AT the real factory address, so only the runtime code-hash pin can refuse it.
contract E2ELookAlikeSeerFactory {
    function realitio() external pure returns (address) {
        return 0xE78996A233895bE74a66F451f1019cA9734205cc;
    }

    function arbitrator() external pure returns (address) {
        return 0x68154EA682f95BF582b80Dd6453FA401737491Dc;
    }

    function realityProxy() external pure returns (address) {
        return 0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C;
    }

    function conditionalTokens() external pure returns (address) {
        return 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce;
    }

    function wrapped1155Factory() external pure returns (address) {
        return 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f;
    }

    function collateralToken() external pure returns (address) {
        return 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    }

    function questionTimeout() external pure returns (uint32) {
        return 302_400;
    }

    function market() external pure returns (address) {
        return 0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a;
    }
}
