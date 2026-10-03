import { releaseSuiteLock } from "./test/lock.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "@pine/shared/types";
import { POSITIONS_MAX_IN_FLIGHT, POSITIONS_RETRY_AFTER_SECONDS } from "./positions.js";
import { ALICE, BOB, createHarness, MARKET_A, refreshIndexer, SDAI, seedClaim, WAD, type Harness } from "./test/harness.js";

afterAll(releaseSuiteLock);

const CAROL: Address = "0x00000000000000000000000000000000000ca401";
const OTHER_TOKEN: Address = "0x5000000000000000000000000000000000000001";
let h: Harness;

const get = (wallet: string, query: string) => h.app.inject({ method: "GET", url: `/api/v1/funding/positions/${wallet}${query}` });

function addPosition(id: bigint, owner: Address, token: Address): void {
  const [token0, token1] = token < SDAI ? [token, SDAI] : [SDAI, token];
  h.chain.positions.set(id, { owner, token0, token1, tickLower: -6_900, tickUpper: -240, liquidity: 1_000n + id, tokensOwed0: 0n, tokensOwed1: 0n });
}

beforeAll(async () => {
  h = await createHarness();
  seedClaim(h.ctx, { ...MARKET_A });
  // Alice: 25 NFTs; every third pairs YES/sDAI, every fifth NO/sDAI, the rest another token.
  for (let index = 0; index < 25; index += 1) {
    const token = index % 3 === 0 ? MARKET_A.yesToken : index % 5 === 0 ? MARKET_A.noToken : OTHER_TOKEN;
    addPosition(BigInt(1_000 + index), ALICE.wallet, token);
  }
  // Carol: 205 NFTs, all YES/sDAI (beyond the 200 scan limit).
  for (let index = 0; index < 205; index += 1) addPosition(BigInt(10_000 + index), CAROL, MARKET_A.yesToken);
  h.chain.setBalance(MARKET_A.yesToken, ALICE.wallet, 7n * WAD);
  h.chain.setBalance(MARKET_A.noToken, ALICE.wallet, 3n * WAD);
});

afterAll(async () => {
  await h.close();
});

beforeEach(() => {
  // Each test starts a minute later than the previous one, so the 10 s server cache never carries over between tests.
  h.ctx.clock.advance(60_000);
  refreshIndexer(h);
  h.chain.calls.length = 0;
});

