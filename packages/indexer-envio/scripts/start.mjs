// @ts-check
// The ONLY supported way to run the Envio indexer (`pnpm --filter @pine/indexer-envio start`; never `envio start`
// directly). PRD-05 section 3a: config.yaml keeps the conformance-scenario placeholders as defaults so `envio codegen`
// and the tests run without environment, so this script fails closed before Envio starts when production would run
// with a placeholder registry address or start block, or with a block lag below 40. It then starts `envio start` with
// the validated values set explicitly (no config.yaml default is relied on). Errors name the variable, never its value
// (the RPC URL may embed a key). While Envio runs, SIGTERM and SIGINT sent to this process are forwarded to it (a process
// manager or container runtime may signal only this PID) and this process exits with Envio's code (PRD-05 section 3b).
// Before launching it verifies eth_chainId of the RPC Envio will use (SEC-IDX-06; envio 3.12.1 never checks it, and with
// ENVIO_GNOSIS_RPC_FOR=sync that RPC is the only data source) and refuses anything but Gnosis (chain 100).

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/** config.yaml defaults = SCENARIO_ADDRESSES of @pine/shared (pinned by test/start.test.ts). They index nothing. */
export const PLACEHOLDER_ADDRESSES = ["0x00000000000000000000000000000000000c1a10", "0x00000000000000000000000000000000000e01de"];

/** GNOSIS_EXTERNAL addresses config.yaml indexes as third-party contracts: never a Pine registry. */
export const EXTERNAL_ADDRESSES = [
  "0xe78996a233895be74a66f451f1019ca9734205cc",
  "0xceafdd6bc0bef976fdcd1112955828e00543c0ce",
  "0x68154ea682f95bf582b80dd6453fa401737491dc",
];

export const MIN_BLOCK_LAG = 40;

/** config.yaml's default for ENVIO_GNOSIS_RPC_URL (pinned by test/start.test.ts): the RPC Envio uses when it is unset. */
export const DEFAULT_RPC_URL = "https://rpc.gnosischain.com";

export const GNOSIS_CHAIN_ID = 100n;

const CHAIN_ID_TIMEOUT_MS = 10_000;
const CHAIN_ID_MAX_BYTES = 64 * 1024;

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, env: Record<string, string | undefined>, warnings: string[] } | { ok: false, errors: string[] }}
 */
export function checkStartEnv(env) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Record<string, string>} */
  const checked = {};

  /** @param {string} name */
  const registry = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return void errors.push(`${name} is required (the config.yaml default is a test placeholder)`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return void errors.push(`${name} must be a 20-byte hex address`);
    const address = raw.toLowerCase();
    if (PLACEHOLDER_ADDRESSES.includes(address)) return void errors.push(`${name} is a conformance-scenario placeholder`);
    if (address === ZERO_ADDRESS || EXTERNAL_ADDRESSES.includes(address)) return void errors.push(`${name} is not a Pine registry address`);
    checked[name] = address;
  };
  registry("ENVIO_CLAIM_REGISTRY_ADDRESS");
  registry("ENVIO_EVIDENCE_REGISTRY_ADDRESS");
  if (checked.ENVIO_CLAIM_REGISTRY_ADDRESS !== undefined && checked.ENVIO_CLAIM_REGISTRY_ADDRESS === checked.ENVIO_EVIDENCE_REGISTRY_ADDRESS) {
    errors.push("ENVIO_CLAIM_REGISTRY_ADDRESS and ENVIO_EVIDENCE_REGISTRY_ADDRESS must differ");
  }

  const start = env.ENVIO_PINE_START_BLOCK;
  if (start === undefined || start === "") errors.push("ENVIO_PINE_START_BLOCK is required (the config.yaml default 0 is a test placeholder)");
  else if (!/^[1-9][0-9]{0,14}$/.test(start)) errors.push("ENVIO_PINE_START_BLOCK must be the Pine deployment block (a positive integer)");
  else checked.ENVIO_PINE_START_BLOCK = start;

  const lag = env.ENVIO_BLOCK_LAG;
  if (lag === undefined || lag === "") checked.ENVIO_BLOCK_LAG = String(MIN_BLOCK_LAG);
  else if (!/^[0-9]{1,9}$/.test(lag) || Number(lag) < MIN_BLOCK_LAG) errors.push(`ENVIO_BLOCK_LAG must be an integer >= ${MIN_BLOCK_LAG}`);
  else checked.ENVIO_BLOCK_LAG = String(Number(lag));

  const rpc = env.ENVIO_GNOSIS_RPC_URL;
  if (rpc !== undefined && rpc !== "") {
    /** @type {URL | null} */
    let url = null;
    try {
      url = new URL(rpc);
    } catch {
      // reported below without the value
    }
    if (url === null || url.protocol !== "https:") errors.push("ENVIO_GNOSIS_RPC_URL must be an https URL");
  }
  const rpcFor = env.ENVIO_GNOSIS_RPC_FOR;
  if (rpcFor !== undefined && rpcFor !== "" && rpcFor !== "fallback" && rpcFor !== "sync") errors.push("ENVIO_GNOSIS_RPC_FOR must be fallback or sync");

  if (errors.length > 0) return { ok: false, errors };
  if (env.ENVIO_API_TOKEN === undefined || env.ENVIO_API_TOKEN === "" || rpcFor === "sync") {
    warnings.push("indexing from a single RPC without HyperSync: one unverified data source (README, launch gate)");
  }
  return { ok: true, env: { ...env, ...checked }, warnings };
}

