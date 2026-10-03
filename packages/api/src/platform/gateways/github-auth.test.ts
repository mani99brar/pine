// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../../contracts/errors.js";
import { sql } from "drizzle-orm";
import { createKeyRing } from "./crypto.js";
import { sqlState } from "./db.js";
import { JOB_NAMES } from "./index.js";
import type { AppContext } from "../../contracts/app.js";
import {
  API,
  appGrant,
  CLIENT_ID,
  createHarness,
  insertUser,
  interceptedDatabase,
  jsonResponse,
  linkUser,
  repoJson,
  sessionFor,
  streamedResponse,
  testSecrets,
  TOKEN_URL,
  USER_A,
  USER_B,
  WEBHOOK_SECRET,
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

/** SEC-GH-03 / frozen GitHubAuthFlow.start: a literal, never the implementation constant. */
const TEN_MINUTES = 600_000;
const REVOKE_URL = `${API}/applications/${CLIENT_ID}/token`;
const GRANT_URL = `${API}/applications/${CLIENT_ID}/grant`;

async function startFor(userId: string, sessionId?: string) {
  await insertUser(h.database, userId);
  const session = sessionFor(userId, sessionId);
  const { authorizationUrl } = await h.gateways.githubAuth.start(session);
  const url = new URL(authorizationUrl);
  return { session, url, state: url.searchParams.get("state") ?? "" };
}

function scriptExchange(grant = appGrant(1), identity = { id: 1001, login: "alice" }, headers: Record<string, string> = { "x-oauth-scopes": "" }) {
  h.fetch.json("POST", TOKEN_URL, 200, grant);
  h.fetch.json("GET", `${API}/user`, 200, identity, headers);
  h.fetch.on("DELETE", REVOKE_URL, () => new Response(null, { status: 204 }));
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

async function count(table: string): Promise<number> {
  const rows = await h.database.sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? 0;
}

describe("start(): PKCE and state (SEC-GH-03)", () => {
  it("builds an authorization URL with PKCE S256, a 128-bit state and the API callback", async () => {
    const { url, state } = await startFor(USER_A);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.pine.test/api/v1/auth/github/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Buffer.from(state, "base64url")).toHaveLength(16);
    // The state is stored only as its SHA-256.
    const rows = await h.database.sql.query<{ state_hash: string; session_id: string; verifier_ciphertext: Uint8Array }>(
      "SELECT state_hash, session_id, verifier_ciphertext FROM github_oauth_states",
    );
    expect(rows.map(({ state_hash, session_id }) => ({ state_hash, session_id }))).toEqual([
      { state_hash: createHash("sha256").update(state).digest("hex"), session_id: `sess-${USER_A}` },
    ]);

    // The verifier sent at exchange time hashes to the challenge of the URL.
    scriptExchange();
    await h.gateways.githubAuth.complete(sessionFor(USER_A), { code: "abc123", state });
    const exchange = new URLSearchParams(h.fetch.callsTo(TOKEN_URL)[0]?.bodyText ?? "");
    const verifier = exchange.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    // The verifier was stored only encrypted.
    expect(Buffer.from(rows[0]?.verifier_ciphertext ?? []).toString("latin1")).not.toContain(verifier);
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(exchange.get("redirect_uri")).toBe("https://app.pine.test/api/v1/auth/github/callback");
    expect(h.fetch.callsTo(TOKEN_URL)[0]?.redirect).toBe("error");
  });

  it("the OAuth App fallback requests no scopes", async () => {
    const oauth = await h.sibling({ secrets: testSecrets({ github: { kind: "oauth", clientId: CLIENT_ID, clientSecret: "client-secret-0123456789abcdef", webhookSecret: null } }) });
    await insertUser(h.database, USER_A);
    const { authorizationUrl } = await oauth.githubAuth.start(sessionFor(USER_A));
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("");
  });
});

describe("complete(): state validation (SEC-GH-03)", () => {
  it("links the GitHub identity by numeric id and the state is single use", async () => {
    const { session, state } = await startFor(USER_A);
    scriptExchange();
    await expect(h.gateways.githubAuth.complete(session, { code: "abc123", state })).resolves.toEqual({ githubUserId: 1001, login: "alice" });
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toEqual({ githubUserId: 1001, login: "alice" });
    const replay = await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }));
    expect(replay.code).toBe("BAD_REQUEST");
    expect(h.fetch.callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it("SEC-GH-03 a state bound to another session links nothing and is burnt", async () => {
    const { state } = await startFor(USER_A, "session-1");
    scriptExchange();
    const error = await rejection(h.gateways.githubAuth.complete(sessionFor(USER_A, "session-2"), { code: "abc123", state }));
    expect(error.code).toBe("BAD_REQUEST");
    expect(h.fetch.calls).toHaveLength(0);
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    // Burnt: even the right session cannot use it afterwards.
    expect((await rejection(h.gateways.githubAuth.complete(sessionFor(USER_A, "session-1"), { code: "abc123", state }))).code).toBe("BAD_REQUEST");
  });

  it("SEC-GH-03 a state presented by another user's session links nothing", async () => {
    const { state } = await startFor(USER_A, "shared-session-id");
    await insertUser(h.database, USER_B);
    scriptExchange();
    await rejection(h.gateways.githubAuth.complete(sessionFor(USER_B, "shared-session-id"), { code: "abc123", state }));
    expect(await h.gateways.githubAuth.identityOf(USER_B)).toBeNull();
    expect(await count("github_tokens")).toBe(0);
  });

  it("SEC-GH-03 the state's user binding is checked on its own, not only through the verifier's AAD", async () => {
    // A state row of USER_A whose verifier decrypts for USER_B: only the user_id comparison can refuse USER_B here.
    await insertUser(h.database, USER_A);
    await insertUser(h.database, USER_B);
    const state = randomBytes(16).toString("base64url");
    const verifier = createKeyRing(h.secrets.tokenEncryptionKeys).encrypt(USER_B, "pkce_verifier", randomBytes(32).toString("base64url"));
    const now = h.clock.now();
    await h.database.sql.query(
      `INSERT INTO github_oauth_states (state_hash, session_id, user_id, verifier_key_id, verifier_iv, verifier_ciphertext, created_at, expires_at)
       VALUES ($1, 'shared-session-id', $2, $3, $4, $5, $6, $7)`,
      [createHash("sha256").update(state).digest("hex"), USER_A, verifier.keyId, Buffer.from(verifier.iv), Buffer.from(verifier.ciphertext), now, new Date(now.getTime() + 60_000)],
    );
    scriptExchange();
    expect((await rejection(h.gateways.githubAuth.complete(sessionFor(USER_B, "shared-session-id"), { code: "abc123", state }))).code).toBe("BAD_REQUEST");
    expect(h.fetch.calls).toHaveLength(0);
    expect(await h.gateways.githubAuth.identityOf(USER_B)).toBeNull();
    expect(await count("github_oauth_states")).toBe(0);
  });

  it("SEC-GH-03 a state is valid for exactly 10 minutes (literal 600000 ms, stored expires_at = created_at + 10 min)", async () => {
    const first = await startFor(USER_A, "session-early");
    const rows = await h.database.sql.query<{ ttl_ms: number }>(
      "SELECT (extract(epoch FROM (expires_at - created_at)) * 1000)::int AS ttl_ms FROM github_oauth_states",
    );
    expect(rows).toEqual([{ ttl_ms: TEN_MINUTES }]);
    scriptExchange();
    h.clock.advance(TEN_MINUTES - 1);
    await expect(h.gateways.githubAuth.complete(first.session, { code: "abc123", state: first.state })).resolves.toEqual({ githubUserId: 1001, login: "alice" });
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);

    const second = await startFor(USER_A, "session-late");
    h.fetch.calls.length = 0;
    h.clock.advance(TEN_MINUTES);
    expect((await rejection(h.gateways.githubAuth.complete(second.session, { code: "abc123", state: second.state }))).code).toBe("BAD_REQUEST");
    expect(h.fetch.calls).toHaveLength(0);
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(await count("github_tokens")).toBe(0);
  });

  it("rejects unknown or malformed states and codes without calling GitHub", async () => {
    const { session } = await startFor(USER_A);
    await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state: "A".repeat(22) }));
    await rejection(h.gateways.githubAuth.complete(session, { code: "abc 123", state: "A".repeat(22) }));
    await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state: "short" }));
    expect(h.fetch.calls).toHaveLength(0);
  });

  it("a code GitHub rejects is BAD_REQUEST and stores nothing", async () => {
    const { session, state } = await startFor(USER_A);
    h.fetch.json("POST", TOKEN_URL, 200, { error: "bad_verification_code" });
    expect((await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }))).code).toBe("BAD_REQUEST");
    expect(await count("github_links")).toBe(0);
  });

  it("keeps at most 5 outstanding states per session and the purge job deletes expired ones", async () => {
    for (let index = 0; index < 7; index += 1) {
      await startFor(USER_A);
      h.clock.advance(1_000);
    }
    expect(await count("github_oauth_states")).toBe(5);
    await startFor(USER_B);
    // USER_A's newest state (t = 6 s) expires at 606 s, USER_B's (t = 7 s) at 607 s; now = 606.5 s.
    h.clock.advance(TEN_MINUTES - 500);
    const job = h.gateways.jobs.find((item) => item.name === JOB_NAMES.purgeOAuthStates);
    await job?.run(undefined as unknown as AppContext, new AbortController().signal);
    expect(await count("github_oauth_states")).toBe(1);
  });
});

