// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryReadModel } from "@pine/shared/testing/memory-read-model";
import type { JobDefinition, RouteModule } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { loadMigrations } from "../../contracts/migrations.js";
import type { Gateways } from "../../contracts/platform.js";
import { createScriptedChain, FakeGitHubGateway, MemoryContentStore } from "../../contracts/testing.js";
import { createConnection } from "node:net";
import { routeModules } from "../../modules.js";
import { createGateways } from "../gateways/index.js";
import { createReadModel } from "../../readmodel.js";
import { productionDependencies, run, type MainIo, type ShutdownSignal } from "../../main.js";
import { startPlatform, type StartDependencies } from "./server.js";
import { testSettings } from "./testing/harness.js";
import { FakeGitHubAuth, useSharedDatabase } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });

const DB_URL = "postgres://pine_api:runtime-db-password-1@db.internal/pine";
const RPC_KEY = "rpc-key-0123456789abcdef";

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PINE_ENVIRONMENT: "development",
    PINE_PUBLIC_ORIGIN: "http://localhost:5173",
    PINE_USER_CONTENT_ORIGIN: "http://127.0.0.1:3001",
    PINE_CLAIM_REGISTRY: "0x00000000000000000000000000000000000c1a10",
    PINE_EVIDENCE_REGISTRY: "0x00000000000000000000000000000000000e01de",
    PINE_DEPLOYMENT_BLOCK: "1000",
    PINE_TERMS_DIGEST: `0x${"ab".repeat(32)}`,
    PINE_DATABASE_URL: DB_URL,
    PINE_RPC_URL_PRIMARY: `https://rpc-a.example/${RPC_KEY}`,
    PINE_RPC_URL_SECONDARY: "https://rpc-b.example/other-key-123456",
    PINE_GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
    PINE_GITHUB_CLIENT_SECRET: "github-client-secret-0123456789",
    PINE_TOKEN_KEY_CURRENT: `k1:${Buffer.alloc(32, 3).toString("base64")}`,
    PINE_READ_MODEL_DATABASE_URL: "postgres://ro:ro-password-123456@db.internal/indexer",
    PINE_HOST: "127.0.0.1",
    PINE_PORT: "0",
    PINE_METRICS_PORT: "0",
    PINE_USER_CONTENT_PORT: "0",
    PINE_LOG_LEVEL: "silent",
    ...overrides,
  };
}

interface Probe {
  events: string[];
  lines: string[];
  deps: StartDependencies;
  /** Arguments of the content server's listen(). */
  contentListen: { host: string; port: number }[];
}

interface ProbeOptions {
  chainId?: string;
  migrationFiles?: StartDependencies["migrationFiles"];
  envOverrides?: Record<string, string | undefined>;
  modules?: RouteModule[];
  /** Makes gateways.close() reject (a failing shutdown step). */
  failGatewaysClose?: boolean;
  /** connect() rejects with this error. */
  connectError?: Error;
  /** eth_chainId rejects with this error. */
  chainError?: Error;
  /** chainId of the gateway chain object (default 100). */
  gatewayChainId?: number;
  /** chainId the read model reports (default 100). */
  readModelChainId?: number;
}

