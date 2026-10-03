// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {EvidenceRegistry} from "../../src/EvidenceRegistry.sol";
import {IClaimRegistry} from "../../src/interfaces/IClaimRegistry.sol";
import {PlanInputs} from "./generated/PlanInputs.sol";

/// @notice Shared fork sequence of the probe and every e2e test contract (operator clarification 2): Gnosis fork at
/// block 48550000, the deployer from its fixed label at its fork nonce, the REAL pair deployed by the script logic
/// under `vm.startPrank(deployer)`, and nothing else before createClaim, so every address the probe observed is
/// reproduced exactly. Inheriting the script runs both CREATEs in this contract's own frame.
abstract contract E2EFork is Test, Deploy {
    address internal constant SWAP_ROUTER = 0xfFB643E73f280B97809A8b41f7232AB401a04ee1;
    address internal constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    address internal deployer;
    address internal creator;
    address internal submitter;
    address internal funder;

    ClaimRegistry internal registry;
    EvidenceRegistry internal evidence;
    /// The record `_deploy` returned (nested struct copied field by field into storage).
    Deployment internal deployment;

    function _selectFork() internal {
        vm.createSelectFork(vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com")), PlanInputs.FORK_BLOCK);
        assertEq(block.number, PlanInputs.FORK_BLOCK, "fork block");
        assertEq(block.chainid, PlanInputs.CHAIN_ID, "chain id");
        deployer = makeAddr(PlanInputs.DEPLOYER_LABEL);
        creator = makeAddr(PlanInputs.CREATOR_LABEL);
        submitter = makeAddr(PlanInputs.SUBMITTER_LABEL);
        funder = makeAddr(PlanInputs.FUNDER_LABEL);
    }

    /// @dev Deploys the pair with the script's `_deploy` under a prank of the deployer and proves the prank path:
    /// the two CREATE addresses are computeCreateAddress(deployer, n) and (n + 1), and the deployer nonce advanced by 2
    /// (operator clarification 4).
    function _deployPair() internal {
        uint64 nonce = vm.getNonce(deployer);
        address predictedEvidence = vm.computeCreateAddress(deployer, nonce);
        address predictedClaim = vm.computeCreateAddress(deployer, uint256(nonce) + 1);
        assertEq(predictedEvidence.code.length, 0, "predicted evidence registry address is empty");
        assertEq(predictedClaim.code.length, 0, "predicted claim registry address is empty");

        vm.startPrank(deployer);
        Deployment memory d = _deploy(deployer);
        vm.stopPrank();

        assertEq(d.evidenceRegistry, predictedEvidence, "EvidenceRegistry at deployer nonce n");
        assertEq(d.claimRegistry, predictedClaim, "ClaimRegistry at deployer nonce n + 1");
        assertEq(uint256(vm.getNonce(deployer)), uint256(nonce) + 2, "deployer nonce advanced by 2");
        assertEq(d.deployerNonce, nonce, "recorded deployer nonce");
        assertEq(d.deployer, deployer, "recorded deployer");

        registry = ClaimRegistry(d.claimRegistry);
        evidence = EvidenceRegistry(d.evidenceRegistry);
        _store(d);
    }

    function _store(Deployment memory d) private {
        deployment.deployer = d.deployer;
        deployment.chainId = d.chainId;
        deployment.blockNumber = d.blockNumber;
        deployment.blockTimestamp = d.blockTimestamp;
        deployment.deployerNonce = d.deployerNonce;
        deployment.evidenceRegistry = d.evidenceRegistry;
        deployment.claimRegistry = d.claimRegistry;
        deployment.seerMarketFactory = d.seerMarketFactory;
        deployment.minimumMinBond = d.minimumMinBond;
        deployment.expected = d.expected;
    }

    /// @dev Claim parameters from PlanInputs with deadlines relative to `forkTimestamp`.
    function _claimParamsA(uint256 forkTimestamp) internal pure returns (IClaimRegistry.CreateClaimParams memory p) {
        uint64 evidenceDeadline = uint64(forkTimestamp) + PlanInputs.A_EVIDENCE_WINDOW;
        p = IClaimRegistry.CreateClaimParams({
            claimDocumentSha256: PlanInputs.A_CLAIM_DOCUMENT_SHA256,
            policyDocumentSha256: PlanInputs.A_POLICY_DOCUMENT_SHA256,
            repositoryId: PlanInputs.A_REPOSITORY_ID,
            commit: PlanInputs.A_COMMIT,
            evidenceDeadline: evidenceDeadline,
            revealDeadline: evidenceDeadline + PlanInputs.A_REVEAL_WINDOW,
            minBond: PlanInputs.A_MIN_BOND,
            title: PlanInputs.A_TITLE
        });
    }

    function _claimParamsB(uint256 forkTimestamp) internal pure returns (IClaimRegistry.CreateClaimParams memory p) {
        uint64 evidenceDeadline = uint64(forkTimestamp) + PlanInputs.B_EVIDENCE_WINDOW;
        p = IClaimRegistry.CreateClaimParams({
            claimDocumentSha256: PlanInputs.B_CLAIM_DOCUMENT_SHA256,
            policyDocumentSha256: PlanInputs.B_POLICY_DOCUMENT_SHA256,
            repositoryId: PlanInputs.B_REPOSITORY_ID,
            commit: PlanInputs.B_COMMIT,
            evidenceDeadline: evidenceDeadline,
            revealDeadline: evidenceDeadline + PlanInputs.B_REVEAL_WINDOW,
            minBond: PlanInputs.B_MIN_BOND,
            title: PlanInputs.B_TITLE
        });
    }
}
