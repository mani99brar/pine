// DEVELOPMENT-ONLY API entry for the local integration stack (scripts/dev-stack). Runs the real `run(env, io)` of
// src/main.ts (real config, database, migrations check, route modules, jobs, read model) with one difference: the
// gateways' injected fetch never reaches the network. GitHub (api.github.com and the github.com token endpoint) is
// answered by DevGitHub (the e2e FakeGitHub plus browsing extras), IPFS (Kubo, pinning service, gateway) by FakeIpfs, and
// every other URL is refused like a network error. The RPC transports talk only to the local anvil fork.
//
// Refuses to start unless PINE_ENVIRONMENT=development, every origin, listener, database and RPC URL is loopback, and the
// RPC node identifies itself as anvil. Also serves a tiny DEV CONTROL server on 127.0.0.1:3999 (never the API port; routes
// in scripts/dev-control.ts): health, the seeded GitHub data, the simulated GitHub consent page, and POST /dev/fund, the
// local-fork faucet (scripts/dev-faucet.ts) that Prism calls when a wallet connects in a local build.
//
// Run (from packages/api): node --env-file=<api.env> --import tsx scripts/dev-server.ts

import type { Server } from "node:http";
import { http as httpTransport, type Transport } from "viem";
import { z } from "zod";
import { processIo, run, type MainIo } from "../src/main.js";
import type { GatewayFactory } from "../src/contracts/platform.js";
import { buildGateways } from "../src/platform/gateways/index.js";
import { CONTROL_HOST, DevRefusal, LOOPBACK_HOSTS, hostOf, startControlServer } from "./dev-control.js";
import { DevGitHub, FakeIpfs, FAKE_IPFS, type DevFetch } from "./dev-fakes.js";
import { createDevFaucet, createLoopbackRpc, type DevFaucet } from "./dev-faucet.js";

const DEFAULT_CONTROL_PORT = 3999;

function hasHostOverride(value: string): boolean {
  try {
    const params = new URL(value).searchParams;
    return params.has("host") || params.has("hostaddr");
  } catch {
    return true;
  }
}

/** Fail closed before anything starts: this entry is for a developer machine and a local anvil fork only. */
function assertDevelopmentEnv(env: Record<string, string | undefined>): void {
  const problems: string[] = [];
  if (env.PINE_ENVIRONMENT !== "development") problems.push("PINE_ENVIRONMENT must be development");
  if (env.NODE_ENV === "production") problems.push("NODE_ENV must not be production");
  const urls: [string, boolean][] = [
    ["PINE_PUBLIC_ORIGIN", true],
    ["PINE_API_ORIGIN", false],
    ["PINE_USER_CONTENT_ORIGIN", true],
    ["PINE_RPC_URL_PRIMARY", true],
    ["PINE_RPC_URL_SECONDARY", true],
    ["PINE_DATABASE_URL", true],
    ["PINE_READ_MODEL_DATABASE_URL", true],
    ["PINE_MIGRATOR_DATABASE_URL", false],
  ];
  for (const [name, required] of urls) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      if (required) problems.push(`${name} is required`);
      continue;
    }
    const host = hostOf(value);
    if (host === null || !LOOPBACK_HOSTS.has(host)) problems.push(`${name} must point at a loopback host`);
    // node-postgres lets `host`/`hostaddr` query parameters replace the URL's authority: refuse them outright.
    if (/^postgres(?:ql)?:/i.test(value) && hasHostOverride(value)) problems.push(`${name} must not override its host with a query parameter`);
  }
  for (const name of ["PINE_HOST", "PINE_USER_CONTENT_HOST", "PINE_METRICS_HOST"]) {
    const value = env[name] ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(value.toLowerCase())) problems.push(`${name} must be a loopback address`);
  }
  if ((env.PINE_INDEXER_BACKEND ?? "native") !== "native") problems.push("PINE_INDEXER_BACKEND must be native");
  // IPFS targets are the in-process fakes only; real Kubo or pinning endpoints are never contacted from the dev server.
  for (const [name, expected] of [
    ["PINE_KUBO_API_URL", FAKE_IPFS.kuboApiUrl],
    ["PINE_PINNING_SERVICE_URL", FAKE_IPFS.pinningServiceUrl],
    ["PINE_IPFS_GATEWAYS", FAKE_IPFS.gatewayUrl],
  ] as const) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "" && value.trim() !== expected) problems.push(`${name} must be unset (the dev server sets its in-memory fake)`);
  }
  if (problems.length > 0) throw new DevRefusal(`dev-server refused to start: ${problems.join("; ")}`);
}

/** The RPC must be a local anvil node (web3_clientVersion "anvil/..."), never a real network endpoint. */
async function assertAnvil(url: string): Promise<void> {
  let version: unknown;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    version = z.object({ result: z.string().max(200) }).parse(await response.json()).result;
  } catch {
    throw new DevRefusal("dev-server refused to start: the RPC endpoint did not answer web3_clientVersion");
  }
  if (typeof version !== "string" || !version.toLowerCase().startsWith("anvil/")) throw new DevRefusal("dev-server refused to start: the RPC endpoint is not a local anvil node");
}

