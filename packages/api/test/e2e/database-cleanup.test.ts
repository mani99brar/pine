// The PostgreSQL e2e setup's safety helpers (PRD-06 section 3a, support/cluster.ts): the role bootstrap refuses a cluster
// that is not on loopback unless PINE_E2E_DISPOSABLE_CLUSTER=1, and a failed DROP DATABASE fails the cleanup with a
// redacted message instead of being swallowed. The guard is also exercised through openE2eDatabase (both modes: the
// refusal happens before any connection). The last cases run on PostgreSQL 16 only: a real e2e database is opened,
// closed, and must be gone from pg_database; and a drop forced to fail fails the e2e harness's close().

import pg from "pg";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/contracts/redact.js";
import { assertDisposableCluster, closeE2eDatabase, DISPOSABLE_CLUSTER_FLAG, disposableClusterRefusal, dropE2eDatabase } from "./support/cluster.js";
import { createE2e } from "./support/app.js";
import { databaseMode, E2E_ROLES, openE2eDatabase } from "./support/database.js";

const SECRET_URL = "postgres://postgres:cluster-superuser-password-0001@db.prod.example:5432/postgres";

describe("disposableClusterRefusal (the bootstrapRoles guard)", () => {
  it("accepts the loopback hosts 127.0.0.1, ::1 and localhost", () => {
    for (const url of [
      "postgres://postgres@127.0.0.1:55432/postgres",
      "postgres://postgres:postgres@127.0.0.1:5432/postgres",
      "postgresql://postgres@localhost/postgres",
      "postgres://postgres@LOCALHOST:5432/postgres",
      "postgres://postgres@[::1]:5432/postgres",
      "postgres://postgres@[0:0:0:0:0:0:0:1]:5432/postgres",
      "postgres://postgres@127.0.0.1/postgres?sslmode=disable",
    ]) {
      expect(disposableClusterRefusal(url, {}), url).toBeNull();
    }
  });

  it("refuses remote hosts, look-alike hosts, host overrides, sockets and non-postgres URLs", () => {
    for (const url of [
      "postgres://postgres@db.prod.example:5432/postgres",
      "postgres://postgres@10.0.0.5/postgres",
      "postgres://postgres@127.0.0.2/postgres",
      "postgres://postgres@127.1/postgres",
      "postgres://postgres@localhost.example.com/postgres",
      "postgres://postgres@127.0.0.1.nip.io/postgres",
      // pg (pg-connection-string) connects to the `host`/`hostaddr` parameter, not the authority.
      "postgres://postgres@127.0.0.1/postgres?host=db.prod.example",
      "postgres://postgres@localhost/postgres?hostaddr=10.0.0.5",
      "postgres://postgres@127.0.0.1/postgres?host=/var/run/postgresql",
      "postgres:///postgres?host=/var/run/postgresql",
      "socket://postgres@/var/run/postgresql",
      "mysql://postgres@127.0.0.1/postgres",
      "not a url",
      "",
    ]) {
      expect(disposableClusterRefusal(url, {}), url).toMatch(new RegExp(`${DISPOSABLE_CLUSTER_FLAG}=1`));
    }
  });

  it("accepts any cluster only with PINE_E2E_DISPOSABLE_CLUSTER=1 exactly", () => {
    expect(disposableClusterRefusal(SECRET_URL, { [DISPOSABLE_CLUSTER_FLAG]: "1" })).toBeNull();
    for (const value of ["0", "true", "yes", " 1", ""]) expect(disposableClusterRefusal(SECRET_URL, { [DISPOSABLE_CLUSTER_FLAG]: value }), value).not.toBeNull();
  });

  it("throws without echoing the URL or its password", () => {
    let message = "";
    try {
      assertDisposableCluster(SECRET_URL, {});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^refusing to bootstrap the e2e roles: .*loopback/);
    expect(message).not.toContain("cluster-superuser-password-0001");
    expect(message).not.toContain("db.prod.example");
    expect(() => assertDisposableCluster("postgres://postgres@127.0.0.1/postgres", {})).not.toThrow();
  });
});

describe("openE2eDatabase", () => {
  it("refuses a non-loopback cluster before contacting it, without echoing the URL or its password", async () => {
    const env = { PINE_E2E_DATABASE_URL: SECRET_URL, PINE_E2E_REQUIRE_PG: "1" };
    const error = await openE2eDatabase(env).then(
      () => null,
      (failure: unknown) => failure,
    );
    const message = error instanceof Error ? error.message : "";
    expect(message).toMatch(/^refusing to bootstrap the e2e roles: .*loopback/);
    expect(message).not.toContain("cluster-superuser-password-0001");
    expect(message).not.toContain("db.prod.example");
  });
});

