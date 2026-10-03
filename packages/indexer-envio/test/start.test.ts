// The fail-closed start script (PRD-05 section 3a): production cannot start with the placeholder registry addresses or
// start block of config.yaml, nor with a block lag below 40, and `pnpm start` is the only entry point that starts Envio.
// Section 3b: it forwards SIGTERM/SIGINT to the Envio child and exits with the child's code.

import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import { SCENARIO_ADDRESSES } from "@pine/shared/testing/read-model-scenarios";
import {
  checkStartEnv,
  DEFAULT_RPC_URL,
  exitCodeOf,
  EXTERNAL_ADDRESSES,
  fetchChainId,
  FORWARDED_SIGNALS,
  isGnosisChainId,
  main,
  MIN_BLOCK_LAG,
  PLACEHOLDER_ADDRESSES,
} from "../scripts/start.mjs";

/** eth_chainId stub answering Gnosis (no network in tests). */
const gnosis = async () => "0x64";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = readFileSync(path.join(ROOT, "config.yaml"), "utf8");

const CLAIM = "0x1111111111111111111111111111111111111111";
const EVIDENCE = "0x2222222222222222222222222222222222222222";
const VALID = { ENVIO_CLAIM_REGISTRY_ADDRESS: CLAIM, ENVIO_EVIDENCE_REGISTRY_ADDRESS: EVIDENCE, ENVIO_PINE_START_BLOCK: "38000000", ENVIO_API_TOKEN: "token" };

function refused(env: Record<string, string | undefined>): string[] {
  const result = checkStartEnv(env);
  if (result.ok) throw new Error("expected a refusal");
  return result.errors;
}

function accepted(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const result = checkStartEnv(env);
  if (!result.ok) throw new Error(`expected acceptance: ${result.errors.join("; ")}`);
  return result.env;
}

describe("start script: placeholders and start block (fail closed)", () => {
  it("refuses to start without the Pine registry addresses and start block (the config.yaml defaults)", () => {
    expect(refused({})).toEqual([
      "ENVIO_CLAIM_REGISTRY_ADDRESS is required (the config.yaml default is a test placeholder)",
      "ENVIO_EVIDENCE_REGISTRY_ADDRESS is required (the config.yaml default is a test placeholder)",
      "ENVIO_PINE_START_BLOCK is required (the config.yaml default 0 is a test placeholder)",
    ]);
    expect(refused({ ...VALID, ENVIO_CLAIM_REGISTRY_ADDRESS: "" })).toHaveLength(1);
  });

  it("refuses either placeholder address in either variable, in any letter case", () => {
    for (const placeholder of [SCENARIO_ADDRESSES.claimRegistry, SCENARIO_ADDRESSES.evidenceRegistry]) {
      for (const variant of [placeholder, placeholder.toUpperCase().replace("0X", "0x")]) {
        expect(refused({ ...VALID, ENVIO_CLAIM_REGISTRY_ADDRESS: variant })).toEqual(["ENVIO_CLAIM_REGISTRY_ADDRESS is a conformance-scenario placeholder"]);
        expect(refused({ ...VALID, ENVIO_EVIDENCE_REGISTRY_ADDRESS: variant })).toEqual(["ENVIO_EVIDENCE_REGISTRY_ADDRESS is a conformance-scenario placeholder"]);
      }
    }
  });

  it("refuses malformed, zero, third-party and identical registry addresses", () => {
    for (const bad of ["0x123", "1111111111111111111111111111111111111111", `0x${"g".repeat(40)}`, ` ${CLAIM}`]) {
      expect(refused({ ...VALID, ENVIO_CLAIM_REGISTRY_ADDRESS: bad }), bad).toEqual(["ENVIO_CLAIM_REGISTRY_ADDRESS must be a 20-byte hex address"]);
    }
    for (const bad of [`0x${"0".repeat(40)}`, ...EXTERNAL_ADDRESSES]) {
      expect(refused({ ...VALID, ENVIO_EVIDENCE_REGISTRY_ADDRESS: bad }), bad).toEqual(["ENVIO_EVIDENCE_REGISTRY_ADDRESS is not a Pine registry address"]);
    }
    expect(refused({ ...VALID, ENVIO_EVIDENCE_REGISTRY_ADDRESS: CLAIM.toUpperCase().replace("0X", "0x") })).toEqual([
      "ENVIO_CLAIM_REGISTRY_ADDRESS and ENVIO_EVIDENCE_REGISTRY_ADDRESS must differ",
    ]);
  });

  it("refuses start block 0 (the placeholder) and anything that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "1e6", "0x10", " 5", "0012", "1234567890123456"]) {
      expect(refused({ ...VALID, ENVIO_PINE_START_BLOCK: bad }), bad).toEqual(["ENVIO_PINE_START_BLOCK must be the Pine deployment block (a positive integer)"]);
    }
    expect(accepted({ ...VALID, ENVIO_PINE_START_BLOCK: "1" }).ENVIO_PINE_START_BLOCK).toBe("1");
  });

  it("passes the validated values explicitly (addresses lowercased), keeping the rest of the environment", () => {
    const env = accepted({ ...VALID, ENVIO_CLAIM_REGISTRY_ADDRESS: "0xAbCdEf0000000000000000000000000000000001", ENVIO_PG_HOST: "db" });
    expect(env).toMatchObject({
      ENVIO_CLAIM_REGISTRY_ADDRESS: "0xabcdef0000000000000000000000000000000001",
      ENVIO_EVIDENCE_REGISTRY_ADDRESS: EVIDENCE,
      ENVIO_PINE_START_BLOCK: "38000000",
      ENVIO_BLOCK_LAG: "40",
      ENVIO_PG_HOST: "db",
    });
  });
});

