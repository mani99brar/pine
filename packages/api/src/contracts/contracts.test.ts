import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteModule } from "./app.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { loadMigrations, runMigrations, verifyMigrations } from "./migrations.js";
import { createRedactor, safeErrorMessage } from "./redact.js";
import { buildTestApp, createTestContext, createTestDatabase, testSession, testSessionHeaders, type TestContext } from "./testing.js";

describe("toErrorResponse", () => {
  it("maps ApiError with issues and hides everything else", () => {
    expect(toErrorResponse(new ApiError("NOT_FOUND", "Claim not found"), "r1", createRedactor())).toEqual({ statusCode: 404, body: { error: { code: "NOT_FOUND", message: "Claim not found", requestId: "r1" } } });
    const internal = toErrorResponse(new Error("connect ECONNREFUSED postgres://user:pw@db/x"), "r2", createRedactor());
    expect(internal.statusCode).toBe(500);
    expect(JSON.stringify(internal.body)).not.toContain("postgres");
    expect(toErrorResponse({ statusCode: 413 }, "r3", createRedactor()).body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(toErrorResponse({ statusCode: 404 }, "r4", createRedactor()).body.error.code).toBe("NOT_FOUND");
    // Only Fastify-branded validation errors are reflected.
    expect(toErrorResponse({ validation: [{ message: "x" }] }, "r5", createRedactor()).statusCode).toBe(500);
    const leaky = toErrorResponse(new ApiError("BAD_REQUEST", "bad https://rpc.example/v1/k3yk3yk3y"), "r6", createRedactor());
    expect(leaky.body.error.message).not.toContain("k3yk3yk3y");
    expect(toErrorResponse(new ApiError("QUOTA_EXCEEDED", "q", { retryAfterSeconds: 60 }), "r7", createRedactor()).retryAfterSeconds).toBe(60);
  });
});

describe("redactor", () => {
  const redact = createRedactor(["s3cr3t-api-key-123"]);
  it("removes known secrets, URL credentials/paths/queries and token shapes", () => {
    const text = redact("HTTP request failed. URL: https://gnosis.example.com/v2/s3cr3t-api-key-123?x=1 token ghp_abcdefghijklmnopqrstuvwxyz0123456789 Bearer abc.def.ghi1234");
    expect(text).not.toContain("s3cr3t-api-key-123");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("abc.def.ghi1234");
    expect(text).toContain("https://gnosis.example.com");
  });
  it("covers connection strings, PEM keys, Pine tokens and labelled values without mangling prose", () => {
    expect(redact("db error postgres://pine:S3cretPass@db:5432/pine failed")).not.toContain("S3cretPass");
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(redact("cookie pine_s1_AbCdEfGhIjKlMnOpQrStUv")).not.toContain("AbCdEfGh");
    expect(redact("callback?code=abc123&state=xyz789")).not.toMatch(/abc123|xyz789/);
    expect(redact('{"password":"correct horse battery"}')).not.toContain("horse");
    expect(redact("insufficient token approval for spender")).toBe("insufficient token approval for spender");
    expect(redact("see https://github.com/org/repo/pull/12 for details")).toBe("see https://github.com/org/repo/pull/12 for details");
    expect(redact("x".repeat(100_000)).length).toBeLessThanOrEqual(2_001);
  });
  it("keeps public 0x data intact", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const address = `0x${"cd".repeat(20)}`;
    expect(redact(`tx ${hash} from ${address}`)).toBe(`tx ${hash} from ${address}`);
  });
  it("prefers viem shortMessage and never includes stacks", () => {
    const error = Object.assign(new Error("long message with https://rpc.example/key"), { shortMessage: "HTTP request failed." });
    expect(safeErrorMessage(error, redact)).toBe("Error: HTTP request failed.");
  });
});

describe("migrations", () => {
  it("applies every group once and refuses a modified applied file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    await mkdir(path.join(root, "platform"));
    await writeFile(path.join(root, "platform", "0001_a.sql"), "CREATE TABLE a (id int);");
    const database = await createTestDatabase({ applyMigrations: false });
    try {
      await expect(verifyMigrations(database.sql, await loadMigrations(root))).rejects.toThrow(/Pending/);
      const first = await runMigrations(database.sql, await loadMigrations(root));
      await verifyMigrations(database.sql, await loadMigrations(root));
      expect(first.applied).toEqual(["platform/0001_a.sql"]);
      const second = await runMigrations(database.sql, await loadMigrations(root));
      expect(second.applied).toEqual([]);
      await writeFile(path.join(root, "platform", "0003_c.sql"), "CREATE TABLE c (id int);");
      await runMigrations(database.sql, await loadMigrations(root));
      await writeFile(path.join(root, "platform", "0002_b.sql"), "CREATE TABLE b (id int);");
      await expect(runMigrations(database.sql, await loadMigrations(root))).rejects.toThrow(/numbered below/);
      await rm(path.join(root, "platform", "0002_b.sql"));
      await writeFile(path.join(root, "platform", "0001_a.sql"), "CREATE TABLE a (id bigint);");
      await expect(runMigrations(database.sql, await loadMigrations(root))).rejects.toThrow(/checksum/);
      await expect(verifyMigrations(database.sql, await loadMigrations(root))).rejects.toThrow(/checksum/);
      await writeFile(path.join(root, "platform", "0001_a.sql"), "CREATE TABLE a (id int);");
      await rm(path.join(root, "platform", "0003_c.sql"));
      await expect(verifyMigrations(database.sql, await loadMigrations(root))).rejects.toThrow(/has no file/);
    } finally {
      await database.close();
    }
  });
  it("rejects badly named files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    await mkdir(path.join(root, "claims"));
    await writeFile(path.join(root, "claims", "1_bad.sql"), "SELECT 1;");
    await expect(loadMigrations(root)).rejects.toThrow(/Invalid migration file name/);
  });
});

describe("test harness", () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });
  it("provides sessions, auth guards, zod validation and the shared error mapping", async () => {
    ctx = await createTestContext();
    const probe: RouteModule = {
      name: "probe",
      async register(app) {
        app.get("/me", { preHandler: app.requireSession }, async (request) => ({ wallet: request.session!.wallet }));
        app.get("/admin", { preHandler: app.requireAdmin }, async () => ({ ok: true }));
        app.withTypeProvider<import("fastify-type-provider-zod").ZodTypeProvider>().post("/echo", { schema: { body: z.object({ n: z.number().int() }) } }, async (request) => ({ n: request.body.n }));
      },
    };
    const app = await buildTestApp([probe], ctx);
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/me", headers: testSessionHeaders(testSession()) });
    expect(me.json()).toEqual({ wallet: testSession().wallet });
    expect((await app.inject({ method: "GET", url: "/admin", headers: testSessionHeaders(testSession()) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin", headers: testSessionHeaders(testSession({ isAdmin: true })) })).statusCode).toBe(200);
    ctx.clock.advance(301_000);
    const stale = await app.inject({ method: "GET", url: "/admin", headers: testSessionHeaders(testSession({ isAdmin: true })) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe("STEP_UP_REQUIRED");
    const bad = await app.inject({ method: "POST", url: "/echo", payload: { n: "x" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
  it("runs the real migration directory on PGlite", async () => {
    ctx = await createTestContext();
    const rows = await ctx.database.sql.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
    expect(rows.map((row) => row.id)).toContain("platform/0001_core.sql");
  });
});
