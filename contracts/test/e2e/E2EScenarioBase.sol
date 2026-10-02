// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {ISeerMarket} from "../../src/interfaces/external/ISeer.sol";
import {E2EFork} from "./E2EFork.sol";
import {
    E2EIAlgebraFactory,
    E2EIAlgebraPool,
    E2EIConditionalTokens,
    E2EIGnosisRouter,
    E2EIPositionManager,
    E2EIRealityETH,
    E2EIRealityProxy,
    E2EISavingsXDai,
    E2EISwapRouter,
    E2EIWrappedNative
} from "./E2EInterfaces.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";
import {PlanVectors, VectorPlan, VectorStep} from "./generated/PlanVectors.sol";

/// @notice One claim scenario on the Gnosis fork: the probe's exact sequence (fork, deployer, REAL pair, createClaim
/// replayed from the TypeScript plan) in setUp, then tests that replay the remaining plans byte for byte and check
/// their effects. Concrete contracts pick scenario A (lifecycle, YES = token1) or B (other orientation, YES = token0).
abstract contract E2EScenarioBase is E2EFork {
    /// Algebra rounds liquidity down, so the mint may pull a few wei less than the exact approval (decisions.md):
    /// the residual allowance after the one ladder mint is at most this, in total, and only toward the position manager.
    uint256 internal constant MAX_RESIDUAL_ALLOWANCE = 10;
    /// YES rounding dust the swap and the burn leave in the pool (both round in the pool's favour; ~20 wei observed).
    /// Not the residual-allowance bound: the exact dust is asserted against the pool balance.
    uint256 internal constant MAX_POOL_DUST = 100;
    bytes32 internal constant ANSWER_YES = bytes32(uint256(0));
    bytes32 internal constant ANSWER_NO = bytes32(uint256(1));
    bytes32 internal constant ANSWER_INVALID = bytes32(type(uint256).max);
    /// Lower bound of the ladder's YES price (1.0001^-16080 ~ 0.2003 sDAI per YES), rounded down to 0.2.
    uint256 internal constant LADDER_LOWER_PRICE_FLOOR_WAD = 0.2 ether;

    struct Scenario {
        address market;
        address yesToken;
        address noToken;
        address invalidToken;
        bytes32 questionId;
        bytes32 conditionId;
        uint256 sdaiShares;
        string question;
        bool yesIsToken0;
        address token0;
        address token1;
        int24 tickLower;
        int24 tickUpper;
        uint160 initSqrtPriceX96;
        uint256 mintAmount;
        uint256 mintAmountMin;
        uint256 mintDeadline;
        IClaimRegistry.CreateClaimParams params;
        VectorPlan create;
        VectorPlan funding;
    }

    address internal market;
    address internal buyer = makeAddr("pine-e2e-buyer");
    address internal answerer = makeAddr("pine-e2e-answerer");

    // Funding round state shared between the steps of the funding test (keeps each helper's stack small).
    address internal pool;
    uint256 internal tokenId;
    uint128 internal positionLiquidity;
    uint256 internal yesInPosition;
    uint256 internal buyerSdaiIn;
    uint256 internal buyerYesOut;

    function _scenario() internal pure virtual returns (Scenario memory);

    function setUp() public virtual {
        _selectFork();
        _assertForkObservations();
        _deployPair();
        assertEq(address(evidence), PlanVectors.EVIDENCE_REGISTRY, "observed evidence registry");
        assertEq(address(registry), PlanVectors.CLAIM_REGISTRY, "observed claim registry");

        Scenario memory s = _scenario();
        // The TypeScript calldata equals the Solidity ABI encoding of the same inputs (PlanInputs + observed timestamp).
        VectorStep memory step = s.create.steps[0];
        assertEq(s.create.steps.length, 1, "create plan has one step");
        assertEq(s.create.account, creator, "create plan account");
        assertEq(step.to, address(registry), "create step target");
        assertEq(step.value, 0, "create step value");
        assertEq(step.data, abi.encodeCall(IClaimRegistry.createClaim, (s.params)), "createClaim calldata");

        market = abi.decode(_replay(s.create, 0, "create"), (address));
        assertEq(market, s.market, "observed market");
    }

    /// @dev Values the probe observed before any deployment: fork timestamp and the labelled accounts.
    function _assertForkObservations() internal view {
        assertEq(block.timestamp, PlanVectors.FORK_TIMESTAMP, "observed fork timestamp");
        assertEq(deployer, PlanVectors.DEPLOYER, "observed deployer");
        assertEq(uint256(vm.getNonce(deployer)), uint256(PlanVectors.DEPLOYER_NONCE), "observed deployer nonce");
        assertEq(creator, PlanVectors.CREATOR, "observed creator");
        assertEq(submitter, PlanVectors.SUBMITTER, "observed submitter");
        assertEq(funder, PlanVectors.FUNDER, "observed funder");
    }

    /// @dev Sends one plan step from the plan account, byte for byte; bubbles a revert.
    function _replay(VectorPlan memory plan, uint256 index, string memory expectedId) internal returns (bytes memory) {
        VectorStep memory step = plan.steps[index];
        assertEq(step.id, expectedId, "step order");
        vm.prank(plan.account);
        (bool ok, bytes memory result) = step.to.call{value: step.value}(step.data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }

    // ------------------------------------------------------------------------------------------------------------
    // createClaim
    // ------------------------------------------------------------------------------------------------------------

    function test_replayedCreateClaim_recordsTheRealSeerMarket() public view {
        Scenario memory s = _scenario();
        IClaimRegistry.Claim memory c = registry.getClaim(market);
        assertEq(c.creator, creator);
        assertEq(c.createdAt, uint64(PlanVectors.FORK_TIMESTAMP));
        assertEq(c.evidenceDeadline, s.params.evidenceDeadline);
        assertEq(c.revealDeadline, s.params.revealDeadline);
        assertEq(c.repositoryId, s.params.repositoryId);
        assertEq(c.commit, s.params.commit);
        assertEq(c.claimDocumentSha256, s.params.claimDocumentSha256);
        assertEq(c.policyDocumentSha256, s.params.policyDocumentSha256);
        assertEq(c.minBond, s.params.minBond);
        assertEq(c.questionId, s.questionId, "observed question id");
        assertEq(c.conditionId, s.conditionId, "observed condition id");
        assertEq(c.yesToken, s.yesToken, "observed YES");
        assertEq(c.noToken, s.noToken, "observed NO");
        assertEq(c.invalidToken, s.invalidToken, "observed INVALID");
        assertTrue(registry.isRegistered(market));
        assertEq(registry.marketOf(creator, s.params.claimDocumentSha256), market);
        assertEq(registry.claimCount(), 1);

        // The question rendered by @pine/shared (TypeScript) is the on-chain market name and renderQuestion().
        assertEq(ISeerMarket(market).marketName(), s.question, "TypeScript renderQuestion = Seer market name");
        assertEq(registry.renderQuestion(s.params), s.question, "TypeScript renderQuestion = registry.renderQuestion");
        assertEq(c.marketNameHash, keccak256(bytes(s.question)));

        E2EIRealityETH reality = E2EIRealityETH(REALITIO);
        assertEq(reality.getOpeningTS(s.questionId), s.params.revealDeadline, "Reality opens at the reveal deadline");
        assertEq(reality.getTimeout(s.questionId), QUESTION_TIMEOUT);
        assertEq(reality.getMinBond(s.questionId), s.params.minBond);
        assertEq(reality.getArbitrator(s.questionId), ARBITRATOR);
        assertEq(E2EIConditionalTokens(CONDITIONAL_TOKENS).getOutcomeSlotCount(s.conditionId), 3);
        assertEq(IERC20Metadata(s.invalidToken).symbol(), "SER-INVALID");
    }

    // ------------------------------------------------------------------------------------------------------------
    // Funding: split, exact approval, pool, single-sided YES mint, a buyer swap, resolution Yes, payouts
    // ------------------------------------------------------------------------------------------------------------

    function test_replayedFunding_ladderMintSwapAndPayoutsAfterYes() public {
        Scenario memory s = _scenario();
        _assertFundingCalldata(s);
        // No warp, split or sDAI deposit happened before this split (operator clarification 3), so the shares minted
        // equal the observed shares and the exact approval of the plan stays valid.
        _replaySplitAndApprove(s);
        _replayPoolAndMint(s);
        _buyYes(s);
        _answerAndResolve(s, ANSWER_YES);
        _assertPayoutNumerators(s.conditionId, 0);
        _redeemAfterYes(s);
    }

    /// @dev The funding calldata built in TypeScript equals the Solidity encoding of independently derived values.
    function _assertFundingCalldata(Scenario memory s) internal pure {
        VectorPlan memory plan = s.funding;
        assertEq(plan.steps.length, 4, "split, approve, create pool, mint");
        // Ladder math, recomputed: margin, slippage floor, orientation, ticks inside the requested YES prices.
        uint256 margin = (s.sdaiShares * PlanInputs.SHARE_MARGIN_BPS + 9_999) / 10_000;
        assertEq(s.mintAmount, s.sdaiShares - margin, "S = shares - ceil(shares * 10 bps)");
        assertEq(s.mintAmountMin, s.mintAmount - (s.mintAmount * PlanInputs.MINT_SLIPPAGE_BPS) / 10_000, "amountMin");
        assertEq(s.yesIsToken0, s.yesToken < COLLATERAL_TOKEN, "orientation from the sorted token order");
        assertEq(s.token0, s.yesIsToken0 ? s.yesToken : COLLATERAL_TOKEN);
        assertEq(s.token1, s.yesIsToken0 ? COLLATERAL_TOKEN : s.yesToken);
        int24 expectedLower = s.yesIsToken0 ? PlanInputs.YES_PRICE_TICK_LOWER : -PlanInputs.YES_PRICE_TICK_UPPER;
        int24 expectedUpper = s.yesIsToken0 ? PlanInputs.YES_PRICE_TICK_UPPER : -PlanInputs.YES_PRICE_TICK_LOWER;
        assertEq(s.tickLower, expectedLower, "tickLower");
        assertEq(s.tickUpper, expectedUpper, "tickUpper");
        assertEq(s.tickLower % PlanInputs.TICK_SPACING, 0);
        assertEq(s.tickUpper % PlanInputs.TICK_SPACING, 0);
        assertEq(s.mintDeadline, PlanVectors.FORK_TIMESTAMP + PlanInputs.MINT_DEADLINE_OFFSET);

        assertEq(plan.account, PlanVectors.FUNDER);
        assertEq(plan.steps[0].to, GNOSIS_ROUTER);
        assertEq(plan.steps[0].value, PlanInputs.FUNDING_BUDGET_WEI);
        assertEq(plan.steps[0].data, abi.encodeCall(E2EIGnosisRouter.splitFromBase, (s.market)), "split calldata");
        assertEq(plan.steps[1].to, s.yesToken);
        assertEq(plan.steps[1].value, 0);
        assertEq(plan.steps[1].data, abi.encodeCall(IERC20.approve, (POSITION_MANAGER, s.mintAmount)), "approve");
        assertEq(plan.steps[2].to, POSITION_MANAGER);
        assertEq(plan.steps[2].value, 0);
        assertEq(
            plan.steps[2].data,
            abi.encodeCall(
                E2EIPositionManager.createAndInitializePoolIfNecessary, (s.token0, s.token1, s.initSqrtPriceX96)
            ),
            "create pool calldata"
        );
        assertEq(plan.steps[3].to, POSITION_MANAGER);
        assertEq(plan.steps[3].value, 0);
        assertEq(plan.steps[3].data, abi.encodeCall(E2EIPositionManager.mint, (_mintParams(s))), "mint calldata");
    }

    function _mintParams(Scenario memory s) internal pure returns (E2EIPositionManager.MintParams memory) {
        return E2EIPositionManager.MintParams({
            token0: s.token0,
            token1: s.token1,
            tickLower: s.tickLower,
            tickUpper: s.tickUpper,
            amount0Desired: s.yesIsToken0 ? s.mintAmount : 0,
            amount1Desired: s.yesIsToken0 ? 0 : s.mintAmount,
            amount0Min: s.yesIsToken0 ? s.mintAmountMin : 0,
            amount1Min: s.yesIsToken0 ? 0 : s.mintAmountMin,
            recipient: PlanVectors.FUNDER,
            deadline: s.mintDeadline
        });
    }

    function _replaySplitAndApprove(Scenario memory s) internal {
        vm.deal(funder, PlanInputs.FUNDING_BUDGET_WEI);
        _replay(s.funding, 0, "split");
        assertEq(funder.balance, 0, "the whole budget was split");
        assertEq(IERC20(s.yesToken).balanceOf(funder), s.sdaiShares, "minted YES = observed sDAI shares");
        assertEq(IERC20(s.noToken).balanceOf(funder), s.sdaiShares, "minted NO = observed sDAI shares");
        assertEq(IERC20(s.invalidToken).balanceOf(funder), s.sdaiShares, "minted INVALID = observed sDAI shares");

        _replay(s.funding, 1, "approve-yes");
        assertEq(IERC20(s.yesToken).allowance(funder, POSITION_MANAGER), s.mintAmount, "exact approval");
    }

    function _replayPoolAndMint(Scenario memory s) internal {
        assertEq(E2EIAlgebraFactory(ALGEBRA_FACTORY).poolByPair(s.yesToken, COLLATERAL_TOKEN), address(0), "no pool yet");
        pool = abi.decode(_replay(s.funding, 2, "create-pool"), (address));
        assertEq(E2EIAlgebraFactory(ALGEBRA_FACTORY).poolByPair(s.yesToken, COLLATERAL_TOKEN), pool, "pool registered");
        E2EIAlgebraPool p = E2EIAlgebraPool(pool);
        assertEq(p.token0(), s.token0);
        assertEq(p.token1(), s.token1);
        assertEq(p.tickSpacing(), PlanInputs.TICK_SPACING);
        (uint160 price, int24 tick,,,,,) = p.globalState();
        assertEq(price, s.initSqrtPriceX96, "initialised at the vector price");
        // Strictly outside the range on the YES-only side: the pool's own TickMath agrees with the BigInt port.
        assertEq(tick, s.yesIsToken0 ? s.tickLower - 1 : s.tickUpper, "initial tick just outside the range");

        (uint256 id, uint128 liquidity, uint256 amount0, uint256 amount1) =
            abi.decode(_replay(s.funding, 3, "mint-yes"), (uint256, uint128, uint256, uint256));
        tokenId = id;
        positionLiquidity = liquidity;
        yesInPosition = s.yesIsToken0 ? amount0 : amount1;
        assertGt(liquidity, 0, "liquidity minted");
        assertEq(s.yesIsToken0 ? amount1 : amount0, 0, "single-sided: no sDAI pulled");
        assertLe(yesInPosition, s.mintAmount, "never more than approved");
        assertGe(yesInPosition, s.mintAmountMin, "at least amountMin");

        uint256 residual = IERC20(s.yesToken).allowance(funder, POSITION_MANAGER);
        assertEq(residual, s.mintAmount - yesInPosition, "approval consumed by the mint");
        assertLe(residual, MAX_RESIDUAL_ALLOWANCE, "residual allowance <= 10 wei in total");
        assertEq(IERC20(s.yesToken).allowance(funder, GNOSIS_ROUTER), 0, "no other YES allowance");
        assertEq(IERC20(s.yesToken).allowance(funder, SWAP_ROUTER), 0, "no other YES allowance");
        assertEq(IERC20(COLLATERAL_TOKEN).allowance(funder, POSITION_MANAGER), 0, "no sDAI allowance");

        assertEq(E2EIPositionManager(POSITION_MANAGER).ownerOf(id), funder, "position owned by the plan account");
        (,,,, int24 lower, int24 upper, uint128 positionLiq,,,,) = E2EIPositionManager(POSITION_MANAGER).positions(id);
        assertEq(lower, s.tickLower);
        assertEq(upper, s.tickUpper);
        assertEq(positionLiq, liquidity);
        assertEq(IERC20(s.yesToken).balanceOf(pool), yesInPosition, "pool holds exactly the minted YES");
        assertEq(IERC20(COLLATERAL_TOKEN).balanceOf(pool), 0, "pool holds no sDAI");
        assertEq(IERC20(s.yesToken).balanceOf(funder), s.sdaiShares - yesInPosition, "funder keeps the margin");
        assertEq(p.liquidity(), 0, "current price outside the range: no active liquidity yet");
    }

    /// @dev A buyer deposits xDAI into sDAI and buys YES from the ladder with all of it.
    function _buyYes(Scenario memory s) internal {
        uint256 assets = 2 ether;
        vm.deal(buyer, assets);
        vm.startPrank(buyer);
        E2EIWrappedNative(WXDAI).deposit{value: assets}();
        IERC20(WXDAI).approve(COLLATERAL_TOKEN, assets);
        buyerSdaiIn = E2EISavingsXDai(COLLATERAL_TOKEN).deposit(assets, buyer);
        IERC20(COLLATERAL_TOKEN).approve(SWAP_ROUTER, buyerSdaiIn);
        buyerYesOut = E2EISwapRouter(SWAP_ROUTER).exactInputSingle(
            E2EISwapRouter.ExactInputSingleParams({
                tokenIn: COLLATERAL_TOKEN,
                tokenOut: s.yesToken,
                recipient: buyer,
                deadline: block.timestamp,
                amountIn: buyerSdaiIn,
                amountOutMinimum: 1,
                limitSqrtPrice: 0
            })
        );
        vm.stopPrank();

        assertGt(buyerYesOut, 0, "buyer received YES");
        assertEq(IERC20(s.yesToken).balanceOf(buyer), buyerYesOut);
        assertEq(IERC20(COLLATERAL_TOKEN).allowance(buyer, SWAP_ROUTER), 0, "buyer approval consumed");
        assertEq(IERC20(s.yesToken).balanceOf(pool), yesInPosition - buyerYesOut, "YES moved out of the pool");
        // The community share of the swap fee (10% of the dynamic fee) leaves the pool for the Swapr vault.
        uint256 poolSdai = IERC20(COLLATERAL_TOKEN).balanceOf(pool);
        assertLe(poolSdai, buyerSdaiIn, "sDAI moved into the pool");
        assertGe(poolSdai, buyerSdaiIn - buyerSdaiIn / 100, "only the community fee left the pool");
        // The ladder sells YES at or above its lower price (fees included in the sDAI paid).
        assertGe(buyerSdaiIn * 1 ether, buyerYesOut * LADDER_LOWER_PRICE_FLOOR_WAD, "price >= ladder lower bound");
        (, int24 tick,,,,,) = E2EIAlgebraPool(pool).globalState();
        if (s.yesIsToken0) {
            assertGe(tick, s.tickLower, "price moved into the range (YES dearer)");
        } else {
            assertLt(tick, s.tickUpper, "price moved into the range (YES dearer)");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Oracle and payouts
    // ------------------------------------------------------------------------------------------------------------

    /// @dev Answers at the opening time, proves finalization is exact to the second, resolves through RealityProxy.
    function _answerAndResolve(Scenario memory s, bytes32 answer) internal {
        if (block.timestamp < s.params.revealDeadline) vm.warp(s.params.revealDeadline);
        E2EIRealityETH reality = E2EIRealityETH(REALITIO);
        vm.deal(answerer, s.params.minBond);
        vm.prank(answerer);
        reality.submitAnswer{value: s.params.minBond}(s.questionId, answer, 0);
        assertEq(reality.getBestAnswer(s.questionId), answer);
        uint256 finalizeTs = reality.getFinalizeTS(s.questionId);
        assertEq(finalizeTs, block.timestamp + QUESTION_TIMEOUT, "finalizes after the 302400 s timeout");

        vm.warp(finalizeTs - 1);
        assertFalse(reality.isFinalized(s.questionId));
        vm.expectRevert();
        E2EIRealityProxy(REALITY_PROXY).resolve(s.market);

        vm.warp(finalizeTs);
        assertTrue(reality.isFinalized(s.questionId));
        vm.prank(makeAddr("pine-e2e-keeper"));
        E2EIRealityProxy(REALITY_PROXY).resolve(s.market);
    }

    function _assertPayoutNumerators(bytes32 conditionId, uint256 winningIndex) internal view {
        E2EIConditionalTokens ctf = E2EIConditionalTokens(CONDITIONAL_TOKENS);
        assertEq(ctf.payoutDenominator(conditionId), 1, "condition resolved");
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(ctf.payoutNumerators(conditionId, i), i == winningIndex ? 1 : 0, "payout vector");
        }
    }

    /// @dev Redeems `amounts` of (YES, NO, INVALID) through GnosisRouter.redeemToBase with exact approvals and returns
    /// the xDAI received, asserting it equals sDAI.previewRedeem of the winning amount.
    function _redeem(Scenario memory s, address holder, uint256[3] memory amounts, uint256 winningIndex)
        internal
        returns (uint256 received)
    {
        address[3] memory tokens = [s.yesToken, s.noToken, s.invalidToken];
        uint256 count;
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] > 0) ++count;
        }
        uint256[] memory indexes = new uint256[](count);
        uint256[] memory values = new uint256[](count);
        uint256 j;
        vm.startPrank(holder);
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] == 0) continue;
            IERC20(tokens[i]).approve(GNOSIS_ROUTER, amounts[i]);
            indexes[j] = i;
            values[j] = amounts[i];
            ++j;
        }
        uint256 expected = E2EISavingsXDai(COLLATERAL_TOKEN).previewRedeem(amounts[winningIndex]);
        uint256 before = holder.balance;
        E2EIGnosisRouter(GNOSIS_ROUTER).redeemToBase(s.market, indexes, values);
        vm.stopPrank();
        received = holder.balance - before;
        assertEq(received, expected, "xDAI paid = winning outcome tokens redeemed 1:1 in sDAI, converted to xDAI");
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] == 0) continue;
            assertEq(IERC20(tokens[i]).allowance(holder, GNOSIS_ROUTER), 0, "redeem approval consumed");
        }
    }

    /// @dev Payout accounting after Yes: the buyer's YES and the funder's YES (kept margin plus what the position
    /// returns) redeem 1:1; the funder's NO and INVALID pay nothing; the funder's sDAI proceeds come from the buyer.
    function _redeemAfterYes(Scenario memory s) internal {
        uint256 buyerPaid = _redeem(s, buyer, [buyerYesOut, uint256(0), uint256(0)], 0);
        assertGt(buyerPaid, 0, "buyer's YES pays out");

        vm.startPrank(funder);
        (uint256 out0, uint256 out1) = E2EIPositionManager(POSITION_MANAGER).decreaseLiquidity(
            E2EIPositionManager.DecreaseLiquidityParams({
                tokenId: tokenId, liquidity: positionLiquidity, amount0Min: 0, amount1Min: 0, deadline: block.timestamp
            })
        );
        (uint256 collected0, uint256 collected1) = E2EIPositionManager(POSITION_MANAGER).collect(
            E2EIPositionManager.CollectParams({
                tokenId: tokenId, recipient: funder, amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );
        vm.stopPrank();
        uint256 yesBack = s.yesIsToken0 ? collected0 : collected1;
        uint256 sdaiBack = s.yesIsToken0 ? collected1 : collected0;
        assertGe(yesBack, s.yesIsToken0 ? out0 : out1, "collect includes the withdrawn YES");
        assertGt(sdaiBack, 0, "the funder collects the buyer's payment");
        assertLe(sdaiBack, buyerSdaiIn, "never more sDAI than the buyer paid in");
        assertEq(IERC20(COLLATERAL_TOKEN).balanceOf(funder), sdaiBack);
        // Conservation of YES: what left the position = bought + returned, up to pool rounding dust.
        assertLe(buyerYesOut + yesBack, yesInPosition, "no YES created");
        uint256 dust = yesInPosition - (buyerYesOut + yesBack);
        assertEq(IERC20(s.yesToken).balanceOf(pool), dust, "what the pool keeps is exactly the rounding dust");
        assertLe(dust, MAX_POOL_DUST, "pool dust only");

        uint256 funderYes = IERC20(s.yesToken).balanceOf(funder);
        assertEq(funderYes, s.sdaiShares - yesInPosition + yesBack, "funder YES = margin + returned");
        uint256 funderPaid = _redeem(s, funder, [funderYes, s.sdaiShares, s.sdaiShares], 0);
        assertGt(funderPaid, 0);
        assertEq(IERC20(s.noToken).balanceOf(funder), 0, "NO burned for nothing");
        assertEq(IERC20(s.invalidToken).balanceOf(funder), 0, "INVALID burned for nothing");
        // Every YES that existed (the split's shares) was redeemed except pool dust.
        assertEq(s.sdaiShares - (buyerYesOut + funderYes), dust, "all YES redeemed but the pool dust");
    }
}
