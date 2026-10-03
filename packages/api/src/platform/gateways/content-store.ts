// Content-addressed blob store (SEC-EVID-03/04/09/11). Postgres bytea is the source of truth for objects of at most one
// raw IPFS block; sha256 and the raw CID are always computed here from the bytes. Moderation `block` hides content from
// get/has/retrieve. retrieve() falls back to the configured trusted IPFS gateways by the CID derived from the digest
// only (redirects refused, size-capped, digest verified) and stores a verified copy locally.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { identify, RAW_CID_MAX_BYTES, rawCidFromSha256, sha256Hex } from "@pine/shared/canonical";
import type { Hex32 } from "@pine/shared/types";
import type { Clock, ContentStore, Database, Metrics, ModerationGateway, StoredContent } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { bytesColumn, execute, inTransaction, queryRows } from "./db.js";
import { HttpError, type HttpClient } from "./http.js";
import type { GatewayLogger } from "./log.js";

const SHA256_PATTERN = /^0x[0-9a-f]{64}$/;
const FALLBACK_MEDIA_TYPE = "application/octet-stream";

/** Lowercase 0x-hex digest, or null for anything that is not a SHA-256 digest. */
export function normalizeSha256(value: string): Hex32 | null {
  const lower = value.toLowerCase();
  return SHA256_PATTERN.test(lower) ? (lower as Hex32) : null;
}

/** The declared media type is informational only; anything unusual is stored as application/octet-stream. */
function cleanMediaType(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(trimmed) ? trimmed : FALLBACK_MEDIA_TYPE;
}

const blobRow = z.object({ sha256: z.string(), size: z.number().int(), cid: z.string(), declared_media_type: z.string(), bytes: bytesColumn });

export interface ContentStoreInternals extends ContentStore {
  /** True when moderation blocks the digest (the content server answers 451). */
  isBlocked(sha256: Hex32): Promise<boolean>;
}

export function createContentStore(deps: {
  db: Database;
  clock: Clock;
  moderation: ModerationGateway;
  http: HttpClient;
  gatewayUrls: readonly string[];
  metrics: Metrics;
  log: GatewayLogger;
}): ContentStoreInternals {
  const { db, clock, moderation, http, gatewayUrls, metrics, log } = deps;

  async function isBlocked(sha256: Hex32): Promise<boolean> {
    const states = await moderation.states("content", [sha256]);
    for (const state of states.values()) if (state.action === "block") return true;
    return false;
  }

  async function readLocal(sha256: Hex32): Promise<{ bytes: Uint8Array; record: StoredContent } | null> {
    const rows = await queryRows(db, sql`SELECT sha256, size, cid, declared_media_type, bytes FROM content_blobs WHERE sha256 = ${sha256}`, blobRow);
    const row = rows[0];
    if (!row) return null;
    // Defense in depth: bytes whose digest no longer matches their key are never served.
    if (sha256Hex(row.bytes) !== sha256) {
      metrics.increment("content_integrity_failed", { source: "local" });
      log.error(`Stored content ${sha256} failed digest verification`);
      return null;
    }
    return { bytes: row.bytes, record: { sha256, size: row.size, cid: row.cid, declaredMediaType: row.declared_media_type } };
  }

  async function store(bytes: Uint8Array, declaredMediaType: string, maxBytes: number): Promise<StoredContent> {
    const limit = Math.min(Number.isFinite(maxBytes) ? maxBytes : 0, RAW_CID_MAX_BYTES);
    if (bytes.byteLength > limit) throw new ApiError("PAYLOAD_TOO_LARGE", "Content exceeds the size limit");
    const id = identify(bytes);
    if (id.cid === null) throw new ApiError("PAYLOAD_TOO_LARGE", "Content exceeds the size limit");
    const cid = id.cid;
    const now = clock.now();
    const mediaType = cleanMediaType(declaredMediaType);
    const rows = await inTransaction(db, async (tx) => {
      await execute(
        tx,
        sql`INSERT INTO content_blobs (sha256, size, cid, declared_media_type, bytes, created_at)
            VALUES (${id.sha256}, ${id.size}, ${cid}, ${mediaType}, ${Buffer.from(bytes)}, ${now})
            ON CONFLICT (sha256) DO NOTHING`,
      );
      await execute(
        tx,
        sql`INSERT INTO content_pins (sha256, status, next_attempt_at, updated_at) VALUES (${id.sha256}, 'pending', ${now}, ${now})
            ON CONFLICT (sha256) DO NOTHING`,
      );
      return queryRows(
        tx,
        sql`SELECT sha256, size, cid, declared_media_type FROM content_blobs WHERE sha256 = ${id.sha256}`,
        blobRow.omit({ bytes: true }),
      );
    });
    const row = rows[0];
    if (!row) throw new Error("Stored content row is missing");
    return { sha256: id.sha256, size: row.size, cid: row.cid, declaredMediaType: row.declared_media_type };
  }

  /** Fetches the raw block from one trusted gateway; null when unavailable, oversize, redirected or not matching. */
  async function fetchFromGateway(base: string, sha256: Hex32, cid: string, cap: number): Promise<Uint8Array | null> {
    try {
      const response = await http.request(`${base}/ipfs/${cid}?format=raw`, {
        method: "GET",
        headers: { accept: "application/vnd.ipld.raw" },
        maxBytes: cap,
      });
      if (response.status !== 200) return null;
      if (sha256Hex(response.body) !== sha256) {
        metrics.increment("content_integrity_failed", { source: "gateway" });
        log.warn(`IPFS gateway returned bytes that do not match ${sha256}`);
        return null;
      }
      return response.body;
    } catch (error) {
      if (error instanceof HttpError) {
        log.warn(`IPFS gateway fetch failed for ${sha256} (${error.kind})`);
        return null;
      }
      throw error;
    }
  }

  return {
    isBlocked,

    put(input) {
      return store(input.bytes, input.declaredMediaType, input.maxBytes);
    },

    async get(sha256) {
      const key = normalizeSha256(sha256);
      if (key === null || (await isBlocked(key))) return null;
      return readLocal(key);
    },

    async has(sha256) {
      const key = normalizeSha256(sha256);
      if (key === null || (await isBlocked(key))) return false;
      const rows = await queryRows(db, sql`SELECT 1 AS present FROM content_blobs WHERE sha256 = ${key}`, z.object({ present: z.number() }));
      return rows.length > 0;
    },

    async retrieve(sha256, maxBytes) {
      const key = normalizeSha256(sha256);
      if (key === null || (await isBlocked(key))) return null;
      const local = await readLocal(key);
      if (local) return local.bytes;
      const cap = Math.min(Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0, RAW_CID_MAX_BYTES);
      // The URL is derived from the digest alone; the CID is never taken from user input.
      const cid = rawCidFromSha256(key);
      for (const base of gatewayUrls) {
        const bytes = await fetchFromGateway(base, key, cid, cap);
        if (bytes === null) continue;
        await store(bytes, FALLBACK_MEDIA_TYPE, cap);
        return bytes;
      }
      return null;
    },
  };
}
