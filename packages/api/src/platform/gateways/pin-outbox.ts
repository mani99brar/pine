// Pin outbox (ADR-0001 D11): every stored blob is pushed to Pine's Kubo node (block/put raw + pin/add) and to an IPFS
// Pinning Service API provider. Each target is recorded as done separately, so a retry after a crash repeats nothing
// that already succeeded, and an item stays due while any configured target has not confirmed it (PRD-02 3a); the
// pinning service is asked for an existing pin before a new one is requested. A CID returned by either target that does
// not equal the locally computed raw CID marks the item integrity_failed and alerts.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { sha256FromRawCid } from "@pine/shared/canonical";
import type { Clock, Database, Metrics } from "../../contracts/app.js";
import type { Redactor } from "../../contracts/redact.js";
import { safeErrorMessage } from "../../contracts/redact.js";
import { bytesColumn, execute, queryRows } from "./db.js";
import { parseJsonBody, type HttpClient } from "./http.js";
import type { GatewayLogger } from "./log.js";

const RESPONSE_MAX_BYTES = 64 * 1024;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;

class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinError";
  }
}

const kuboBlockPut = z.object({ Key: z.string().max(200), Size: z.number().int().nonnegative() });
const kuboPinAdd = z.object({ Pins: z.array(z.string().max(200)).max(10) });
const psaPinStatus = z.object({
  requestid: z.string().max(200),
  status: z.enum(["queued", "pinning", "pinned", "failed"]),
  pin: z.object({ cid: z.string().max(200) }),
});
const psaPinList = z.object({ count: z.number().int().nonnegative(), results: z.array(psaPinStatus).max(1000) });

const outboxRow = z.object({
  sha256: z.string(),
  cid: z.string(),
  bytes: bytesColumn,
  kubo_done: z.boolean(),
  service_done: z.boolean(),
  attempts: z.number().int(),
});

export interface PinTargets {
  /** Kubo RPC API base (e.g. http://127.0.0.1:5001), or null. */
  kuboApiUrl: string | null;
  /** Pinning Service API base, or null. */
  pinningServiceUrl: string | null;
  pinningServiceToken: string | null;
}

export interface PinOutbox {
  /** Processes due items until `signal` aborts (checked before the batch and between items; it also cancels the
   *  in-flight request). `pinned` counts items every configured target has now confirmed. */
  run(signal: AbortSignal, batchSize?: number): Promise<{ pinned: number; failed: number; integrityFailed: number }>;
}