function probe(options: ProbeOptions = {}): Probe {
  const events: string[] = [];
  const lines: string[] = [];
  const contentListen: { host: string; port: number }[] = [];
  const job: JobDefinition = {
    name: "gateways.probe",
    intervalMs: 60_000,
    run: (_ctx, signal) =>
      new Promise<void>((resolve) => {
        events.push("job.started");
        signal.addEventListener("abort", () => {
          events.push("job.aborted");
          resolve();
        });
      }),
  };
  const deps: StartDependencies = {
    env: env(options.envOverrides),
    modules: [
      {
        name: "probe",
        async register(app) {
          app.addHook("onClose", async () => void events.push("app.closed"));
        },
      },
      ...(options.modules ?? []),
    ],
    write: (line) => void lines.push(line),
    async connect() {
      if (options.connectError) throw options.connectError;
      events.push("db.connect");
      return { db: db().db, sql: db().sql, close: async () => void events.push("db.close") };
    },
    async createGateways(gatewayDeps) {
      events.push("gateways.create");
      expect(typeof gatewayDeps.moderation.states).toBe("function");
      const gateways: Gateways = {
        github: new FakeGitHubGateway(),
        githubAuth: new FakeGitHubAuth({ now: () => new Date() }),
        contentStore: new MemoryContentStore(),
        chain: Object.assign(
          createScriptedChain(async (method) => {
            if (method === "eth_chainId") {
              if (options.chainError) throw options.chainError;
              return options.chainId ?? "0x64";
            }
            throw new Error(`unexpected ${method}`);
          }),
          options.gatewayChainId === undefined ? {} : { chainId: options.gatewayChainId },
        ),
        createContentServer: () => ({
          listen: async (listenOptions: { host: string; port: number }) => {
            contentListen.push(listenOptions);
            events.push("content.listen");
          },
          close: async () => void events.push("content.close"),
        }),
        jobs: [job],
        close: async () => {
          events.push("gateways.close");
          if (options.failGatewaysClose === true) throw new Error("gateway pool did not drain");
        },
      };
      return gateways;
    },
    async createReadModel() {
      events.push("readModel.create");
      const model = new MemoryReadModel({ chainId: options.readModelChainId ?? 100, questionTimeout: 302_400 });
      return Object.assign(model, { close: async () => void events.push("readModel.close") });
    },
  };
  if (options.migrationFiles) deps.migrationFiles = options.migrationFiles;
  return { events, lines, deps, contentListen };
}

