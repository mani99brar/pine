// Committed entity snapshots (PRD-05 3.1): the rows the real handlers produced for a frozen scenario, sorted by entity
// and id, bigints as decimal strings, undefined as null, bound to the scenario by the SHA-256 of its events. They live in
// packages/read-model-envio/test/fixtures/<scenario>.entities.json, where the read-model fake serves them. Rewritten only
// with UPDATE_SNAPSHOTS=1; otherwise any difference fails, so a gate run never dirties the worktree.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainEvent } from "@pine/shared/chain-events";

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../read-model-envio/test/fixtures");

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Canonical JSON: object keys sorted, bigint as {"$bigint": "<decimal>"}. Mirrored in read-model-envio/test/snapshots.ts. */
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

/** A stored entity row: Hasura-like plain JSON (bigints as decimal strings, missing optionals as null). */
export function toSnapshotRow(row: object): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(row).sort()) out[key] = toSnapshotValue((row as Record<string, unknown>)[key]);
  return out;
}

function toSnapshotValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(toSnapshotValue);
  if (typeof value === "object") return toSnapshotRow(value);
  throw new Error(`cannot snapshot ${typeof value}`);
}

export interface EntitySnapshot {
  scenario: string;
  eventsSha256: string;
  entities: { [entity: string]: { [key: string]: JsonValue }[] };
}

export function buildSnapshot(scenario: string, events: readonly ChainEvent[], entities: Record<string, readonly { id: string }[]>): EntitySnapshot {
  const sorted: EntitySnapshot["entities"] = {};
  for (const name of Object.keys(entities).sort()) {
    sorted[name] = [...(entities[name] ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(toSnapshotRow);
  }
  return { scenario, eventsSha256: eventsSha256(events), entities: sorted };
}

export const snapshotPath = (scenario: string, dir = FIXTURES_DIR): string => path.join(dir, `${scenario}.entities.json`);

export const serializeSnapshot = (snapshot: EntitySnapshot): string => `${JSON.stringify(snapshot, null, 2)}\n`;

/** Returns the committed text (or null when missing); writes `actual` first when UPDATE_SNAPSHOTS=1. */
export function committedSnapshot(scenario: string, actual: EntitySnapshot, dir = FIXTURES_DIR): string | null {
  const file = snapshotPath(scenario, dir);
  if (process.env.UPDATE_SNAPSHOTS === "1") writeFileSync(file, serializeSnapshot(actual));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}