describe("e2e database cleanup", () => {
  const redact = createRedactor([SECRET_URL]);
  const NAME = "pine_e2e_0123456789ab";

  it("drops the file's database, terminating leftover sessions", async () => {
    const sql: string[] = [];
    await dropE2eDatabase(async (statement) => void sql.push(statement), NAME, redact);
    expect(sql).toEqual([`DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`]);
  });

  it("refuses to drop a database the setup did not create", async () => {
    const sql: string[] = [];
    for (const name of ["pine", "postgres", 'pine_e2e_0123456789ab"; DROP DATABASE pine; --', "pine_e2e_", "pine_e2e_0123456789AB"]) {
      await expect(dropE2eDatabase(async (statement) => void sql.push(statement), name, redact), name).rejects.toThrow(/did not create/);
    }
    expect(sql).toEqual([]);
  });

  it("reports a failed DROP DATABASE with a redacted message (forced failure)", async () => {
    const failing = () => Promise.reject(new Error(`database "${NAME}" is being accessed by other users; connection ${SECRET_URL}`));
    const error = await dropE2eDatabase(failing, NAME, redact).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain(`DROP DATABASE ${NAME} failed`);
    expect(message).toContain("is being accessed by other users");
    expect(message).not.toContain("cluster-superuser-password-0001");
  });

  it("closeE2eDatabase fails when the drop fails, after closing every connection and ending the admin connection", async () => {
    const order: string[] = [];
    const cleanup = closeE2eDatabase({
      disconnect: [async () => void order.push("pool"), () => Promise.reject(new Error("pool already ended"))],
      drop: () => dropE2eDatabase(() => Promise.reject(new Error(`could not drop: ${SECRET_URL}`)), NAME, redact).finally(() => order.push("drop")),
      endAdmin: async () => void order.push("admin"),
      redact,
    });
    await expect(cleanup).rejects.toThrow(/DROP DATABASE pine_e2e_0123456789ab failed/);
    await cleanup.catch((error: unknown) => expect(String(error)).not.toContain("cluster-superuser-password-0001"));
    // A disconnect failure is not fatal (the forced drop terminates leftover sessions); the drop and the admin end still run.
    expect(order).toEqual(["pool", "drop", "admin"]);
  });

  it("closeE2eDatabase reports a failed admin end and succeeds when everything closes", async () => {
    await expect(closeE2eDatabase({ disconnect: [], drop: null, endAdmin: () => Promise.reject(new Error(`end: ${SECRET_URL}`)), redact })).rejects.toThrow(/closing the admin connection failed: end: \[REDACTED\]/);
    const dropped: string[] = [];
    await expect(closeE2eDatabase({ disconnect: [], drop: async () => void dropped.push(NAME), endAdmin: async () => undefined, redact })).resolves.toBeUndefined();
    expect(dropped).toEqual([NAME]);
  });
});

describe.runIf(databaseMode() === "postgres")("e2e database lifecycle on PostgreSQL 16", () => {
  it("creates its own pine_e2e_<hex> database and drops it on close (gone from pg_database)", async () => {
    const adminUrl = process.env.PINE_E2E_DATABASE_URL ?? "";
    const admin = new pg.Client({ connectionString: adminUrl, application_name: "pine-e2e-cleanup-check" });
    admin.on("error", () => undefined);
    await admin.connect();
    try {
      const exists = async (name: string) => (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1;
      const db = await openE2eDatabase();
      expect(db.mode).toBe("postgres");
      expect(db.name).toMatch(/^pine_e2e_[0-9a-f]{12}$/);
      expect(await exists(db.name)).toBe(true);
      // Sessions still open on the database (the API pool, the indexer pool, the file's admin client) do not block the drop.
      await db.api.sql.query("SELECT 1");
      await db.indexer.query("SELECT 1");
      await db.close();
      expect(await exists(db.name)).toBe(false);
    } finally {
      await admin.end();
    }
  });

  it("fails the harness's close() with a redacted message when the drop really fails (template database)", async () => {
    const adminUrl = process.env.PINE_E2E_DATABASE_URL ?? "";
    const admin = new pg.Client({ connectionString: adminUrl, application_name: "pine-e2e-cleanup-check" });
    admin.on("error", () => undefined);
    await admin.connect();
    const e2e = await createE2e();
    const name = e2e.db.name;
    const secrets = [...e2e.db.secrets, ...e2e.secretStrings()].filter((value) => value.length >= 8);
    try {
      expect(name).toMatch(/^pine_e2e_[0-9a-f]{12}$/);
      // PostgreSQL refuses to drop a template database, even WITH (FORCE).
      await admin.query(`ALTER DATABASE "${name}" IS_TEMPLATE true`);
      const error = await e2e.close().then(
        () => null,
        (failure: unknown) => failure,
      );
      const message = error instanceof Error ? error.message : "";
      expect(message).toMatch(new RegExp(`DROP DATABASE ${name} failed: .*template database`));
      for (const secret of secrets) expect(message.includes(secret), "the cleanup error leaks a secret").toBe(false);
      for (const role of E2E_ROLES) expect(message).not.toContain(`${role.replace("_", "-")}-e2e-password`);
    } finally {
      if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1) {
        await admin.query(`ALTER DATABASE "${name}" IS_TEMPLATE false`);
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      }
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount).toBe(0);
      await admin.end();
    }
  });
});
