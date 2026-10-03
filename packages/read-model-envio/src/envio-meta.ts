// The ONE place that names Envio's indexer-metadata fields. UNVERIFIED until the live gate (`pnpm test:live` against a
// real Envio deployment): taken from the Envio v3 docs (docs/research/envio-hyperindex.md section 6, "_meta { chainId
// progressBlock sourceBlock isReady ... }"), not observed on a running Hasura. Envio's _meta has no block timestamp, so
// status() also reads the IndexerProgress singleton the handlers maintain (packages/indexer-envio/schema.graphql).

export const ENVIO_META = {
  /** Root field of the per-chain indexing metadata: a list with one row per chain (selected by chainId in code). */
  root: "_meta",
  chainId: "chainId",
  /** Highest block whose events are fully processed. */
  progressBlock: "progressBlock",
  /** Latest block height the source (HyperSync/RPC) reported. */
  sourceBlock: "sourceBlock",
} as const;

export const ENVIO_PROGRESS = {
  /** Entity written by every handler: id = chain id, last applied block and its timestamp. */
  entity: "IndexerProgress",
  blockNumber: "blockNumber",
  blockTimestamp: "blockTimestamp",
} as const;