describe("start script: block lag lower bound", () => {
  it(`defaults ENVIO_BLOCK_LAG to ${MIN_BLOCK_LAG} and sets it explicitly for envio`, () => {
    expect(MIN_BLOCK_LAG).toBe(40);
    expect(accepted(VALID).ENVIO_BLOCK_LAG).toBe("40");
    expect(accepted({ ...VALID, ENVIO_BLOCK_LAG: "" }).ENVIO_BLOCK_LAG).toBe("40");
  });

  it("refuses a lag below 40 (including the test value 0) or a malformed one; accepts 40 and above", () => {
    for (const bad of ["0", "1", "39", "-40", "40.5", "4e1", "abc", " 40", "1234567890"]) {
      expect(refused({ ...VALID, ENVIO_BLOCK_LAG: bad }), bad).toEqual(["ENVIO_BLOCK_LAG must be an integer >= 40"]);
    }
    expect(accepted({ ...VALID, ENVIO_BLOCK_LAG: "40" }).ENVIO_BLOCK_LAG).toBe("40");
    expect(accepted({ ...VALID, ENVIO_BLOCK_LAG: "0064" }).ENVIO_BLOCK_LAG).toBe("64");
  });

  it("the bound matches config.yaml's default lag", () => {
    expect(CONFIG).toContain(`block_lag: \${ENVIO_BLOCK_LAG:-${MIN_BLOCK_LAG}}`);
  });
});

describe("start script: data source", () => {
  it("requires an https RPC URL when one is configured and never echoes it", () => {
    for (const bad of ["http://rpc.example/key-in-path-SECRET", "ws://rpc.example", "not a url SECRET"]) {
      const errors = refused({ ...VALID, ENVIO_GNOSIS_RPC_URL: bad });
      expect(errors).toEqual(["ENVIO_GNOSIS_RPC_URL must be an https URL"]);
      expect(errors.join()).not.toContain("SECRET");
    }
    expect(accepted({ ...VALID, ENVIO_GNOSIS_RPC_URL: "https://rpc.example/v1/SECRET" }).ENVIO_GNOSIS_RPC_URL).toBe("https://rpc.example/v1/SECRET");
    expect(refused({ ...VALID, ENVIO_GNOSIS_RPC_FOR: "realtime" })).toEqual(["ENVIO_GNOSIS_RPC_FOR must be fallback or sync"]);
  });

  it("warns that a run without HyperSync trusts one unverified source", () => {
    const warning = "indexing from a single RPC without HyperSync: one unverified data source (README, launch gate)";
    const withToken = checkStartEnv(VALID);
    expect(withToken.ok && withToken.warnings).toEqual([]);
    const noToken = checkStartEnv({ ...VALID, ENVIO_API_TOKEN: undefined });
    expect(noToken.ok && noToken.warnings).toEqual([warning]);
    const rpcOnly = checkStartEnv({ ...VALID, ENVIO_GNOSIS_RPC_FOR: "sync" });
    expect(rpcOnly.ok && rpcOnly.warnings).toEqual([warning]);
  });
});