describe("startPlatform (src/main.ts composition)", () => {
  it("starts in order, serves requests and shuts down gracefully (jobs aborted, everything closed)", async () => {
    const { events, deps } = probe();
    const running = await startPlatform(deps);
    try {
      const res = await running.app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expect(running.metricsListener.address()?.port).toBeGreaterThan(0);
      await expect.poll(() => events.includes("job.started"), { timeout: 5_000 }).toBe(true);
    } finally {
      await running.shutdown();
    }
    expect(events.slice(0, 5)).toEqual(["db.connect", "gateways.create", "readModel.create", "content.listen", "job.started"]);
    expect(events).toEqual(expect.arrayContaining(["job.aborted", "content.close", "readModel.close", "gateways.close", "db.close"]));
    expect(events.indexOf("job.aborted")).toBeLessThan(events.indexOf("db.close"));
    await running.shutdown();
  });

  it("shuts down in order: stop accepting, abort jobs, then content server, read model, gateways and pool; metrics port closed", async () => {
    const { events, deps, contentListen } = probe();
    const running = await startPlatform(deps);
    await expect.poll(() => events.includes("job.started"), { timeout: 5_000 }).toBe(true);
    const metricsPort = running.metricsListener.address()?.port ?? 0;
    expect(metricsPort).toBeGreaterThan(0);
    // The user-content server listens on its own host and port (never the API's).
    expect(contentListen).toEqual([{ host: "127.0.0.1", port: 0 }]);
    await running.shutdown();
    const order = ["app.closed", "job.aborted", "content.close", "readModel.close", "gateways.close", "db.close"];
    expect(events.filter((event) => order.includes(event))).toEqual(order);
    const refused = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: metricsPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(true));
    });
    expect(refused).toBe(true);
  });

  it("starts the content server on PINE_USER_CONTENT_HOST/PORT", async () => {
    const { deps, contentListen } = probe({ envOverrides: { PINE_USER_CONTENT_HOST: "127.0.0.2", PINE_USER_CONTENT_PORT: "4555" } });
    const running = await startPlatform(deps);
    try {
      expect(contentListen).toEqual([{ host: "127.0.0.2", port: 4555 }]);
    } finally {
      await running.shutdown();
    }
  });

  it("runs gateway jobs, module jobs and the core cleanup job; module jobs are aborted on shutdown", async () => {
    const moduleEvents: string[] = [];
    const moduleJob: JobDefinition = {
      name: "module.probe",
      intervalMs: 60_000,
      run: (_ctx, signal) =>
        new Promise<void>((resolve) => {
          moduleEvents.push("started");
          signal.addEventListener("abort", () => {
            moduleEvents.push("aborted");
            resolve();
          });
        }),
    };
    const { deps } = probe({ modules: [{ name: "with-job", register: async () => undefined, jobs: [moduleJob] }] });
    const running = await startPlatform(deps);
    try {
      expect(running.runner.jobNames.sort()).toEqual(["gateways.probe", "module.probe", "platform.cleanup"]);
      await expect.poll(() => moduleEvents, { timeout: 5_000 }).toEqual(["started"]);
    } finally {
      await running.shutdown();
    }
    expect(moduleEvents).toEqual(["started", "aborted"]);
  });

  it("SEC-OPS-02 a refused startup logs connection errors redacted (the error echoes the database URL)", async () => {
    const { events, lines, deps } = probe({ connectError: new Error(`connect ECONNREFUSED ${DB_URL}`) });
    await expect(startPlatform(deps)).rejects.toThrow(/ECONNREFUSED/);
    const output = lines.join("");
    expect(output).toContain('"level":"fatal"');
    expect(output).toContain("ECONNREFUSED");
    for (const secret of [DB_URL, "runtime-db-password-1"]) expect(output).not.toContain(secret);
    expect(events).toEqual([]);
  });

  it("SEC-OPS-02 a refused startup logs RPC errors redacted (the error echoes the keyed RPC URL), closing what it opened", async () => {
    const rpcUrl = `https://rpc-a.example/${RPC_KEY}`;
    const { events, lines, deps } = probe({ chainError: new Error(`HTTP request failed. URL: ${rpcUrl} Details: 401`) });
    await expect(startPlatform(deps)).rejects.toThrow();
    const output = lines.join("");
    expect(output).toContain('"level":"fatal"');
    for (const secret of [rpcUrl, RPC_KEY]) expect(output).not.toContain(secret);
    expect(events).toEqual(expect.arrayContaining(["readModel.close", "gateways.close", "db.close"]));
  });

  for (const [name, options, message] of [
    ["the gateway chain object is for another chain", { gatewayChainId: 1 }, /chain gateway is configured for another chain id/],
    ["the read model reports another chain", { readModelChainId: 10200 }, /read model reports another chain id/],
  ] as const) {
    it(`refuses to start when ${name}, and closes what it opened`, async () => {
      const { events, lines, deps } = probe(options);
      await expect(startPlatform(deps)).rejects.toThrow(message);
      expect(events).toEqual(expect.arrayContaining(["readModel.close", "gateways.close", "db.close"]));
      expect(events).not.toContain("content.listen");
      expect(lines.join("")).toContain('"level":"fatal"');
    });
  }

  it("SEC-OPS-10 refuses to start with pending migrations, before creating gateways", async () => {
    const files = await loadMigrations();
    const pending = [...files, { group: "platform" as const, name: "0999_future.sql", number: 999, sql: "SELECT 1", checksum: "x" }];
    const { events, lines, deps } = probe({ migrationFiles: pending });
    await expect(startPlatform(deps)).rejects.toThrow(/Pending migrations/);
    expect(events).toEqual(["db.connect", "db.close"]);
    expect(lines.join("")).toContain('"level":"fatal"');
  });

  it("refuses to start when the RPC reports another chain id, and closes what it opened", async () => {
    const { events, lines, deps } = probe({ chainId: "0x1" });
    await expect(startPlatform(deps)).rejects.toThrow(/chain id/);
    expect(events).toEqual(expect.arrayContaining(["readModel.close", "gateways.close", "db.close"]));
    expect(lines.join("")).not.toContain(RPC_KEY);
  });

  it("SEC-OPS-01 refuses an invalid configuration with a redacted fatal line naming the variable", async () => {
    const { events, lines, deps } = probe({ envOverrides: { PINE_RPC_URL_SECONDARY: undefined, PINE_TERMS_DIGEST: "bad" } });
    await expect(startPlatform(deps)).rejects.toThrow(/PINE_RPC_URL_SECONDARY/);
    expect(events).toEqual([]);
    const output = lines.join("");
    expect(output).toContain("PINE_TERMS_DIGEST");
    for (const secret of [DB_URL, RPC_KEY, "runtime-db-password-1"]) expect(output).not.toContain(secret);
  });
});

