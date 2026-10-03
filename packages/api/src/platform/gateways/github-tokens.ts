// Encrypted GitHub token storage, single-flight refresh and revocation (SEC-GH-06/07/09/10). Tokens are decrypted only
// here and handed to the GitHub gateway in memory; they are never returned to modules, logged or stored in plaintext.
//
// Revocation channel (PRD-02 2.4/3.1): an unusable token (GitHub 401, decrypt/AAD failure, rejected refresh) deletes the
// stored tokens, marks the link revoked (identityOf -> null), increments pine_github_link_revoked_total{reason}, logs a
// redacted line and surfaces as GitHubGatewayError("GITHUB_NOT_LINKED"), never UPSTREAM. Core audits it.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { GitHubGatewayError, type Clock, type Database, type Metrics } from "../../contracts/app.js";
import { DecryptError, type EncryptedSecret, type KeyRing } from "./crypto.js";
import { bytesColumn, epochMsText, execute, inTransaction, int8Text, queryRows, type Executor } from "./db.js";
import { GitHubUpstreamError, OAuthRejectedError, type GitHubClient, type TokenGrant } from "./github-client.js";
import type { GatewayLogger } from "./log.js";

export type RevocationReason = "unauthorized" | "decrypt_failed" | "refresh_rejected" | "webhook";
type TokenKind = "access" | "refresh";

/** Refresh this long before the recorded expiry so a token never expires in flight. */
const REFRESH_SKEW_MS = 60_000;

const tokenRow = z.object({
  kind: z.enum(["access", "refresh"]),
  key_id: z.string(),
  iv: bytesColumn,
  ciphertext: bytesColumn,
  expires_ms: epochMsText.nullable(),
});
type TokenRow = z.infer<typeof tokenRow>;

const notLinked = () => new GitHubGatewayError("GITHUB_NOT_LINKED", "GitHub account is not connected");

export interface TokenStore {
  /** A usable access token for the user (refreshed when expiring). Throws GITHUB_NOT_LINKED or UPSTREAM. */
  accessToken(userId: string): Promise<string>;
  /** Stores a fresh grant for a user whose link row exists (inside the caller's transaction). */
  writeGrant(tx: Executor, userId: string, grant: TokenGrant): Promise<void>;
  /** Unlink: a currently valid access token (refreshed first when expired) to revoke the grant with, or null when the
   *  authorization is already unusable (not linked, no token, undecryptable, refresh rejected). Never revokes the link
   *  or counts a revocation itself; throws UPSTREAM when a refresh fails transiently. */
  grantRevocationToken(userId: string): Promise<string | null>;
  /** Deletes the tokens and marks the link revoked; true when an active link was revoked by this call. */
  revoke(userId: string, reason: RevocationReason): Promise<boolean>;
  /** Revokes and throws GITHUB_NOT_LINKED. */
  revokeAndThrow(userId: string, reason: RevocationReason): Promise<never>;
  /** SEC-GH-07: re-encrypts rows under non-current keys; returns counts. */
  reencrypt(signal: AbortSignal, batchSize?: number): Promise<{ reencrypted: number; revoked: number; remaining: number }>;
}