describe("complete(): scopes and identity (SEC-GH-04/05)", () => {
  it("SEC-GH-04 an OAuth token with non-empty X-OAuth-Scopes is revoked at GitHub and leaves no token row", async () => {
    const oauth = await h.sibling({ secrets: testSecrets({ github: { kind: "oauth", clientId: CLIENT_ID, clientSecret: "client-secret-0123456789abcdef", webhookSecret: null } }) });
    await insertUser(h.database, USER_A);
    const { authorizationUrl } = await oauth.githubAuth.start(sessionFor(USER_A));
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    const grant = { access_token: "gho_overscopedtoken0123456789abcdef", token_type: "bearer", scope: "" };
    scriptExchange(appGrant(1, grant), { id: 1001, login: "alice" }, { "x-oauth-scopes": "repo, user" });
    const error = await rejection(oauth.githubAuth.complete(sessionFor(USER_A), { code: "abc123", state }));
    expect(error.code).toBe("FORBIDDEN");
    const revoke = h.fetch.callsTo(REVOKE_URL);
    expect(revoke).toHaveLength(1);
    expect(JSON.parse(revoke[0]?.bodyText ?? "{}")).toEqual({ access_token: grant.access_token });
    expect(revoke[0]?.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:client-secret-0123456789abcdef`).toString("base64")}`);
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
  });

  it("SEC-GH-04 an OAuth token whose scope check is impossible (header missing) fails closed", async () => {
    const oauth = await h.sibling({ secrets: testSecrets({ github: { kind: "oauth", clientId: CLIENT_ID, clientSecret: "client-secret-0123456789abcdef", webhookSecret: null } }) });
    await insertUser(h.database, USER_A);
    const { authorizationUrl } = await oauth.githubAuth.start(sessionFor(USER_A));
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    scriptExchange(appGrant(1), { id: 1001, login: "alice" }, {});
    expect((await rejection(oauth.githubAuth.complete(sessionFor(USER_A), { code: "abc123", state }))).code).toBe("FORBIDDEN");
    expect(await count("github_tokens")).toBe(0);
  });

  it("SEC-GH-04 a token response granting scopes is refused", async () => {
    const { session, state } = await startFor(USER_A);
    scriptExchange(appGrant(1, { scope: "repo" }));
    expect((await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }))).code).toBe("FORBIDDEN");
    expect(h.fetch.callsTo(REVOKE_URL)).toHaveLength(1);
    expect(await count("github_tokens")).toBe(0);
  });

  it("a malformed identity response is refused and the token revoked", async () => {
    const { session, state } = await startFor(USER_A);
    scriptExchange(appGrant(1), { id: "1001", login: "alice" } as unknown as { id: number; login: string });
    expect((await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }))).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(h.fetch.callsTo(REVOKE_URL)).toHaveLength(1);
    expect(await count("github_links")).toBe(0);
  });

  it("one GitHub id maps to one Pine user: an active link held by another user is CONFLICT", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const error = await linkUser(h, USER_B, { githubUserId: 1001, grant: appGrant(2) }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("CONFLICT");
    expect(await h.gateways.githubAuth.identityOf(USER_B)).toBeNull();
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toEqual({ githubUserId: 1001, login: "alice" });
  });

  it("the partial unique index enforces one live link per GitHub id, and its violation is recognised through drizzle's wrapper", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    await insertUser(h.database, USER_B);
    const error = await h.database.db
      .execute(sql`INSERT INTO github_links (user_id, github_user_id, login, login_fetched_at, status, linked_at) VALUES (${USER_B}, 1001, 'x', now(), 'active', now())`)
      .then(() => null, (caught: unknown) => caught);
    expect(sqlState(error)).toBe("23505");
  });

  it("a revoked link does not block another user, whose link replaces it; re-linking reactivates the row", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    await h.database.sql.query("UPDATE github_links SET status = 'revoked', revoked_reason = 'webhook', revoked_at = now() WHERE user_id = $1", [USER_A]);
    await linkUser(h, USER_B, { githubUserId: 1001, grant: appGrant(2) });
    expect(await h.gateways.githubAuth.identityOf(USER_B)).toEqual({ githubUserId: 1001, login: "alice" });
    expect(await count("github_links")).toBe(1);

    await h.database.sql.query("UPDATE github_links SET status = 'revoked', revoked_reason = 'webhook', revoked_at = now() WHERE user_id = $1", [USER_B]);
    await linkUser(h, USER_B, { githubUserId: 1001, login: "alice-renamed", grant: appGrant(3) });
    const rows = await h.database.sql.query<{ status: string; login: string }>("SELECT status, login FROM github_links WHERE user_id = $1", [USER_B]);
    expect(rows).toEqual([{ status: "active", login: "alice-renamed" }]);
  });
});

