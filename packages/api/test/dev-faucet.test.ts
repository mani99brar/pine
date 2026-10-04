// The local-fork dev faucet (scripts/dev-faucet.ts): only ever tops up on a verified local anvil fork, only upwards, only
// for EOAs (plain or EIP-7702-delegated), rate limited. A fake JSON-RPC node stands in for anvil; no network.
import { describe, expect, it } from "vitest";
import { createDevFaucet, createLoopbackRpc, DEFAULT_TARGET_WEI, DEFAULT_THRESHOLD_WEI, XDAI, type FaucetRpc } from "../scripts/dev-faucet.js";

const CLAIM_REGISTRY = "0x4Af9f320fE64C09a59572B6F687B308278367D61";
const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DELEGATE = "0xcA11bde05977b3631167028862bE2a173976CA11";

interface FakeNode {
  rpc: FaucetRpc;
  calls: { method: string; params: readonly unknown[] }[];
  balances: Map<string, bigint>;
  code: Map<string, string>;
  version: string;
  chainId: string;
}

function fakeAnvil(): FakeNode {
  const node: FakeNode = {
    calls: [],
    balances: new Map(),
    code: new Map([[CLAIM_REGISTRY.toLowerCase(), "0x6080"]]),
    version: "anvil/v1.5.1",
    chainId: "0x64",
    rpc: async (method, params) => {
      node.calls.push({ method, params });
      const addr = String(params[0] ?? "").toLowerCase();
      switch (method) {
        case "web3_clientVersion":
          return node.version;
        case "eth_chainId":
          return node.chainId;
        case "eth_getCode":
          return node.code.get(addr) ?? "0x";
        case "eth_getBalance":
          return `0x${(node.balances.get(addr) ?? 0n).toString(16)}`;
        case "anvil_setBalance":
          node.balances.set(addr, BigInt(String(params[1])));
          return null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return node;
}

function setup(node = fakeAnvil()) {
  let now = 1_000_000;
  const faucet = createDevFaucet({ rpc: node.rpc, clock: () => now, claimRegistry: CLAIM_REGISTRY });
  return { node, faucet, advance: (ms: number) => (now += ms) };
}

const anvilWrites = (node: FakeNode) => node.calls.filter((c) => c.method.startsWith("anvil_"));

describe("dev faucet: top-up", () => {
  it("raises an empty EOA to the target with anvil_setBalance and reports it", async () => {
    const { node, faucet } = setup();
    const out = await faucet.fund({ address: USER });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toMatchObject({ address: USER, chainId: 100, funded: true, balanceWei: DEFAULT_TARGET_WEI.toString(), previousBalanceWei: "0", delegatedTo: null, tokens: [] });
    expect(anvilWrites(node)).toEqual([{ method: "anvil_setBalance", params: [USER, `0x${DEFAULT_TARGET_WEI.toString(16)}`] }]);
    // Never a value transfer or any other transaction.
    expect(node.calls.some((c) => c.method.startsWith("eth_send"))).toBe(false);
  });

  it("is a no-op at or above the threshold and never lowers a balance", async () => {
    const { node, faucet } = setup();
    node.balances.set(USER.toLowerCase(), DEFAULT_THRESHOLD_WEI);
    const out = await faucet.fund({ address: USER });
    expect(out.ok && out.body).toMatchObject({ funded: false, balanceWei: DEFAULT_THRESHOLD_WEI.toString() });
    node.balances.set(USER.toLowerCase(), 50_000n * XDAI);
    const rich = await faucet.fund({ address: USER });
    expect(rich.ok && rich.body).toMatchObject({ funded: false, balanceWei: (50_000n * XDAI).toString() });
    expect(anvilWrites(node)).toEqual([]);
  });

  it("tops up just below the threshold", async () => {
    const { node, faucet } = setup();
    node.balances.set(USER.toLowerCase(), DEFAULT_THRESHOLD_WEI - 1n);
    const out = await faucet.fund({ address: USER });
    expect(out.ok && out.body.funded).toBe(true);
    expect(node.balances.get(USER.toLowerCase())).toBe(DEFAULT_TARGET_WEI);
  });

  it("funds an EIP-7702-delegated EOA and warns about its delegate", async () => {
    const { node, faucet } = setup();
    node.code.set(USER.toLowerCase(), `0xef0100${DELEGATE.slice(2).toLowerCase()}`);
    const out = await faucet.fund({ address: USER });
    expect(out.ok && out.body).toMatchObject({ funded: true, delegatedTo: DELEGATE });
    expect(out.ok && out.body.warning).toMatch(/EIP-7702/);
  });

  it("refuses an address that holds contract code", async () => {
    const { node, faucet } = setup();
    node.code.set(USER.toLowerCase(), "0x6080604052");
    const out = await faucet.fund({ address: USER });
    expect(out).toMatchObject({ ok: false, status: 422 });
    expect(anvilWrites(node)).toEqual([]);
  });

  it("rejects the target below the threshold at construction", () => {
    expect(() => createDevFaucet({ rpc: fakeAnvil().rpc, clock: () => 0, claimRegistry: CLAIM_REGISTRY, thresholdWei: 10n, targetWei: 5n })).toThrow();
  });
});

describe("dev faucet: input", () => {
  it.each([
    ["a lowercase (not checksummed) address", { address: USER.toLowerCase() }],
    ["a wrong checksum", { address: USER.replace("C5", "c5") }],
    ["a short address", { address: "0x1234" }],
    ["the zero address", { address: "0x0000000000000000000000000000000000000000" }],
    ["extra keys", { address: USER, amount: "1000000" }],
    ["a non-object", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
  ])("refuses %s with 400 and calls nothing", async (_name, body) => {
    const { node, faucet } = setup();
    const out = await faucet.fund(body);
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(node.calls).toEqual([]);
  });
});

describe("dev faucet: only a local anvil fork with Pine deployed", () => {
  it("SEC-OPS-14 refuses a node that is not anvil (e.g. a real Gnosis RPC) and calls no anvil_* method", async () => {
    const node = fakeAnvil();
    node.version = "Nethermind/v1.30.0";
    const { faucet } = setup(node);
    expect(await faucet.fund({ address: USER })).toMatchObject({ ok: false, status: 503 });
    expect(anvilWrites(node)).toEqual([]);
  });

  it("refuses an anvil on another chain id", async () => {
    const node = fakeAnvil();
    node.chainId = "0x1";
    const { faucet } = setup(node);
    expect(await faucet.fund({ address: USER })).toMatchObject({ ok: false, status: 503 });
    expect(anvilWrites(node)).toEqual([]);
  });

  it("refuses a chain where Pine's ClaimRegistry has no code", async () => {
    const node = fakeAnvil();
    node.code.delete(CLAIM_REGISTRY.toLowerCase());
    const { faucet } = setup(node);
    expect(await faucet.fund({ address: USER })).toMatchObject({ ok: false, status: 503 });
    expect(anvilWrites(node)).toEqual([]);
  });

  it("re-checks the node before every top-up", async () => {
    const node = fakeAnvil();
    const { faucet } = setup(node);
    expect((await faucet.fund({ address: USER })).ok).toBe(true);
    node.version = "geth/v1.14";
    node.balances.clear();
    expect(await faucet.fund({ address: USER })).toMatchObject({ ok: false, status: 503 });
    expect(anvilWrites(node)).toHaveLength(1);
  });

  it("createLoopbackRpc refuses a non-loopback RPC URL before any request", () => {
    const fetchImpl = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    for (const url of ["https://rpc.gnosischain.com", "http://127.0.0.1.nip.io:8545", "http://user:pw@127.0.0.1:8545", "file:///etc/passwd", "not a url"]) {
      expect(() => createLoopbackRpc(url, fetchImpl)).toThrow(/loopback|invalid/);
    }
  });

  it("createLoopbackRpc refuses redirects and hides the URL in errors", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }));
    }) as unknown as typeof fetch;
    const rpc = createLoopbackRpc("http://127.0.0.1:8545/secret-key", fetchImpl);
    await expect(rpc("eth_chainId", [])).rejects.toThrow(/^dev faucet: eth_chainId returned an error$/);
    expect(seen[0]?.redirect).toBe("error");
  });
});