describe("start script: entry point", () => {
  it("never launches envio when the check fails, and reports each refusal", async () => {
    const launched: unknown[] = [];
    const lines: string[] = [];
    const signals = new EventEmitter();
    const code = await main({ ENVIO_BLOCK_LAG: "0" }, [], (...args) => {
      launched.push(args);
      return new StubChild();
    }, (line) => lines.push(line), signals);
    expect(code).toBe(1);
    expect(launched).toEqual([]);
    expect(FORWARDED_SIGNALS.map((signal) => signals.listenerCount(signal))).toEqual([0, 0]);
    expect(lines).toHaveLength(4);
    expect(lines.every((line) => line.startsWith("indexer-envio start refused: "))).toBe(true);
  });

  it("launches `envio start` (the pinned package's bin) with the validated environment and returns its exit code", async () => {
    const launched: { command: string; args: string[]; env: Record<string, string | undefined> }[] = [];
    const code = await main({ ...VALID, PATH: "/bin" }, ["--flag"], (command, args, options) => {
      launched.push({ command, args, env: options.env });
      const child = new StubChild();
      queueMicrotask(() => child.emit("exit", 3, null));
      return child;
    }, () => undefined, new EventEmitter(), gnosis);
    expect(code).toBe(3);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.command).toBe(process.execPath);
    expect(launched[0]!.args).toEqual([createRequire(path.join(ROOT, "package.json")).resolve("envio/bin.mjs"), "start", "--flag"]);
    expect(launched[0]!.env).toMatchObject({ ENVIO_CLAIM_REGISTRY_ADDRESS: CLAIM, ENVIO_PINE_START_BLOCK: "38000000", ENVIO_BLOCK_LAG: "40", PATH: "/bin" });
  });

  it("logs the single-source warning and still launches envio when no HyperSync token is set", async () => {
    const lines: string[] = [];
    let launches = 0;
    const code = await main({ ...VALID, ENVIO_API_TOKEN: "" }, [], () => {
      launches += 1;
      const child = new StubChild();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }, (line) => lines.push(line), new EventEmitter(), gnosis);
    expect(code).toBe(0);
    expect(launches).toBe(1);
    expect(lines).toEqual(["indexer-envio start warning: indexing from a single RPC without HyperSync: one unverified data source (README, launch gate)"]);
  });

  it("run as a process with the placeholder defaults, it exits 1 before starting Envio", () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, "scripts/start.mjs")], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("indexer-envio start refused: ENVIO_CLAIM_REGISTRY_ADDRESS is required");
    expect(run.stdout).toBe("");
  });

  it("`start` is the only package script that starts Envio, and it runs the check", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe("node scripts/start.mjs");
    for (const [name, command] of Object.entries(pkg.scripts)) expect(command, name).not.toMatch(/envio (start|dev)\b/);
  });

  it("the placeholder and external lists are those of config.yaml, SCENARIO_ADDRESSES and GNOSIS_EXTERNAL", () => {
    expect(PLACEHOLDER_ADDRESSES).toEqual([SCENARIO_ADDRESSES.claimRegistry, SCENARIO_ADDRESSES.evidenceRegistry]);
    expect(CONFIG).toContain(`\${ENVIO_CLAIM_REGISTRY_ADDRESS:-${SCENARIO_ADDRESSES.claimRegistry}}`);
    expect(CONFIG).toContain(`\${ENVIO_EVIDENCE_REGISTRY_ADDRESS:-${SCENARIO_ADDRESSES.evidenceRegistry}}`);
    expect(CONFIG).toContain("start_block: ${ENVIO_PINE_START_BLOCK:-0}");
    expect(EXTERNAL_ADDRESSES).toEqual([GNOSIS_EXTERNAL.seer.realitio, GNOSIS_EXTERNAL.seer.conditionalTokens, GNOSIS_EXTERNAL.seer.arbitrator]);
  });
});

/** A stand-in for the `envio start` child: records the signals it is sent; the test decides when it exits. */
class StubChild extends EventEmitter {
  readonly killed: NodeJS.Signals[] = [];
  pid: number | undefined = undefined;
  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }
}

/** Starts main() with a valid environment, a stub child and a stub signal source, and waits until the child is launched. */
async function startWithStub() {
  const child = new StubChild();
  const signals = new EventEmitter();
  const lines: string[] = [];
  let settled: number | undefined;
  let launched: () => void = () => undefined;
  const isLaunched = new Promise<void>((resolve) => (launched = resolve));
  const launch = () => {
    launched();
    return child;
  };
  const exit = main(VALID, [], launch, (line) => lines.push(line), signals, gnosis).then((code) => (settled = code));
  await isLaunched;
  return { child, signals, lines, exit, settled: () => settled };
}