export function createPinOutbox(deps: {
  db: Database;
  clock: Clock;
  http: HttpClient;
  targets: PinTargets;
  metrics: Metrics;
  redact: Redactor;
  log: GatewayLogger;
}): PinOutbox {
  const { db, clock, http, targets, metrics, redact, log } = deps;

  /** Same digest, raw codec, sha2-256: the only CID that identifies these bytes. */
  const sameCid = (returned: string, sha256: string) => sha256FromRawCid(returned) === sha256;

  async function json(response: { status: number; body: Uint8Array }, what: string): Promise<unknown> {
    try {
      return parseJsonBody(response.body);
    } catch {
      throw new PinError(`${what} returned a non-JSON body (status ${response.status})`);
    }
  }

  async function pinToKubo(base: string, item: z.infer<typeof outboxRow>, signal: AbortSignal): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(item.bytes)], { type: "application/octet-stream" }), "block");
    const put = await http.request(`${base}/api/v0/block/put?cid-codec=raw&mhtype=sha2-256&mhlen=32&pin=false`, {
      method: "POST",
      body: form,
      maxBytes: RESPONSE_MAX_BYTES,
      signal,
    });
    if (put.status !== 200) throw new PinError(`Kubo block/put returned status ${put.status}`);
    const block = kuboBlockPut.safeParse(await json(put, "Kubo block/put"));
    if (!block.success) throw new PinError("Kubo block/put returned an unexpected response");
    if (!sameCid(block.data.Key, item.sha256) || block.data.Size !== item.bytes.byteLength) {
      throw new IntegrityError("Kubo block/put returned a CID that differs from the local CID");
    }
    const pin = await http.request(`${base}/api/v0/pin/add?arg=${encodeURIComponent(item.cid)}`, {
      method: "POST",
      maxBytes: RESPONSE_MAX_BYTES,
      signal,
    });
    if (pin.status !== 200) throw new PinError(`Kubo pin/add returned status ${pin.status}`);
    const pins = kuboPinAdd.safeParse(await json(pin, "Kubo pin/add"));
    if (!pins.success) throw new PinError("Kubo pin/add returned an unexpected response");
    if (pins.data.Pins.length !== 1 || !pins.data.Pins.every((value) => sameCid(value, item.sha256))) {
      throw new IntegrityError("Kubo pin/add returned a CID that differs from the local CID");
    }
  }

  async function pinToService(base: string, token: string, item: z.infer<typeof outboxRow>, signal: AbortSignal): Promise<void> {
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
    // Idempotency across crashes: an existing pin request for this CID is reused instead of creating another.
    const existing = await http.request(`${base}/pins?cid=${encodeURIComponent(item.cid)}&status=queued,pinning,pinned&limit=10`, {
      method: "GET",
      headers,
      maxBytes: RESPONSE_MAX_BYTES,
      signal,
    });
    if (existing.status === 200) {
      const list = psaPinList.safeParse(await json(existing, "Pinning service"));
      if (!list.success) throw new PinError("Pinning service returned an unexpected pin list");
      if (list.data.results.some((result) => !sameCid(result.pin.cid, item.sha256))) {
        throw new IntegrityError("Pinning service listed a CID that differs from the local CID");
      }
      if (list.data.results.length > 0) return;
    } else if (existing.status !== 404) {
      throw new PinError(`Pinning service returned status ${existing.status}`);
    }
    const created = await http.request(`${base}/pins`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cid: item.cid, name: item.sha256 }),
      maxBytes: RESPONSE_MAX_BYTES,
      signal,
    });
    if (created.status !== 202 && created.status !== 200) throw new PinError(`Pinning service returned status ${created.status}`);
    const status = psaPinStatus.safeParse(await json(created, "Pinning service"));
    if (!status.success) throw new PinError("Pinning service returned an unexpected pin status");
    if (!sameCid(status.data.pin.cid, item.sha256)) throw new IntegrityError("Pinning service returned a CID that differs from the local CID");
    if (status.data.status === "failed") throw new PinError("Pinning service reported the pin as failed");
  }

  return {
    async run(signal, batchSize = 20) {
      const kubo = targets.kuboApiUrl;
      const service = targets.pinningServiceUrl !== null && targets.pinningServiceToken !== null
        ? { url: targets.pinningServiceUrl, token: targets.pinningServiceToken }
        : null;
      const result = { pinned: 0, failed: 0, integrityFailed: 0 };
      // Development without pin targets: items stay pending until a target is configured.
      if (signal.aborted || (kubo === null && service === null)) return result;
      const now = clock.now();
      // Per-target completion (PRD-02 3a): an item is due while any CONFIGURED target has not confirmed it, so content
      // stored before a provider was configured still reaches that provider once it is.
      const items = await queryRows(
        db,
        sql`SELECT p.sha256, b.cid, b.bytes, p.kubo_done, p.service_done, p.attempts
              FROM content_pins p JOIN content_blobs b ON b.sha256 = p.sha256
             WHERE p.status = 'pending' AND p.next_attempt_at <= ${now}
               AND ((${kubo !== null} AND NOT p.kubo_done) OR (${service !== null} AND NOT p.service_done))
             ORDER BY p.next_attempt_at, p.sha256 LIMIT ${batchSize}`,
        outboxRow,
      );
      for (const item of items) {
        if (signal.aborted) break;
        let kuboDone = item.kubo_done;
        let serviceDone = item.service_done;
        try {
          if (!kuboDone && kubo !== null) {
            await pinToKubo(kubo, item, signal);
            kuboDone = true;
          }
          if (!serviceDone && service !== null) {
            await pinToService(service.url, service.token, item, signal);
            serviceDone = true;
          }
          // 'pinned' only once BOTH targets confirmed; with one target unconfigured the item stays pending with its
          // done flag set and is selected again when that target is configured.
          await execute(
            db,
            sql`UPDATE content_pins SET status = ${kuboDone && serviceDone ? "pinned" : "pending"}, kubo_done = ${kuboDone},
                  service_done = ${serviceDone}, last_error = NULL, updated_at = ${clock.now()}
                 WHERE sha256 = ${item.sha256} AND status = 'pending'`,
          );
          result.pinned += 1;
        } catch (error) {
          if (signal.aborted && !(error instanceof IntegrityError)) {
            // Stopped by the job runner mid-request: keep what was confirmed, count no failed attempt.
            await execute(
              db,
              sql`UPDATE content_pins SET kubo_done = ${kuboDone}, service_done = ${serviceDone}, updated_at = ${clock.now()}
                   WHERE sha256 = ${item.sha256} AND status = 'pending'`,
            );
            break;
          }
          const message = safeErrorMessage(error, redact).slice(0, 500);
          if (error instanceof IntegrityError) {
            await execute(
              db,
              sql`UPDATE content_pins SET status = 'integrity_failed', kubo_done = ${kuboDone}, service_done = ${serviceDone},
                    last_error = ${message}, updated_at = ${clock.now()} WHERE sha256 = ${item.sha256} AND status = 'pending'`,
            );
            metrics.increment("content_pin_integrity_failed");
            log.error(`Pin integrity failure for ${item.sha256}: ${message}`);
            result.integrityFailed += 1;
            continue;
          }
          const attempts = item.attempts + 1;
          const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts - 1, 20));
          await execute(
            db,
            sql`UPDATE content_pins SET kubo_done = ${kuboDone}, service_done = ${serviceDone}, attempts = ${attempts},
                  next_attempt_at = ${new Date(clock.now().getTime() + backoff)}, last_error = ${message}, updated_at = ${clock.now()}
                 WHERE sha256 = ${item.sha256} AND status = 'pending'`,
          );
          metrics.increment("content_pin_failed");
          log.warn(`Pinning ${item.sha256} failed (attempt ${attempts}): ${message}`);
          result.failed += 1;
        }
      }
      return result;
    },
  };
}
