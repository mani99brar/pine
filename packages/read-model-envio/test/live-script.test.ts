// Runs the real `test:live` script (live/smoke.live.ts under vitest.live.config.ts, as package.json defines it) in a
// child process against the Hasura fake served over HTTP on 127.0.0.1, so the launch-gate script itself is proven:
// it passes against an endpoint serving the rows the real handlers produced, fails against a broken endpoint, and
// refuses to run (instead of passing vacuously) without ENVIO_GRAPHQL_URL. No network beyond the loopback server.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHasura } from "./fake-hasura.js";
import { loadSnapshots } from "./snapshots.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_URL = "https://envio.test/v1/graphql";
const SCRIPT = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts["test:live"]!;

/** `vitest <args>` of the test:live script, run with this node and the workspace's pinned vitest. */
function liveCommand(): string[] {
  const [bin, ...args] = SCRIPT.split(" ");
  expect(bin).toBe("vitest");
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("vitest/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: Record<string, string> };
  return [path.join(path.dirname(pkgPath), pkg.bin.vitest!), ...args];
}

/** Runs test:live with only PATH/HOME and the given variables (no VITEST_* leaking from this run). */
function runLive(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, liveCommand(), {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("exit", (code) => resolve({ code, output }));
  });
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Serves `handle` on 127.0.0.1 and records the POST bodies; returns the endpoint URL. */
async function serve(handle: (body: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/v1/graphql") {
          res.writeHead(404).end();
          return;
        }
        requests.push(body);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, String(value)]));
        const { status, text } = await handle(body, headers);
        res.writeHead(status, { "content-type": "application/json" }).end(text);
      })();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/graphql`, requests };
}

describe("test:live (the Envio launch-gate script)", { timeout: 180_000 }, () => {
  for (const snapshot of loadSnapshots()) {
    it(`passes against the Hasura fake serving the ${snapshot.scenario} rows over HTTP`, async () => {
      const fake = createFakeHasura(snapshot, { url: FAKE_URL });
      const endpoint = await serve(async (body, headers) => {
        const response = await fake.fetch(FAKE_URL, { method: "POST", headers, body, redirect: "error", signal: new AbortController().signal });
        return { status: response.status, text: await new Response(response.body).text() };
      });
      const run = await runLive({ ENVIO_GRAPHQL_URL: endpoint.url });
      expect(run.output).toMatch(/Tests\s+3 passed \(3\)/);
      expect(run.code, run.output).toBe(0);
      // Every read-model operation went through the endpoint, and nothing else was requested.
      const operations = new Set(endpoint.requests.map((body) => (JSON.parse(body) as { operationName: string }).operationName));
      expect(snapshot.entities.Claim!.length).toBeGreaterThan(0);
      expect([...operations].sort()).toEqual([
        "GetArbitration", "GetClaim", "GetConditionResolution", "GetEvidence", "GetOracleQuestion",
        "ListClaims", "ListClaimsByQuestion", "ListEvidence", "ListOracleAnswers", "Status",
      ]);
      expect(fake.requests.length).toBe(endpoint.requests.length);
    });
  }

  it("fails against an endpoint that answers GraphQL errors", async () => {
    const endpoint = await serve(async () => ({ status: 200, text: JSON.stringify({ errors: [{ message: "no" }] }) }));
    const run = await runLive({ ENVIO_GRAPHQL_URL: endpoint.url });
    expect(run.code).not.toBe(0);
    expect(run.output).toMatch(/Tests\s+3 failed \(3\)/);
    expect(endpoint.requests.length).toBeGreaterThan(0);
  });

  it("refuses to run without ENVIO_GRAPHQL_URL instead of passing vacuously", async () => {
    const run = await runLive({});
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("test:live needs ENVIO_GRAPHQL_URL");
    expect(run.output).not.toMatch(/Tests\s+\d+ passed/);
  });
});