describe("dev faucet: rate limits", () => {
  it("SEC-OPS-04 limits requests per address (429 with retry-after) and frees them after the window", async () => {
    const { node, faucet, advance } = setup();
    for (let i = 0; i < 5; i += 1) expect((await faucet.fund({ address: USER })).ok).toBe(true);
    const limited = await faucet.fund({ address: USER });
    expect(limited).toMatchObject({ ok: false, status: 429 });
    expect(!limited.ok && limited.retryAfterSeconds).toBeGreaterThan(0);
    // Another address is not affected.
    expect((await faucet.fund({ address: DELEGATE })).ok).toBe(true);
    advance(60_000);
    expect((await faucet.fund({ address: USER })).ok).toBe(true);
    expect(anvilWrites(node).length).toBeGreaterThan(0);
  });

  it("limits requests globally", async () => {
    const node = fakeAnvil();
    const faucet = createDevFaucet({ rpc: node.rpc, clock: () => 0, claimRegistry: CLAIM_REGISTRY, global: { max: 2, windowMs: 60_000 } });
    expect((await faucet.fund({ address: USER })).ok).toBe(true);
    expect((await faucet.fund({ address: DELEGATE })).ok).toBe(true);
    expect(await faucet.fund({ address: CLAIM_REGISTRY })).toMatchObject({ ok: false, status: 429 });
  });

  it("serialises concurrent calls for one wallet: a single top-up", async () => {
    const { node, faucet } = setup();
    const results = await Promise.all([faucet.fund({ address: USER }), faucet.fund({ address: USER }), faucet.fund({ address: USER })]);
    expect(results.filter((r) => r.ok && r.body.funded)).toHaveLength(1);
    expect(anvilWrites(node)).toHaveLength(1);
  });
});