describe("SEC-OPS-02 the composed platform redacts every production secret (PRD-02 3b)", () => {
  const SECRETS = {
    PINE_DATABASE_URL: "postgres://pine_api:runtime-db-password-1@db.internal:5432/pine",
    PINE_MIGRATOR_DATABASE_URL: "postgres://pine_migrator:migrator-password-2@db.internal:5432/pine",
    PINE_RPC_URL_PRIMARY: "https://rpc-a.example.net/v1/rpc-key-aaaaaaaaaaaa",
    PINE_RPC_URL_SECONDARY: "https://rpc-b.example.org/v1/rpc-key-bbbbbbbbbbbb",
    PINE_GITHUB_CLIENT_SECRET: "github-client-secret-0123456789",
    PINE_GITHUB_WEBHOOK_SECRET: "github-webhook-secret-0123456789",
    PINE_KUBO_API_URL: "https://kubo.internal.example/api/v0",
    PINE_PINNING_SERVICE_URL: "https://pinning.example.com/psa",
    PINE_PINNING_SERVICE_TOKEN: "pinning-service-token-0123456789",
  };
  const KEY_CURRENT = Buffer.alloc(32, 7).toString("base64");
  const KEY_PREVIOUS = Buffer.alloc(32, 9).toString("base64");
  const READ_MODEL_URL = "postgres://pine_readonly:ro-password-3@db.internal:5432/indexer";
  const ENVIO_URL = "https://envio.internal.example/v1/graphql-key-0123456789";
  const ENVIO_ADMIN = "envio-admin-secret-0123456789";

  function productionEnv(backend: "native" | "envio"): Record<string, string | undefined> {
    return {
      PINE_ENVIRONMENT: "production",
      PINE_PUBLIC_ORIGIN: "https://verify.pine.example",
      PINE_USER_CONTENT_ORIGIN: "https://pine-usercontent.net",
      PINE_COMPLIANCE_COUNTRY_HEADER: "CF-IPCountry",
      PINE_TRUST_PROXY_HOPS: "1",
      PINE_SANCTIONS_MODE: "static",
      PINE_SANCTIONS_DENYLIST_PATH: "/etc/pine/denylist.json",
      PINE_TOKEN_KEY_CURRENT: `k2:${KEY_CURRENT}`,
      PINE_TOKEN_KEYS_PREVIOUS: `k1:${KEY_PREVIOUS}`,
      PINE_LOG_LEVEL: "info",
      PINE_READ_MODEL_DATABASE_URL: undefined,
      ...SECRETS,
      ...(backend === "native" ? { PINE_READ_MODEL_DATABASE_URL: READ_MODEL_URL } : { PINE_INDEXER_BACKEND: "envio", PINE_ENVIO_GRAPHQL_URL: ENVIO_URL, PINE_ENVIO_ADMIN_SECRET: ENVIO_ADMIN }),
    };
  }

  for (const backend of ["native", "envio"] as const) {
    it(`masks each secret in a log line, an error response and an audit detail (${backend} read model)`, async () => {
      const secrets: [string, string][] = [
        ...Object.entries(SECRETS),
        ["PINE_TOKEN_KEY_CURRENT", KEY_CURRENT],
        ["PINE_TOKEN_KEYS_PREVIOUS", KEY_PREVIOUS],
        ...(backend === "native"
          ? ([["PINE_READ_MODEL_DATABASE_URL", READ_MODEL_URL]] as [string, string][])
          : ([
              ["PINE_ENVIO_GRAPHQL_URL", ENVIO_URL],
              ["PINE_ENVIO_ADMIN_SECRET", ENVIO_ADMIN],
            ] as [string, string][])),
      ];
      // Neutral markers (no "name=" labels, which the label pattern would mask even without registration).
      const leak = secrets.map(([, secret], i) => `<${i}> ${secret} </${i}>`).join(" ");
      const masked = secrets.map((_, i) => `<${i}> [REDACTED] </${i}>`).join(" ");
      const leakModule: RouteModule = {
        name: "leak",
        async register(app, ctx) {
          app.get("/api/v1/leak/internal", async () => {
            throw new Error(leak);
          });
          app.get("/api/v1/leak/api-error", async () => {
            throw new ApiError("BAD_REQUEST", leak);
          });
          app.get("/api/v1/leak/audit", async () => {
            await ctx.audit.record({
              actorUserId: null,
              action: "test.leak",
              subjectType: "test",
              subjectId: "leak",
              details: { leak, each: Object.fromEntries(secrets.map(([variable, secret]) => [variable, secret])) },
              ip: null,
            });
            return { ok: true };
          });
        },
      };
      const logLines: string[] = [];
      const { lines, deps } = probe({ modules: [leakModule] });
      deps.env = { ...env(), ...productionEnv(backend) };
      deps.readFile = () => JSON.stringify(["0x00000000000000000000000000000000000bad01"]);
      deps.logStream = { write: (line) => void logLines.push(line) };
      const running = await startPlatform(deps);
      try {
        const internal = await running.app.inject({ method: "GET", url: "/api/v1/leak/internal" });
        expect(internal.statusCode).toBe(500);
        const apiError = await running.app.inject({ method: "GET", url: "/api/v1/leak/api-error" });
        expect(apiError.statusCode).toBe(400);
        expect(apiError.json<{ error: { message: string } }>().error.message).toBe(masked);
        expect((await running.app.inject({ method: "GET", url: "/api/v1/leak/audit" })).statusCode).toBe(200);

        const failed = logLines.map((line) => JSON.parse(line) as { msg?: string; error?: string }).find((line) => line.msg === "request failed");
        expect(failed?.error).toBe(`Error: ${masked}`);
        const rows = await db().sql.query<{ details: { leak: string; each: Record<string, string> } }>("SELECT details FROM audit_log WHERE action = 'test.leak'");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.details.leak).toBe(masked);
        expect(rows[0]?.details.each).toEqual(Object.fromEntries(secrets.map(([variable]) => [variable, "[REDACTED]"])));

        const everything = [...logLines, ...lines, internal.body, apiError.body, JSON.stringify(rows)].join("\n");
        for (const [variable, secret] of secrets) expect(everything, variable).not.toContain(secret);
      } finally {
        await running.shutdown();
      }
    });
  }
});

