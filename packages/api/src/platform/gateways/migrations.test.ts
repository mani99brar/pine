// Must stay the first import: serializes the memory-heavy (PGlite) gateways test files across vitest workers.
import "./testing/suite-lock.js";
import { describe, expect, it } from "vitest";
import { identify } from "@pine/shared/canonical";
import { loadMigrations, runMigrations } from "../../contracts/migrations.js";
import { createTestDatabase } from "../../contracts/testing.js";

// Migrations of the gateways group applied on top of rows written by earlier migrations (append-only: 0001 is never
// edited because its checksum may already be recorded in a database).

describe("migration gateways/0002 (per-target pin completion backfill)", () => {
  it("reopens items closed as pinned before a target was configured, keeping each confirmed target done", async () => {
    const database = await createTestDatabase({ applyMigrations: false });
    try {
      const files = await loadMigrations();
      const upTo0001 = files.slice(0, files.findIndex((file) => file.group === "gateways" && file.number === 1) + 1);
      expect(upTo0001.at(-1)?.name).toBe("0001_gateways.sql");
      await runMigrations(database.sql, upTo0001);
      const rows = [
        { text: "kubo only", status: "pinned", kubo: true, service: false },
        { text: "service only", status: "pinned", kubo: false, service: true },
        { text: "both", status: "pinned", kubo: true, service: true },
        { text: "retrying", status: "pending", kubo: true, service: false },
        { text: "bad", status: "integrity_failed", kubo: true, service: false },
      ].map((row) => ({ ...row, id: identify(new TextEncoder().encode(row.text)) }));
      for (const row of rows) {
        await database.sql.query(
          "INSERT INTO content_blobs (sha256, size, cid, declared_media_type, bytes, created_at) VALUES ($1, $2, $3, 'text/plain', $4, now())",
          [row.id.sha256, row.id.size, row.id.cid, Buffer.from(row.text)],
        );
        await database.sql.query(
          "INSERT INTO content_pins (sha256, status, kubo_done, service_done, attempts, next_attempt_at, updated_at) VALUES ($1, $2, $3, $4, 3, now(), now())",
          [row.id.sha256, row.status, row.kubo, row.service],
        );
      }
      const result = await runMigrations(database.sql, files);
      expect(result.applied).toContain("gateways/0002_pin_target_completion.sql");
      const after = await database.sql.query<{ sha256: string; status: string; kubo_done: boolean; service_done: boolean; attempts: number }>(
        "SELECT sha256, status, kubo_done, service_done, attempts FROM content_pins",
      );
      const bySha = new Map(after.map((row) => [row.sha256, row]));
      const state = (text: string) => {
        const row = rows.find((candidate) => candidate.text === text);
        return bySha.get(row?.id.sha256 ?? "");
      };
      expect(state("kubo only")).toEqual(expect.objectContaining({ status: "pending", kubo_done: true, service_done: false, attempts: 0 }));
      expect(state("service only")).toEqual(expect.objectContaining({ status: "pending", kubo_done: false, service_done: true, attempts: 0 }));
      expect(state("both")).toEqual(expect.objectContaining({ status: "pinned", kubo_done: true, service_done: true }));
      expect(state("retrying")).toEqual(expect.objectContaining({ status: "pending", kubo_done: true, attempts: 3 }));
      expect(state("bad")).toEqual(expect.objectContaining({ status: "integrity_failed" }));
    } finally {
      await database.close();
    }
  });
});
