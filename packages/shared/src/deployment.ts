// FROZEN. Deployment manifest: every contract address a transaction plan may target, pinned per chain (SEC-TX-12).
// External addresses were verified on Gnosis Chain on 2026-10-02 (docs/research/*.md: code present, immutables read
// back with cast). Pine's own addresses are filled from the deployment record after `forge script` deploys them.

import { keccak256, toBytes } from "viem";
import { canonicalJson } from "./canonical.js";
import type { Address, Hex32 } from "./types.js";

export interface DeploymentManifest {
  version: 1;
  chainId: number;
  pine: {
    claimRegistry: Address;
    evidenceRegistry: Address;
    /** Block of the ClaimRegistry deployment (indexers start here). */
    deploymentBlock: number;
  };
  seer: {
    marketFactory: Address;
    marketImplementation: Address;
    realityProxy: Address;
    /** Router functions plus xDAI helpers (splitFromBase/mergeToBase/redeemToBase via SavingsXDaiAdapter). */
    gnosisRouter: Address;
    conditionalTokens: Address;
    wrapped1155Factory: Address;
    /** sDAI (Savings xDAI, ERC-4626 over WXDAI): Seer's collateral on Gnosis. */
    collateralToken: Address;
    savingsXDaiAdapter: Address;
    /** Reality.eth v3 (native xDAI bonds). */
    realitio: Address;
    /** Kleros RealitioHomeArbitrationProxy (arbitrator of every Seer question). */
    arbitrator: Address;
    questionTimeoutSeconds: number;
  };
  amm: {
    /** Swapr v3 = Algebra V1.9. */
    factory: Address;
    poolDeployer: Address;
    poolInitCodeHash: Hex32;
    positionManager: Address;
    swapRouter: Address;
    quoter: Address;
  };
  kleros: {
    /** Ethereum mainnet: requestArbitration / submitEvidence happen here (instructions only; never in Gnosis plans). */
    foreignChainId: number;
    foreignProxy: Address;
    homeProxy: Address;
  };
}

/** Verified external deployments on Gnosis Chain (chain 100). */
export const GNOSIS_EXTERNAL: Omit<DeploymentManifest, "pine" | "version"> = {
  chainId: 100,
  seer: {
    marketFactory: "0x83183da839ce8228e31ae41222ead9edbb5cdcf1",
    marketImplementation: "0x8f76bc35f8c72e5e2ec55ebed785da5efaa9636a",
    realityProxy: "0xc260adfac11f97c001dc143d2a4f45b98e0f2d6c",
    gnosisRouter: "0xec9048b59b3467415b1a38f63416407ea0c70fb8",
    conditionalTokens: "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
    wrapped1155Factory: "0xd194319d1804c1051dd21ba1dc931ca72410b79f",
    collateralToken: "0xaf204776c7245bf4147c2612bf6e5972ee483701",
    savingsXDaiAdapter: "0xd499b51fcfc66bd31248ef4b28d656d67e591a94",
    realitio: "0xe78996a233895be74a66f451f1019ca9734205cc",
    arbitrator: "0x68154ea682f95bf582b80dd6453fa401737491dc",
    questionTimeoutSeconds: 302_400,
  },
  amm: {
    factory: "0xa0864cca6e114013ab0e27cbd5b6f4c8947da766",
    poolDeployer: "0xc1b576ac6ec749d5ace1787bf9ec6340908ddb47",
    poolInitCodeHash: "0xbce37a54eab2fcd71913a0d40723e04238970e7fc1159bfd58ad5b79531697e7",
    positionManager: "0x91fd594c46d8b01e62dbdebed2401dde01817834",
    swapRouter: "0xffb643e73f280b97809a8b41f7232ab401a04ee1",
    quoter: "0xcbad9fdf0d2814659eb26f600efdeaf005eda0f7",
  },
  kleros: {
    foreignChainId: 1,
    foreignProxy: "0xfe0eb5fc686f929eb26d541d75bb59f816c0aa68",
    homeProxy: "0x68154ea682f95bf582b80dd6453fa401737491dc",
  },
};

/** keccak256 of the RFC 8785 canonical JSON of the manifest (bigint-free by construction). Plans carry it. */
export function deploymentHash(manifest: DeploymentManifest): Hex32 {
  return keccak256(toBytes(canonicalJson(manifest as unknown as Parameters<typeof canonicalJson>[0])));
}
