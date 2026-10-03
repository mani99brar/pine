// Must stay the first import: blocks this file until no other PGlite-backed core test file runs.
import "./testing/suite-lock.js";
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSiweFields, newSiweNonce, termsStatement } from "./siwe.js";
import { cookieValue, createHarness, csrfHeaders, signIn, TEST_TERMS_DIGEST, testAccount, useSharedDatabase, type CoreHarness } from "./testing/harness.js";

const db = useSharedDatabase({ beforeAll, afterAll, beforeEach });
let h: CoreHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<CoreHarness> {
  h = await createHarness({ database: db(), ...options });
  return h;
}

const alice = testAccount(0xa11ce);
const mallory = testAccount(0xbad);

async function challenge(app: CoreHarness["app"], address: string, presession?: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/siwe/challenge",
    headers: csrfHeaders(presession ? { cookie: `__Host-pine_presession=${presession}` } : {}),
    payload: { address },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ message: string; nonce: string; expiresAt: string }>();
  return { ...body, presession: cookieValue(res.headers["set-cookie"], "__Host-pine_presession") ?? presession ?? "", setCookie: res.headers["set-cookie"] };
}

async function verify(app: CoreHarness["app"], input: { message: string; signature: string; presession?: string; extraCookie?: string }) {
  const cookies = [input.presession ? `__Host-pine_presession=${input.presession}` : null, input.extraCookie ?? null].filter(Boolean).join("; ");
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/siwe/verify",
    headers: csrfHeaders(cookies ? { cookie: cookies } : {}),
    payload: { message: input.message, signature: input.signature },
  });
}

async function failures(h: CoreHarness): Promise<string[]> {
  const rows = await h.database.sql.query<{ reason: string }>("SELECT details->>'reason' AS reason FROM audit_log WHERE action = 'auth.siwe.failed' ORDER BY id");
  return rows.map((row) => row.reason);
}

function expectGenericFailure(res: { statusCode: number; json(): { error: { code: string; message: string } } }) {
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe("UNAUTHENTICATED");
  expect(res.json().error.message).toBe("Sign-in failed");
}

