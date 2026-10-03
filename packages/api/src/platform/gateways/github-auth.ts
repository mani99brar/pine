// GitHub account linking (SEC-AUTH-18/19, SEC-GH-03..06/10): authorization-code flow with PKCE S256 and a 128-bit state
// stored hashed, bound to the session and user, single use and valid 10 minutes; one GitHub id <-> one Pine user;
// tokens stored only encrypted; revocation through unlink and the HMAC-verified github_app_authorization webhook.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { GitHubGatewayError, type Clock, type Database, type Metrics, type SessionInfo } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import type { GitHubAuthFlow, GitHubIdentity, PlatformSecrets } from "../../contracts/platform.js";
import { DecryptError, type KeyRing } from "./crypto.js";
import { bytesColumn, execute, inTransaction, int8Text, queryRows, sqlState } from "./db.js";
import { GITHUB_AUTHORIZE_URL, GitHubUpstreamError, OAuthRejectedError, type GitHubClient, type TokenGrant } from "./github-client.js";
import type { TokenStore } from "./github-tokens.js";
import { githubUserSchema } from "./github-schemas.js";
import type { GatewayLogger } from "./log.js";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Outstanding authorization requests kept per session; older ones are discarded on start(). */
const MAX_STATES_PER_SESSION = 5;
const WEBHOOK_MAX_BYTES = 64 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

const completeInput = z.object({
  code: z.string().min(1).max(512).regex(/^[A-Za-z0-9_.-]+$/),
  // 16 random bytes as base64url without padding.
  state: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
});

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const webhookPayload = z.object({
  action: z.string().max(64),
  sender: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).optional(),
});

