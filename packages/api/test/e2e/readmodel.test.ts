// src/readmodel.ts (PRD-06 section 3): the read model is selected by secrets.readModel.kind (native default, Envio
// wired), the backend's chain id must equal the configuration's, and nothing it reports on refusal carries the
// connection URL or the admin secret. On real Postgres the native read model connects with the production pool as
// pine_readonly through createReadModel itself, and the role grants are proven (SEC-IDX-11, SEC-OPS-07/10).

import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "@pine/read-model-envio";
import { scenarioClaimsAndEvidence } from "@pine/shared/testing/read-model-scenarios";
import { applyEvents, advanceCursor } from "@pine/indexer-native";
import type { PlatformSecrets } from "../../src/contracts/platform.js";
import { createRedactor } from "../../src/contracts/redact.js";
import { FakeClock, testConfig } from "../../src/contracts/testing.js";
import { buildReadModel, createReadModel, ReadModelConfigError } from "../../src/readmodel.js";
import { databaseMode, openE2eDatabase, type E2eDatabase } from "./support/database.js";

let db: E2eDatabase;
const clock = new FakeClock();
const config = testConfig();
const ENVIO_URL = "https://envio.internal.example/v1/graphql?apikey=e2e-envio-url-key-0123456789";
const ENVIO_SECRET = "e2e-envio-admin-secret-0123456789";

const secretsWith = (readModel: PlatformSecrets["readModel"]): PlatformSecrets => ({ readModel }) as PlatformSecrets;
const deps = (readModel: PlatformSecrets["readModel"], overrides: Partial<typeof config> = {}) => ({
  config: { ...config, ...overrides },
  secrets: secretsWith(readModel),
  redact: createRedactor([db.readModelUrl, ENVIO_URL, ENVIO_SECRET, ...db.secrets]),
  clock,
});

/** A Hasura endpoint that answers the read model's Status query for the given chains (the meta shape of src/envio-meta.ts). */
function envioEndpoint(chains: number[], seen: { urls: string[]; headers: Record<string, string>[] }): FetchLike {
  return async (url, init) => {
    seen.urls.push(url);
    seen.headers.push(init.headers);
    const body = JSON.stringify({
      data: {
        _meta: chains.map((chainId) => ({ chainId, progressBlock: "41000000", sourceBlock: "41000010" })),
        IndexerProgress_by_pk: { blockNumber: "41000000", blockTimestamp: 1_790_000_000 },
      },
    });
    return { ok: true, status: 200, body: new Blob([body]).stream() };
  };
}

beforeAll(async () => {
  db = await openE2eDatabase();
  const { events } = scenarioClaimsAndEvidence();
  await db.indexer.transaction(async (tx) => {
    await applyEvents(tx, events, { chainId: 100, questionTimeout: 302_400 });
    const last = events.at(-1);
    if (last) await advanceCursor(tx, { chainId: 100, block: last.blockNumber, blockHash: last.blockHash, blockTimestamp: last.blockTimestamp });
  });
}, 30 * 60_000);

afterAll(async () => {
  await db?.close();
}, 120_000);

describe("native read model (default)", () => {
  it("serves the indexed scenario through the factory with the configured chain id", async () => {
    const model = await buildReadModel(deps({ kind: "native", databaseUrl: db.readModelUrl }), db.readModelIo);
    try {
      const status = await model.status();
      expect(status).toMatchObject({ backend: "native", chainId: 100, halted: false });
      const page = await model.listClaims({ order: "created_desc", limit: 10 });
      expect(page.items.length).toBe(3);
    } finally {
      await model.close();
    }
  });

  it("refuses a native index that holds another chain's cursor", async () => {
    await db.indexer.query("INSERT INTO pine_index.cursor (chain_id) VALUES (10200) RETURNING chain_id");
    try {
      const refusal = await buildReadModel(deps({ kind: "native", databaseUrl: db.readModelUrl }), db.readModelIo).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(ReadModelConfigError);
      expect(String(refusal)).toMatch(/chain id 10200.*chain id 100/);
    } finally {
      await db.indexer.query("DELETE FROM pine_index.cursor WHERE chain_id = 10200 RETURNING chain_id");
    }
  });

  it("refuses when the connection kind and PINE_INDEXER_BACKEND disagree", async () => {
    await expect(buildReadModel(deps({ kind: "native", databaseUrl: db.readModelUrl }, { indexerBackend: "envio" }), db.readModelIo)).rejects.toThrow(ReadModelConfigError);
  });

  it("refuses an index whose migrations are not exactly this build's, without echoing the URL", async () => {
    await db.admin.query("INSERT INTO pine_index.schema_migrations (id, checksum) VALUES ('9999_from_the_future.sql', 'x') RETURNING id");
    try {
      const refusal = await buildReadModel(deps({ kind: "native", databaseUrl: db.readModelUrl }), db.readModelIo).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(ReadModelConfigError);
      expect(String(refusal)).toMatch(/9999_from_the_future\.sql/);
      expect(String(refusal)).not.toContain(db.readModelUrl);
    } finally {
      await db.admin.query("DELETE FROM pine_index.schema_migrations WHERE id = '9999_from_the_future.sql' RETURNING id");
    }
  });
});

