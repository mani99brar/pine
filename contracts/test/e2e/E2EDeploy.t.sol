// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {ISeerMarketFactory} from "../../src/interfaces/external/ISeer.sol";
import {E2EFork} from "./E2EFork.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";
import {E2ELookAlikeSeerFactory} from "./mocks/E2ELookAlikeSeerFactory.sol";

/// @notice The deploy script's logic (`_deploy`, inherited) on the Gnosis fork at block 48550000: the REAL pair is
/// deployed at the predicted addresses and bound, the Seer factory is pinned by address and runtime code hash, and the
/// JSON record lists what the operator must check. `run()` itself is exercised once as a dry run: `forge test` never
/// sends what `vm.startBroadcast` records.
contract E2EDeployTest is E2EFork {
    function setUp() public {
        _selectFork();
    }

    /// External entry so `vm.expectRevert` can observe a refusal (the refusals happen before any CREATE).
    function deployWith(address deployer_, address factory) external returns (Deployment memory) {
        return _deployWith(deployer_, factory);
    }

    function test_deploy_realPair_predictedBoundAndPinned() public {
        assertEq(SEER_MARKET_FACTORY.codehash, SEER_MARKET_FACTORY_CODEHASH, "pinned code hash = fork code");
        _deployPair();

        assertEq(evidence.claimRegistry(), address(registry), "evidence registry bound to the claim registry");
        assertEq(registry.evidenceRegistry(), address(evidence), "claim registry bound to the evidence registry");
        assertEq(registry.seerMarketFactory(), SEER_MARKET_FACTORY);
        assertEq(registry.minimumMinBond(), MINIMUM_MIN_BOND);
        assertEq(registry.deploymentChainId(), 100);
        assertEq(registry.claimCount(), 0);
        assertEq(evidence.submissionCount(), 0);
        assertEq(deployment.chainId, 100);
        assertEq(deployment.blockNumber, PlanInputs.FORK_BLOCK);
        assertEq(deployment.deployerNonce, 0);

        // Every Seer immutable the registry relies on, read back from the real factory.
        ISeerMarketFactory factory = ISeerMarketFactory(SEER_MARKET_FACTORY);
        assertEq(factory.realitio(), deployment.expected.realitio);
        assertEq(factory.arbitrator(), deployment.expected.arbitrator);
        assertEq(factory.realityProxy(), deployment.expected.realityProxy);
        assertEq(factory.conditionalTokens(), deployment.expected.conditionalTokens);
        assertEq(factory.wrapped1155Factory(), deployment.expected.wrapped1155Factory);
        assertEq(factory.collateralToken(), deployment.expected.collateralToken);
        assertEq(factory.questionTimeout(), deployment.expected.questionTimeout);
        assertEq(factory.market(), SEER_MARKET_IMPLEMENTATION);
        assertEq(deployment.expected.questionTimeout, 302_400);
        assertEq(deployment.expected.collateralToken, COLLATERAL_TOKEN);
    }

    /// The n / n+1 prediction does not assume a fresh deployer.
    function test_deploy_predictionHoldsForAUsedDeployer() public {
        vm.setNonce(deployer, 41);
        _deployPair();
        assertEq(deployment.deployerNonce, 41);
        assertEq(address(evidence), vm.computeCreateAddress(deployer, 41));
        assertEq(address(registry), vm.computeCreateAddress(deployer, 42));
    }

    function test_deploy_recordListsAddressesArgsAndCodeHashes() public {
        vm.startPrank(deployer);
        Deployment memory d = _deploy(deployer);
        vm.stopPrank();
        string memory json = _record(d);

        assertEq(vm.parseJsonAddress(json, ".claimRegistry"), d.claimRegistry);
        assertEq(vm.parseJsonAddress(json, ".evidenceRegistry"), d.evidenceRegistry);
        assertEq(vm.parseJsonAddress(json, ".deployer"), deployer);
        assertEq(vm.parseJsonUint(json, ".deployerNonce"), 0);
        assertEq(vm.parseJsonUint(json, ".chainId"), 100);
        assertEq(vm.parseJsonUint(json, ".blockNumber"), PlanInputs.FORK_BLOCK);
        assertEq(vm.parseJsonUint(json, ".blockTimestamp"), block.timestamp);
        assertEq(vm.parseJsonAddress(json, ".evidenceRegistryConstructorArg"), d.claimRegistry);

        string memory args = ".claimRegistryConstructorArgs";
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".seerMarketFactory")), SEER_MARKET_FACTORY);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".evidenceRegistry")), d.evidenceRegistry);
        assertEq(vm.parseJsonUint(json, string.concat(args, ".minimumMinBond")), MINIMUM_MIN_BOND);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedRealitio")), REALITIO);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedArbitrator")), ARBITRATOR);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedRealityProxy")), REALITY_PROXY);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedConditionalTokens")), CONDITIONAL_TOKENS);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedWrapped1155Factory")), WRAPPED_1155_FACTORY);
        assertEq(vm.parseJsonAddress(json, string.concat(args, ".expectedCollateralToken")), COLLATERAL_TOKEN);
        assertEq(vm.parseJsonUint(json, string.concat(args, ".expectedQuestionTimeout")), QUESTION_TIMEOUT);

        assertEq(vm.parseJsonBytes32(json, ".externalCodeHashes.seerMarketFactory"), SEER_MARKET_FACTORY_CODEHASH);
        _assertCodeHash(json, "seerMarketImplementation", SEER_MARKET_IMPLEMENTATION);
        _assertCodeHash(json, "realitio", REALITIO);
        _assertCodeHash(json, "arbitrator", ARBITRATOR);
        _assertCodeHash(json, "realityProxy", REALITY_PROXY);
        _assertCodeHash(json, "conditionalTokens", CONDITIONAL_TOKENS);
        _assertCodeHash(json, "wrapped1155Factory", WRAPPED_1155_FACTORY);
        _assertCodeHash(json, "collateralToken", COLLATERAL_TOKEN);
        _assertCodeHash(json, "gnosisRouter", GNOSIS_ROUTER);
        _assertCodeHash(json, "algebraFactory", ALGEBRA_FACTORY);
        _assertCodeHash(json, "positionManager", POSITION_MANAGER);
    }

    function _assertCodeHash(string memory json, string memory key, address account) internal view {
        bytes32 recorded = vm.parseJsonBytes32(json, string.concat(".externalCodeHashes.", key));
        assertEq(recorded, account.codehash, key);
        assertTrue(recorded != bytes32(0) && recorded != keccak256(""), string.concat(key, " has code"));
    }

    /// The look-alike has identical getters and sits AT the pinned address, so the address check and every immutable
    /// check pass; only the runtime code-hash pin refuses it, before any CREATE. The ClaimRegistry constructor alone
    /// would accept it (it compares getters only; chain-005 security review P2), which is why the script pins the hash.
    function test_deploy_refusesALookAlikeFactoryAtThePinnedAddress() public {
        E2ELookAlikeSeerFactory lookAlike = new E2ELookAlikeSeerFactory();
        ISeerMarketFactory real = ISeerMarketFactory(SEER_MARKET_FACTORY);
        ISeerMarketFactory fake = ISeerMarketFactory(address(lookAlike));
        assertEq(fake.realitio(), real.realitio());
        assertEq(fake.arbitrator(), real.arbitrator());
        assertEq(fake.realityProxy(), real.realityProxy());
        assertEq(fake.conditionalTokens(), real.conditionalTokens());
        assertEq(fake.wrapped1155Factory(), real.wrapped1155Factory());
        assertEq(fake.collateralToken(), real.collateralToken());
        assertEq(fake.questionTimeout(), real.questionTimeout());
        assertEq(fake.market(), real.market());

        vm.etch(SEER_MARKET_FACTORY, address(lookAlike).code);
        bytes32 lookAlikeHash = SEER_MARKET_FACTORY.codehash;
        assertTrue(lookAlikeHash != SEER_MARKET_FACTORY_CODEHASH);

        vm.startStateDiffRecording();
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.SeerFactoryCodeHashMismatch.selector, lookAlikeHash, SEER_MARKET_FACTORY_CODEHASH
            )
        );
        this.deployWith(deployer, SEER_MARKET_FACTORY);
        _assertNoCreate(vm.stopAndReturnStateDiff());

        // Without the script's pin, the constructor accepts the look-alike.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        EvidenceRegistry ev = new EvidenceRegistry(predicted);
        ClaimRegistry unpinned = new ClaimRegistry(SEER_MARKET_FACTORY, address(ev), MINIMUM_MIN_BOND, _expectedSeer());
        assertEq(address(unpinned), predicted);
    }

    function test_deploy_refusesAFactoryAtAnotherAddress() public {
        E2ELookAlikeSeerFactory lookAlike = new E2ELookAlikeSeerFactory();
        vm.expectRevert(abi.encodeWithSelector(Deploy.SeerFactoryAddressMismatch.selector, address(lookAlike)));
        this.deployWith(deployer, address(lookAlike));
    }

    // One refusal per Seer immutable the script checks (eight getters), each before any CREATE.

    function test_deploy_refusesAMismatchedSeerImmutable_realitio() public {
        _expectImmutableRefusal(abi.encodeCall(ISeerMarketFactory.realitio, ()), abi.encode(address(0xbad)), "realitio");
    }

    function test_deploy_refusesAMismatchedSeerImmutable_arbitrator() public {
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.arbitrator, ()), abi.encode(address(0xbad)), "arbitrator"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_realityProxy() public {
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.realityProxy, ()), abi.encode(address(0xbad)), "realityProxy"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_conditionalTokens() public {
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.conditionalTokens, ()), abi.encode(address(0xbad)), "conditionalTokens"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_wrapped1155Factory() public {
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.wrapped1155Factory, ()), abi.encode(address(0xbad)), "wrapped1155Factory"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_collateralToken() public {
        // WXDAI instead of sDAI: a real token, the wrong collateral.
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.collateralToken, ()), abi.encode(WXDAI), "collateralToken"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_questionTimeout() public {
        _expectImmutableRefusal(
            abi.encodeCall(ISeerMarketFactory.questionTimeout, ()), abi.encode(uint32(86_400)), "questionTimeout"
        );
    }

    function test_deploy_refusesAMismatchedSeerImmutable_market() public {
        _expectImmutableRefusal(abi.encodeCall(ISeerMarketFactory.market, ()), abi.encode(address(0xbad)), "market");
    }

    /// @dev The real factory with one getter mocked: refused with that getter's name, and nothing is created.
    function _expectImmutableRefusal(bytes memory getterCall, bytes memory wrongValue, string memory getter) internal {
        vm.mockCall(SEER_MARKET_FACTORY, getterCall, wrongValue);
        vm.startStateDiffRecording();
        vm.expectRevert(abi.encodeWithSelector(Deploy.SeerImmutableMismatch.selector, getter));
        this.deployWith(deployer, SEER_MARKET_FACTORY);
        _assertNoCreate(vm.stopAndReturnStateDiff());
    }

    function test_deploy_refusesMissingExternalCode() public {
        vm.etch(POSITION_MANAGER, "");
        vm.expectRevert(abi.encodeWithSelector(Deploy.MissingCode.selector, POSITION_MANAGER));
        this.deployWith(deployer, SEER_MARKET_FACTORY);
    }

    function test_deploy_refusesAnotherChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Deploy.WrongChain.selector, 1));
        this.deployWith(deployer, SEER_MARKET_FACTORY);
    }

    /// The operator's entry point itself, as a dry run: `run()` reads PINE_DEPLOYER and deploys under
    /// `vm.startBroadcast`, whose recorded transactions `forge test` never sends (no key, no RPC write). Exactly two
    /// CREATEs come from the deployer, at nonces n and n + 1, no CALL is sent from it (under broadcast a CALL would
    /// consume a nonce and break the prediction only in production), and the deployed pair is bound.
    function test_deploy_runDryRun_twoCreatesAtNoncesNAndNPlusOneBound() public {
        uint64 n = 5;
        vm.setNonce(deployer, n);
        vm.setEnv("PINE_DEPLOYER", vm.toString(deployer));

        vm.startStateDiffRecording();
        this.run();
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();

        Vm.AccountAccess[] memory creates = _creates(accesses);
        assertEq(creates.length, 2, "exactly two CREATEs");
        assertEq(creates[0].accessor, deployer, "first CREATE from the deployer");
        assertEq(creates[0].account, vm.computeCreateAddress(deployer, n), "EvidenceRegistry at nonce n");
        assertEq(creates[1].accessor, deployer, "second CREATE from the deployer");
        assertEq(creates[1].account, vm.computeCreateAddress(deployer, uint256(n) + 1), "ClaimRegistry at nonce n + 1");
        assertEq(vm.getNonce(deployer), uint256(n) + 2, "deployer nonce advanced by exactly 2");
        for (uint256 i = 0; i < accesses.length; ++i) {
            bool sent = accesses[i].kind == VmSafe.AccountAccessKind.Call && accesses[i].accessor == deployer;
            assertFalse(sent, "no CALL from the deployer");
        }

        EvidenceRegistry ev = EvidenceRegistry(creates[0].account);
        ClaimRegistry cr = ClaimRegistry(creates[1].account);
        assertEq(ev.claimRegistry(), address(cr), "evidence registry bound to the claim registry");
        assertEq(cr.evidenceRegistry(), address(ev), "claim registry bound to the evidence registry");
        assertEq(cr.seerMarketFactory(), SEER_MARKET_FACTORY);
        assertEq(cr.minimumMinBond(), MINIMUM_MIN_BOND);
        assertEq(cr.deploymentChainId(), 100);
        assertEq(cr.claimCount(), 0);
        assertEq(ev.submissionCount(), 0);
    }

    /// @dev The CREATEs that took effect, in execution order.
    function _creates(Vm.AccountAccess[] memory accesses) internal pure returns (Vm.AccountAccess[] memory out) {
        uint256 count;
        for (uint256 i = 0; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Create && !accesses[i].reverted) ++count;
        }
        out = new Vm.AccountAccess[](count);
        count = 0;
        for (uint256 i = 0; i < accesses.length; ++i) {
            if (accesses[i].kind == VmSafe.AccountAccessKind.Create && !accesses[i].reverted) {
                out[count++] = accesses[i];
            }
        }
    }

    /// @dev No CREATE was attempted, not even one a revert rolled back: a refusal happened before deployment. (After a
    /// reverted call the deployer nonce is unchanged whether or not a CREATE ran, so a nonce check proves nothing.)
    function _assertNoCreate(Vm.AccountAccess[] memory accesses) internal pure {
        for (uint256 i = 0; i < accesses.length; ++i) {
            assertTrue(accesses[i].kind != VmSafe.AccountAccessKind.Create, "nothing was created");
        }
    }
}
