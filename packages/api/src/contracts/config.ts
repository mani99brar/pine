// FROZEN cross-lane contract. The configuration visible to route modules.
//
// Secrets (database URL, RPC URLs, GitHub client secret, token-encryption keys, session secret, pinning-service
// credentials) are deliberately NOT part of AppConfig: the platform keeps them in its own PlatformSecrets, so a
// module can never log, return or persist one. The platform loads and validates both from the environment at
// startup and refuses to start on any missing or invalid value (fail closed).

import type { Address } from "@pine/shared/types";

export type DeploymentEnvironment = "development" | "test" | "staging" | "production";

export interface ContractAddresses {
  /** Pine ClaimRegistry (creates Seer markets and records claims). */
  claimRegistry: Address;
  /** Pine EvidenceRegistry bound to claimRegistry. */
  evidenceRegistry: Address;
  /** Block of the claimRegistry deployment (indexing start). */
  deploymentBlock: bigint;
}

export interface SeerAddresses {
  marketFactory: Address;
  realityProxy: Address;
  /** GnosisRouter: Router functions plus xDAI helpers (splitFromBase, mergeToBase, redeemToBase). */
  gnosisRouter: Address;
  conditionalTokens: Address;
  wrapped1155Factory: Address;
  /** Seer collateral (sDAI on Gnosis). */
  collateralToken: Address;
  /** Reality.eth v3 (native xDAI). */
  realitio: Address;
  /** Arbitrator passed to Reality by the Seer factory (Kleros RealitioHomeArbitrationProxy on Gnosis). */
  arbitrator: Address;
  /** Seer MarketFactory.questionTimeout(), seconds. */
  questionTimeoutSeconds: number;
  /** Ethereum-mainnet side of Kleros arbitration (requestArbitration, submitEvidence), for instructions only. */
  klerosForeignProxy: Address;
  klerosForeignChainId: number;
}

export interface AmmAddresses {
  /** Swapr v3 (Algebra V1.9) factory on Gnosis. */
  factory: Address;
  /** Swapr v3 (Algebra) NonfungiblePositionManager. */
  positionManager: Address;
  /** Algebra Quoter (eth_call only) for executable depth. No swap plans exist, so no router is configured. */
  quoter: Address;
}

export interface ClaimRules {
  /** Bounds enforced by the API before building a transaction plan; the ClaimRegistry enforces its own immutable bounds. */
  minEvidenceWindowSeconds: number;
  maxEvidenceWindowSeconds: number;
  defaultEvidenceWindowSeconds: number;
  revealWindowSeconds: number;
  /** Reality minimum bond for new questions, native wei. */
  defaultMinBondWei: bigint;
  /** Policy families whose approved versions may be published (e.g. ["FUNC-001", "BOT-001"]). */
  enabledPolicyFamilies: string[];
  /**
   * When false (required in production), only catalog entries with status "approved" can be published. Draft
   * policies are for development and staging only.
   */
  allowDraftPolicies: boolean;
  /** Seer Reality question category and language. */
  questionCategory: string;
  questionLanguage: string;
}

export interface EvidenceRules {
  /** Largest accepted upload, bytes; at most 262144 (one raw IPFS block). */
  maxUploadBytes: number;
  /** Media types accepted for artifact uploads (manifests are always application/json). */
  allowedArtifactMediaTypes: string[];
}

export interface AppConfig {
  environment: DeploymentEnvironment;
  /** Public origin of the web app, e.g. https://verify.example.org (SIWE domain/uri and links derive from it). */
  publicOrigin: string;
  /** Public origin of this API. Must equal publicOrigin in production (the API is served same-origin under /api). */
  apiOrigin: string;
  /**
   * Separate origin that serves untrusted user content (evidence downloads) with attachment disposition and a
   * sandbox CSP. Must be a different registrable domain (not a subdomain) from publicOrigin, e.g. https://pine-usercontent.net.
   */
  userContentOrigin: string;
  chainId: number;
  contracts: ContractAddresses;
  seer: SeerAddresses;
  amm: AmmAddresses;
  claims: ClaimRules;
  evidence: EvidenceRules;
  /** Which read-model implementation serves chain data. */
  indexerBackend: "native" | "envio";
  /** Read model older than this (seconds behind wall clock) marks API responses as stale. */
  maxIndexerLagSeconds: number;
}