describe("src/main.ts run(env, io): signal handling", () => {
  function mainIo(deps: StartDependencies): { io: MainIo; signals: EventEmitter; exits: number[] } {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const { env: _env, ...dependencies } = deps;
    const io: MainIo = {
      signals: { once: (signal: ShutdownSignal, listener: () => void) => signals.once(signal, listener) },
      exit: (code) => void exits.push(code),
      dependencies,
    };
    return { io, signals, exits };
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} stops accepting, aborts jobs, closes every resource and exits 0`, async () => {
      const { events, deps } = probe();
      const { io, signals, exits } = mainIo(deps);
      const running = await run(deps.env, io);
      if (running === null) throw new Error("startup refused");
      expect(running.app.server.listening).toBe(true);
      expect(running.metricsListener.address()).not.toBeNull();
      await expect.poll(() => events.includes("job.started"), { timeout: 5_000 }).toBe(true);
      expect(signals.listenerCount("SIGTERM")).toBe(1);
      expect(signals.listenerCount("SIGINT")).toBe(1);

      signals.emit(signal);
      await expect.poll(() => exits, { timeout: 15_000 }).toEqual([0]);
      expect(running.app.server.listening).toBe(false);
      expect(running.metricsListener.address()).toBeNull();
      for (const event of ["app.closed", "job.aborted", "content.close", "readModel.close", "gateways.close", "db.close"]) expect(events, event).toContain(event);
      // Stop accepting first, abort jobs before closing what they use, the database last.
      expect(events.indexOf("app.closed")).toBeLessThan(events.indexOf("job.aborted"));
      expect(events.indexOf("job.aborted")).toBeLessThan(events.indexOf("gateways.close"));
      expect(events.at(-1)).toBe("db.close");

      // A second signal neither shuts down again nor exits again.
      signals.emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(exits).toEqual([0]);
      expect(events.filter((event) => event === "db.close")).toHaveLength(1);
    });
  }

  it("exits 1 when a shutdown step fails, after still closing every other resource", async () => {
    const { events, lines, deps } = probe({ failGatewaysClose: true });
    const { io, signals, exits } = mainIo(deps);
    const running = await run(deps.env, io);
    if (running === null) throw new Error("startup refused");
    signals.emit("SIGTERM");
    await expect.poll(() => exits, { timeout: 15_000 }).toEqual([1]);
    expect(running.app.server.listening).toBe(false);
    for (const event of ["job.aborted", "content.close", "readModel.close", "gateways.close", "db.close"]) expect(events, event).toContain(event);
    expect(lines.join("")).toContain("shutdown step failed");
  });

  it("composes the real dependencies: src/modules.ts, the gateway and read-model factories, a pool on PINE_DATABASE_URL", async () => {
    expect(productionDependencies.modules).toBe(routeModules);
    expect(productionDependencies.createGateways).toBe(createGateways);
    expect(productionDependencies.createReadModel).toBe(createReadModel);
    // Port 1 on loopback refuses: the pool really uses the runtime URL (and is closed afterwards).
    const connection = await productionDependencies.connect({
      secrets: { databaseUrl: "postgres://pine_api:pool-password-0123@127.0.0.1:1/pine" } as Parameters<StartDependencies["connect"]>[0]["secrets"],
      settings: testSettings(),
    });
    try {
      // The refusal names the runtime URL's host and port, so a pool built from any other URL fails this test.
      await expect(connection.sql.query("SELECT 1")).rejects.toThrow(/127\.0\.0\.1:1\b/);
    } finally {
      await connection.close();
    }
  });

  it("SEC-OPS-01 a refused startup exits 1 without installing signal handlers", async () => {
    const { events, deps } = probe({ envOverrides: { PINE_DATABASE_URL: undefined } });
    const { io, signals, exits } = mainIo(deps);
    await expect(run(deps.env, io)).resolves.toBeNull();
    expect(exits).toEqual([1]);
    expect(events).toEqual([]);
    expect(signals.listenerCount("SIGTERM") + signals.listenerCount("SIGINT")).toBe(0);
  });

  it("runs when executed directly: an invalid environment gives one redacted fatal line and exit 1", () => {
    const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const child = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: apiDir,
      env: { PATH: process.env.PATH ?? "", PINE_DATABASE_URL: DB_URL },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(child.status).toBe(1);
    const lines = child.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "fatal", msg: "startup refused" });
    expect(child.stderr).toContain("PINE_PUBLIC_ORIGIN");
    expect(child.stderr).not.toContain("runtime-db-password-1");
  }, 90_000);
});