/** Routes the gateways' fetch: GitHub -> DevGitHub, IPFS -> FakeIpfs, anything else -> a refused "network error". */
function devFetch(github: DevGitHub, ipfs: FakeIpfs): DevFetch {
  return async (input, init) => {
    const url = new URL(input);
    if (url.origin === "https://github.com" || url.origin === "https://api.github.com") return github.fetch(input, init);
    const answered = await ipfs.handle(input, init);
    if (answered) return answered;
    throw new TypeError(`fetch failed: the dev server refuses outbound requests to ${url.origin}`);
  };
}

// ------------------------------------------------------------------------------------------------ main

function line(level: "info" | "fatal", msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, component: "dev-server", ...fields })}\n`);
}

async function main(): Promise<void> {
  const source = process.env;
  try {
    assertDevelopmentEnv(source);
  } catch (error) {
    line("fatal", error instanceof DevRefusal ? error.message : "dev-server refused to start");
    process.exit(1);
  }
  const pinningToken = source.PINE_DEV_PINNING_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pinningToken)) {
    line("fatal", "dev-server refused to start: PINE_DEV_PINNING_TOKEN must be 16-128 characters of A-Z a-z 0-9 _ -");
    process.exit(1);
  }
  const env: Record<string, string | undefined> = {
    ...source,
    PINE_KUBO_API_URL: FAKE_IPFS.kuboApiUrl,
    PINE_PINNING_SERVICE_URL: FAKE_IPFS.pinningServiceUrl,
    PINE_PINNING_SERVICE_TOKEN: pinningToken,
    PINE_IPFS_GATEWAYS: FAKE_IPFS.gatewayUrl,
  };
  const primary = env.PINE_RPC_URL_PRIMARY ?? "";
  const secondary = env.PINE_RPC_URL_SECONDARY ?? "";
  try {
    await assertAnvil(primary);
    await assertAnvil(secondary);
  } catch (error) {
    line("fatal", error instanceof DevRefusal ? error.message : "dev-server refused to start");
    process.exit(1);
  }

  const github = new DevGitHub();
  const ipfs = new FakeIpfs(pinningToken);
  const fetchRouter = devFetch(github, ipfs);
  const rpc = (url: string): Transport => httpTransport(url, { timeout: 10_000, retryCount: 2, fetchOptions: { redirect: "error" } });
  const createDevGateways: GatewayFactory = (deps) =>
    buildGateways(deps, { fetch: fetchRouter, transports: { primary: rpc(deps.secrets.rpcUrls.primary), secondary: rpc(deps.secrets.rpcUrls.secondary) } });

  const controlPort = Number(source.PINE_DEV_CONTROL_PORT ?? DEFAULT_CONTROL_PORT);
  if (!Number.isInteger(controlPort) || controlPort < 1 || controlPort > 65_535) {
    line("fatal", "dev-server refused to start: PINE_DEV_CONTROL_PORT must be a port number");
    process.exit(1);
  }
  let control: Server | null = null;
  const io: MainIo = {
    signals: processIo.signals,
    exit: (code) => {
      control?.close();
      process.exit(code);
    },
    dependencies: { createGateways: createDevGateways },
  };
  const running = await run(env, io);
  if (!running) return;

  const publicOrigin = new URL(env.PINE_PUBLIC_ORIGIN ?? "").origin;
  const apiOrigin = new URL(env.PINE_API_ORIGIN && env.PINE_API_ORIGIN.trim() !== "" ? env.PINE_API_ORIGIN : publicOrigin).origin;
  const apiHost = env.PINE_HOST ?? "127.0.0.1";
  const apiPort = env.PINE_PORT ?? "3000";
  // The local-fork faucet talks only to the primary RPC verified above (loopback + anvil); it re-checks anvil, chain id 100
  // and Pine's ClaimRegistry code before every top-up.
  let faucet: DevFaucet | null = null;
  try {
    faucet = createDevFaucet({ rpc: createLoopbackRpc(primary), clock: () => Date.now(), claimRegistry: env.PINE_CLAIM_REGISTRY ?? "" });
  } catch {
    line("info", "dev faucet disabled: PINE_CLAIM_REGISTRY is not an address or the RPC is not loopback");
  }
  try {
    control = await startControlServer({
      port: controlPort,
      github,
      callbackOrigin: apiOrigin,
      publicOrigin,
      faucet,
      log: (msg, fields) => line("info", msg, fields),
      health: () => ({
        api: `http://${apiHost}:${apiPort}`,
        publicOrigin,
        apiOrigin,
        userContent: env.PINE_USER_CONTENT_ORIGIN ?? null,
        chainId: Number(env.PINE_CHAIN_ID ?? "100"),
        rpc: primary,
        ipfs: ipfs.stats,
      }),
    });
  } catch {
    line("fatal", "dev control server could not listen; shutting down");
    await running.shutdown().catch(() => undefined);
    process.exit(1);
  }
  line("info", "dev control server listening", { url: `http://${CONTROL_HOST}:${controlPort}` });
}

void main().catch(() => {
  line("fatal", "dev-server failed");
  process.exit(1);
});