describe("Envio read model (wired; live conformance is a launch gate)", () => {
  it("selects the Envio client for kind envio and checks that the endpoint indexes the configured chain", async () => {
    const seen = { urls: [] as string[], headers: [] as Record<string, string>[] };
    const model = await buildReadModel(deps({ kind: "envio", graphqlUrl: ENVIO_URL, adminSecret: null }, { indexerBackend: "envio" }), { connectNative: () => Promise.reject(new Error("unused")), envioFetch: envioEndpoint([100], seen) });
    expect(await model.status()).toMatchObject({ backend: "envio", chainId: 100, indexedBlock: 41_000_000n });
    await model.close();
    expect(seen.urls.every((url) => url === ENVIO_URL)).toBe(true);
    // No admin secret configured: none is sent (the API reads through a select-only Hasura role).
    expect(seen.headers.every((headers) => !("x-hasura-admin-secret" in headers))).toBe(true);
  });

  it("refuses an Envio endpoint that indexes another chain, without echoing the URL or the admin secret", async () => {
    const seen = { urls: [] as string[], headers: [] as Record<string, string>[] };
    const refusal = await buildReadModel(deps({ kind: "envio", graphqlUrl: ENVIO_URL, adminSecret: ENVIO_SECRET }, { indexerBackend: "envio" }), {
      connectNative: () => Promise.reject(new Error("unused")),
      envioFetch: envioEndpoint([10200], seen),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ReadModelConfigError);
    expect(String(refusal)).not.toContain("envio.internal.example/v1");
    expect(String(refusal)).not.toContain(ENVIO_SECRET);
    expect(String(refusal)).not.toContain("e2e-envio-url-key");
    // The admin secret travels only as a header, over https.
    expect(seen.headers[0]?.["x-hasura-admin-secret"]).toBe(ENVIO_SECRET);
  });
});

describe.skipIf(databaseMode() !== "postgres")("production pool and role grants (real PostgreSQL 16)", () => {
  it("createReadModel (production I/O) reads as pine_readonly; a refused login does not echo the URL or password", async () => {
    const model = await createReadModel(deps({ kind: "native", databaseUrl: db.readModelUrl }));
    try {
      expect((await model.listClaims({ order: "created_desc", limit: 10 })).items).toHaveLength(3);
    } finally {
      await model.close();
    }
    // A role that does not exist fails under any pg_hba method (the operator's cluster may use trust auth).
    const wrong = new URL(db.readModelUrl);
    wrong.username = "pine_e2e_no_such_role";
    wrong.password = `wrong-${randomBytes(8).toString("hex")}`;
    const refusal = await createReadModel({ ...deps({ kind: "native", databaseUrl: wrong.toString() }), redact: createRedactor([wrong.toString()]) }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ReadModelConfigError);
    expect(String(refusal)).not.toContain(wrong.password);
  });

  it("SEC-IDX-11 pine_readonly can only read pine_index; pine_api has DML on every API table but cannot alter the audit log or the ledger", async () => {
    const privileges = await db.admin.query<{ role: string; target: string; privilege: string; granted: boolean }>(`
      SELECT r.role, t.target, p.privilege, has_table_privilege(r.role, t.target, p.privilege) AS granted
        FROM (VALUES ('pine_readonly'), ('pine_api'), ('pine_indexer')) AS r(role)
        CROSS JOIN (VALUES ('pine_index.claims'), ('pine_index.halts'), ('public.claim_drafts'), ('public.markets_plans'), ('public.funding_plans'),
                           ('public.content_blobs'), ('public.github_tokens'), ('public.audit_log'), ('public.schema_migrations')) AS t(target)
        CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(privilege)`);
    const granted = (role: string, target: string, privilege: string) => privileges.find((row) => row.role === role && row.target === target && row.privilege === privilege)?.granted;
    // pine_readonly: SELECT on pine_index only, never DML, nothing in public.
    expect(granted("pine_readonly", "pine_index.claims", "SELECT")).toBe(true);
    expect(granted("pine_readonly", "pine_index.claims", "INSERT")).toBe(false);
    expect(granted("pine_readonly", "pine_index.halts", "DELETE")).toBe(false);
    expect(granted("pine_readonly", "public.claim_drafts", "SELECT")).toBe(false);
    // pine_api: DML on the module tables created after platform 0002 (default privileges of pine_migrator).
    for (const table of ["public.claim_drafts", "public.markets_plans", "public.funding_plans", "public.content_blobs", "public.github_tokens"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(granted("pine_api", table, privilege), `${table} ${privilege}`).toBe(true);
    }
    expect(granted("pine_api", "public.audit_log", "INSERT")).toBe(true);
    expect(granted("pine_api", "public.audit_log", "UPDATE")).toBe(false);
    expect(granted("pine_api", "public.audit_log", "DELETE")).toBe(false);
    expect(granted("pine_api", "public.schema_migrations", "INSERT")).toBe(false);
    expect(granted("pine_api", "pine_index.claims", "SELECT")).toBe(false);
    // pine_indexer: DML on pine_index only.
    expect(granted("pine_indexer", "pine_index.halts", "INSERT")).toBe(true);
    expect(granted("pine_indexer", "public.claim_drafts", "SELECT")).toBe(false);
    // No runtime role may create objects (no DDL) in either schema.
    const ddl = await db.admin.query<{ role: string; schema: string; create: boolean }>(`
      SELECT r.role, s.schema, has_schema_privilege(r.role, s.schema, 'CREATE') AS create
        FROM (VALUES ('pine_readonly'), ('pine_api'), ('pine_indexer')) AS r(role) CROSS JOIN (VALUES ('public'), ('pine_index')) AS s(schema)`);
    expect(ddl.filter((row) => row.create)).toEqual([]);
    // And the read-only role really cannot write, even through its own connection.
    const client = new pg.Client({ connectionString: db.readModelUrl });
    client.on("error", () => undefined);
    await client.connect();
    try {
      await expect(client.query("DELETE FROM pine_index.halts")).rejects.toThrow(/permission denied|read-only transaction/);
    } finally {
      await client.end();
    }
  });
});