/**
 * eth_chainId of `url`: one JSON-RPC POST, redirects refused, 10 s, the body capped at 64 KiB. Throws on any failure
 * (the caller reports it without the URL or the error text, which may carry the URL).
 * @param {string} url
 * @returns {Promise<string>} the result string as returned
 */
export async function fetchChainId(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    redirect: "error",
    signal: AbortSignal.timeout(CHAIN_ID_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("eth_chainId: HTTP error");
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CHAIN_ID_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("eth_chainId: response too large");
    }
    chunks.push(value);
  }
  /** @type {unknown} */
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = typeof body === "object" && body !== null && "result" in body ? body.result : undefined;
  if (typeof result !== "string") throw new Error("eth_chainId: no result");
  return result;
}

/**
 * Whether `result` (an eth_chainId answer) is Gnosis.
 * @param {string} result
 */
export function isGnosisChainId(result) {
  return /^0x[0-9a-fA-F]{1,16}$/.test(result) && BigInt(result) === GNOSIS_CHAIN_ID;
}

/** Signals forwarded to the Envio child while it runs. */
export const FORWARDED_SIGNALS = /** @type {const} */ (["SIGTERM", "SIGINT"]);

/**
 * @typedef {{
 *   on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown,
 *   on(event: "error", listener: (error: Error) => void): unknown,
 *   kill(signal: NodeJS.Signals): unknown,
 *   readonly pid?: number | undefined,
 * }} Child
 * @typedef {(command: string, args: string[], options: { stdio: "inherit", env: Record<string, string | undefined> }) => Child} Launch
 * @typedef {{
 *   on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown,
 *   off(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown,
 * }} SignalSource
 */

/**
 * The exit code of this process for a child that ended with `code` or by `signal` (shell convention 128 + n).
 * @param {number | null} code
 * @param {NodeJS.Signals | null} signal
 */
export function exitCodeOf(code, signal) {
  if (code !== null) return code;
  if (signal === null) return 1;
  return 128 + (constants.signals[signal] ?? 0);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} args extra arguments for `envio start`
 * @param {Launch} launch
 * @param {(line: string) => void} log
 * @param {SignalSource} signals where SIGTERM/SIGINT arrive (the process; a stub in tests)
 * @param {(url: string) => Promise<string>} chainIdOf eth_chainId of an RPC URL (fetchChainId; a stub in tests)
 * @returns {Promise<number>} the exit code
 */
export async function main(env, args, launch, log, signals = process, chainIdOf = fetchChainId) {
  const result = checkStartEnv(env);
  if (!result.ok) {
    for (const error of result.errors) log(`indexer-envio start refused: ${error}`);
    return 1;
  }
  for (const warning of result.warnings) log(`indexer-envio start warning: ${warning}`);
  const rpcUrl = result.env.ENVIO_GNOSIS_RPC_URL || DEFAULT_RPC_URL;
  /** @type {string} */
  let chainId;
  try {
    chainId = await chainIdOf(rpcUrl);
  } catch {
    log("indexer-envio start refused: the RPC (ENVIO_GNOSIS_RPC_URL or the config.yaml default) did not answer eth_chainId");
    return 1;
  }
  if (!isGnosisChainId(chainId)) {
    log("indexer-envio start refused: the RPC (ENVIO_GNOSIS_RPC_URL or the config.yaml default) is not a Gnosis (chain 100) endpoint");
    return 1;
  }
  const envioBin = createRequire(import.meta.url).resolve("envio/bin.mjs");
  const child = launch(process.execPath, [envioBin, "start", ...args], { stdio: "inherit", env: result.env });
  return new Promise((resolve) => {
    /** @param {NodeJS.Signals} signal */
    const forward = (signal) => {
      log(`indexer-envio start: forwarding ${signal} to envio`);
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) signals.on(signal, forward);
    /** @param {number} code */
    const finish = (code) => {
      for (const signal of FORWARDED_SIGNALS) signals.off(signal, forward);
      resolve(code);
    };
    child.on("exit", (code, signal) => finish(exitCodeOf(code, signal)));
    // Spawn failures (e.g. ENOENT) arrive as "error" without "exit" and leave no pid. An "error" of a running child (a
    // failed kill) must not end this process while Envio still runs. The message may carry paths, so it is not printed.
    child.on("error", () => {
      if (child.pid !== undefined) return log("indexer-envio start: could not signal envio");
      log("indexer-envio start: envio could not be started");
      finish(1);
    });
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.env, process.argv.slice(2), spawn, (line) => console.error(line));
}
