// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitHubGatewayError, type AppContext } from "../../contracts/app.js";
import { createKeyRing } from "./crypto.js";
import { JOB_NAMES } from "./index.js";
import {
  API,
  appGrant,
  createHarness,
  interceptedDatabase,
  jsonResponse,
  linkUser,
  repoJson,
  streamedResponse,
  testKey,
  testSecrets,
  TOKEN_URL,
  USER_A,
  USER_B,
  type Harness,
} from "./testing/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const REPO_URL = `${API}/repos/kleros/pine`;
const noCtx = undefined as unknown as AppContext;

async function tokenRows(userId: string) {
  const result = await h.database.sql.query<{ kind: string; key_id: string }>("SELECT kind, key_id FROM github_tokens WHERE user_id = $1 ORDER BY kind", [userId]);
  return result;
}

async function linkStatus(userId: string) {
  const rows = await h.database.sql.query<{ status: string; revoked_reason: string | null }>("SELECT status, revoked_reason FROM github_links WHERE user_id = $1", [userId]);
  return rows[0] ?? null;
}

async function expectNotLinked(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(GitHubGatewayError);
  expect((error as GitHubGatewayError).code).toBe("GITHUB_NOT_LINKED");
}

function revokedCount(reason: string): number {
  return h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason })}`) ?? 0;
}

describe("encrypted token storage", () => {
  it("SEC-GH-06/08 stores tokens only as AES-GCM ciphertext under the current key", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    const rows = await h.database.sql.query<{ kind: string; key_id: string; ciphertext: Uint8Array }>(
      "SELECT kind, key_id, ciphertext FROM github_tokens WHERE user_id = $1 ORDER BY kind",
      [USER_A],
    );
    expect(rows.map((row) => [row.kind, row.key_id])).toEqual([["access", "k2"], ["refresh", "k2"]]);
    for (const row of rows) expect(Buffer.from(row.ciphertext).toString("latin1")).not.toMatch(/gh[ur]_/);
  });

  it("SEC-GH-06 ciphertexts swapped between two users fail closed: token deleted, link revoked, GITHUB_NOT_LINKED", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1), githubUserId: 1001 });
    await linkUser(h, USER_B, { grant: appGrant(2), githubUserId: 1002, login: "bob" });
    await h.database.sql.query(
      `UPDATE github_tokens t SET iv = o.iv, ciphertext = o.ciphertext
         FROM github_tokens o WHERE t.kind = 'access' AND o.kind = 'access' AND t.user_id <> o.user_id`,
    );
    h.fetch.calls.length = 0;
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    await expectNotLinked(h.gateways.github.getRepo(USER_B, "kleros", "pine"));
    // No token was used: GitHub was never called.
    expect(h.fetch.calls).toHaveLength(0);
    expect(await tokenRows(USER_A)).toEqual([]);
    expect(await linkStatus(USER_A)).toEqual({ status: "revoked", revoked_reason: "decrypt_failed" });
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(await h.gateways.githubAuth.identityOf(USER_B)).toBeNull();
    expect(revokedCount("decrypt_failed")).toBe(2);
    expect(h.logs.some((line) => line.level === "warn" && line.msg.includes("decrypt_failed"))).toBe(true);
  });

  it("a never-linked user gets GITHUB_NOT_LINKED without a revocation metric", async () => {
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    expect(revokedCount("decrypt_failed") + revokedCount("unauthorized")).toBe(0);
  });

  it("SEC-GH-07 a key removed from configuration fails closed as decrypt_failed", async () => {
    await linkUser(h, USER_A);
    const process2 = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: testKey("k3"), previous: [] } }) });
    await expectNotLinked(process2.github.getRepo(USER_A, "kleros", "pine"));
    expect(await linkStatus(USER_A)).toEqual({ status: "revoked", revoked_reason: "decrypt_failed" });
    expect(await tokenRows(USER_A)).toEqual([]);
    expect(revokedCount("decrypt_failed")).toBe(1);
  });

  it("SEC-GH-07 the re-encryption job moves rows to the current key and revokes undecryptable ones", async () => {
    const k1 = h.secrets.tokenEncryptionKeys.previous[0];
    if (!k1) throw new Error("fixture needs a previous key");
    const oldProcess = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: k1, previous: [] } }) });
    await linkUser(h, USER_A, { gateways: oldProcess, grant: appGrant(1) });
    await linkUser(h, USER_B, { gateways: oldProcess, grant: appGrant(2), githubUserId: 1002, login: "bob" });
    expect((await tokenRows(USER_A)).map((row) => row.key_id)).toEqual(["k1", "k1"]);
    // USER_B's access row is relabelled to a key nobody holds any more.
    await h.database.sql.query("UPDATE github_tokens SET key_id = 'k0' WHERE user_id = $1 AND kind = 'access'", [USER_B]);

    const job = h.gateways.jobs.find((item) => item.name === JOB_NAMES.reencryptTokens);
    await job?.run(noCtx, new AbortController().signal);

    expect((await tokenRows(USER_A)).map((row) => row.key_id)).toEqual(["k2", "k2"]);
    expect(await tokenRows(USER_B)).toEqual([]);
    expect(await linkStatus(USER_B)).toEqual({ status: "revoked", revoked_reason: "decrypt_failed" });
    const remaining = await h.database.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM github_tokens WHERE key_id <> 'k2'");
    expect(remaining[0]?.n).toBe(0);
    expect(h.logs.some((line) => line.msg.includes("0 remain under retired keys"))).toBe(true);

    // The re-encrypted token still works, and a process without k1 can read it.
    h.fetch.on("GET", REPO_URL, (call) =>
      call.headers.get("authorization") === `Bearer ${appGrant(1).access_token}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {}),
    );
    const k1Gone = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: h.secrets.tokenEncryptionKeys.current, previous: [] } }) });
    await expect(k1Gone.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
  });
});

