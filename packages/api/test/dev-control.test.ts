// The dev control server's /dev/fund route (scripts/dev-control.ts): only the app origin may call it, with a CORS
// preflight answered for that origin alone. The server listens on 127.0.0.1:0 with a fake faucet; no other network.
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startControlServer, type ControlDeps } from "../scripts/dev-control.js";
import type { DevFaucet, FundOutcome } from "../scripts/dev-faucet.js";

const APP = "http://localhost:3004";
const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function fakeFaucet(outcome?: FundOutcome): DevFaucet & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    thresholdWei: 1n,
    targetWei: 2n,
    async fund(input) {
      inputs.push(input);
      return (
        outcome ?? {
          ok: true,
          body: { address: USER, chainId: 100, funded: true, balanceWei: "2", previousBalanceWei: "0", thresholdWei: "1", targetWei: "2", delegatedTo: null, tokens: [] },
        }
      );
    },
  };
}

async function start(faucet: DevFaucet | null = fakeFaucet()): Promise<number> {
  const deps: ControlDeps = {
    port: 0,
    github: { authorize: () => ({ code: "c", state: "s" }), describe: () => [] } as unknown as ControlDeps["github"],
    callbackOrigin: "http://localhost:3004",
    publicOrigin: APP,
    health: () => ({ rpc: "http://127.0.0.1:8545" }),
    faucet,
  };
  server = await startControlServer(deps);
  return (server.address() as AddressInfo).port;
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const fundHeaders = { origin: APP, "x-pine-dev": "1", "content-type": "application/json" };
const fundBody = JSON.stringify({ address: USER });

describe("dev control: POST /dev/fund", () => {
  it("funds for the app origin and answers CORS for it only", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    const res = await call(port, "POST", "/dev/fund", fundHeaders, fundBody);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(APP);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({ funded: true, balanceWei: "2" });
    expect(faucet.inputs).toEqual([{ address: USER }]);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["another loopback port", "http://localhost:5173"],
    ["the app origin on 127.0.0.1 instead of localhost", "http://127.0.0.1:3004"],
    ["a null origin", "null"],
  ])("SEC-OPS refuses an Origin of %s (403) without reading the body or calling the faucet", async (_name, origin) => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    const res = await call(port, "POST", "/dev/fund", { ...fundHeaders, origin }, fundBody);
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(faucet.inputs).toEqual([]);
  });

  it("refuses a call without an Origin header (only the app's page may ask)", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    const { origin: _origin, ...noOrigin } = fundHeaders;
    expect((await call(port, "POST", "/dev/fund", noOrigin, fundBody)).status).toBe(403);
    expect(faucet.inputs).toEqual([]);
  });

  it("refuses a missing x-pine-dev header (a simple cross-site form post cannot set it)", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    const res = await call(port, "POST", "/dev/fund", { origin: APP, "content-type": "application/json" }, fundBody);
    expect(res.status).toBe(403);
    expect(faucet.inputs).toEqual([]);
  });

  it("refuses a non-JSON content type and malformed JSON", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    expect((await call(port, "POST", "/dev/fund", { ...fundHeaders, "content-type": "text/plain" }, fundBody)).status).toBe(415);
    expect((await call(port, "POST", "/dev/fund", fundHeaders, "{not json")).status).toBe(400);
    expect(faucet.inputs).toEqual([]);
  });

  it("refuses an unexpected Host header (DNS rebinding) with 421", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    expect((await call(port, "POST", "/dev/fund", { ...fundHeaders, host: `attacker.example:${port}` }, fundBody)).status).toBe(421);
    expect(faucet.inputs).toEqual([]);
  });

  it("passes faucet refusals through with the generic error and retry-after", async () => {
    const port = await start(fakeFaucet({ ok: false, status: 429, error: "too many faucet requests", retryAfterSeconds: 12 }));
    const res = await call(port, "POST", "/dev/fund", fundHeaders, fundBody);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.body).not.toContain("8545");
  });

  it("answers 404 when no faucet is configured", async () => {
    const port = await start(null);
    expect((await call(port, "POST", "/dev/fund", fundHeaders, fundBody)).status).toBe(404);
  });

  it("refuses an oversized body", async () => {
    const faucet = fakeFaucet();
    const port = await start(faucet);
    const res = await call(port, "POST", "/dev/fund", fundHeaders, JSON.stringify({ address: USER, pad: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(faucet.inputs).toEqual([]);
  });
});

describe("dev control: OPTIONS /dev/fund (CORS preflight)", () => {
  it("answers the app origin's preflight without credentials", async () => {
    const port = await start();
    const res = await call(port, "OPTIONS", "/dev/fund", { origin: APP, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-pine-dev" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(APP);
    expect(res.headers["access-control-allow-methods"]).toBe("POST");
    expect(res.headers["access-control-allow-headers"]).toContain("x-pine-dev");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it.each(["https://evil.example", "http://localhost:5173", "http://127.0.0.1:3004"])("refuses a preflight from %s", async (origin) => {
    const port = await start();
    const res = await call(port, "OPTIONS", "/dev/fund", { origin, "access-control-request-method": "POST" });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never answers a preflight on other routes", async () => {
    const port = await start();
    const res = await call(port, "OPTIONS", "/dev/github/authorize", { origin: APP, "access-control-request-method": "POST" });
    expect(res.status).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