describe("webhook (SEC-GH-10)", () => {
  const sign = (body: Buffer, secret = WEBHOOK_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const revokedPayload = (githubUserId: number) => Buffer.from(JSON.stringify({ action: "revoked", sender: { login: "alice", id: githubUserId } }));

  it("SEC-GH-10 rejects a missing, malformed or wrong signature with UNAUTHENTICATED and changes nothing", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const body = revokedPayload(1001);
    for (const header of [undefined, "", "sha1=abc", sign(body, "another-secret-123456"), sign(Buffer.from("other body")), `${sign(body)}00`]) {
      const error = await rejection(h.gateways.githubAuth.handleWebhook(body, header));
      expect(error.code).toBe("UNAUTHENTICATED");
    }
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
    expect(await count("github_tokens")).toBe(2);
    expect([...h.metrics.counters.keys()].filter((key) => key.startsWith("github_link_revoked"))).toEqual([]);
  });

  it("SEC-GH-10 rejects every webhook when no secret is configured", async () => {
    const noSecret = await h.sibling({ secrets: testSecrets({ github: { kind: "app", clientId: CLIENT_ID, clientSecret: "client-secret-0123456789abcdef", webhookSecret: null } }) });
    const body = revokedPayload(1001);
    expect((await rejection(noSecret.githubAuth.handleWebhook(body, sign(body)))).code).toBe("UNAUTHENTICATED");
  });

  it("SEC-GH-10 a valid github_app_authorization revocation deletes the tokens and revokes the link", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    await linkUser(h, USER_B, { githubUserId: 2002, login: "bob", grant: appGrant(2) });
    const body = revokedPayload(1001);
    await h.gateways.githubAuth.handleWebhook(body, sign(body));
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    const rows = await h.database.sql.query<{ user_id: string }>("SELECT user_id::text AS user_id FROM github_tokens");
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([USER_B]));
    expect(h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason: "webhook" })}`)).toBe(1);
    // No audit row exists for webhook revocations (handleWebhook returns void): the metric and this line carry them.
    const lines = h.logs.filter((line) => line.level === "warn" && line.msg.includes("GitHub link revoked"));
    expect(lines.map((line) => line.msg)).toEqual([`GitHub link revoked for user ${USER_A} (reason webhook); stored tokens deleted`]);
    for (const line of h.logs) expect(line.msg).not.toMatch(/gh[pousr]_[A-Za-z0-9]/);
  });

  it("accepts the form-encoded delivery format over the exact raw bytes", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const body = Buffer.from(`payload=${encodeURIComponent(JSON.stringify({ action: "revoked", sender: { login: "alice", id: 1001 } }))}`);
    await h.gateways.githubAuth.handleWebhook(body, sign(body));
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
  });

  it("ignores signed events that are not revocations", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const body = Buffer.from(JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 }));
    await h.gateways.githubAuth.handleWebhook(body, sign(body));
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
  });

  it("other failures after a valid signature are ordinary errors (core answers 500), never UNAUTHENTICATED", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const oversize = Buffer.from(JSON.stringify({ action: "revoked", sender: { id: 1001 }, padding: "x".repeat(64 * 1024) }));
    const malformed = Buffer.from("{not json");
    for (const body of [oversize, malformed]) {
      const error = await h.gateways.githubAuth.handleWebhook(body, sign(body)).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ApiError);
    }
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
    expect(await count("github_tokens")).toBe(2);
  });

  it("a revocation for a GitHub id without an active link changes nothing and counts nothing", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001 });
    const body = revokedPayload(4242);
    await h.gateways.githubAuth.handleWebhook(body, sign(body));
    expect(await h.gateways.githubAuth.identityOf(USER_A)).not.toBeNull();
    expect(await count("github_tokens")).toBe(2);
    expect(h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason: "webhook" })}`)).toBeUndefined();
  });

  it("accepted fail-safe: a stale revoked webhook delivered after unlink and a quick re-link deletes the new tokens", async () => {
    await linkUser(h, USER_A, { githubUserId: 1001, grant: appGrant(1) });
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);
    await linkUser(h, USER_A, { githubUserId: 1001, grant: appGrant(2) });
    // GitHub's webhook for the unlink's grant revocation arrives late.
    const body = revokedPayload(1001);
    await h.gateways.githubAuth.handleWebhook(body, sign(body));
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(await count("github_tokens")).toBe(0);
    expect(h.metrics.counters.get(`github_link_revoked${JSON.stringify({ reason: "webhook" })}`)).toBe(1);
  });
});