describe("start script: signals (PRD-05 section 3b)", () => {
  it("forwards SIGTERM and SIGINT to the envio child while it runs, and only exits when the child exits, with its code", async () => {
    expect(FORWARDED_SIGNALS).toEqual(["SIGTERM", "SIGINT"]);
    for (const signal of FORWARDED_SIGNALS) {
      const run = await startWithStub();
      run.signals.emit(signal, signal);
      await new Promise((resolve) => setImmediate(resolve));
      expect(run.child.killed).toEqual([signal]);
      expect(run.settled()).toBeUndefined();
      expect(run.lines).toContain(`indexer-envio start: forwarding ${signal} to envio`);
      run.child.emit("exit", 0, null);
      expect(await run.exit).toBe(0);
    }
  });

  it("forwards every repeated signal (a second Ctrl-C reaches envio too)", async () => {
    const run = await startWithStub();
    run.signals.emit("SIGINT", "SIGINT");
    run.signals.emit("SIGINT", "SIGINT");
    run.signals.emit("SIGTERM", "SIGTERM");
    expect(run.child.killed).toEqual(["SIGINT", "SIGINT", "SIGTERM"]);
    run.child.emit("exit", 130, null);
    expect(await run.exit).toBe(130);
  });

  it("exits with the child's own code after a forwarded signal (graceful shutdown with a non-zero code)", async () => {
    const run = await startWithStub();
    run.signals.emit("SIGTERM", "SIGTERM");
    run.child.emit("exit", 7, null);
    expect(await run.exit).toBe(7);
  });

  it("a child killed by a signal exits 128 + the signal number", async () => {
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(5, null)).toBe(5);
    expect(exitCodeOf(null, "SIGTERM")).toBe(143);
    expect(exitCodeOf(null, "SIGINT")).toBe(130);
    expect(exitCodeOf(null, "SIGKILL")).toBe(137);
    expect(exitCodeOf(null, null)).toBe(1);
    const run = await startWithStub();
    run.signals.emit("SIGTERM", "SIGTERM");
    run.child.emit("exit", null, "SIGTERM");
    expect(await run.exit).toBe(143);
  });

  it("installs the handlers only while the child runs and removes them when it exits", async () => {
    const run = await startWithStub();
    expect(FORWARDED_SIGNALS.map((signal) => run.signals.listenerCount(signal))).toEqual([1, 1]);
    run.child.emit("exit", 0, null);
    await run.exit;
    expect(FORWARDED_SIGNALS.map((signal) => run.signals.listenerCount(signal))).toEqual([0, 0]);
    run.signals.emit("SIGTERM", "SIGTERM");
    expect(run.child.killed).toEqual([]);
  });

  it("a child that cannot be started exits 1, removes the handlers and does not print the spawn error", async () => {
    const run = await startWithStub();
    run.child.emit("error", new Error("spawn /secret/path ENOENT"));
    expect(await run.exit).toBe(1);
    expect(FORWARDED_SIGNALS.map((signal) => run.signals.listenerCount(signal))).toEqual([0, 0]);
    expect(run.lines).toContain("indexer-envio start: envio could not be started");
    expect(run.lines.join("\n")).not.toContain("secret");
  });

  it("an error of a running child (a failed kill) does not end the wrapper while envio still runs", async () => {
    const run = await startWithStub();
    run.child.pid = 4242;
    run.child.emit("error", new Error("kill EPERM"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(run.settled()).toBeUndefined();
    expect(run.lines).toContain("indexer-envio start: could not signal envio");
    expect(FORWARDED_SIGNALS.map((signal) => run.signals.listenerCount(signal))).toEqual([1, 1]);
    run.child.emit("exit", 0, null);
    expect(await run.exit).toBe(0);
  });

  it("as a real process, a SIGTERM sent only to the wrapper's PID reaches the child and the wrapper exits with the child's code", async () => {
    // The harness runs main() with its defaults (signals = process) and a launch that spawns a stub child instead of envio.
    // The stub prints "ready" once its handler is installed, exits 7 on SIGTERM, and would otherwise outlive the test.
    const stubChild = [
      'process.on("SIGTERM", () => { console.log("child got SIGTERM"); process.exit(7); });',
      'console.log("ready");',
      "setTimeout(() => process.exit(99), 20000);",
    ].join("");
    const harness = [
      `import { spawn } from "node:child_process";`,
      `import { main } from ${JSON.stringify(path.join(ROOT, "scripts/start.mjs"))};`,
      `const env = ${JSON.stringify(VALID)};`,
      `const launch = () => spawn(process.execPath, ["-e", ${JSON.stringify(stubChild)}], { stdio: "inherit" });`,
      "process.exitCode = await main(env, [], launch, (line) => console.error(line), process, async () => \"0x64\");",
    ].join("\n");
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", harness], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    wrapper.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      wrapper.on("exit", (code, signal) => resolve({ code, signal })),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stub child never became ready: ${stderr}`)), 20_000);
      wrapper.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    expect(wrapper.kill("SIGTERM")).toBe(true);
    const result = await exited;
    expect(result).toEqual({ code: 7, signal: null });
    expect(stdout).toContain("child got SIGTERM");
    expect(stderr).toContain("indexer-envio start: forwarding SIGTERM to envio");
  });
});

describe("start script: chain id (SEC-IDX-06)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function start(env: Record<string, string | undefined>, chainIdOf: (url: string) => Promise<string>) {
    const lines: string[] = [];
    const asked: string[] = [];
    let launches = 0;
    const code = await main(env, [], () => {
      launches += 1;
      const child = new StubChild();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    }, (line) => lines.push(line), new EventEmitter(), async (url) => {
      asked.push(url);
      return chainIdOf(url);
    });
    return { code, lines, asked, launches };
  }

  it("launches only after the RPC Envio will use answers eth_chainId 0x64 (the configured URL, else config.yaml's default)", async () => {
    const configured = await start({ ...VALID, ENVIO_GNOSIS_RPC_URL: "https://rpc.example/v1/SECRET" }, gnosis);
    expect(configured).toMatchObject({ code: 0, launches: 1, asked: ["https://rpc.example/v1/SECRET"] });
    const defaulted = await start(VALID, gnosis);
    expect(defaulted).toMatchObject({ code: 0, launches: 1, asked: [DEFAULT_RPC_URL] });
    expect(CONFIG).toContain(`url: \${ENVIO_GNOSIS_RPC_URL:-${DEFAULT_RPC_URL}}`);
  });

  it("refuses another chain (exit 1, no launch, the URL never echoed)", async () => {
    for (const answer of ["0x1", "0x89", "0x640", "100", "0x", "gnosis", "0x64 "]) {
      const run = await start({ ...VALID, ENVIO_GNOSIS_RPC_URL: "https://rpc.example/v1/SECRET" }, async () => answer);
      expect(run.code, answer).toBe(1);
      expect(run.launches, answer).toBe(0);
      expect(run.lines, answer).toEqual(["indexer-envio start refused: the RPC (ENVIO_GNOSIS_RPC_URL or the config.yaml default) is not a Gnosis (chain 100) endpoint"]);
    }
    expect(isGnosisChainId("0x64")).toBe(true);
    expect(isGnosisChainId("0x064")).toBe(true);
  });

  it("refuses when the RPC fails to answer, without echoing the URL or the error", async () => {
    const run = await start({ ...VALID, ENVIO_GNOSIS_RPC_URL: "https://rpc.example/v1/SECRET" }, async (url) => {
      throw new Error(`fetch failed for ${url}`);
    });
    expect(run).toMatchObject({ code: 1, launches: 0 });
    expect(run.lines).toEqual(["indexer-envio start refused: the RPC (ENVIO_GNOSIS_RPC_URL or the config.yaml default) did not answer eth_chainId"]);
    expect(run.lines.join("\n")).not.toContain("SECRET");
  });

  it("fetchChainId sends one eth_chainId POST with redirects refused and a timeout, and returns the result", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x64" }));
    });
    expect(await fetchChainId("https://rpc.example/v1/SECRET")).toBe("0x64");
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe("https://rpc.example/v1/SECRET");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  });

  it("fetchChainId throws on an HTTP error, a non-JSON or result-less body, a JSON-RPC error and an oversized body", async () => {
    for (const response of [
      () => new Response("nope", { status: 502 }),
      () => new Response("<html>"),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } })),
      () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 100 })),
      () => new Response(JSON.stringify({ result: "0x64", pad: " ".repeat(70_000) })),
    ]) {
      vi.stubGlobal("fetch", async () => response());
      await expect(fetchChainId("https://rpc.example/")).rejects.toThrow();
    }
  });
});
