// Server-side sessions (SEC-AUTH-09..13): opaque `pine_s1_` + base64url(32 random bytes) tokens, stored only as
// SHA-256 hex; idle 24 h (touched at most every 5 minutes), absolute 7 days; rotation copies authenticatedAt and the
// absolute expiry (a GitHub link never refreshes the admin step-up window or extends the session lifetime).

import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import type { Address, Hex32 } from "@pine/shared/types";
import { iso, queryOne, queryRows, toDate, type Executor } from "./db.js";

export const SESSION_COOKIE = "__Host-pine_session";
export const PRESESSION_COOKIE = "__Host-pine_presession";
export const SESSION_IDLE_MS = 24 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3_600_000;
export const SESSION_TOUCH_MS = 5 * 60_000;

const SESSION_TOKEN = /^pine_s1_[A-Za-z0-9_-]{43}$/;
const PRESESSION_TOKEN = /^pine_ps1_[A-Za-z0-9_-]{43}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function newSessionToken(): string {
  return `pine_s1_${randomBytes(32).toString("base64url")}`;
}

export function newPresessionToken(): string {
  return `pine_ps1_${randomBytes(32).toString("base64url")}`;
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === "string" && SESSION_TOKEN.test(value);
}

export function isPresessionToken(value: unknown): value is string {
  return typeof value === "string" && PRESESSION_TOKEN.test(value);
}

export interface SessionRow {
  sessionId: string;
  userId: string;
  wallet: Address;
  termsDigest: Hex32;
  authenticatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

interface RawSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  wallet_address: string;
  terms_digest: string;
  authenticated_at: unknown;
  idle_expires_at: unknown;
  absolute_expires_at: unknown;
}

function fromRow(row: RawSessionRow): SessionRow {
  return {
    sessionId: row.id,
    userId: row.user_id,
    wallet: row.wallet_address as Address,
    termsDigest: row.terms_digest as Hex32,
    authenticatedAt: toDate(row.authenticated_at),
    idleExpiresAt: toDate(row.idle_expires_at),
    absoluteExpiresAt: toDate(row.absolute_expires_at),
  };
}

export async function createSession(
  db: Executor,
  input: { userId: string; wallet: Address; termsDigest: string; authenticatedAt: Date; now: Date },
): Promise<{ token: string; session: SessionRow }> {
  const token = newSessionToken();
  const absolute = new Date(input.now.getTime() + SESSION_ABSOLUTE_MS);
  const idle = new Date(Math.min(input.now.getTime() + SESSION_IDLE_MS, absolute.getTime()));
  const row = await queryOne<RawSessionRow>(
    db,
    sql`INSERT INTO sessions (token_hash, user_id, wallet_address, terms_digest, authenticated_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES (${sha256Hex(token)}, ${input.userId}::uuid, ${input.wallet.toLowerCase()}, ${input.termsDigest}, ${iso(input.authenticatedAt)}::timestamptz,
                ${iso(input.now)}::timestamptz, ${iso(input.now)}::timestamptz, ${iso(idle)}::timestamptz, ${iso(absolute)}::timestamptz)
        RETURNING id::text AS id, user_id::text AS user_id, wallet_address, terms_digest, authenticated_at, idle_expires_at, absolute_expires_at`,
  );
  if (!row) throw new Error("session insert returned no row");
  return { token, session: fromRow(row) };
}

/**
 * Looks a token up and touches the idle expiry (at most once per 5 minutes) in ONE statement. Valid iff
 * now < idle_expires_at and now < absolute_expires_at.
 */
export async function lookupSession(db: Executor, token: string, now: Date): Promise<SessionRow | null> {
  if (!isSessionToken(token)) return null;
  const nowIso = iso(now);
  const row = await queryOne<RawSessionRow>(
    db,
    sql`WITH found AS (
          SELECT * FROM sessions
          WHERE token_hash = ${sha256Hex(token)} AND idle_expires_at > ${nowIso}::timestamptz AND absolute_expires_at > ${nowIso}::timestamptz
        ), touched AS (
          UPDATE sessions
          SET last_seen_at = ${nowIso}::timestamptz,
              idle_expires_at = least(${nowIso}::timestamptz + make_interval(secs => ${SESSION_IDLE_MS / 1000}), sessions.absolute_expires_at)
          FROM found
          WHERE sessions.id = found.id AND found.last_seen_at <= ${nowIso}::timestamptz - make_interval(secs => ${SESSION_TOUCH_MS / 1000})
          RETURNING sessions.id, sessions.idle_expires_at
        )
        SELECT found.id::text AS id, found.user_id::text AS user_id, found.wallet_address, found.terms_digest, found.authenticated_at,
               coalesce(touched.idle_expires_at, found.idle_expires_at) AS idle_expires_at, found.absolute_expires_at
        FROM found LEFT JOIN touched ON touched.id = found.id`,
  );
  return row ? fromRow(row) : null;
}

/**
 * Replaces a session with a fresh token in ONE statement (SEC-AUTH-11). authenticatedAt and the absolute expiry are
 * copied from the old row. Returns null when the old session no longer exists or has expired.
 */
export async function rotateSession(db: Executor, sessionId: string, now: Date): Promise<{ token: string; session: SessionRow } | null> {
  const token = newSessionToken();
  const nowIso = iso(now);
  const row = await queryOne<RawSessionRow>(
    db,
    sql`WITH old AS (
          DELETE FROM sessions WHERE id = ${sessionId}::uuid RETURNING *
        )
        INSERT INTO sessions (token_hash, user_id, wallet_address, terms_digest, authenticated_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        SELECT ${sha256Hex(token)}, user_id, wallet_address, terms_digest, authenticated_at, ${nowIso}::timestamptz, ${nowIso}::timestamptz,
               least(${nowIso}::timestamptz + make_interval(secs => ${SESSION_IDLE_MS / 1000}), absolute_expires_at), absolute_expires_at
        FROM old
        WHERE old.absolute_expires_at > ${nowIso}::timestamptz AND old.idle_expires_at > ${nowIso}::timestamptz
        RETURNING id::text AS id, user_id::text AS user_id, wallet_address, terms_digest, authenticated_at, idle_expires_at, absolute_expires_at`,
  );
  return row ? { token, session: fromRow(row) } : null;
}

export async function deleteSession(db: Executor, sessionId: string): Promise<void> {
  await queryRows(db, sql`DELETE FROM sessions WHERE id = ${sessionId}::uuid RETURNING id`);
}

export async function deleteUserSessions(db: Executor, userId: string): Promise<number> {
  const rows = await queryRows(db, sql`DELETE FROM sessions WHERE user_id = ${userId}::uuid RETURNING id`);
  return rows.length;
}

export function setSessionCookie(reply: FastifyReply, token: string, session: Pick<SessionRow, "absoluteExpiresAt">, now: Date): void {
  const maxAge = Math.max(1, Math.floor((session.absoluteExpiresAt.getTime() - now.getTime()) / 1000));
  void reply.setCookie(SESSION_COOKIE, token, { path: "/", secure: true, httpOnly: true, sameSite: "lax", maxAge });
}

export function clearSessionCookie(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
}
