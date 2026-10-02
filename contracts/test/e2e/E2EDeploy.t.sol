// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Deploy} from "../../script/Deploy.s.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {ISeerMarketFactory} from "../../src/interfaces/external/ISeer.sol";
import {E2EFork} from "./E2EFork.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";
import {E2ELookAlikeSeerFactory} from "./mocks/E2ELookAlikeSeerFactory.sol";

/// @notice The deploy script's logic (`_deploy`, inherited) on the Gnosis fork at block 48550000: the REAL pair is
/// deployed at the predicted addresses and bound, the Seer factory is pinned by address and runtime code hash, and the
/// JSON record lists what the operator must check. `run()` (the only broadcast) is never called from tests.
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

        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.SeerFactoryCodeHashMismatch.selector, lookAlikeHash, SEER_MARKET_FACTORY_CODEHASH
            )
        );
        this.deployWith(deployer, SEER_MARKET_FACTORY);
        assertEq(vm.getNonce(deployer), 0, "nothing was deployed");

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

    function test_deploy_refusesAMismatchedSeerImmutable() public {
        vm.mockCall(
            SEER_MARKET_FACTORY, abi.encodeCall(ISeerMarketFactory.questionTimeout, ()), abi.encode(uint32(86_400))
        );
        vm.expectRevert(abi.encodeWithSelector(Deploy.SeerImmutableMismatch.selector, "questionTimeout"));
        this.deployWith(deployer, SEER_MARKET_FACTORY);
        vm.clearMockedCalls();

        vm.mockCall(SEER_MARKET_FACTORY, abi.encodeCall(ISeerMarketFactory.market, ()), abi.encode(address(0xbad)));
        vm.expectRevert(abi.encodeWithSelector(Deploy.SeerImmutableMismatch.selector, "market"));
        this.deployWith(deployer, SEER_MARKET_FACTORY);
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
}
