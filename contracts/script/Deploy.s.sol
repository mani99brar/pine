// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ClaimRegistry} from "../src/ClaimRegistry.sol";
import {EvidenceRegistry} from "../src/EvidenceRegistry.sol";
import {ISeerMarketFactory} from "../src/interfaces/external/ISeer.sol";

/// @title Deploy
/// @notice Deploys the Pine pair on Gnosis Chain (docs/prd/PRD-06-assembly.md section 2): the EvidenceRegistry first,
/// bound to the ClaimRegistry's predicted CREATE address, then the ClaimRegistry, which verifies the binding and the
/// Seer immutables in its constructor. The script additionally pins the Seer MarketFactory by address AND runtime code
/// hash (the constructor only compares getters, chain-005 security review P2), checks code at every external contract,
/// and prints a JSON deployment record.
/// Usage (operator, hardware wallet; never from tests):
///   PINE_DEPLOYER=0x... forge script script/Deploy.s.sol --rpc-url gnosis --ledger --sender $PINE_DEPLOYER --broadcast
/// @dev Every external read before the second CREATE is a view call or a cheatcode: under broadcast a non-view call
/// would consume a deployer nonce and break the n / n+1 prediction only in production. Tests inherit this contract
/// and run `_deploy` under `vm.startPrank(deployer)` so both CREATEs happen in the test's own frame.
contract Deploy is Script {
    uint256 internal constant GNOSIS_CHAIN_ID = 100;

    // GNOSIS_EXTERNAL (packages/shared/src/deployment.ts), verified on Gnosis 2026-10-02.
    address internal constant SEER_MARKET_FACTORY = 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1;
    /// Runtime code hash of the Seer MarketFactory at block 48550000 and on 2026-10-02 (PRD-06 section 2).
    bytes32 internal constant SEER_MARKET_FACTORY_CODEHASH =
        0x387f37b6df5c9faf28875b9b108cd4bf56c27152989d3362600516a2381e2fe6;
    address internal constant SEER_MARKET_IMPLEMENTATION = 0x8F76bC35F8C72E5e2Ec55ebED785da5efaa9636a;
    address internal constant REALITIO = 0xE78996A233895bE74a66F451f1019cA9734205cc;
    address internal constant ARBITRATOR = 0x68154EA682f95BF582b80Dd6453FA401737491Dc;
    address internal constant REALITY_PROXY = 0xc260ADfAC11f97c001dC143d2a4F45b98e0f2D6C;
    address internal constant CONDITIONAL_TOKENS = 0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce;
    address internal constant WRAPPED_1155_FACTORY = 0xD194319D1804C1051DD21Ba1Dc931cA72410B79f;
    /// sDAI (Savings xDAI): Seer's collateral token on Gnosis.
    address internal constant COLLATERAL_TOKEN = 0xaf204776c7245bF4147c2612BF6e5972Ee483701;
    address internal constant GNOSIS_ROUTER = 0xeC9048b59b3467415b1a38F63416407eA0c70fB8;
    address internal constant ALGEBRA_FACTORY = 0xA0864cCA6E114013AB0e27cbd5B6f4c8947da766;
    address internal constant POSITION_MANAGER = 0x91fD594c46D8B01E62dBDeBed2401dde01817834;
    uint32 internal constant QUESTION_TIMEOUT = 302_400;

    /// Deploy-time floor of the Reality.eth minimum bond: 1 xDAI (ADR-0001 D3).
    uint256 internal constant MINIMUM_MIN_BOND = 1 ether;

    struct Deployment {
        address deployer;
        uint256 chainId;
        uint256 blockNumber;
        uint256 blockTimestamp;
        /// Deployer nonce before the first CREATE (EvidenceRegistry at n, ClaimRegistry at n + 1).
        uint64 deployerNonce;
        address evidenceRegistry;
        address claimRegistry;
        address seerMarketFactory;
        uint256 minimumMinBond;
        ClaimRegistry.ExpectedSeer expected;
    }

    error WrongChain(uint256 chainId);
    error SeerFactoryAddressMismatch(address factory);
    error SeerFactoryCodeHashMismatch(bytes32 actual, bytes32 expected);
    error SeerImmutableMismatch(string getter);
    error MissingCode(address account);
    error PredictionMismatch(address predicted, address deployed);
    error BindingMismatch(string check);

    function run() external {
        address deployer = vm.envAddress("PINE_DEPLOYER");
        vm.startBroadcast(deployer);
        Deployment memory d = _deploy(deployer);
        vm.stopBroadcast();
        console.log(_record(d));
    }

    /// @notice The deployment logic: refuses a wrong chain, a look-alike factory or missing external code, then deploys
    /// and verifies the pair. The caller provides the CREATE context (broadcast in `run`, a prank in tests).
    function _deploy(address deployer) internal returns (Deployment memory d) {
        return _deployWith(deployer, SEER_MARKET_FACTORY);
    }

    function _deployWith(address deployer, address seerMarketFactory) internal returns (Deployment memory d) {
        if (block.chainid != GNOSIS_CHAIN_ID) revert WrongChain(block.chainid);
        ClaimRegistry.ExpectedSeer memory expected = _expectedSeer();
        _checkSeerFactory(seerMarketFactory, expected);
        _checkExternalCode();

        d.deployer = deployer;
        d.chainId = block.chainid;
        d.blockNumber = block.number;
        d.blockTimestamp = block.timestamp;
        d.deployerNonce = vm.getNonce(deployer);
        d.seerMarketFactory = seerMarketFactory;
        d.minimumMinBond = MINIMUM_MIN_BOND;
        d.expected = expected;

        address predictedEvidence = vm.computeCreateAddress(deployer, d.deployerNonce);
        address predictedClaim = vm.computeCreateAddress(deployer, uint256(d.deployerNonce) + 1);

        EvidenceRegistry evidence = new EvidenceRegistry(predictedClaim);
        if (address(evidence) != predictedEvidence) revert PredictionMismatch(predictedEvidence, address(evidence));
        ClaimRegistry registry = new ClaimRegistry(seerMarketFactory, address(evidence), MINIMUM_MIN_BOND, expected);
        if (address(registry) != predictedClaim) revert PredictionMismatch(predictedClaim, address(registry));

        d.evidenceRegistry = address(evidence);
        d.claimRegistry = address(registry);
        _checkBinding(d);
    }

    function _expectedSeer() internal pure returns (ClaimRegistry.ExpectedSeer memory) {
        return ClaimRegistry.ExpectedSeer({
            realitio: REALITIO,
            arbitrator: ARBITRATOR,
            realityProxy: REALITY_PROXY,
            conditionalTokens: CONDITIONAL_TOKENS,
            wrapped1155Factory: WRAPPED_1155_FACTORY,
            collateralToken: COLLATERAL_TOKEN,
            questionTimeout: QUESTION_TIMEOUT
        });
    }

    /// @dev Address pin, every Seer immutable (view calls), then the runtime code hash: a contract with identical getters
    /// at the pinned address (look-alike) passes the first two checks and is refused by the third.
    function _checkSeerFactory(address factoryAddress, ClaimRegistry.ExpectedSeer memory expected) internal view {
        if (factoryAddress != SEER_MARKET_FACTORY) revert SeerFactoryAddressMismatch(factoryAddress);
        if (factoryAddress.code.length == 0) revert MissingCode(factoryAddress);
        ISeerMarketFactory factory = ISeerMarketFactory(factoryAddress);
        if (factory.realitio() != expected.realitio) revert SeerImmutableMismatch("realitio");
        if (factory.arbitrator() != expected.arbitrator) revert SeerImmutableMismatch("arbitrator");
        if (factory.realityProxy() != expected.realityProxy) revert SeerImmutableMismatch("realityProxy");
        if (factory.conditionalTokens() != expected.conditionalTokens) revert SeerImmutableMismatch("conditionalTokens");
        if (factory.wrapped1155Factory() != expected.wrapped1155Factory) {
            revert SeerImmutableMismatch("wrapped1155Factory");
        }
        if (factory.collateralToken() != expected.collateralToken) revert SeerImmutableMismatch("collateralToken");
        if (factory.questionTimeout() != expected.questionTimeout) revert SeerImmutableMismatch("questionTimeout");
        if (factory.market() != SEER_MARKET_IMPLEMENTATION) revert SeerImmutableMismatch("market");
        if (factoryAddress.codehash != SEER_MARKET_FACTORY_CODEHASH) {
            revert SeerFactoryCodeHashMismatch(factoryAddress.codehash, SEER_MARKET_FACTORY_CODEHASH);
        }
    }

    function _checkExternalCode() internal view {
        address[10] memory externals = _externalContracts();
        for (uint256 i = 0; i < externals.length; ++i) {
            if (externals[i].code.length == 0) revert MissingCode(externals[i]);
        }
    }

    function _externalContracts() internal pure returns (address[10] memory) {
        return [
            REALITIO,
            ARBITRATOR,
            REALITY_PROXY,
            CONDITIONAL_TOKENS,
            WRAPPED_1155_FACTORY,
            COLLATERAL_TOKEN,
            GNOSIS_ROUTER,
            ALGEBRA_FACTORY,
            POSITION_MANAGER,
            SEER_MARKET_IMPLEMENTATION
        ];
    }

    function _checkBinding(Deployment memory d) internal view {
        EvidenceRegistry evidence = EvidenceRegistry(d.evidenceRegistry);
        ClaimRegistry registry = ClaimRegistry(d.claimRegistry);
        if (evidence.claimRegistry() != d.claimRegistry) revert BindingMismatch("evidence.claimRegistry");
        if (registry.evidenceRegistry() != d.evidenceRegistry) revert BindingMismatch("registry.evidenceRegistry");
        if (registry.seerMarketFactory() != d.seerMarketFactory) revert BindingMismatch("registry.seerMarketFactory");
        if (registry.minimumMinBond() != d.minimumMinBond) revert BindingMismatch("registry.minimumMinBond");
        if (registry.deploymentChainId() != GNOSIS_CHAIN_ID) revert BindingMismatch("registry.deploymentChainId");
        if (registry.claimCount() != 0 || evidence.submissionCount() != 0) revert BindingMismatch("fresh state");
        if (vm.getNonce(d.deployer) != uint256(d.deployerNonce) + 2) revert BindingMismatch("deployer nonce");
    }

    /// @notice The deployment record as JSON, built in memory (fs_permissions = []; forge's broadcast/ output is the
    /// durable record). Lists addresses, block, chain id, constructor arguments, the deployer and the runtime code
    /// hashes of every external contract the pair or the plans rely on, read now.
    function _record(Deployment memory d) internal returns (string memory) {
        string memory root = "pine-deployment";
        string memory args = "pine-deployment-claim-registry-args";
        string memory hashes = "pine-deployment-code-hashes";
        vm.serializeJson(root, "{}");
        vm.serializeJson(args, "{}");
        vm.serializeJson(hashes, "{}");

        vm.serializeAddress(args, "seerMarketFactory", d.seerMarketFactory);
        vm.serializeAddress(args, "evidenceRegistry", d.evidenceRegistry);
        vm.serializeUint(args, "minimumMinBond", d.minimumMinBond);
        vm.serializeAddress(args, "expectedRealitio", d.expected.realitio);
        vm.serializeAddress(args, "expectedArbitrator", d.expected.arbitrator);
        vm.serializeAddress(args, "expectedRealityProxy", d.expected.realityProxy);
        vm.serializeAddress(args, "expectedConditionalTokens", d.expected.conditionalTokens);
        vm.serializeAddress(args, "expectedWrapped1155Factory", d.expected.wrapped1155Factory);
        vm.serializeAddress(args, "expectedCollateralToken", d.expected.collateralToken);
        string memory argsJson = vm.serializeUint(args, "expectedQuestionTimeout", d.expected.questionTimeout);

        vm.serializeBytes32(hashes, "seerMarketFactory", d.seerMarketFactory.codehash);
        vm.serializeBytes32(hashes, "seerMarketImplementation", SEER_MARKET_IMPLEMENTATION.codehash);
        vm.serializeBytes32(hashes, "realitio", REALITIO.codehash);
        vm.serializeBytes32(hashes, "arbitrator", ARBITRATOR.codehash);
        vm.serializeBytes32(hashes, "realityProxy", REALITY_PROXY.codehash);
        vm.serializeBytes32(hashes, "conditionalTokens", CONDITIONAL_TOKENS.codehash);
        vm.serializeBytes32(hashes, "wrapped1155Factory", WRAPPED_1155_FACTORY.codehash);
        vm.serializeBytes32(hashes, "collateralToken", COLLATERAL_TOKEN.codehash);
        vm.serializeBytes32(hashes, "gnosisRouter", GNOSIS_ROUTER.codehash);
        vm.serializeBytes32(hashes, "algebraFactory", ALGEBRA_FACTORY.codehash);
        string memory hashesJson = vm.serializeBytes32(hashes, "positionManager", POSITION_MANAGER.codehash);

        vm.serializeString(root, "claimRegistryConstructorArgs", argsJson);
        vm.serializeAddress(root, "evidenceRegistryConstructorArg", d.claimRegistry);
        vm.serializeString(root, "externalCodeHashes", hashesJson);
        vm.serializeAddress(root, "deployer", d.deployer);
        vm.serializeUint(root, "deployerNonce", d.deployerNonce);
        vm.serializeUint(root, "chainId", d.chainId);
        vm.serializeUint(root, "blockNumber", d.blockNumber);
        vm.serializeUint(root, "blockTimestamp", d.blockTimestamp);
        vm.serializeAddress(root, "evidenceRegistry", d.evidenceRegistry);
        return vm.serializeAddress(root, "claimRegistry", d.claimRegistry);
    }
}
