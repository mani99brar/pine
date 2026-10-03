import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import { EXIT_FAILED } from "../src/migrate-cli.js";

// The two process entries, spawned as real processes (PRD-05 section 3a: the top-level call has a handler, so no raw
// error or stack is printed). This file opens no database, so no PGlite instance is resident while a child runs.

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PASSWORD = "s3cretDbPassw0rd";
const RPC_KEY = "rpcKEY0123456789abcdef";
const ENV = {
  DATABASE_URL: `postgres://pine_indexer:${DB_PASSWORD}@db.internal:5432/pine`,
  RPC_PRIMARY_URL: `https://gnosis.rpc-one.example/v1/${RPC_KEY}`,
  RPC_SECONDARY_URL: "https://rpc.gnosischain.com",
  CHAIN_ID: "100",
  CLAIM_REGISTRY_ADDRESS: SCENARIO_ADDRESSES.claimRegistry,
  EVIDENCE_REGISTRY_ADDRESS: SCENARIO_ADDRESSES.evidenceRegistry,
  REALITY_ADDRESS: SCENARIO_ADDRESSES.reality,
  CONDITIONAL_TOKENS_ADDRESS: SCENARIO_ADDRESSES.conditionalTokens,
  KLEROS_HOME_PROXY_ADDRESS: SCENARIO_ADDRESSES.klerosHomeProxy,
  DEPLOYMENT_BLOCK: "1000",
  POLL_INTERVAL_MS: "500",
};
const PASSWORD = "MigrAtorPassw0rd";

function expectNoSecrets(text: string): void {
  expect(text).not.toContain(DB_PASSWORD);
  expect(text).not.toContain(RPC_KEY);
}

describe("src/main.ts process entry", () => {
  function runMain(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "main.ts")], {
        cwd: path.join(here, ".."),
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("close", (code) => resolve({ code, out }));
    });
  }

  it("fails closed with a redacted message and no stack on a bad configuration and on an unreachable database", async () => {
    const bad = await runMain({ ...ENV, CHAIN_ID: "1" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("refusing to start");
    expectNoSecrets(bad.out);
    const unreachable = await runMain({ ...ENV, DATABASE_URL: `postgres://pine_indexer:${DB_PASSWORD}@127.0.0.1:1/pine`, METRICS_PORT: "1" });
    expect(unreachable.code).toBe(1);
    expect(unreachable.out).toContain("indexer stopped");
    expect(unreachable.out).not.toMatch(/\n\s+at /);
    expectNoSecrets(unreachable.out);
  });
});

describe("migrate script: the process entry (spawned)", () => {
  function runCli(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "..", "src", "migrate-cli.ts")], {
        cwd: path.join(here, ".."),
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("an invalid URL and an unreachable database exit 1, each with one redacted line and no stack", async () => {
    const invalid = await runCli({ DATABASE_URL: `mysql://root:${PASSWORD}@db.internal/pine` });
    expect(invalid.code).toBe(EXIT_FAILED);
    expect(invalid.stderr).toBe("migration refused: DATABASE_URL must be a postgres:// URL\n");
    // Port 1 on the loopback interface refuses the connection at once (no external network).
    const unreachable = await runCli({ DATABASE_URL: `postgres://pine_owner:${PASSWORD}@127.0.0.1:1/pine` });
    expect(unreachable.code).toBe(EXIT_FAILED);
    expect(unreachable.stderr).toMatch(/^migration failed: [^\n]*\n$/);
    expect(unreachable.stderr).not.toContain(PASSWORD);
    expect(unreachable.stderr).not.toMatch(/\n\s+at /);
    expect(unreachable.stdout).toBe("");
  });

  it("importing the module runs nothing (only the process entry calls main)", async () => {
    // This file imported src/migrate-cli.ts at the top: had it run main, it would have set a non-zero exit code here.
    expect(process.exitCode ?? 0).toBe(0);
  });
});
