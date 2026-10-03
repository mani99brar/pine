import "./lock.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../src/db.js";
import { EXIT_FAILED, EXIT_OK, main, type MigrateIo, type MigrationDatabase } from "../src/migrate-cli.js";
import { loadMigrations } from "../src/migrations.js";
import { openDatabase, type TestDatabase } from "./harness.js";

// The `migrate` script (PRD-05 sections 2.2 and 3b): URL validation, one redacted fatal line, exit codes and applied ids.
// The spawned process entry is tested in entries.test.ts (no database open while a child process runs).

const PASSWORD = "MigrAtorPassw0rd";
const URL_WITH_PASSWORD = `postgres://pine_owner:${PASSWORD}@db.internal:5432/pine`;

let database: TestDatabase;
beforeAll(async () => {
  database = await openDatabase({ migrate: false });
});
afterAll(async () => {
  await database.close();
});

interface Captured {
  io: MigrateIo;
  stdout: string[];
  stderr: string[];
  opened: string[];
  ended: () => number;
}

function capture(open: (url: string, onError: (error: unknown) => void) => MigrationDatabase = () => ({ db: database.db, end: async () => undefined })): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];
  let ended = 0;
  return {
    stdout,
    stderr,
    opened,
    ended: () => ended,
    io: {
      stdout: (line) => void stdout.push(line),
      stderr: (line) => void stderr.push(line),
      openDatabase: (url, onError) => {
        opened.push(url);
        const db = open(url, onError);
        return {
          db: db.db,
          end: async () => {
            ended += 1;
            await db.end();
          },
        };
      },
    },
  };
}

/** An executor whose every statement fails with a driver error echoing the connection string. */
const failingDb = (message: string): SqlExecutor => {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return { exec: fail, query: fail, transaction: fail };
};

describe("migrate script: main(env, io)", () => {
  it.each([
    ["no database URL at all", {}, "DATABASE_URL"],
    ["a non-postgres DATABASE_URL", { DATABASE_URL: `mysql://root:${PASSWORD}@db.internal/pine` }, "DATABASE_URL"],
    ["an unparseable postgres URL", { DATABASE_URL: `postgres://root:${PASSWORD}@db internal/pine` }, "DATABASE_URL"],
    ["an empty MIGRATION_DATABASE_URL (no silent fallback to DATABASE_URL)", { MIGRATION_DATABASE_URL: "", DATABASE_URL: URL_WITH_PASSWORD }, "MIGRATION_DATABASE_URL"],
  ])("refuses %s with exit code 1, naming the variable and never printing its value", async (_label, env, variable) => {
    const out = capture();
    expect(await main(env, out.io)).toBe(EXIT_FAILED);
    expect(out.stderr).toEqual([`migration refused: ${variable} must be a postgres:// URL`]);
    expect(out.stdout).toEqual([]);
    expect(out.opened).toEqual([]);
    expect(out.stderr.join("\n")).not.toContain(PASSWORD);
  });

  it("applies every migration on a fresh database and prints the applied ids; a second run applies nothing (exit 0)", async () => {
    const names = (await loadMigrations()).map((file) => file.name);
    const first = capture();
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, first.io)).toBe(EXIT_OK);
    expect(first.stdout.map((line) => JSON.parse(line) as unknown)).toEqual([{ applied: names, skipped: [] }]);
    expect(first.stderr).toEqual([]);
    expect(first.ended()).toBe(1);
    const second = capture();
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, second.io)).toBe(EXIT_OK);
    expect(second.stdout.map((line) => JSON.parse(line) as unknown)).toEqual([{ applied: [], skipped: names }]);
    expect(names).toEqual(["0001_pine_index.sql", "0002_roles.sql", "0003_drop_applied_events.sql"]);
  });

  it("prefers MIGRATION_DATABASE_URL (the DDL-capable login) over DATABASE_URL", async () => {
    const out = capture();
    const migrationUrl = "postgres://pine_owner:another-secret-1@db.internal:5432/pine";
    expect(await main({ MIGRATION_DATABASE_URL: migrationUrl, DATABASE_URL: URL_WITH_PASSWORD }, out.io)).toBe(EXIT_OK);
    expect(out.opened).toEqual([migrationUrl]);
  });

  it("a database error is one redacted fatal line with exit code 1, and the database is closed", async () => {
    const out = capture(() => ({ db: failingDb(`password authentication failed for user "pine_owner" at ${URL_WITH_PASSWORD} (password ${PASSWORD})`), end: async () => undefined }));
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, out.io)).toBe(EXIT_FAILED);
    expect(out.stderr).toHaveLength(1);
    expect(out.stderr[0]).toMatch(/^migration failed: Error: password authentication failed/);
    expect(out.stderr[0]).toContain("[REDACTED]");
    expect(out.stderr[0]).not.toContain(PASSWORD);
    expect(out.stdout).toEqual([]);
    expect(out.ended()).toBe(1);
  });

  it("a pool construction (connection-string parsing) error is caught and redacted (exit 1)", async () => {
    const out = capture(() => {
      throw new TypeError(`Invalid connection string ${URL_WITH_PASSWORD}`);
    });
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, out.io)).toBe(EXIT_FAILED);
    expect(out.stderr).toHaveLength(1);
    expect(out.stderr[0]).toMatch(/^migration failed: TypeError: Invalid connection string/);
    expect(out.stderr[0]).not.toContain(PASSWORD);
  });

  it("an idle database client error is printed through the redactor", async () => {
    const out = capture((_url, onError) => {
      onError(new Error(`terminating connection ${URL_WITH_PASSWORD}`));
      return { db: database.db, end: async () => undefined };
    });
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, out.io)).toBe(EXIT_OK);
    expect(out.stderr).toHaveLength(1);
    expect(out.stderr[0]).toMatch(/^idle database client error: /);
    expect(out.stderr[0]).not.toContain(PASSWORD);
  });

  it("a refused migration set (an applied file was modified) exits 1 with the runner's reason", async () => {
    const files = await loadMigrations();
    const out = capture();
    out.io.loadMigrations = async () => files.map((file, index) => (index === 0 ? { ...file, checksum: "0".repeat(64) } : file));
    expect(await main({ DATABASE_URL: URL_WITH_PASSWORD }, out.io)).toBe(EXIT_FAILED);
    expect(out.stderr[0]).toMatch(/^migration failed: MigrationError: Applied migration 0001_pine_index.sql was modified/);
  });
});
