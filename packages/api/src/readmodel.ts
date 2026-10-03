// Read-model composition (PRD-06 section 3, ADR-0001): `secrets.readModel.kind` selects the native indexer's Postgres
// schema (`@pine/indexer-native`, read through the read-only role) or Envio's GraphQL API (`@pine/read-model-envio`).
// Fails closed before the API serves anything: the backend must match `config.indexerBackend`, the native index schema
// must be exactly the migrations this build knows and must not hold another chain's cursor, and an Envio endpoint must
// index the configured chain id. Error messages never carry the database URL, the GraphQL URL or the admin secret.

import { createEnvioReadModel, type FetchLike } from "@pine/read-model-envio";
import {
  createNativeReadModel,
  loadMigrations as loadIndexMigrations,
  pgPoolExecutor,
  verifyMigrations as verifyIndexMigrations,
  type SqlExecutor,
} from "@pine/indexer-native";
import type { ReadModel } from "@pine/shared/read-model";
import type { ReadModelFactory } from "./contracts/platform.js";
import { safeErrorMessage } from "./contracts/redact.js";
import { createPool } from "./platform/core/pg.js";

export type ClosableReadModel = ReadModel & { close(): Promise<void> };
type ReadModelDeps = Parameters<ReadModelFactory>[0];

/** Connections of the read-only role; the read model only runs short SELECTs. */
export const NATIVE_POOL_MAX = 5;

export class ReadModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadModelConfigError";
  }
}

export interface NativeConnection {
  executor: SqlExecutor;
  close(): Promise<void>;
}

/** The I/O the factory needs; production uses node-postgres and globalThis.fetch, the e2e suite injects PGlite or fakes. */
export interface ReadModelIo {
  connectNative(databaseUrl: string): Promise<NativeConnection>;
  /** Fetch for the Envio GraphQL endpoint (undefined: the package's default, globalThis.fetch). */
  envioFetch?: FetchLike;
  /** Allows an Envio admin secret over http:// (in-process tests only; never derived from the environment). */
  envioAllowInsecureTransport?: boolean;
}

async function connectNativePool(databaseUrl: string): Promise<NativeConnection> {
  const pool = createPool({ connectionString: databaseUrl, max: NATIVE_POOL_MAX, applicationName: "pine-api-read-model" });
  // An idle-client error must not crash the process; its message may echo the URL and is never logged raw.
  pool.on("error", () => undefined);
  return { executor: pgPoolExecutor(pool), close: () => pool.end() };
}

export const productionReadModelIo: ReadModelIo = { connectNative: connectNativePool };

/** Refuses an index that holds the cursor of another chain (the API would serve another network's claims). */
async function assertNativeChain(executor: SqlExecutor, chainId: number): Promise<void> {
  const rows = await executor.query<{ chain_id: number }>("SELECT chain_id FROM pine_index.cursor ORDER BY chain_id");
  const foreign = rows.map((row) => Number(row.chain_id)).filter((id) => id !== chainId);
  if (foreign.length > 0) throw new ReadModelConfigError(`the native index holds chain id ${foreign.join(", ")}, the API is configured for chain id ${chainId}`);
}

async function createNative(deps: ReadModelDeps, databaseUrl: string, io: ReadModelIo): Promise<ClosableReadModel> {
  const connection = await io.connectNative(databaseUrl);
  try {
    // SELECT-only checks with the read-only role: the schema is exactly what this build's read model queries.
    await verifyIndexMigrations(connection.executor, await loadIndexMigrations());
    await assertNativeChain(connection.executor, deps.config.chainId);
  } catch (error) {
    await connection.close().catch(() => undefined);
    if (error instanceof ReadModelConfigError) throw error;
    throw new ReadModelConfigError(`native read model refused: ${safeErrorMessage(error, deps.redact)}`);
  }
  const model = createNativeReadModel(connection.executor, { chainId: deps.config.chainId });
  return Object.assign(model, { close: () => connection.close() });
}

async function createEnvio(deps: ReadModelDeps, graphqlUrl: string, adminSecret: string | null, io: ReadModelIo): Promise<ClosableReadModel> {
  const model = createEnvioReadModel({
    graphqlUrl,
    chainId: deps.config.chainId,
    ...(adminSecret !== null ? { adminSecret } : {}),
    ...(io.envioFetch !== undefined ? { fetch: io.envioFetch } : {}),
    ...(io.envioAllowInsecureTransport === true ? { allowInsecureTransport: true } : {}),
  });
  // status() throws unless the endpoint reports the configured chain (`chain N is not indexed by this endpoint`).
  let reported: number;
  try {
    reported = (await model.status()).chainId;
  } catch (error) {
    throw new ReadModelConfigError(`Envio read model refused: ${safeErrorMessage(error, deps.redact)}`);
  }
  if (reported !== deps.config.chainId) throw new ReadModelConfigError(`the Envio endpoint reports chain id ${reported}, the API is configured for chain id ${deps.config.chainId}`);
  // HTTP only: nothing to release.
  return Object.assign(model, { close: async () => undefined });
}

/** The factory with explicit I/O (tests); `createReadModel` is this with the production I/O. */
export async function buildReadModel(deps: ReadModelDeps, io: ReadModelIo): Promise<ClosableReadModel> {
  const { config, secrets } = deps;
  if (secrets.readModel.kind !== config.indexerBackend) {
    throw new ReadModelConfigError(`the read-model connection is for ${secrets.readModel.kind} but PINE_INDEXER_BACKEND is ${config.indexerBackend}`);
  }
  if (secrets.readModel.kind === "native") return createNative(deps, secrets.readModel.databaseUrl, io);
  return createEnvio(deps, secrets.readModel.graphqlUrl, secrets.readModel.adminSecret, io);
}

export const createReadModel: ReadModelFactory = (deps) => buildReadModel(deps, productionReadModelIo);
