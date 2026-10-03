// Reader for the committed entity snapshots written by packages/indexer-envio/test/entities.test.ts (the rows the real
// handlers produced for each frozen scenario). The fake serves a snapshot only for the exact events it was produced from.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChainEvent } from "@pine/shared/chain-events";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Row = Record<string, JsonValue>;

const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(json), z.record(z.string(), json)]));

const snapshotSchema = z.object({
  scenario: z.string(),
  eventsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  entities: z.record(z.string(), z.array(z.record(z.string(), json).and(z.object({ id: z.string() })))),
});

export type EntitySnapshot = z.infer<typeof snapshotSchema>;

/** Canonical JSON: object keys sorted, bigint as {"$bigint": "<decimal>"}. Mirrors packages/indexer-envio/test/snapshot.ts. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value));
}

function toCanonical(value: unknown): JsonValue {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = toCanonical(item);
    }
    return out;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

export function eventsSha256(events: readonly ChainEvent[]): string {
  return createHash("sha256").update(canonicalJson(events)).digest("hex");
}

export function loadSnapshots(): EntitySnapshot[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".entities.json"))
    .sort()
    .map((file) => snapshotSchema.parse(JSON.parse(readFileSync(path.join(FIXTURES_DIR, file), "utf8"))));
}

/** The snapshot the handlers produced for exactly these events; throws unless a recorded hash equals theirs. */
export function snapshotFor(events: readonly ChainEvent[]): EntitySnapshot {
  const hash = eventsSha256(events);
  const snapshot = loadSnapshots().find((item) => item.eventsSha256 === hash);
  if (!snapshot) throw new Error(`no committed entity snapshot for events ${hash}; regenerate with UPDATE_SNAPSHOTS=1 pnpm --filter @pine/indexer-envio test`);
  return snapshot;
}