describe("token refresh (SEC-GH-09)", () => {
  function scriptRepoFor(token: string) {
    h.fetch.on("GET", REPO_URL, (call) => (call.headers.get("authorization") === `Bearer ${token}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {})));
  }

  it("10 concurrent requests from two processes with an expired token refresh exactly once and persist the rotated refresh token", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.clock.advance(8 * 3_600_000);
    const refreshed = appGrant(2);
    h.fetch.on("POST", TOKEN_URL, (call) => {
      const params = new URLSearchParams(call.bodyText ?? "");
      if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === appGrant(1).refresh_token) return jsonResponse(200, refreshed);
      return jsonResponse(200, { error: "bad_refresh_token" });
    });
    scriptRepoFor(refreshed.access_token);
    h.fetch.calls.length = 0;
    const process2 = await h.sibling();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? h.gateways : process2).github.getRepo(USER_A, "kleros", "pine")),
    );
    expect(results.every((repo) => repo.id === 4242)).toBe(true);
    expect(h.fetch.callsTo(TOKEN_URL)).toHaveLength(1);
    expect(revokedCount("refresh_rejected")).toBe(0);

    // The next refresh presents the rotated refresh token (it was persisted before use).
    h.clock.advance(8 * 3_600_000);
    const third = appGrant(3);
    h.fetch.on("POST", TOKEN_URL, (call) =>
      new URLSearchParams(call.bodyText ?? "").get("refresh_token") === refreshed.refresh_token ? jsonResponse(200, third) : jsonResponse(200, { error: "bad_refresh_token" }),
    );
    scriptRepoFor(third.access_token);
    await expect(h.gateways.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
  });

  it("SEC-GH-07 a refresh decrypts under a previous key and re-encrypts the rotated tokens under the current key", async () => {
    const previous = h.secrets.tokenEncryptionKeys.previous[0];
    if (!previous) throw new Error("harness has no previous key");
    const before = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: previous, previous: [] } }) });
    await linkUser(h, USER_A, { grant: appGrant(1), gateways: before });
    expect((await tokenRows(USER_A)).map((row) => row.key_id)).toEqual([previous.id, previous.id]);
    h.clock.advance(9 * 3_600_000);
    h.fetch.json("POST", TOKEN_URL, 200, appGrant(2));
    scriptRepoFor(appGrant(2).access_token);
    await expect(h.gateways.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(await tokenRows(USER_A)).toEqual([
      { kind: "access", key_id: h.secrets.tokenEncryptionKeys.current.id },
      { kind: "refresh", key_id: h.secrets.tokenEncryptionKeys.current.id },
    ]);
  });

  it("a rejected refresh deletes the tokens, revokes the link and throws GITHUB_NOT_LINKED (never UPSTREAM)", async () => {
    await linkUser(h, USER_A);
    h.clock.advance(9 * 3_600_000);
    h.fetch.json("POST", TOKEN_URL, 200, { error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." });
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    expect(await tokenRows(USER_A)).toEqual([]);
    expect(await linkStatus(USER_A)).toEqual({ status: "revoked", revoked_reason: "refresh_rejected" });
    expect(revokedCount("refresh_rejected")).toBe(1);
    // The revocation is attributable from the log alone (core audits it; the line carries user and reason).
    const lines = h.logs.filter((line) => line.level === "warn" && line.msg.includes("GitHub link revoked"));
    expect(lines.map((line) => line.msg)).toEqual([`GitHub link revoked for user ${USER_A} (reason refresh_rejected); stored tokens deleted`]);
  });

  it("an expired refresh token is treated as a rejected refresh without calling GitHub", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1, { refresh_token_expires_in: 3_600 }) });
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    expect(h.fetch.calls).toHaveLength(0);
    expect(revokedCount("refresh_rejected")).toBe(1);
  });

  it("a transient token-endpoint failure is UPSTREAM and keeps the link and tokens", async () => {
    await linkUser(h, USER_A);
    h.clock.advance(9 * 3_600_000);
    h.fetch.json("POST", TOKEN_URL, 502, { message: "bad gateway" });
    const error = await h.gateways.github.getRepo(USER_A, "kleros", "pine").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubGatewayError);
    expect((error as GitHubGatewayError).code).toBe("UPSTREAM");
    expect(await linkStatus(USER_A)).toEqual({ status: "active", revoked_reason: null });
    expect(await tokenRows(USER_A)).toHaveLength(2);
  });

  it("SEC-GH-15 an oversize token-endpoint answer to a refresh (streamed, above 64 KiB) is UPSTREAM and keeps the link", async () => {
    await linkUser(h, USER_A);
    h.clock.advance(9 * 3_600_000);
    // A valid grant padded with an ignored field: only the byte cap can refuse it.
    const body = new TextEncoder().encode(JSON.stringify({ ...appGrant(2), padding: "x".repeat(1024 * 1024) }));
    h.fetch.on("POST", TOKEN_URL, () => streamedResponse(body));
    scriptRepoFor(appGrant(2).access_token);
    const error = await h.gateways.github.getRepo(USER_A, "kleros", "pine").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitHubGatewayError);
    expect((error as GitHubGatewayError).code).toBe("UPSTREAM");
    expect(await linkStatus(USER_A)).toEqual({ status: "active", revoked_reason: null });
    expect(await tokenRows(USER_A)).toHaveLength(2);
  });

  it("OAuth App tokens without expiry are used without refreshing", async () => {
    await linkUser(h, USER_A, { grant: { access_token: "gho_0123456789abcdefghijklmnopqrstuvwxyz", token_type: "bearer", scope: "" } });
    h.clock.advance(365 * 86_400_000);
    scriptRepoFor("gho_0123456789abcdefghijklmnopqrstuvwxyz");
    h.fetch.calls.length = 0;
    await expect(h.gateways.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(h.fetch.callsTo(TOKEN_URL)).toHaveLength(0);
    const rows = await h.database.db.execute(sql`SELECT count(*)::int AS n FROM github_tokens WHERE kind = 'refresh'`);
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0);
  });
});

describe("decrypt failures on the refresh path (SEC-GH-06/07)", () => {
  async function expectDecryptRevoked(userId: string) {
    expect(await tokenRows(userId)).toEqual([]);
    expect(await linkStatus(userId)).toEqual({ status: "revoked", revoked_reason: "decrypt_failed" });
    expect(await h.gateways.githubAuth.identityOf(userId)).toBeNull();
    expect(revokedCount("decrypt_failed")).toBe(1);
    expect(h.fetch.callsTo(TOKEN_URL)).toHaveLength(0);
  }

  it("an expired access token with a refresh row under an unknown key id fails closed without calling the token endpoint", async () => {
    await linkUser(h, USER_A);
    await h.database.sql.query("UPDATE github_tokens SET key_id = 'k0' WHERE user_id = $1 AND kind = 'refresh'", [USER_A]);
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.json("POST", TOKEN_URL, 200, appGrant(9));
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    await expectDecryptRevoked(USER_A);
  });

  it("an expired access token with a refresh ciphertext swapped from another user fails closed", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1), githubUserId: 1001 });
    await linkUser(h, USER_B, { grant: appGrant(2), githubUserId: 1002, login: "bob" });
    await h.database.sql.query(
      `UPDATE github_tokens t SET iv = o.iv, ciphertext = o.ciphertext
         FROM github_tokens o WHERE t.user_id = $1 AND o.user_id = $2 AND t.kind = 'refresh' AND o.kind = 'refresh'`,
      [USER_A, USER_B],
    );
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.json("POST", TOKEN_URL, 200, appGrant(9));
    await expectNotLinked(h.gateways.github.getRepo(USER_A, "kleros", "pine"));
    await expectDecryptRevoked(USER_A);
    // USER_B is untouched.
    expect(await linkStatus(USER_B)).toEqual({ status: "active", revoked_reason: null });
  });

  it("an access token found fresh under the row lock but undecryptable fails closed (in-lock re-check)", async () => {
    await linkUser(h, USER_A);
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.json("POST", TOKEN_URL, 200, appGrant(9));
    let staged = false;
    // Between the unlocked read (access expired) and the locked re-read, another writer stores a fresh access row that
    // this process cannot decrypt (here: a key id it does not hold).
    const process2 = await h.sibling({
      db: interceptedDatabase(h.database.db, async (text, executor) => {
        if (staged || !/from github_links .* for update/i.test(text)) return;
        staged = true;
        await executor.execute(
          sql`UPDATE github_tokens SET key_id = 'k0', expires_at = ${new Date(h.clock.now().getTime() + 3_600_000)} WHERE user_id = ${USER_A} AND kind = 'access'`,
        );
      }),
    });
    await expectNotLinked(process2.github.getRepo(USER_A, "kleros", "pine"));
    expect(staged).toBe(true);
    await expectDecryptRevoked(USER_A);
  });
});

describe("per-user tokens (frozen GitHubGateway: the user's own linked token)", () => {
  const REPO_OF = { [USER_A]: `${API}/repos/kleros/a`, [USER_B]: `${API}/repos/kleros/b` } as const;
  function scriptOwnRepos(tokens: Record<string, string>) {
    for (const userId of [USER_A, USER_B]) {
      h.fetch.on("GET", REPO_OF[userId as keyof typeof REPO_OF], (call) =>
        call.headers.get("authorization") === `Bearer ${tokens[userId]}` ? jsonResponse(200, repoJson()) : jsonResponse(401, { message: "Bad credentials" }),
      );
    }
  }
  const interleaved = () =>
    Promise.all(
      Array.from({ length: 10 }, (_, index) => {
        const userId = index % 2 === 0 ? USER_A : USER_B;
        return h.gateways.github.getRepo(userId, "kleros", userId === USER_A ? "a" : "b");
      }),
    );

  it("interleaved concurrent calls of two users each carry only their own token, also across a refresh", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1), githubUserId: 1001 });
    await linkUser(h, USER_B, { grant: appGrant(2), githubUserId: 1002, login: "bob" });
    scriptOwnRepos({ [USER_A]: appGrant(1).access_token, [USER_B]: appGrant(2).access_token });
    expect(await interleaved()).toHaveLength(10);
    expect([...h.metrics.counters.keys()].filter((key) => key.startsWith("github_link_revoked"))).toEqual([]);

    // Both access tokens expire: one refresh per user, each with that user's own refresh token.
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    const next: Record<string, ReturnType<typeof appGrant>> = { [appGrant(1).refresh_token ?? ""]: appGrant(11), [appGrant(2).refresh_token ?? ""]: appGrant(12) };
    h.fetch.on("POST", TOKEN_URL, (call) => {
      const grant = next[new URLSearchParams(call.bodyText ?? "").get("refresh_token") ?? ""];
      return grant ? jsonResponse(200, grant) : jsonResponse(200, { error: "bad_refresh_token" });
    });
    scriptOwnRepos({ [USER_A]: appGrant(11).access_token, [USER_B]: appGrant(12).access_token });
    expect(await interleaved()).toHaveLength(10);
    const refreshes = h.fetch.callsTo(TOKEN_URL).map((call) => new URLSearchParams(call.bodyText ?? "").get("refresh_token"));
    expect(refreshes.sort()).toEqual([appGrant(1).refresh_token, appGrant(2).refresh_token].sort());
    expect(await linkStatus(USER_A)).toEqual({ status: "active", revoked_reason: null });
    expect(await linkStatus(USER_B)).toEqual({ status: "active", revoked_reason: null });
  });
});

describe("re-encryption never overwrites a concurrent refresh (SEC-GH-07/09)", () => {
  it("a refresh that rewrites the rows between the job's read and write wins; the rotated refresh token stays usable", async () => {
    const k1 = h.secrets.tokenEncryptionKeys.previous[0];
    if (!k1) throw new Error("fixture needs a previous key");
    const oldProcess = await h.sibling({ secrets: testSecrets({ tokenEncryptionKeys: { current: k1, previous: [] } }) });
    await linkUser(h, USER_A, { gateways: oldProcess, grant: appGrant(1) });
    h.clock.advance(9 * 3_600_000);
    h.fetch.on("POST", TOKEN_URL, (call) =>
      new URLSearchParams(call.bodyText ?? "").get("refresh_token") === appGrant(1).refresh_token ? jsonResponse(200, appGrant(2)) : jsonResponse(200, { error: "bad_refresh_token" }),
    );
    h.fetch.on("GET", REPO_URL, (call) => (call.headers.get("authorization") === `Bearer ${appGrant(2).access_token}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {})));

    let refreshed = false;
    const jobProcess = await h.sibling({
      db: interceptedDatabase(h.database.db, async (text) => {
        if (refreshed || !/^update github_tokens/i.test(text.trim())) return;
        refreshed = true;
        // The user's request refreshes (and rotates the refresh token) right before the job writes its re-encryption.
        await h.gateways.github.getRepo(USER_A, "kleros", "pine");
      }),
    });
    await jobProcess.jobs.find((item) => item.name === JOB_NAMES.reencryptTokens)?.run(noCtx, new AbortController().signal);
    expect(refreshed).toBe(true);

    const ring = createKeyRing(h.secrets.tokenEncryptionKeys);
    const rows = await h.database.sql.query<{ kind: "access" | "refresh"; key_id: string; iv: Uint8Array; ciphertext: Uint8Array }>(
      "SELECT kind, key_id, iv, ciphertext FROM github_tokens WHERE user_id = $1 ORDER BY kind",
      [USER_A],
    );
    const plain = Object.fromEntries(rows.map((row) => [row.kind, ring.decrypt(USER_A, row.kind, { keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext })]));
    expect(plain).toEqual({ access: appGrant(2).access_token, refresh: appGrant(2).refresh_token });

    // The next refresh presents the rotated token and succeeds.
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.on("POST", TOKEN_URL, (call) =>
      new URLSearchParams(call.bodyText ?? "").get("refresh_token") === appGrant(2).refresh_token ? jsonResponse(200, appGrant(3)) : jsonResponse(200, { error: "bad_refresh_token" }),
    );
    h.fetch.on("GET", REPO_URL, (call) => (call.headers.get("authorization") === `Bearer ${appGrant(3).access_token}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {})));
    await expect(h.gateways.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(revokedCount("refresh_rejected")).toBe(0);
  });
});
