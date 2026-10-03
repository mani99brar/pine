// Sign-In with Ethereum (SEC-AUTH-01..08). The server issues the exact EIP-4361 message, keyed by a 128-bit
// crypto.randomBytes nonce bound to a pre-session cookie (at most 5 outstanding, 10 minutes, single use). Verification
// consumes the nonce atomically, requires the signed text to be byte-identical to the stored one, re-checks every field
// explicitly and recovers the EOA signer locally (no RPC; contract wallets cannot sign in).

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getAddress, recoverMessageAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import type { Address } from "@pine/shared/types";
import type { Database } from "../../contracts/app.js";
import { iso, queryOne, queryRows, toDate, type Executor } from "./db.js";
import { createSession, isPresessionToken, newPresessionToken, sha256Hex, type SessionRow } from "./sessions.js";

export const SIWE_TTL_MS = 10 * 60_000;
export const PRESESSION_TTL_MS = 10 * 60_000;
export const MAX_OUTSTANDING_NONCES = 5;
export const ISSUED_AT_SKEW_MS = 5 * 60_000;

/** 128-bit nonce from node:crypto, lowercase hex (SEC-AUTH-02). */
export function newSiweNonce(): string {
  return randomBytes(16).toString("hex");
}

export function termsStatement(termsDigest: string): string {
  return `Sign in to Pine. I accept the terms with sha256 ${termsDigest}.`;
}

export interface SiweSettings {
  publicOrigin: string;
  chainId: number;
  termsDigest: string;
}

/** Why a verification failed (server-side only; clients always see one generic UNAUTHENTICATED). */
export type SiweFailureReason =
  | "malformed_message"
  | "malformed_signature"
  | "no_presession"
  | "unknown_nonce"
  | "foreign_presession"
  | "expired"
  | "message_mismatch"
  | "field_mismatch"
  | "signature_mismatch";

export class SiweFailure extends Error {
  constructor(
    readonly reason: SiweFailureReason,
    readonly address: Address | null = null,
  ) {
    super(`SIWE verification failed: ${reason}`);
    this.name = "SiweFailure";
  }
}

export interface ChallengeResult {
  message: string;
  nonce: string;
  expiresAt: Date;
  /** Set when a new pre-session was created (the caller sets the cookie). */
  presessionToken: string | null;
}

/**
 * Issues a challenge. Reuses a valid pre-session from the cookie, otherwise creates one. Writes at most one
 * pre-session and one nonce row; evicts the oldest outstanding nonces so at most 5 remain per pre-session.
 */
export async function issueChallenge(db: Database, settings: SiweSettings, input: { address: Address; presessionCookie: string | undefined; now: Date }): Promise<ChallengeResult> {
  const now = input.now;
  const expiresAt = new Date(now.getTime() + SIWE_TTL_MS);
  const nonce = newSiweNonce();
  const message = createSiweMessage({
    domain: new URL(settings.publicOrigin).host,
    address: getAddress(input.address),
    statement: termsStatement(settings.termsDigest),
    uri: settings.publicOrigin,
    version: "1",
    chainId: settings.chainId,
    nonce,
    issuedAt: now,
    expirationTime: expiresAt,
  });

  return db.transaction(async (tx) => {
    let presessionId: string | null = null;
    let presessionToken: string | null = null;
    if (isPresessionToken(input.presessionCookie)) {
      const existing = await queryOne<{ id: string }>(
        tx,
        sql`UPDATE siwe_presessions SET expires_at = ${iso(new Date(now.getTime() + PRESESSION_TTL_MS))}::timestamptz
            WHERE token_hash = ${sha256Hex(input.presessionCookie)} AND expires_at > ${iso(now)}::timestamptz
            RETURNING id::text AS id`,
      );
      presessionId = existing?.id ?? null;
    }
    if (presessionId === null) {
      presessionToken = newPresessionToken();
      const created = await queryOne<{ id: string }>(
        tx,
        sql`INSERT INTO siwe_presessions (token_hash, created_at, expires_at)
            VALUES (${sha256Hex(presessionToken)}, ${iso(now)}::timestamptz, ${iso(new Date(now.getTime() + PRESESSION_TTL_MS))}::timestamptz)
            RETURNING id::text AS id`,
      );
      if (!created) throw new Error("pre-session insert returned no row");
      presessionId = created.id;
    }
    // The UPDATE above (or the fresh INSERT) holds the pre-session row lock, so concurrent challenges serialise here.
    await queryRows(
      tx,
      sql`DELETE FROM siwe_nonces WHERE nonce IN (
            SELECT nonce FROM siwe_nonces WHERE presession_id = ${presessionId}::uuid
            ORDER BY seq DESC OFFSET ${MAX_OUTSTANDING_NONCES - 1}
          ) RETURNING nonce`,
    );
    await queryRows(
      tx,
      sql`INSERT INTO siwe_nonces (nonce, presession_id, address, message, created_at, expires_at)
          VALUES (${nonce}, ${presessionId}::uuid, ${input.address.toLowerCase()}, ${message}, ${iso(now)}::timestamptz, ${iso(expiresAt)}::timestamptz)
          RETURNING nonce`,
    );
    return { message, nonce, expiresAt, presessionToken };
  });
}

/** Extracts the nonce line of a candidate message without trusting anything else in it. */
export function nonceOf(message: string): string | null {
  const match = /^Nonce: ([0-9a-f]{32})$/m.exec(message);
  return match?.[1] ?? null;
}