describe("SIWE challenge", () => {
  it("issues the exact EIP-4361 message and a pre-session cookie", async () => {
    const { app, clock } = await harness();
    const c = await challenge(app, alice.address);
    const expected = createSiweMessage({
      domain: "app.pine.test",
      address: getAddress(alice.address),
      statement: termsStatement(TEST_TERMS_DIGEST),
      uri: "https://app.pine.test",
      version: "1",
      chainId: 100,
      nonce: c.nonce,
      issuedAt: clock.now(),
      expirationTime: new Date(clock.now().getTime() + 600_000),
    });
    expect(c.message).toBe(expected);
    expect(c.message).toContain(`Sign in to Pine. I accept the terms with sha256 ${TEST_TERMS_DIGEST}.`);
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    const cookie = [c.setCookie].flat().find((line) => line?.startsWith("__Host-pine_presession=")) ?? "";
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  it("SEC-AUTH-02 nonces come from node:crypto: 10^5 distinct 128-bit hex values", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) seen.add(newSiweNonce());
    expect(seen.size).toBe(100_000);
    for (const nonce of [...seen].slice(0, 100)) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("SEC-AUTH-08 each allowed challenge writes at most one pre-session and one nonce row", async () => {
    const { app, database } = await harness();
    const count = async (table: string) => (await database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n;
    const first = await challenge(app, alice.address);
    expect([await count("siwe_presessions"), await count("siwe_nonces")]).toEqual([1, 1]);
    await challenge(app, alice.address, first.presession);
    expect([await count("siwe_presessions"), await count("siwe_nonces")]).toEqual([1, 2]);
    await challenge(app, alice.address);
    expect([await count("siwe_presessions"), await count("siwe_nonces")]).toEqual([2, 3]);
  });

  it("SEC-AUTH-03 keeps at most 5 outstanding nonces per pre-session (oldest evicted)", async () => {
    const { app, database } = await harness();
    const first = await challenge(app, alice.address);
    for (let i = 0; i < 5; i += 1) await challenge(app, alice.address, first.presession);
    const rows = await database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM siwe_nonces");
    expect(rows[0]?.n).toBe(5);
    const evicted = await verify(app, { message: first.message, signature: await alice.signMessage({ message: first.message }), presession: first.presession });
    expectGenericFailure(evicted);
  });
});

describe("SIWE verify", () => {
  it("creates a session: __Host- cookie attributes, lowercase user, hashed token, terms acceptance, audit", async () => {
    const { app, database } = await harness();
    const c = await challenge(app, alice.address);
    const signature = await alice.signMessage({ message: c.message });
    const res = await verify(app, { message: c.message, signature, presession: c.presession });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ wallet: alice.address.toLowerCase(), isAdmin: false, termsAccepted: true, termsDigest: TEST_TERMS_DIGEST });
    const setCookie = [res.headers["set-cookie"]].flat().find((line) => line?.startsWith("__Host-pine_session=")) ?? "";
    // SEC-AUTH-10
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/; HttpOnly/);
    expect(setCookie).toMatch(/; SameSite=Lax/);
    expect(setCookie).toMatch(/; Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
    const token = cookieValue(res.headers["set-cookie"], "__Host-pine_session") ?? "";
    expect(token).toMatch(/^pine_s1_[A-Za-z0-9_-]{43}$/);
    // SEC-AUTH-09: only sha256(token) is stored; no column anywhere equals the cookie.
    const sessions = await database.sql.query<Record<string, unknown>>("SELECT * FROM sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    const dump = JSON.stringify(await database.sql.query("SELECT row_to_json(t)::text AS j FROM (SELECT * FROM sessions) t"));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(8));
    const users = await database.sql.query<{ wallet_address: string }>("SELECT wallet_address FROM users");
    expect(users.map((u) => u.wallet_address)).toEqual([alice.address.toLowerCase()]);
    // SEC-AUTH-07 / SEC-LEGAL-03: the signed message is the acceptance record.
    const terms = await database.sql.query<{ terms_digest: string; message: string; signature: string; method: string }>("SELECT terms_digest, message, signature, method FROM terms_acceptances");
    expect(terms).toEqual([{ terms_digest: TEST_TERMS_DIGEST, message: c.message, signature: signature.toLowerCase(), method: "siwe" }]);
    expect(sessions[0]?.terms_digest).toBe(TEST_TERMS_DIGEST);
    const presessions = await database.sql.query("SELECT * FROM siwe_presessions");
    expect(presessions).toHaveLength(0);
    const audit = await database.sql.query<{ action: string }>("SELECT action FROM audit_log");
    expect(audit.map((a) => a.action)).toEqual(["auth.siwe.succeeded"]);
  });

  it("SEC-AUTH-03 rejects a replayed nonce", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    const signature = await alice.signMessage({ message: c.message });
    expect((await verify(app, { message: c.message, signature, presession: c.presession })).statusCode).toBe(200);
    expectGenericFailure(await verify(app, { message: c.message, signature, presession: c.presession }));
  });

  it("SEC-AUTH-03 a nonce is consumed by its first attempt: a replay on the same, still-valid pre-session fails", async () => {
    const { app, database } = await harness();
    const c = await challenge(app, alice.address);
    // First attempt with a wrong signature consumes the nonce (atomic DELETE ... RETURNING).
    expectGenericFailure(await verify(app, { message: c.message, signature: await mallory.signMessage({ message: c.message }), presession: c.presession }));
    // Second attempt: correct signature, same pre-session (still valid) -> the nonce is gone.
    expectGenericFailure(await verify(app, { message: c.message, signature: await alice.signMessage({ message: c.message }), presession: c.presession }));
    expect(await failures(h!)).toEqual(["signature_mismatch", "unknown_nonce"]);
    expect(await database.sql.query("SELECT id FROM sessions")).toEqual([]);
    // The pre-session was alive all along: a fresh nonce on it verifies.
    const again = await challenge(app, alice.address, c.presession);
    expect(again.presession).toBe(c.presession);
    expect((await verify(app, { message: again.message, signature: await alice.signMessage({ message: again.message }), presession: c.presession })).statusCode).toBe(200);
  });

  it("SEC-AUTH-04 rejects a stored message past its expiration while the pre-session is still valid", async () => {
    const { app, clock, database } = await harness();
    const first = await challenge(app, alice.address);
    clock.advance(9 * 60_000);
    // A later challenge refreshes the pre-session (10 more minutes); the first message still expires at t0 + 10 min.
    await challenge(app, alice.address, first.presession);
    clock.advance(60_000 + 1_000);
    expectGenericFailure(await verify(app, { message: first.message, signature: await alice.signMessage({ message: first.message }), presession: first.presession }));
    expect(await failures(h!)).toEqual(["expired"]);
    expect(await database.sql.query("SELECT id FROM sessions")).toEqual([]);
  });

  for (const [name, settings, config] of [
    ["SEC-LEGAL-03 the terms digest changed", { termsDigest: `0x${"d2".repeat(32)}` }, {}],
    ["SEC-AUTH-04 the chain id changed", {}, { chainId: 10200 }],
  ] as const) {
    it(`SEC-AUTH-04 explicit field checks run on the stored message: refused when ${name} between challenge and verify`, async () => {
      const { app, database } = await harness();
      const c = await challenge(app, alice.address);
      const signature = await alice.signMessage({ message: c.message });
      const other = await createHarness({ database: db(), settings, config });
      try {
        expectGenericFailure(await verify(other.app, { message: c.message, signature, presession: c.presession }));
      } finally {
        await other.close();
      }
      expect(await failures(h!)).toEqual(["field_mismatch"]);
      expect(await database.sql.query("SELECT id FROM sessions")).toEqual([]);
      expect(await database.sql.query("SELECT id FROM terms_acceptances")).toEqual([]);
    });
  }

  it("SEC-AUTH-03 rejects a nonce issued to another pre-session (and does not burn it)", async () => {
    const { app } = await harness();
    const victim = await challenge(app, alice.address);
    const attacker = await challenge(app, mallory.address);
    const signature = await alice.signMessage({ message: victim.message });
    expectGenericFailure(await verify(app, { message: victim.message, signature, presession: attacker.presession }));
    expect(await failures(h!)).toEqual(["foreign_presession"]);
    expect((await verify(app, { message: victim.message, signature, presession: victim.presession })).statusCode).toBe(200);
  });

  it("SEC-AUTH-03 rejects a verify without a pre-session cookie", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    expectGenericFailure(await verify(app, { message: c.message, signature: await alice.signMessage({ message: c.message }) }));
  });

  it("SEC-AUTH-04 rejects an expired challenge", async () => {
    const { app, clock } = await harness();
    const c = await challenge(app, alice.address);
    const signature = await alice.signMessage({ message: c.message });
    clock.advance(600_000);
    expectGenericFailure(await verify(app, { message: c.message, signature, presession: c.presession }));
  });

  it("SEC-AUTH-01 rejects a signature over the stored message plus an appended line", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    const altered = `${c.message}\nResources:\n- https://evil.example`;
    expectGenericFailure(await verify(app, { message: altered, signature: await alice.signMessage({ message: altered }), presession: c.presession }));
    expect(await failures(h!)).toEqual(["message_mismatch"]);
  });

  it("SEC-AUTH-01 rejects a message with one altered byte", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    const altered = c.message.replace("Sign in to Pine.", "Sign in to Pinf.");
    expectGenericFailure(await verify(app, { message: altered, signature: await alice.signMessage({ message: altered }), presession: c.presession }));
  });

  const mutations: [string, Partial<Parameters<typeof createSiweMessage>[0]>][] = [
    ["chain id", { chainId: 10200 }],
    ["domain", { domain: "evil.example" }],
    ["uri", { uri: "https://evil.example" }],
    ["statement", { statement: "Sign in to Pine." }],
    ["expiration", { expirationTime: new Date("2026-10-02T00:00:00Z") }],
  ];
  for (const [field, change] of mutations) {
    it(`SEC-AUTH-04 rejects a signed message with another ${field}`, async () => {
      const { app, clock } = await harness();
      const c = await challenge(app, alice.address);
      const forged = createSiweMessage({
        domain: "app.pine.test",
        address: getAddress(alice.address),
        statement: termsStatement(TEST_TERMS_DIGEST),
        uri: "https://app.pine.test",
        version: "1",
        chainId: 100,
        nonce: c.nonce,
        issuedAt: clock.now(),
        expirationTime: new Date(clock.now().getTime() + 600_000),
        ...change,
      });
      expect(forged).not.toBe(c.message);
      const res = await verify(app, { message: forged, signature: await alice.signMessage({ message: forged }), presession: c.presession });
      expectGenericFailure(res);
      const audit = await h!.database.sql.query<{ action: string }>("SELECT action FROM audit_log");
      expect(audit.map((a) => a.action)).toEqual(["auth.siwe.failed"]);
    });
  }

  it("SEC-AUTH-04 explicit field checks reject every mutated field of a stored message", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const nonce = "0123456789abcdef0123456789abcdef";
    const settings = { publicOrigin: "https://app.pine.test", chainId: 100, termsDigest: TEST_TERMS_DIGEST };
    const base = {
      domain: "app.pine.test",
      address: getAddress(alice.address),
      statement: termsStatement(TEST_TERMS_DIGEST),
      uri: "https://app.pine.test",
      version: "1" as const,
      chainId: 100,
      nonce,
      issuedAt: now,
      expirationTime: new Date(now.getTime() + 600_000),
    };
    const expected = { address: alice.address.toLowerCase(), nonce };
    expect(checkSiweFields(createSiweMessage(base), settings, expected, now)).toBe(true);
    const bad: Partial<typeof base & { notBefore: Date }>[] = [
      { domain: "app.pine.test:8443" },
      { uri: "https://app.pine.test.evil.example" },
      { chainId: 10200 },
      { nonce: "ffffffffffffffffffffffffffffffff" },
      { address: getAddress(mallory.address) },
      { statement: "Sign in." },
      { issuedAt: new Date(now.getTime() - 6 * 60_000), expirationTime: new Date(now.getTime() + 60_000) },
      { expirationTime: new Date(now.getTime() + 11 * 60_000) },
      { expirationTime: now },
      { notBefore: new Date(now.getTime() + 60_000) },
    ];
    for (const change of bad) expect(checkSiweFields(createSiweMessage({ ...base, ...change }), settings, expected, now), JSON.stringify(change)).toBe(false);
    const noExpiry = createSiweMessage({ ...base, expirationTime: undefined });
    expect(checkSiweFields(noExpiry, settings, expected, now)).toBe(false);
  });

  it("SEC-AUTH-05 rejects a signature by another key", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    expectGenericFailure(await verify(app, { message: c.message, signature: await mallory.signMessage({ message: c.message }), presession: c.presession }));
    expect(await failures(h!)).toEqual(["signature_mismatch"]);
  });

  it("SEC-AUTH-05 contract wallets cannot sign in: ERC-6492/1271 signatures are refused without any RPC call", async () => {
    const { app, ctx } = await harness();
    const rpcCalls: string[] = [];
    (ctx.chain as unknown as { setHandler(fn: (method: string) => Promise<unknown>): void }).setHandler(async (method: string) => {
      rpcCalls.push(method);
      // A hostile RPC that validates everything.
      return method === "eth_call" ? `0x${"0".repeat(63)}1` : "0x01";
    });
    const c = await challenge(app, alice.address);
    const wrapped = `0x${"ab".repeat(200)}6492649264926492649264926492649264926492649264926492649264926492`;
    expectGenericFailure(await verify(app, { message: c.message, signature: wrapped, presession: c.presession }));
    expect(rpcCalls).toEqual([]);
    expect(await failures(h!)).toEqual(["malformed_signature"]);
  });

  it("SEC-AUTH-08 every failure returns the same generic body", async () => {
    const { app } = await harness();
    const c = await challenge(app, alice.address);
    const a = await verify(app, { message: c.message, signature: await mallory.signMessage({ message: c.message }), presession: c.presession });
    const b = await verify(app, { message: "garbage", signature: "0x00", presession: c.presession });
    for (const res of [a, b]) {
      expectGenericFailure(res);
      expect(Object.keys(res.json().error).sort()).toEqual(["code", "message", "requestId"]);
    }
  });

  it("SEC-AUTH-11 a session cookie supplied before sign-in is never valid afterwards (fixation)", async () => {
    const { app } = await harness();
    const planted = `pine_s1_${"F".repeat(43)}`;
    const c = await challenge(app, alice.address);
    const res = await verify(app, { message: c.message, signature: await alice.signMessage({ message: c.message }), presession: c.presession, extraCookie: `__Host-pine_session=${planted}` });
    expect(res.statusCode).toBe(200);
    const issued = cookieValue(res.headers["set-cookie"], "__Host-pine_session");
    expect(issued).not.toBe(planted);
    const probe = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: { cookie: `__Host-pine_session=${planted}` } });
    expect(probe.statusCode).toBe(401);
  });

  it("signing in twice reuses the same user", async () => {
    await harness();
    const first = await signIn(h!, alice);
    const second = await signIn(h!, alice);
    expect(second.userId).toBe(first.userId);
    expect(second.token).not.toBe(first.token);
  });
});