describe("GET /api/v1/funding/positions/:wallet (PRD-04 3.3)", () => {
  it("pages 20 NFTs at a time and returns only the market's outcome/sDAI positions plus outcome balances", async () => {
    const first = await get(ALICE.wallet, `?market=${MARKET_A.market}`);
    expect(first.statusCode).toBe(200);
    const page1 = first.json();
    expect(page1.scanned).toEqual({ from: 0, to: 20 });
    expect(page1.nextCursor).toBe("20");
    expect(page1.truncated).toBe(false);
    expect(page1.positionCount).toBe("25");
    const expectedFirst = Array.from({ length: 20 }, (_, index) => index).filter((index) => index % 3 === 0 || index % 5 === 0);
    expect(page1.items.map((item: { tokenId: string }) => Number(item.tokenId) - 1_000)).toEqual(expectedFirst);
    expect(page1.items[0]).toMatchObject({ outcome: "yes", token0: MARKET_A.yesToken, token1: SDAI, tickLower: -6_900, tickUpper: -240 });
    expect(page1.items.find((item: { tokenId: string }) => item.tokenId === "1005")).toMatchObject({ outcome: "no" });
    expect(page1.balances).toEqual({ yes: (7n * WAD).toString(), no: (3n * WAD).toString(), invalid: "0" });

    const page2 = (await get(ALICE.wallet, `?market=${MARKET_A.market}&cursor=20`)).json();
    expect(page2.scanned).toEqual({ from: 20, to: 25 });
    expect(page2.nextCursor).toBeNull();
    expect(page2.items.map((item: { tokenId: string }) => Number(item.tokenId) - 1_000)).toEqual([20, 21, 24]);
  });

  it("bounds the scan: at most 20 NFTs per request and 200 per wallet (truncated beyond)", async () => {
    const response = (await get(CAROL, `?market=${MARKET_A.market}&cursor=180`)).json();
    expect(response.truncated).toBe(true);
    expect(response.scanned).toEqual({ from: 180, to: 200 });
    expect(response.nextCursor).toBeNull();
    expect(response.items).toHaveLength(20);
    const perNft = h.chain.calls.filter((call) => call.functionName === "tokenOfOwnerByIndex" || call.functionName === "positions");
    expect(perNft).toHaveLength(40);
    expect(h.chain.calls.length).toBeLessThanOrEqual(1 + 40 + 5);
  });

  it("an empty wallet has no items and no cursor", async () => {
    const response = (await get(BOB.wallet, `?market=${MARKET_A.market}`)).json();
    expect(response).toMatchObject({ positionCount: "0", items: [], nextCursor: null, truncated: false });
  });

  it("caches per (wallet, market, cursor) for 10 s: no chain reads inside the window (PRD-04 4a)", async () => {
    const first = await get(ALICE.wallet, `?market=${MARKET_A.market}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("public, max-age=10");
    const reads = h.chain.rpcCount;
    h.ctx.clock.advance(9_999);
    const cached = await get(ALICE.wallet, `?market=${MARKET_A.market}`);
    expect(cached.json()).toEqual(first.json());
    expect(h.chain.rpcCount).toBe(reads);
    // Another cursor or another wallet is another key.
    await get(ALICE.wallet, `?market=${MARKET_A.market}&cursor=20`);
    expect(h.chain.rpcCount).toBeGreaterThan(reads);
    const afterCursor = h.chain.rpcCount;
    await get(BOB.wallet, `?market=${MARKET_A.market}`);
    expect(h.chain.rpcCount).toBeGreaterThan(afterCursor);
    // Expired after 10 s: read again.
    const beforeExpiry = h.chain.rpcCount;
    h.ctx.clock.advance(1);
    await get(ALICE.wallet, `?market=${MARKET_A.market}`);
    expect(h.chain.rpcCount).toBeGreaterThan(beforeExpiry);
  });

  it("requires a registered market and a valid cursor", async () => {
    expect((await get(ALICE.wallet, "")).statusCode).toBe(400);
    expect((await get(ALICE.wallet, "?market=0x0000000000000000000000000000000000dead01")).statusCode).toBe(404);
    for (const cursor of ["7", "200", "abc", "-20", "020"]) {
      expect((await get(ALICE.wallet, `?market=${MARKET_A.market}&cursor=${cursor}`)).statusCode, cursor).toBe(400);
    }
    expect((await get("0x123", `?market=${MARKET_A.market}`)).statusCode).toBe(400);
  });

  it("caps RPC fan-out at 4 concurrent cache misses: a 5th is 429 RATE_LIMITED at once, never queued (PRD-04 4b)", async () => {
    expect(POSITIONS_MAX_IN_FLIGHT).toBe(4);
    const wallets: Address[] = Array.from({ length: 6 }, (_, index) => `0x00000000000000000000000000000000000f00${index.toString(16).padStart(2, "0")}` as Address);
    // Warm one key first: a cached answer is served even while the limiter is full (checked after the cache lookup).
    expect((await get(wallets[5] as Address, `?market=${MARKET_A.market}`)).statusCode).toBe(200);
    const original = h.chain.handle;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = 0;
    h.ctx.chain.setHandler(async (method, params) => {
      held += 1;
      await gate;
      return original(method, params);
    });
    try {
      const pending = wallets.slice(0, 4).map((wallet) => get(wallet, `?market=${MARKET_A.market}`));
      // Each of the 4 requests is parked on its first scripted RPC promise.
      await vi.waitFor(() => expect(held).toBe(4));
      const fifth = await get(wallets[4] as Address, `?market=${MARKET_A.market}`);
      expect(fifth.statusCode, fifth.body).toBe(429);
      expect(fifth.json().error.code).toBe("RATE_LIMITED");
      expect(fifth.headers["retry-after"]).toBe(String(POSITIONS_RETRY_AFTER_SECONDS));
      expect(held).toBe(4); // the refused request made no RPC call
      const cached = await get(wallets[5] as Address, `?market=${MARKET_A.market}`);
      expect(cached.statusCode).toBe(200);
      release();
      for (const response of await Promise.all(pending)) expect(response.statusCode, response.body).toBe(200);
    } finally {
      release();
      h.ctx.chain.setHandler(original);
    }
    // Released: the next miss is served.
    expect((await get(wallets[4] as Address, `?market=${MARKET_A.market}`)).statusCode).toBe(200);
  });

  it("releases a slot when the chain read fails, so errors cannot exhaust the limiter", async () => {
    h.chain.failTransport = true;
    try {
      for (let index = 0; index < POSITIONS_MAX_IN_FLIGHT + 2; index += 1) {
        const failed = await get(`0x00000000000000000000000000000000000e00${index.toString(16).padStart(2, "0")}`, `?market=${MARKET_A.market}`);
        expect(failed.statusCode).not.toBe(429);
      }
    } finally {
      h.chain.failTransport = false;
    }
    expect((await get(ALICE.wallet, `?market=${MARKET_A.market}`)).statusCode).toBe(200);
  });
});