export function createGitHubAuthFlow(deps: {
  db: Database;
  clock: Clock;
  keyRing: KeyRing;
  client: GitHubClient;
  tokens: TokenStore;
  github: PlatformSecrets["github"];
  redirectUri: string;
  metrics: Metrics;
  log: GatewayLogger;
}): GitHubAuthFlow & { purgeExpiredStates(batchSize?: number): Promise<number> } {
  const { db, clock, keyRing, client, tokens, github, redirectUri, metrics, log } = deps;

  const fail = (message: string) => new ApiError("BAD_REQUEST", message);

  /** Exchanges the code and reads the identity; on scope violations the token is revoked at GitHub first. */
  async function obtainIdentity(code: string, codeVerifier: string): Promise<{ grant: TokenGrant; identity: GitHubIdentity }> {
    let grant: TokenGrant;
    try {
      grant = await client.exchangeCode({ code, codeVerifier, redirectUri }, clock.now());
    } catch (error) {
      if (error instanceof OAuthRejectedError) throw fail("GitHub authorization failed");
      if (error instanceof GitHubUpstreamError) throw new ApiError("UPSTREAM_UNAVAILABLE", "GitHub is unavailable");
      throw error;
    }
    let response;
    try {
      response = await client.get(grant.accessToken, "/user");
    } catch (error) {
      if (error instanceof GitHubUpstreamError) throw new ApiError("UPSTREAM_UNAVAILABLE", "GitHub is unavailable");
      throw error;
    }
    if (response.status !== 200) {
      await revokeAtGitHub(grant.accessToken);
      throw new ApiError("UPSTREAM_UNAVAILABLE", "GitHub identity lookup failed");
    }
    // SEC-GH-04: the OAuth App must hold no scopes. The header is mandatory for OAuth tokens (fail closed when absent);
    // a GitHub App user token never carries scopes, so a non-empty header there is rejected as well.
    const scopesHeader = response.headers.get("x-oauth-scopes");
    const scopes = [grant.scope, scopesHeader ?? ""].map((value) => value.trim()).filter((value) => value.length > 0);
    if (scopes.length > 0 || (github.kind === "oauth" && scopesHeader === null)) {
      await revokeAtGitHub(grant.accessToken);
      throw new ApiError("FORBIDDEN", "GitHub authorization carried unexpected scopes");
    }
    const user = githubUserSchema.safeParse(response.json);
    if (!user.success) {
      await revokeAtGitHub(grant.accessToken);
      throw new ApiError("UPSTREAM_UNAVAILABLE", "GitHub returned an unexpected identity");
    }
    return { grant, identity: { githubUserId: user.data.id, login: user.data.login } };
  }

  async function revokeAtGitHub(accessToken: string): Promise<boolean> {
    try {
      await client.revokeToken(accessToken);
      return true;
    } catch (error) {
      log.warn(`GitHub token revocation failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return false;
    }
  }

  return {
    async start(session: SessionInfo) {
      if (!isUuid(session.userId) || session.sessionId.length === 0 || session.sessionId.length > 128) throw fail("Invalid session");
      const state = base64url(randomBytes(16));
      const codeVerifier = base64url(randomBytes(32));
      const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
      const now = clock.now();
      const verifier = keyRing.encrypt(session.userId, "pkce_verifier", codeVerifier);
      await inTransaction(db, async (tx) => {
        await execute(tx, sql`DELETE FROM github_oauth_states WHERE session_id = ${session.sessionId} AND expires_at <= ${now}`);
        await execute(
          tx,
          sql`DELETE FROM github_oauth_states WHERE state_hash IN (
                SELECT state_hash FROM github_oauth_states WHERE session_id = ${session.sessionId}
                 ORDER BY created_at DESC OFFSET ${MAX_STATES_PER_SESSION - 1})`,
        );
        await execute(
          tx,
          sql`INSERT INTO github_oauth_states (state_hash, session_id, user_id, verifier_key_id, verifier_iv, verifier_ciphertext, created_at, expires_at)
              VALUES (${sha256Hex(state)}, ${session.sessionId}, ${session.userId}, ${verifier.keyId}, ${Buffer.from(verifier.iv)},
                      ${Buffer.from(verifier.ciphertext)}, ${now}, ${new Date(now.getTime() + OAUTH_STATE_TTL_MS)})`,
        );
      });
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", github.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("allow_signup", "false");
      if (github.kind === "oauth") url.searchParams.set("scope", "");
      return { authorizationUrl: url.toString() };
    },

    async complete(session, input) {
      const parsed = completeInput.safeParse(input);
      if (!parsed.success) throw fail("Invalid GitHub authorization response");
      const now = clock.now();
      // Single use: the state row is deleted whoever presents it, before any other check.
      const consumed = await queryRows(
        db,
        sql`DELETE FROM github_oauth_states WHERE state_hash = ${sha256Hex(parsed.data.state)}
            RETURNING session_id, user_id::text AS user_id, verifier_key_id, verifier_iv, verifier_ciphertext,
                      (expires_at > ${now}) AS live`,
        z.object({ session_id: z.string(), user_id: z.string(), verifier_key_id: z.string(), verifier_iv: bytesColumn, verifier_ciphertext: bytesColumn, live: z.boolean() }),
      );
      const row = consumed[0];
      if (!row || !row.live || row.session_id !== session.sessionId || row.user_id !== session.userId.toLowerCase()) {
        throw fail("GitHub authorization state is invalid or expired");
      }
      let codeVerifier: string;
      try {
        codeVerifier = keyRing.decrypt(session.userId, "pkce_verifier", { keyId: row.verifier_key_id, iv: row.verifier_iv, ciphertext: row.verifier_ciphertext });
      } catch (error) {
        if (error instanceof DecryptError) throw fail("GitHub authorization state is invalid or expired");
        throw error;
      }
      const { grant, identity } = await obtainIdentity(parsed.data.code, codeVerifier);
      const userId = session.userId.toLowerCase();
      const linkedAt = clock.now();
      const outcome = await inTransaction(db, async (tx) => {
        const holders = await queryRows(
          tx,
          sql`SELECT user_id::text AS user_id FROM github_links
               WHERE github_user_id = ${identity.githubUserId} AND status <> 'revoked' AND user_id <> ${userId} FOR UPDATE`,
          z.object({ user_id: z.string() }),
        );
        if (holders.length > 0) return "conflict" as const;
        // A revoked link of another user for this GitHub id is replaced (it no longer counts as a link).
        await execute(tx, sql`DELETE FROM github_links WHERE github_user_id = ${identity.githubUserId} AND status = 'revoked' AND user_id <> ${userId}`);
        await execute(
          tx,
          sql`INSERT INTO github_links (user_id, github_user_id, login, login_fetched_at, status, revoked_reason, linked_at, revoked_at)
              VALUES (${userId}, ${identity.githubUserId}, ${identity.login}, ${linkedAt}, 'active', NULL, ${linkedAt}, NULL)
              ON CONFLICT (user_id) DO UPDATE SET github_user_id = EXCLUDED.github_user_id, login = EXCLUDED.login,
                login_fetched_at = EXCLUDED.login_fetched_at, status = 'active', revoked_reason = NULL,
                linked_at = EXCLUDED.linked_at, revoked_at = NULL`,
        );
        await execute(tx, sql`DELETE FROM github_tokens WHERE user_id = ${userId}`);
        await tokens.writeGrant(tx, userId, grant);
        return "linked" as const;
      }).catch((error: unknown) => {
        // Unique-index race with a concurrent link of the same GitHub id by another user.
        if (sqlState(error) === "23505") return "conflict" as const;
        throw error;
      });
      if (outcome === "conflict") {
        throw new ApiError("CONFLICT", "This GitHub account is linked to another Pine account");
      }
      log.info(`GitHub account ${identity.githubUserId} linked to user ${userId}`);
      return identity;
    },

    async unlink(userId) {
      if (!isUuid(userId)) return;
      // SEC-GH-10: revoke the whole authorization at GitHub first (every token GitHub issued to this user for the app),
      // with a currently valid access token. null: nothing usable is stored (a rejected refresh means the authorization is
      // already unusable). The local rows are deleted regardless; a failed revocation is logged and counted.
      let token: string | null = null;
      let failure: string | null = null;
      try {
        token = await tokens.grantRevocationToken(userId);
      } catch (error) {
        failure = error instanceof GitHubGatewayError ? error.message : "token unavailable";
      }
      if (token !== null) {
        try {
          await client.revokeGrant(token);
        } catch (error) {
          failure = error instanceof GitHubUpstreamError ? error.message : "unexpected error";
        }
      }
      if (failure !== null) {
        metrics.increment("github_grant_revoke_failed");
        log.warn(`GitHub grant revocation failed for user ${userId}: ${failure}; local tokens deleted anyway`);
      }
      await inTransaction(db, async (tx) => {
        await execute(tx, sql`DELETE FROM github_tokens WHERE user_id = ${userId}`);
        await execute(tx, sql`DELETE FROM github_links WHERE user_id = ${userId}`);
        await execute(tx, sql`DELETE FROM github_oauth_states WHERE user_id = ${userId}`);
      });
      log.info(`GitHub account unlinked from user ${userId}`);
    },

    async identityOf(userId) {
      if (!isUuid(userId)) return null;
      const rows = await queryRows(
        db,
        sql`SELECT github_user_id::text AS github_user_id, login FROM github_links WHERE user_id = ${userId} AND status = 'active'`,
        z.object({ github_user_id: int8Text, login: z.string() }),
      );
      const row = rows[0];
      return row ? { githubUserId: row.github_user_id, login: row.login } : null;
    },

    async handleWebhook(rawBody, signatureHeader) {
      const secret = github.webhookSecret;
      if (secret === null || secret.length === 0) throw new ApiError("UNAUTHENTICATED", "Webhook signature invalid");
      const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader ?? "");
      if (!match?.[1]) throw new ApiError("UNAUTHENTICATED", "Webhook signature invalid");
      const expected = createHmac("sha256", secret).update(rawBody).digest();
      const presented = Buffer.from(match[1], "hex");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new ApiError("UNAUTHENTICATED", "Webhook signature invalid");
      }
      if (rawBody.byteLength > WEBHOOK_MAX_BYTES) throw new Error("Webhook body exceeds 64 KiB");
      const payload = webhookPayload.safeParse(parseWebhookBody(rawBody));
      // github_app_authorization has exactly one action, "revoked", sent by the user who revoked the app.
      if (!payload.success || payload.data.action !== "revoked" || payload.data.sender === undefined) return;
      const githubUserId = payload.data.sender.id;
      const users = await queryRows(
        db,
        sql`SELECT user_id::text AS user_id FROM github_links WHERE github_user_id = ${githubUserId} AND status = 'active'`,
        z.object({ user_id: z.string() }),
      );
      for (const user of users) await tokens.revoke(user.user_id, "webhook");
    },

    async purgeExpiredStates(batchSize = 500) {
      const rows = await queryRows(
        db,
        sql`DELETE FROM github_oauth_states WHERE state_hash IN (
              SELECT state_hash FROM github_oauth_states WHERE expires_at <= ${clock.now()} ORDER BY expires_at LIMIT ${batchSize})
            RETURNING state_hash`,
        z.object({ state_hash: z.string() }),
      );
      return rows.length;
    },
  };
}

/** Webhook bodies arrive as JSON or as `payload=<urlencoded JSON>` (form content type). */
function parseWebhookBody(rawBody: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
  const payload = new URLSearchParams(text).get("payload");
  if (payload === null) throw new Error("Webhook body is neither JSON nor a form payload");
  return JSON.parse(payload) as unknown;
}