describe("unlink (SEC-GH-10)", () => {
  const grantFailures = () => h.metrics.counters.get("github_grant_revoke_failed{}") ?? 0;
  const revokedMetrics = () => [...h.metrics.counters.keys()].filter((key) => key.startsWith("github_link_revoked"));

  it("revokes the whole grant at GitHub with client credentials first, then deletes link, tokens and states", async () => {
    await linkUser(h, USER_A, { grant: appGrant(7) });
    await h.gateways.githubAuth.start(sessionFor(USER_A));
    h.fetch.calls.length = 0;
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);
    const revoke = h.fetch.callsTo(GRANT_URL);
    expect(revoke).toHaveLength(1);
    expect(revoke[0]?.redirect).toBe("error");
    expect(revoke[0]?.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${testSecrets().github.clientSecret}`).toString("base64")}`);
    expect(JSON.parse(revoke[0]?.bodyText ?? "{}")).toEqual({ access_token: appGrant(7).access_token });
    // The grant, not just the one token: the token endpoint is not used.
    expect(h.fetch.callsTo(REVOKE_URL)).toHaveLength(0);
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
    expect(await count("github_oauth_states")).toBe(0);
    expect(grantFailures()).toBe(0);
    expect(revokedMetrics()).toEqual([]);
  });

  it("refreshes an expired access token first and revokes the grant with the fresh token", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.on("POST", TOKEN_URL, (call) =>
      new URLSearchParams(call.bodyText ?? "").get("refresh_token") === appGrant(1).refresh_token
        ? jsonResponse(200, appGrant(2))
        : jsonResponse(200, { error: "bad_refresh_token" }),
    );
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);
    expect(h.fetch.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${TOKEN_URL}`, `DELETE ${GRANT_URL}`]);
    expect(JSON.parse(h.fetch.callsTo(GRANT_URL)[0]?.bodyText ?? "{}")).toEqual({ access_token: appGrant(2).access_token });
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
    expect(grantFailures()).toBe(0);
  });

  it("a rejected refresh means the authorization is already unusable: no grant call, local rows deleted, nothing counted", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.clock.advance(9 * 3_600_000);
    h.fetch.calls.length = 0;
    h.fetch.json("POST", TOKEN_URL, 200, { error: "bad_refresh_token" });
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);
    expect(h.fetch.callsTo(GRANT_URL)).toHaveLength(0);
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
    expect(grantFailures()).toBe(0);
    // Unlinking is not a detected revocation.
    expect(revokedMetrics()).toEqual([]);
  });

  it("still deletes the local ciphertext when GitHub is unreachable, and logs and counts the failed revocation", async () => {
    await linkUser(h, USER_A);
    h.fetch.json("DELETE", GRANT_URL, 503, {});
    await h.gateways.githubAuth.unlink(USER_A);
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
    expect(grantFailures()).toBe(1);
    expect(h.logs.some((line) => line.level === "warn" && /grant revocation failed/.test(line.msg))).toBe(true);
  });

  it("a transient refresh failure counts a failed revocation and still deletes the local rows", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.clock.advance(9 * 3_600_000);
    h.fetch.json("POST", TOKEN_URL, 503, {});
    h.fetch.on("DELETE", GRANT_URL, () => new Response(null, { status: 204 }));
    await h.gateways.githubAuth.unlink(USER_A);
    expect(h.fetch.callsTo(GRANT_URL)).toHaveLength(0);
    expect(await count("github_tokens")).toBe(0);
    expect(await count("github_links")).toBe(0);
    expect(grantFailures()).toBe(1);
  });

  it("an already revoked or never linked user is unlinked without calling GitHub", async () => {
    await linkUser(h, USER_A);
    h.fetch.json("GET", `${API}/repos/kleros/pine`, 401, { message: "Bad credentials" });
    await h.gateways.github.getRepo(USER_A, "kleros", "pine").catch(() => undefined);
    h.fetch.calls.length = 0;
    await h.gateways.githubAuth.unlink(USER_A);
    await h.gateways.githubAuth.unlink(USER_B);
    expect(h.fetch.calls).toHaveLength(0);
    expect(await count("github_links")).toBe(0);
    expect(grantFailures()).toBe(0);
  });
});

describe("SEC-GH-08 no token reaches a log line", () => {
  it("the whole flow, revocations and failures log no gh*_ token", async () => {
    await linkUser(h, USER_A, { grant: appGrant(1) });
    h.fetch.json("GET", `${API}/repos/kleros/pine`, 401, { message: "Bad credentials" });
    await h.gateways.github.getRepo(USER_A, "kleros", "pine").catch(() => undefined);
    await linkUser(h, USER_A, { grant: appGrant(2) });
    h.fetch.on("DELETE", GRANT_URL, () => jsonResponse(500, {}));
    await h.gateways.githubAuth.unlink(USER_A);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line.msg).not.toMatch(/gh[pousr]_[A-Za-z0-9]/);
  });
});

describe("one GitHub id per Pine user under a concurrent link (SEC-AUTH-19)", () => {
  it("the partial-unique-index race inside complete() is CONFLICT, links nothing and stores no token", async () => {
    await insertUser(h.database, USER_A);
    await insertUser(h.database, USER_B);
    let raced = false;
    // USER_B's link of the same GitHub id commits between complete()'s holder check and its INSERT (staged through the
    // same transaction, which PGlite would otherwise serialise).
    const process2 = await h.sibling({
      db: interceptedDatabase(h.database.db, async (text, executor) => {
        if (raced || !/^insert into github_links/i.test(text.trim())) return;
        raced = true;
        await executor.execute(
          sql`INSERT INTO github_links (user_id, github_user_id, login, login_fetched_at, status, linked_at) VALUES (${USER_B}, 1001, 'bob', now(), 'active', now())`,
        );
      }),
    });
    const session = sessionFor(USER_A);
    const { authorizationUrl } = await process2.githubAuth.start(session);
    scriptExchange();
    const error = await rejection(process2.githubAuth.complete(session, { code: "abc123", state: new URL(authorizationUrl).searchParams.get("state") ?? "" }));
    expect(raced).toBe(true);
    expect(error.code).toBe("CONFLICT");
    expect(await h.gateways.githubAuth.identityOf(USER_A)).toBeNull();
    expect(await count("github_tokens")).toBe(0);
  });
});

describe("token endpoint and revocation responses are bounded and validated (SEC-GH-15)", () => {
  async function completeWith(answer: () => Response) {
    const { session, state } = await startFor(USER_A);
    h.fetch.on("POST", TOKEN_URL, answer);
    h.fetch.json("GET", `${API}/user`, 200, { id: 1001, login: "alice" }, { "x-oauth-scopes": "" });
    return rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }));
  }

  it("a token-endpoint body above 64 KiB (streamed, no Content-Length) is UPSTREAM_UNAVAILABLE and stores nothing", async () => {
    // A valid grant padded with an ignored field: only the byte cap can refuse it.
    const body = new TextEncoder().encode(JSON.stringify({ ...appGrant(1), padding: "x".repeat(1024 * 1024) }));
    expect((await completeWith(() => streamedResponse(body))).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(await count("github_links")).toBe(0);
    expect(await count("github_tokens")).toBe(0);
  });

  it("a token-endpoint success body that fails validation (token_type mac, access_token with a space) is UPSTREAM_UNAVAILABLE", async () => {
    for (const grant of [appGrant(1, { token_type: "mac" }), appGrant(1, { access_token: "ghu_with space0123456789abcdef" })]) {
      expect((await completeWith(() => jsonResponse(200, grant))).code).toBe("UPSTREAM_UNAVAILABLE");
    }
    expect(await count("github_links")).toBe(0);
    expect(await count("github_tokens")).toBe(0);
  });

  it("an oversize answer to the grant revocation is a failed revocation (counted), not an accepted 404", async () => {
    await linkUser(h, USER_A);
    const huge = new TextEncoder().encode(JSON.stringify({ message: "Not Found", padding: "x".repeat(1024 * 1024) }));
    h.fetch.on("DELETE", GRANT_URL, () => streamedResponse(huge, 16_384, 404));
    await h.gateways.githubAuth.unlink(USER_A);
    expect(h.metrics.counters.get("github_grant_revoke_failed{}")).toBe(1);
    expect(await count("github_tokens")).toBe(0);
  });

  it("an oversize answer to the token revocation after a scope refusal is logged as a failed revocation", async () => {
    const { session, state } = await startFor(USER_A);
    scriptExchange(appGrant(1, { scope: "repo" }));
    const huge = new TextEncoder().encode(JSON.stringify({ message: "Not Found", padding: "x".repeat(1024 * 1024) }));
    h.fetch.on("DELETE", REVOKE_URL, () => streamedResponse(huge, 16_384, 404));
    expect((await rejection(h.gateways.githubAuth.complete(session, { code: "abc123", state }))).code).toBe("FORBIDDEN");
    expect(h.logs.some((line) => line.level === "warn" && line.msg.startsWith("GitHub token revocation failed"))).toBe(true);
  });
});

describe("OAuth App fallback (SEC-GH-04)", () => {
  it("links when X-OAuth-Scopes is present and empty; the non-expiring token is used without the token endpoint", async () => {
    const oauth = await h.sibling({ secrets: testSecrets({ github: { kind: "oauth", clientId: CLIENT_ID, clientSecret: "client-secret-0123456789abcdef", webhookSecret: null } }) });
    await insertUser(h.database, USER_A);
    const { authorizationUrl } = await oauth.githubAuth.start(sessionFor(USER_A));
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    const token = "gho_0123456789abcdefghijklmnopqrstuvwxyz";
    h.fetch.json("POST", TOKEN_URL, 200, { access_token: token, token_type: "bearer", scope: "" });
    h.fetch.json("GET", `${API}/user`, 200, { id: 1001, login: "alice" }, { "x-oauth-scopes": "" });
    h.fetch.on("DELETE", REVOKE_URL, () => new Response(null, { status: 204 }));
    await expect(oauth.githubAuth.complete(sessionFor(USER_A), { code: "abc123", state })).resolves.toEqual({ githubUserId: 1001, login: "alice" });
    expect(await oauth.githubAuth.identityOf(USER_A)).toEqual({ githubUserId: 1001, login: "alice" });
    const rows = await h.database.sql.query<{ kind: string; expires_at: Date | null }>("SELECT kind, expires_at FROM github_tokens WHERE user_id = $1", [USER_A]);
    expect(rows).toEqual([{ kind: "access", expires_at: null }]);
    expect(h.fetch.callsTo(REVOKE_URL)).toHaveLength(0);

    h.fetch.calls.length = 0;
    h.clock.advance(30 * 86_400_000);
    h.fetch.on("GET", `${API}/repos/kleros/pine`, (call) =>
      call.headers.get("authorization") === `Bearer ${token}` ? jsonResponse(200, repoJson()) : jsonResponse(401, {}),
    );
    await expect(oauth.github.getRepo(USER_A, "kleros", "pine")).resolves.toMatchObject({ id: 4242 });
    expect(h.fetch.callsTo(TOKEN_URL)).toHaveLength(0);
  });
});
