import "./lock.js";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import { SCENARIO_CHAIN_ID, SCENARIO_QUESTION_TIMEOUT, scenarioClaimsAndEvidence, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import { applyEvents } from "../src/apply.js";
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, MigrationError, runMigrations, verifyMigrations } from "../src/migrations.js";
import { createNativeReadModel } from "../src/read-model.js";
import { advanceCursor, recordBlock, recordHalt, recordObservation } from "../src/store.js";
import { openDatabase, type TestDatabase } from "./harness.js";

let database: TestDatabase;
let scratch: string;

beforeAll(async () => {
  database = await openDatabase({ migrate: false });
  scratch = await mkdtemp(path.join(os.tmpdir(), "pine-index-migrations-"));
});
afterAll(async () => {
  await database.close();
  await rm(scratch, { recursive: true, force: true });
});

async function copyOfMigrations(name: string): Promise<string> {
  const dir = path.join(scratch, name);
  await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

describe("migrations and roles", () => {
  it("applies the ordered files once, then verifies and skips them", async () => {
    const files = await loadMigrations();
    expect(files.map((file) => file.name)).toEqual((await readdir(DEFAULT_MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort());
    await expect(verifyMigrations(database.db, files)).rejects.toThrow(/Pending/);
    expect((await runMigrations(database.db, files)).applied).toEqual(files.map((file) => file.name));
    expect(await runMigrations(database.db, files)).toEqual({ applied: [], skipped: files.map((file) => file.name) });
    await verifyMigrations(database.db, files);
  });

  it("refuses a modified applied file", async () => {
    const dir = await copyOfMigrations("modified");
    const files = await loadMigrations(dir);
    await writeFile(path.join(dir, files[0]!.name), `${files[0]!.sql}\n-- edited\n`);
    await expect(runMigrations(database.db, await loadMigrations(dir))).rejects.toThrow(MigrationError);
    await expect(verifyMigrations(database.db, await loadMigrations(dir))).rejects.toThrow(/modified/);
  });

  it("refuses an orphan ledger entry (a deleted file)", async () => {
    const dir = await copyOfMigrations("orphan");
    const files = await loadMigrations(dir);
    await rm(path.join(dir, files.at(-1)!.name));
    await expect(verifyMigrations(database.db, await loadMigrations(dir))).rejects.toThrow(/no file/);
  });

  it("refuses a file numbered below an applied one, bad names and CR line endings", async () => {
    const late = await copyOfMigrations("late");
    await writeFile(path.join(late, "0000_late.sql"), "SELECT 1;\n");
    await expect(runMigrations(database.db, await loadMigrations(late))).rejects.toThrow(/numbered below/);
    const badName = await copyOfMigrations("bad-name");
    await writeFile(path.join(badName, "9_x.sql"), "SELECT 1;\n");
    await expect(loadMigrations(badName)).rejects.toThrow(/Invalid migration file name/);
    const crlf = await copyOfMigrations("crlf");
    await writeFile(path.join(crlf, "0099_crlf.sql"), "SELECT 1;\r\n");
    await expect(loadMigrations(crlf)).rejects.toThrow(/CR/);
  });

  it("SEC-IDX-11 pine_readonly can only read: an INSERT fails with 42501", async () => {
    await database.db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pine_readonly");
      await tx.query("SELECT count(*)::text AS count FROM pine_index.claims");
      await tx.query("SELECT count(*)::text AS count FROM pine_index.halts");
    });
    for (const statement of [
      "INSERT INTO pine_index.tracked_conditions (condition_id) VALUES ('0x01')","UPDATE pine_index.cursor SET head_block = 1", "DELETE FROM pine_index.halts", "INSERT INTO pine_index.halts (chain_id, reason, detail) VALUES (100, 'apply_conflict', 'x')"]) {
      const code = await database.db
        .transaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE pine_readonly");
          await tx.exec(statement);
        })
        .then(() => "ok", (error: { code?: string }) => error.code);
      expect(code, statement).toBe("42501");
    }
  });

  it("SEC-IDX-11 pine_indexer has DML on the data tables but no DDL and cannot rewrite the migration ledger", async () => {
    await database.db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pine_indexer");
      await tx.exec("INSERT INTO pine_index.tracked_conditions (condition_id) VALUES ('0x02')");
      await tx.exec("UPDATE pine_index.tracked_conditions SET condition_id = '0x03' WHERE condition_id = '0x02'");
      await tx.exec("INSERT INTO pine_index.halts (chain_id, reason, detail) VALUES (100, 'apply_conflict', 'x')");
      await tx.exec("DELETE FROM pine_index.halts");
      await tx.exec("DELETE FROM pine_index.tracked_conditions");
      await tx.query("SELECT id FROM pine_index.schema_migrations");
    });
    for (const statement of [
      "CREATE TABLE pine_index.x (id int)",
      "ALTER TABLE pine_index.claims ADD COLUMN x int",
      "DROP TABLE pine_index.claims",
      "UPDATE pine_index.schema_migrations SET checksum = 'x'",
      "DELETE FROM pine_index.schema_migrations",
    ]) {
      const code = await database.db
        .transaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE pine_indexer");
          await tx.exec(statement);
        })
        .then(() => "ok", (error: { code?: string }) => error.code);
      expect(code, statement).toBe("42501");
    }
  });

  it("re-running the role creation block is idempotent (roles already exist)", async () => {
    const files = await loadMigrations();
    const roles = files.find((file) => file.name.includes("roles"))!;
    const block = /DO \$\$[\s\S]*?\$\$;/.exec(roles.sql)?.[0];
    expect(block).toContain("CREATE ROLE pine_indexer NOLOGIN");
    await database.db.transaction((tx) => tx.exec(block!));
    const rows = await database.db.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolname IN ('pine_indexer', 'pine_readonly') ORDER BY rolname");
    expect(rows.map((row) => row.rolname)).toEqual(["pine_indexer", "pine_readonly"]);
  });
});