/** The challenged address of an outstanding nonce (for the per-address rate limit), or null. */
export async function challengedAddress(db: Executor, nonce: string): Promise<Address | null> {
  const row = await queryOne<{ address: string }>(db, sql`SELECT address FROM siwe_nonces WHERE nonce = ${nonce}`);
  return row ? (row.address as Address) : null;
}

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** Explicit EIP-4361 field checks on the stored message (SEC-AUTH-04), defence in depth on top of byte equality. */
export function checkSiweFields(message: string, settings: SiweSettings, expected: { address: string; nonce: string }, now: Date): boolean {
  const parsed = parseSiweMessage(message);
  const origin = new URL(settings.publicOrigin);
  if (!origin.host || parsed.domain !== origin.host) return false;
  if (parsed.uri !== settings.publicOrigin && !(parsed.uri ?? "").startsWith(`${settings.publicOrigin}/`)) return false;
  if (parsed.version !== "1") return false;
  if (parsed.chainId !== settings.chainId) return false;
  if (parsed.nonce !== expected.nonce) return false;
  if (!parsed.address || parsed.address.toLowerCase() !== expected.address) return false;
  if (parsed.statement !== termsStatement(settings.termsDigest)) return false;
  if (!parsed.issuedAt || Math.abs(parsed.issuedAt.getTime() - now.getTime()) > ISSUED_AT_SKEW_MS) return false;
  if (!parsed.expirationTime) return false;
  if (parsed.expirationTime.getTime() > parsed.issuedAt.getTime() + SIWE_TTL_MS) return false;
  if (now.getTime() >= parsed.expirationTime.getTime()) return false;
  if (parsed.notBefore && parsed.notBefore.getTime() > now.getTime()) return false;
  return true;
}

export interface VerifyResult {
  token: string;
  session: SessionRow;
  userId: string;
  address: Address;
}

/**
 * Verifies a signed challenge and creates a session. Throws SiweFailure (with a server-side reason) on every failure.
 * The nonce is consumed (deleted) on the first attempt from its own pre-session, whatever the outcome.
 */
export async function verifyChallenge(
  db: Database,
  settings: SiweSettings,
  input: { message: string; signature: string; presessionCookie: string | undefined; now: Date; country: string | null },
): Promise<VerifyResult> {
  const { message, signature, now } = input;
  const nonce = nonceOf(message);
  if (nonce === null) throw new SiweFailure("malformed_message");
  if (!isPresessionToken(input.presessionCookie)) throw new SiweFailure("no_presession");
  const presession = await queryOne<{ id: string }>(
    db,
    sql`SELECT id::text AS id FROM siwe_presessions WHERE token_hash = ${sha256Hex(input.presessionCookie)} AND expires_at > ${iso(now)}::timestamptz`,
  );
  if (!presession) throw new SiweFailure("no_presession");

  // Atomic single-use consumption (SEC-AUTH-03): only the pre-session that requested the nonce can consume it.
  const consumed = await queryOne<{ address: string; message: string; expires_at: unknown }>(
    db,
    sql`DELETE FROM siwe_nonces WHERE nonce = ${nonce} AND presession_id = ${presession.id}::uuid
        RETURNING address, message, expires_at`,
  );
  if (!consumed) {
    const elsewhere = await challengedAddress(db, nonce);
    throw new SiweFailure(elsewhere ? "foreign_presession" : "unknown_nonce", elsewhere);
  }
  const address = consumed.address as Address;
  if (toDate(consumed.expires_at).getTime() <= now.getTime()) throw new SiweFailure("expired", address);
  if (consumed.message !== message) throw new SiweFailure("message_mismatch", address);
  if (!checkSiweFields(consumed.message, settings, { address, nonce }, now)) throw new SiweFailure("field_mismatch", address);
  // EOA only: a 65-byte ECDSA signature recovered locally. ERC-6492 wrappers and ERC-1271 contract signatures fail here.
  if (!SIGNATURE.test(signature)) throw new SiweFailure("malformed_signature", address);
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: consumed.message, signature: signature as `0x${string}` });
  } catch {
    throw new SiweFailure("malformed_signature", address);
  }
  if (recovered.toLowerCase() !== address) throw new SiweFailure("signature_mismatch", address);

  return db.transaction(async (tx) => {
    const user = await queryOne<{ id: string }>(
      tx,
      sql`INSERT INTO users (wallet_address) VALUES (${address})
          ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
          RETURNING id::text AS id`,
    );
    if (!user) throw new Error("user upsert returned no row");
    const created = await createSession(tx, { userId: user.id, wallet: address, termsDigest: settings.termsDigest, authenticatedAt: now, now });
    await queryRows(tx, sql`DELETE FROM siwe_presessions WHERE id = ${presession.id}::uuid RETURNING id`);
    await queryRows(
      tx,
      sql`INSERT INTO terms_acceptances (user_id, wallet_address, terms_digest, method, message, signature, country, accepted_at)
          VALUES (${user.id}::uuid, ${address}, ${settings.termsDigest}, 'siwe', ${consumed.message}, ${signature.toLowerCase()}, ${input.country}, ${iso(now)}::timestamptz)
          RETURNING id::text AS id`,
    );
    return { token: created.token, session: created.session, userId: user.id, address };
  });
}
