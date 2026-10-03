// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {ISeerMarket, ISeerMarketFactory} from "../../src/interfaces/external/ISeer.sol";
import {CRForkBase} from "./CRForkBase.sol";

/// @notice A copycat creates a Seer market directly with Pine's exact question and swapped token names BEFORE Pine's
/// createClaim (docs/prd/PRD-07-hardening.md section 2; accepted by features/chain/decisions.md and
/// features/hardening/decisions.md). Seer reuses the Reality question, the CTF condition and the SER-INVALID wrapper,
/// but the differently named YES/NO wrappers are distinct contracts. RPC budget: one direct createCategoricalMarket
/// plus one createClaim, in the only test of this contract.
contract CRForkCopycatTest is CRForkBase {
    address internal mallory = makeAddr("mallory");

    function test_fork_copycatMarketFirst_registryRecordsOnlyPineMarketAndTokens() public {
        string memory question = registry.renderQuestion(params);

        // The copycat: Pine's question, Pine's market parameters, the PY_/PN_ names swapped.
        vm.prank(mallory);
        address copycat = ISeerMarketFactory(MARKET_FACTORY).createCategoricalMarket(_copycatParams(question));
        assertEq(ISeerMarket(copycat).marketName(), question, "copycat carries Pine's question");
        assertFalse(registry.isRegistered(copycat));

        vm.prank(alice);
        address market = registry.createClaim(params);
        assertTrue(market != copycat, "Pine has its own market");
        IClaimRegistry.Claim memory c = registry.getClaim(market);
        ISeerMarket pine = ISeerMarket(market);
        ISeerMarket copy = ISeerMarket(copycat);

        // Pine's record carries its own market's ids and wrappers, named PY_/PN_.
        assertEq(pine.marketName(), question);
        assertEq(c.creator, alice);
        assertEq(c.marketNameHash, keccak256(bytes(question)));
        assertEq(c.questionId, pine.questionsIds()[0]);
        assertEq(c.conditionId, pine.conditionId());
        (address pineYes,) = pine.wrappedOutcome(0);
        (address pineNo,) = pine.wrappedOutcome(1);
        (address pineInvalid,) = pine.wrappedOutcome(2);
        assertEq(c.yesToken, pineYes);
        assertEq(c.noToken, pineNo);
        assertEq(c.invalidToken, pineInvalid);
        assertEq(IERC20Metadata(c.yesToken).name(), "PY_e3b0c442");
        assertEq(IERC20Metadata(c.yesToken).symbol(), "PY_e3b0c442");
        assertEq(IERC20Metadata(c.noToken).name(), "PN_e3b0c442");
        assertEq(IERC20Metadata(c.noToken).symbol(), "PN_e3b0c442");

        // Shared with the copycat: the Reality question, the CTF condition and the SER-INVALID wrapper.
        bytes32[] memory copyQuestions = copy.questionsIds();
        assertEq(copyQuestions.length, 1);
        assertEq(c.questionId, copyQuestions[0], "same Reality question");
        assertEq(c.conditionId, copy.conditionId(), "same CTF condition");
        (address copyYes,) = copy.wrappedOutcome(0);
        (address copyNo,) = copy.wrappedOutcome(1);
        (address copyInvalid,) = copy.wrappedOutcome(2);
        assertEq(c.invalidToken, copyInvalid, "same SER-INVALID wrapper");
        assertEq(IERC20Metadata(copyInvalid).symbol(), "SER-INVALID");

        // Not shared: the copycat's YES/NO wrappers (its YES is named PN_, its NO PY_) differ from Pine's.
        assertEq(IERC20Metadata(copyYes).name(), "PN_e3b0c442");
        assertEq(IERC20Metadata(copyNo).name(), "PY_e3b0c442");
        assertTrue(c.yesToken != copyYes && c.yesToken != copyNo, "Pine YES is not a copycat wrapper");
        assertTrue(c.noToken != copyYes && c.noToken != copyNo, "Pine NO is not a copycat wrapper");

        // The registry records only Pine's market.
        assertTrue(registry.isRegistered(market));
        assertFalse(registry.isRegistered(copycat));
        vm.expectRevert(abi.encodeWithSelector(IClaimRegistry.UnknownMarket.selector, copycat));
        registry.getClaim(copycat);
        assertEq(registry.claimCount(), 1);
        assertEq(registry.marketOf(alice, params.claimDocumentSha256), market);
        assertEq(registry.marketOf(mallory, params.claimDocumentSha256), address(0));
    }

    /// @dev ClaimRegistry._marketParams for `params`, with the token names swapped.
    function _copycatParams(string memory question)
        internal
        view
        returns (ISeerMarketFactory.CreateMarketParams memory p)
    {
        string[] memory outcomes = new string[](2);
        outcomes[0] = "Yes";
        outcomes[1] = "No";
        string[] memory names = new string[](2);
        names[0] = "PN_e3b0c442";
        names[1] = "PY_e3b0c442";
        p.marketName = question;
        p.outcomes = outcomes;
        p.category = "misc";
        p.lang = "en_US";
        p.minBond = params.minBond;
        p.openingTime = SafeCast.toUint32(params.revealDeadline);
        p.tokenNames = names;
    }
}