describe("applied history and the runner's file rules (operator gap 16)", () => {
  it("0001 and 0002 are byte-identical to their indexers-002 versions and 0003 to its indexers-003 version (applied history is never edited)", async () => {
    const sha = async (name: string): Promise<string> => createHash("sha256").update(await readFile(path.join(DEFAULT_MIGRATIONS_DIR, name))).digest("hex");
    expect(await sha("0001_pine_index.sql")).toBe("7b984781c8a9baaab133239f48d826ec958520e5b5961dc10cbcb89ce7287caf");
    expect(await sha("0002_roles.sql")).toBe("e2d060fa652753c7b46b7223178ac97a72a52d265b299286b85c0c0779d0c7e7");
    expect(await sha("0003_drop_applied_events.sql")).toBe("3876bcceaa354d5b87d28338c896d35b07198f6aeb6e41480e3d84fa0035b544");
  });

  it("refuses two files with the same number", async () => {
    const dir = await copyOfMigrations("duplicate");
    await writeFile(path.join(dir, "0004_a.sql"), "SELECT 1;\n");
    await writeFile(path.join(dir, "0004_b.sql"), "SELECT 2;\n");
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration number 4/);
  });
});

describe("SEC-IDX-11 the real write and read paths under the runtime roles (operator gap 15)", () => {
  const OPTIONS = { chainId: SCENARIO_CHAIN_ID, questionTimeout: SCENARIO_QUESTION_TIMEOUT };
  /** The oracle scenario, then the claims/evidence scenario moved 10,000 blocks later: every data table gets rows. */
  const events = (): ChainEvent[] => [
    ...scenarioOracle().events,
    ...scenarioClaimsAndEvidence().events.map((event) => ({ ...event, blockNumber: event.blockNumber + 10_000n })),
  ];

  it("pine_indexer runs applyEvents, recordBlock, advanceCursor, recordObservation and recordHalt on every table in one transaction", async () => {
    const all = events();
    const last = all.at(-1)!;
    await database.db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pine_indexer");
      await applyEvents(tx, all, OPTIONS);
      for (const number of new Set(all.map((event) => event.blockNumber))) await recordBlock(tx, SCENARIO_CHAIN_ID, number, `0x${"ab".repeat(32)}`, 1);
      await advanceCursor(tx, { chainId: SCENARIO_CHAIN_ID, block: last.blockNumber, blockHash: last.blockHash, blockTimestamp: last.blockTimestamp });
      await recordObservation(tx, SCENARIO_CHAIN_ID, last.blockNumber + 2n, last.blockNumber + 64n);
      await recordHalt(tx, SCENARIO_CHAIN_ID, "apply_conflict", "role test", null);
      await tx.exec("DELETE FROM pine_index.halts");
    });
    const counts = await database.db.query<{ name: string; count: string }>(
      `SELECT 'claims' AS name, count(*)::text AS count FROM pine_index.claims UNION ALL SELECT 'evidence', count(*)::text FROM pine_index.evidence
       UNION ALL SELECT 'questions', count(*)::text FROM pine_index.questions UNION ALL SELECT 'question_markets', count(*)::text FROM pine_index.question_markets
       UNION ALL SELECT 'answers', count(*)::text FROM pine_index.answers UNION ALL SELECT 'arbitrations', count(*)::text FROM pine_index.arbitrations
       UNION ALL SELECT 'arbitration_history', count(*)::text FROM pine_index.arbitration_history UNION ALL SELECT 'tracked_conditions', count(*)::text FROM pine_index.tracked_conditions
       UNION ALL SELECT 'condition_resolutions', count(*)::text FROM pine_index.condition_resolutions UNION ALL SELECT 'condition_payouts', count(*)::text FROM pine_index.condition_payouts
       UNION ALL SELECT 'blocks', count(*)::text FROM pine_index.blocks UNION ALL SELECT 'cursor', count(*)::text FROM pine_index.cursor`,
    );
    for (const row of counts) expect(Number(row.count), row.name).toBeGreaterThan(0);
  });

  it("pine_readonly serves every ReadModel method (SELECT only) with the reference's answers", async () => {
    const all = events();
    const memory = new MemoryReadModel(OPTIONS);
    memory.apply(all);
    const claim = (await memory.listClaims({ order: "created_desc", limit: 100 })).items.find((item) => item.questionId === all.find((event) => event.kind === "KlerosHome")?.questionId)!;
    const evidence = (await memory.listEvidence({ limit: 1 })).items[0]!;
    await database.db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE pine_readonly");
      const model = createNativeReadModel(tx, { chainId: SCENARIO_CHAIN_ID });
      expect((await model.status()).indexedBlock).toBe(all.at(-1)!.blockNumber);
      expect(await model.getClaim(claim.market)).toEqual(claim);
      expect((await model.listClaims({ order: "created_desc", limit: 100 })).items).toEqual((await memory.listClaims({ order: "created_desc", limit: 100 })).items);
      expect((await model.listClaims({ order: "evidence_deadline_asc", limit: 100 })).items).toEqual((await memory.listClaims({ order: "evidence_deadline_asc", limit: 100 })).items);
      expect(await model.listClaimsByQuestion(claim.questionId)).toEqual(await memory.listClaimsByQuestion(claim.questionId));
      expect(await model.getEvidence(evidence.registry, evidence.submissionId)).toEqual(evidence);
      expect((await model.listEvidence({ limit: 100 })).items).toEqual((await memory.listEvidence({ limit: 100 })).items);
      expect(await model.getOracleQuestion(claim.questionId)).toEqual(await memory.getOracleQuestion(claim.questionId));
      expect(await model.listOracleAnswers(claim.questionId)).toEqual(await memory.listOracleAnswers(claim.questionId));
      expect(await model.getArbitration(claim.questionId)).toEqual(await memory.getArbitration(claim.questionId));
      expect(await model.getConditionResolution(claim.conditionId)).toEqual(await memory.getConditionResolution(claim.conditionId));
    });
    expect(await memory.getArbitration(claim.questionId)).not.toBeNull();
    expect(await memory.getConditionResolution(claim.conditionId)).not.toBeNull();
  });

  it("ALTER DEFAULT PRIVILEGES: a table the migrator adds later is DML for pine_indexer and SELECT-only for pine_readonly", async () => {
    await database.db.exec("CREATE TABLE pine_index.future_table (id int PRIMARY KEY)");
    try {
      await database.db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE pine_indexer");
        await tx.exec("INSERT INTO pine_index.future_table (id) VALUES (1)");
        await tx.exec("UPDATE pine_index.future_table SET id = 2 WHERE id = 1");
        await tx.exec("DELETE FROM pine_index.future_table WHERE id = 2");
        await tx.exec("INSERT INTO pine_index.future_table (id) VALUES (3)");
      });
      await database.db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE pine_readonly");
        expect(await tx.query("SELECT id FROM pine_index.future_table")).toEqual([{ id: 3 }]);
      });
      const code = await database.db
        .transaction(async (tx) => {
          await tx.exec("SET LOCAL ROLE pine_readonly");
          await tx.exec("INSERT INTO pine_index.future_table (id) VALUES (4)");
        })
        .then(() => "ok", (error: { code?: string }) => error.code);
      expect(code).toBe("42501");
    } finally {
      await database.db.exec("DROP TABLE pine_index.future_table");
    }
  });
});
