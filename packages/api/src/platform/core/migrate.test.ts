// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
// src/migrate.ts (PRD-02 2.6, 3a; SEC-OPS-10): the success path on PGlite through an injected executor, and the
// refusal paths both in process and as a child process (one redacted fatal line, exit 1).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadMigrations, verifyMigrations, type MigrationFile } from "../../contracts/migrations.js";
import type { TestDatabase } from "../../contracts/testing.js";
import { main, type MigrateIo } from "../../migrate.js";
import { lockedTestDatabase } from "./testing/harness.js";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASSWORD = "migrator-password-0123456789";
const URL_WITH_SECRET = `postgres://pine_migrator:${PASSWORD}@db.internal:5432/pine`;

interface Captured {
  io: MigrateIo;
  stdout: string[];
  stderr: string[];
  exits: number[];
  connects: string[];
}

function capture(connect: MigrateIo["connect"]): Captured {
  const out: Captured = { stdout: [], stderr: [], exits: [], connects: [], io: undefined as unknown as MigrateIo };
  out.io = {
    connect: async (url) => {
      out.connects.push(url);
      return connect(url);
    },
    stdout: (text) => void out.stdout.push(text),
    stderr: (text) => void out.stderr.push(text),
    exit: (code) => void out.exits.push(code),
  };
  return out;
}

const neverConnect: MigrateIo["connect"] = async () => {
  throw new Error("must not connect");
};

let database: TestDatabase | null = null;
afterAll(async () => {
  await database?.close();
}, 60_000);

describe("migrate main(env, io)", () => {
  it("applies every pending migration through the injected executor, prints the ids and exits 0; a rerun applies nothing", async () => {
    database = await lockedTestDatabase({ applyMigrations: false });
    const db = database;
    // Production: the DBA pre-creates pine_api WITH LOGIN; 0002 must then be a no-op for the role (IF NOT EXISTS).
    await db.sql.exec("CREATE ROLE pine_api LOGIN");
    const expected = (await loadMigrations()).map((file) => `${file.group}/${file.name}`);
    expect(expected).toContain("platform/0002_platform_core.sql");
    let closed = 0;
    const connect: MigrateIo["connect"] = async () => ({
      executor: db.sql,
      close: async () => {
        closed += 1;
      },
    });

    const first = capture(connect);
    await main({ PINE_MIGRATOR_DATABASE_URL: URL_WITH_SECRET }, first.io);
    expect(first.exits).toEqual([0]);
    expect(first.connects).toEqual([URL_WITH_SECRET]);
    expect(first.stdout).toEqual(expected.map((id) => `applied ${id}\n`));
    expect(closed).toBe(1);
    await expect(verifyMigrations(db.sql, await loadMigrations())).resolves.toBeUndefined();
    expect(first.stderr.join("")).not.toContain(PASSWORD);
    expect(await db.sql.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'pine_api'")).toEqual([{ rolcanlogin: true }]);
    // The grants were applied to the pre-existing role.
    await db.sql.exec("SET ROLE pine_api");
    try {
      await db.sql.exec("INSERT INTO audit_log (action, subject_type, subject_id) VALUES ('test.grant', 'x', 'y')");
      await expect(db.sql.exec("UPDATE audit_log SET action = 'forged'")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.sql.exec("RESET ROLE");
    }

    const second = capture(connect);
    await main({ PINE_MIGRATOR_DATABASE_URL: URL_WITH_SECRET }, second.io);
    expect(second.exits).toEqual([0]);
    expect(second.stdout).toEqual([]);
    expect(JSON.parse(second.stderr.join("").trim())).toMatchObject({ level: "info", applied: 0, skipped: expected.length });
  }, 120_000);

  for (const [name, mutate] of [
    ["a migration file with invalid SQL", (files: MigrationFile[]) => [...files, { group: "platform" as const, name: "0999_broken.sql", number: 999, sql: "CREATE TABL broken (", checksum: "broken" }]],
    ["a changed checksum of an applied migration", (files: MigrationFile[]) => files.map((file, i) => (i === 0 ? { ...file, checksum: "tampered" } : file))],
  ] as const) {
    it(`SEC-OPS-10 exits 1 with one redacted fatal line and applies nothing when runMigrations fails: ${name}`, async () => {
      const db = database;
      if (db === null) throw new Error("the success-path test must run first");
      const ledgerBefore = await db.sql.query("SELECT id, checksum FROM schema_migrations ORDER BY id");
      let closed = 0;
      const files = mutate(await loadMigrations());
      const run = capture(async () => ({ executor: db.sql, close: async () => void (closed += 1) }));
      await main({ PINE_MIGRATOR_DATABASE_URL: URL_WITH_SECRET }, { ...run.io, loadMigrations: async () => files });
      expect(run.exits).toEqual([1]);
      expect(run.stdout).toEqual([]);
      const lines = run.stderr.join("").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "fatal", msg: "migration failed" });
      expect(lines[0]).not.toContain(PASSWORD);
      expect(closed).toBe(1);
      expect(await db.sql.query("SELECT id, checksum FROM schema_migrations ORDER BY id")).toEqual(ledgerBefore);
    }, 60_000);
  }

  for (const [name, env] of [
    ["SEC-OPS-10 a missing migrator URL", {}],
    ["SEC-OPS-10 a non-postgres migrator URL", { PINE_MIGRATOR_DATABASE_URL: `mysql://root:${PASSWORD}@db.internal/pine` }],
  ] as const) {
    it(`refuses ${name} with one redacted fatal line and exit 1, without connecting`, async () => {
      const run = capture(neverConnect);
      await main(env, run.io);
      expect(run.exits).toEqual([1]);
      expect(run.connects).toEqual([]);
      expect(run.stdout).toEqual([]);
      const lines = run.stderr.join("").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "fatal", msg: "migration failed" });
      expect(lines[0]).toContain("PINE_MIGRATOR_DATABASE_URL");
      expect(lines[0]).not.toContain(PASSWORD);
    });
  }

  it("SEC-OPS-02 a connection failure that echoes the URL is reported redacted with exit 1", async () => {
    const run = capture(async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    });
    await main({ PINE_MIGRATOR_DATABASE_URL: URL_WITH_SECRET }, run.io);
    expect(run.exits).toEqual([1]);
    const text = run.stderr.join("");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain(PASSWORD);
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});

describe("migrate as a child process", () => {
  const runChild = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/migrate.ts"], {
      cwd: API_DIR,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
      timeout: 60_000,
    });

  for (const [name, env] of [
    ["SEC-OPS-10 a missing migrator URL", {}],
    ["SEC-OPS-10 a non-postgres migrator URL", { PINE_MIGRATOR_DATABASE_URL: `mysql://root:${PASSWORD}@db.internal/pine` }],
  ] as const) {
    it(`refuses ${name}: exit 1, one redacted fatal line on stderr, nothing on stdout`, () => {
      const child = runChild(env);
      expect(child.status).toBe(1);
      expect(child.stdout).toBe("");
      const lines = child.stderr.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "fatal", msg: "migration failed" });
      expect(child.stderr).not.toContain(PASSWORD);
    }, 90_000);
  }
});
