// DEVELOPMENT-ONLY API entry for the local integration stack (scripts/dev-stack). Runs the real `run(env, io)` of
// src/main.ts (real config, database, migrations check, route modules, jobs, read model) with one difference: the
// gateways' injected fetch never reaches the network. GitHub (api.github.com and the github.com token endpoint) is
// answered by DevGitHub (the e2e FakeGitHub plus browsing extras), IPFS (Kubo, pinning service, gateway) by FakeIpfs, and
// every other URL is refused like a network error. The RPC transports talk only to the local anvil fork.
//
// Refuses to start unless PINE_ENVIRONMENT=development, every origin, listener, database and RPC URL is loopback, and the
// RPC node identifies itself as anvil. Also serves a tiny DEV CONTROL server on 127.0.0.1:3999 (never the API port):
//   GET  /dev/health              -> { ok, api, userContent, chainId, rpc, ipfs }
//   GET  /dev/github/repos        -> the seeded repositories, branches, PRs and commit SHAs
//   POST /dev/github/authorize    {authorizationUrl, githubUserId?, login?} -> {code, state, callbackUrl}
//        (the "user approves on github.com" step; a Playwright test intercepts the github.com navigation and then
//         navigates to callbackUrl)
//
// Run (from packages/api): node --env-file=<api.env> --import tsx scripts/dev-server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { http as httpTransport, type Transport } from "viem";
import { z } from "zod";
import { processIo, run, type MainIo } from "../src/main.js";
import type { GatewayFactory } from "../src/contracts/platform.js";
import { buildGateways } from "../src/platform/gateways/index.js";
import { DevGitHub, FakeIpfs, FAKE_IPFS, type DevFetch } from "./dev-fakes.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CONTROL_HOST = "127.0.0.1";
const DEFAULT_CONTROL_PORT = 3999;
const CONTROL_BODY_LIMIT = 16 * 1024;
const DEFAULT_IDENTITY = { githubUserId: 190_455_201, login: "pine-labs" } as const;

class DevRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevRefusal";
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

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

// ------------------------------------------------------------------------------------------------ dev control server

const authorizeBody = z
  .object({
    authorizationUrl: z.string().url().max(4096),
    githubUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/).optional(),
  })
  .strict();

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > CONTROL_BODY_LIMIT) throw new DevRefusal("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ControlDeps {
  port: number;
  github: DevGitHub;
  /** The API origin: callback URLs are only ever built on it. */
  callbackOrigin: string;
  health: () => Record<string, unknown>;
}

function startControlServer(deps: ControlDeps): Promise<ReturnType<typeof createServer>> {
  const allowedHosts = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
  const server = createServer((request, response) => {
    void (async () => {
      // DNS-rebinding and cross-site guards: loopback Host only; browsers' cross-origin requests are refused (a JSON
      // POST also needs a CORS preflight, which is never answered).
      const host = (request.headers.host ?? "").toLowerCase();
      if (!allowedHosts.has(host)) return send(response, 421, { error: "unexpected Host header" });
      const origin = request.headers.origin;
      if (origin !== undefined && !LOOPBACK_HOSTS.has(hostOf(origin) ?? "")) return send(response, 403, { error: "cross-origin requests are refused" });
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.method === "GET" && url.pathname === "/dev/health") return send(response, 200, { ok: true, ...deps.health() });
      if (request.method === "GET" && url.pathname === "/dev/github/repos") return send(response, 200, { defaultIdentity: DEFAULT_IDENTITY, repos: deps.github.describe() });
      if (request.method === "POST" && url.pathname === "/dev/github/authorize") {
        if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(response, 415, { error: "content-type must be application/json" });
        let parsed;
        try {
          parsed = authorizeBody.safeParse(JSON.parse(await readBody(request)) as unknown);
        } catch {
          return send(response, 400, { error: "invalid JSON body" });
        }
        if (!parsed.success) return send(response, 400, { error: "invalid body", issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })) });
        const identity = { githubUserId: parsed.data.githubUserId ?? DEFAULT_IDENTITY.githubUserId, login: parsed.data.login ?? DEFAULT_IDENTITY.login };
        let result;
        try {
          result = deps.github.authorize(parsed.data.authorizationUrl, identity);
        } catch (error) {
          return send(response, 400, { error: error instanceof Error ? error.message : "authorization refused" });
        }
        // The callback the browser would be sent to: only on the configured API origin.
        const redirect = new URL(parsed.data.authorizationUrl).searchParams.get("redirect_uri");
        let callbackUrl: string | null = null;
        if (redirect !== null && hostOf(redirect) !== null && new URL(redirect).origin === deps.callbackOrigin) {
          const callback = new URL(redirect);
          callback.searchParams.set("code", result.code);
          callback.searchParams.set("state", result.state);
          callbackUrl = callback.toString();
        }
        return send(response, 200, { code: result.code, state: result.state, callbackUrl, identity });
      }
      return send(response, 404, { error: "not found" });
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { error: "internal error" });
      else response.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, CONTROL_HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
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
  let control: ReturnType<typeof createServer> | null = null;
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
  try {
    control = await startControlServer({
      port: controlPort,
      github,
      callbackOrigin: apiOrigin,
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
