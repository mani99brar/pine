// PGlite harness: a fresh in-memory database with the indexer migrations applied. Test files that use it import
// "./lock.js" first (cross-process memory lock) and close every database they open.

import { PGlite } from "@electric-sql/pglite";
import { pgliteExecutor, type SqlExecutor } from "../src/db.js";
import { loadMigrations, runMigrations } from "../src/migrations.js";

export interface TestDatabase {
  pg: PGlite;
  db: SqlExecutor;
  close: () => Promise<void>;
}

// Small Postgres buffers: the test data is tiny, and each instance then needs about 100 MB less on a shared host.
const POSTGRESQL_CONF = ["shared_buffers = 16MB", "work_mem = 1MB", "maintenance_work_mem = 8MB", "wal_buffers = 1MB", "temp_buffers = 1MB"];

export async function openDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const pg = new PGlite({ postgresqlconf: POSTGRESQL_CONF });
  await pg.waitReady;
  const db = pgliteExecutor(pg);
  if (options.migrate !== false) await runMigrations(db, await loadMigrations());
  let closed = false;
  return {
    pg,
    db,
    close: async () => {
      if (closed) return;
      closed = true;
      await pg.close();
    },
  };
}
