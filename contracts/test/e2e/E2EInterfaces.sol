// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// Test-local interfaces of the external Gnosis contracts the e2e tests drive (transcribed from the verified sources
// cited in docs/research/*.md and the frozen ABIs of packages/shared/src/abi/*.ts). Names carry an E2E prefix so they
// never collide with the frozen interface artifacts export-abis reads.

interface E2EIRealityETH {
    function submitAnswer(bytes32 questionId, bytes32 answer, uint256 maxPrevious) external payable;
    function getOpeningTS(bytes32 questionId) external view returns (uint32);
    function getTimeout(bytes32 questionId) external view returns (uint32);
    function getMinBond(bytes32 questionId) external view returns (uint256);
    function getArbitrator(bytes32 questionId) external view returns (address);
    function getFinalizeTS(bytes32 questionId) external view returns (uint32);
    function getBestAnswer(bytes32 questionId) external view returns (bytes32);
    function isFinalized(bytes32 questionId) external view returns (bool);
}

interface E2EIRealityProxy {
    function resolve(address market) external;
}

interface E2EIConditionalTokens {
    function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
    function payoutNumerators(bytes32 conditionId, uint256 index) external view returns (uint256);
    function payoutDenominator(bytes32 conditionId) external view returns (uint256);
}

interface E2EIGnosisRouter {
    function splitFromBase(address market) external payable;
    function redeemToBase(address market, uint256[] calldata outcomeIndexes, uint256[] calldata amounts) external;
}

/// sDAI (Savings xDAI, ERC-4626 over WXDAI).
interface E2EISavingsXDai {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function asset() external view returns (address);
}

interface E2EIWrappedNative {
    function deposit() external payable;
}

interface E2EIAlgebraFactory {
    function poolByPair(address tokenA, address tokenB) external view returns (address);
}

interface E2EIAlgebraPool {
    function globalState()
        external
        view
        returns (
            uint160 price,
            int24 tick,
            uint16 fee,
            uint16 timepointIndex,
            uint8 communityFeeToken0,
            uint8 communityFeeToken1,
            bool unlocked
        );
    function liquidity() external view returns (uint128);
    function tickSpacing() external view returns (int24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface E2EIPositionManager {
    struct MintParams {
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface E2EISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