export function createTokenStore(deps: {
  db: Database;
  clock: Clock;
  keyRing: KeyRing;
  client: GitHubClient;
  metrics: Metrics;
  log: GatewayLogger;
}): TokenStore {
  const { db, clock, keyRing, client, metrics, log } = deps;
  const inflight = new Map<string, Promise<string>>();

  const selectTokens = (executor: Executor, userId: string) =>
    queryRows(
      executor,
      sql`SELECT t.kind, t.key_id, t.iv, t.ciphertext,
                 CASE WHEN t.expires_at IS NULL THEN NULL ELSE (extract(epoch FROM t.expires_at) * 1000)::bigint::text END AS expires_ms
            FROM github_tokens t JOIN github_links l ON l.user_id = t.user_id
           WHERE t.user_id = ${userId} AND l.status = 'active'`,
      tokenRow,
    );

  const activeLink = async (executor: Executor, userId: string, lock: boolean): Promise<boolean> => {
    const rows = await queryRows(
      executor,
      lock
        ? sql`SELECT user_id::text AS user_id FROM github_links WHERE user_id = ${userId} AND status = 'active' FOR UPDATE`
        : sql`SELECT user_id::text AS user_id FROM github_links WHERE user_id = ${userId} AND status = 'active'`,
      z.object({ user_id: z.string() }),
    );
    return rows.length > 0;
  };

  const decrypt = (userId: string, row: TokenRow): string => {
    const secret: EncryptedSecret = { keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext };
    return keyRing.decrypt(userId, row.kind, secret);
  };

  const isFresh = (row: TokenRow) => row.expires_ms === null || row.expires_ms.getTime() - REFRESH_SKEW_MS > clock.now().getTime();

  async function revokeWith(executor: Executor, userId: string, reason: RevocationReason): Promise<boolean> {
    await execute(executor, sql`DELETE FROM github_tokens WHERE user_id = ${userId}`);
    const rows = await queryRows(
      executor,
      sql`UPDATE github_links SET status = 'revoked', revoked_reason = ${reason}, revoked_at = ${clock.now()}
           WHERE user_id = ${userId} AND status = 'active' RETURNING user_id::text AS user_id`,
      z.object({ user_id: z.string() }),
    );
    return rows.length > 0;
  }

  function reportRevocation(userId: string, reason: RevocationReason): void {
    metrics.increment("github_link_revoked", { reason });
    log.warn(`GitHub link revoked for user ${userId} (reason ${reason}); stored tokens deleted`);
  }

  async function revoke(userId: string, reason: RevocationReason): Promise<boolean> {
    const changed = await inTransaction(db, (tx) => revokeWith(tx, userId, reason));
    if (changed) reportRevocation(userId, reason);
    return changed;
  }

  async function revokeAndThrow(userId: string, reason: RevocationReason): Promise<never> {
    await revoke(userId, reason);
    throw notLinked();
  }

  async function writeGrant(tx: Executor, userId: string, grant: TokenGrant): Promise<void> {
    const now = clock.now();
    const put = async (kind: TokenKind, token: string, expiresAt: Date | null) => {
      const secret = keyRing.encrypt(userId, kind, token);
      await execute(
        tx,
        sql`INSERT INTO github_tokens (user_id, kind, key_id, iv, ciphertext, expires_at, updated_at)
            VALUES (${userId}, ${kind}, ${secret.keyId}, ${Buffer.from(secret.iv)}, ${Buffer.from(secret.ciphertext)}, ${expiresAt}, ${now})
            ON CONFLICT (user_id, kind) DO UPDATE SET key_id = EXCLUDED.key_id, iv = EXCLUDED.iv, ciphertext = EXCLUDED.ciphertext,
              expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
      );
    };
    await put("access", grant.accessToken, grant.accessExpiresAt);
    if (grant.refreshToken !== null) await put("refresh", grant.refreshToken, grant.refreshExpiresAt);
    else await execute(tx, sql`DELETE FROM github_tokens WHERE user_id = ${userId} AND kind = 'refresh'`);
  }

  type RefreshOutcome = { kind: "token"; token: string } | { kind: "revoke"; reason: RevocationReason } | { kind: "not_linked" };

  /** SEC-GH-09: the link row lock makes refresh single-flight across processes; the new refresh token is persisted
   *  (committed) before the new access token is used. */
  function refreshLocked(userId: string): Promise<RefreshOutcome> {
    return inTransaction(db, async (tx): Promise<RefreshOutcome> => {
      if (!(await activeLink(tx, userId, true))) return { kind: "not_linked" };
      const rows = await selectTokens(tx, userId);
      const access = rows.find((row) => row.kind === "access");
      const refresh = rows.find((row) => row.kind === "refresh");
      if (access && isFresh(access)) {
        // Another request or process refreshed while this one waited for the lock.
        try {
          return { kind: "token", token: decrypt(userId, access) };
        } catch (error) {
          if (error instanceof DecryptError) return { kind: "revoke", reason: "decrypt_failed" };
          throw error;
        }
      }
      if (!refresh || (refresh.expires_ms !== null && refresh.expires_ms.getTime() <= clock.now().getTime())) {
        return { kind: "revoke", reason: "refresh_rejected" };
      }
      let refreshToken: string;
      try {
        refreshToken = decrypt(userId, refresh);
      } catch (error) {
        if (error instanceof DecryptError) return { kind: "revoke", reason: "decrypt_failed" };
        throw error;
      }
      let grant: TokenGrant;
      try {
        grant = await client.refresh(refreshToken, clock.now());
      } catch (error) {
        if (error instanceof OAuthRejectedError && error.oauthError === "bad_refresh_token") return { kind: "revoke", reason: "refresh_rejected" };
        if (error instanceof OAuthRejectedError || error instanceof GitHubUpstreamError) {
          throw new GitHubGatewayError("UPSTREAM", `GitHub token refresh failed: ${error.message}`);
        }
        throw error;
      }
      await writeGrant(tx, userId, grant);
      return { kind: "token", token: grant.accessToken };
    });
  }

  /** A usable access token, or why there is none. Throws only for transient failures (UPSTREAM). */
  async function resolveAccessToken(userId: string): Promise<RefreshOutcome> {
    if (!(await activeLink(db, userId, false))) return { kind: "not_linked" };
    const rows = await selectTokens(db, userId);
    const access = rows.find((row) => row.kind === "access");
    if (!access) return { kind: "revoke", reason: "decrypt_failed" };
    if (isFresh(access)) {
      try {
        return { kind: "token", token: decrypt(userId, access) };
      } catch (error) {
        if (error instanceof DecryptError) return { kind: "revoke", reason: "decrypt_failed" };
        throw error;
      }
    }
    return refreshLocked(userId);
  }

  async function loadAccessToken(userId: string): Promise<string> {
    const outcome = await resolveAccessToken(userId);
    if (outcome.kind === "token") return outcome.token;
    if (outcome.kind === "not_linked") throw notLinked();
    return revokeAndThrow(userId, outcome.reason);
  }

  return {
    accessToken(userId) {
      const existing = inflight.get(userId);
      if (existing) return existing;
      const pending = loadAccessToken(userId).finally(() => inflight.delete(userId));
      inflight.set(userId, pending);
      return pending;
    },
    writeGrant,
    async grantRevocationToken(userId) {
      const outcome = await resolveAccessToken(userId);
      return outcome.kind === "token" ? outcome.token : null;
    },
    revoke,
    revokeAndThrow,
    async reencrypt(signal, batchSize = 100) {
      let reencrypted = 0;
      let revoked = 0;
      const skipped = new Set<string>();
      for (let round = 0; round < 50 && !signal.aborted; round += 1) {
        const rows = await queryRows(
          db,
          sql`SELECT user_id::text AS user_id, kind, key_id, iv, ciphertext FROM github_tokens
               WHERE key_id <> ${keyRing.currentKeyId} ORDER BY user_id, kind LIMIT ${batchSize}`,
          z.object({ user_id: z.string(), kind: z.enum(["access", "refresh"]), key_id: z.string(), iv: bytesColumn, ciphertext: bytesColumn }),
        );
        const pending = rows.filter((row) => !skipped.has(`${row.user_id}:${row.kind}`));
        if (pending.length === 0) break;
        for (const row of pending) {
          if (signal.aborted) break;
          let plaintext: string;
          try {
            plaintext = keyRing.decrypt(row.user_id, row.kind, { keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext });
          } catch (error) {
            if (!(error instanceof DecryptError)) throw error;
            skipped.add(`${row.user_id}:${row.kind}`);
            if (await revoke(row.user_id, "decrypt_failed")) revoked += 1;
            continue;
          }
          const secret = keyRing.encrypt(row.user_id, row.kind, plaintext);
          // Compare-and-set on the old ciphertext: a concurrent refresh that rewrote the row wins.
          const updated = await queryRows(
            db,
            sql`UPDATE github_tokens SET key_id = ${secret.keyId}, iv = ${Buffer.from(secret.iv)}, ciphertext = ${Buffer.from(secret.ciphertext)}
                 WHERE user_id = ${row.user_id} AND kind = ${row.kind} AND key_id = ${row.key_id} AND iv = ${Buffer.from(row.iv)}
                 RETURNING user_id::text AS user_id`,
            z.object({ user_id: z.string() }),
          );
          if (updated.length > 0) reencrypted += 1;
          else skipped.add(`${row.user_id}:${row.kind}`);
        }
      }
      const remainingRows = await queryRows(
        db,
        sql`SELECT count(*)::text AS remaining FROM github_tokens WHERE key_id <> ${keyRing.currentKeyId}`,
        z.object({ remaining: int8Text }),
      );
      const remaining = remainingRows[0]?.remaining ?? 0;
      log.info(`GitHub token re-encryption: ${reencrypted} re-encrypted, ${revoked} revoked (undecryptable), ${remaining} remain under retired keys`);
      return { reencrypted, revoked, remaining };
    },
  };
}
