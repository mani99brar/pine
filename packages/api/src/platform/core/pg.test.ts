// The production pool settings (PRD-02 2.4, 2.5): statement timeout 15 s and a connection wait below the lease
// renewal period. Constructing a pg.Pool opens no connection.

import { describe, expect, it } from "vitest";
import { DEFAULT_LEASE_TTL_MS } from "./jobs.js";
import { createPool, POOL_CONNECTION_TIMEOUT_MS } from "./pg.js";

describe("createPool", () => {
  it("sets the statement timeout to 15 s and a connection timeout below the default renewal period", async () => {
    const pool = createPool({ connectionString: "postgres://pine_api:pw@127.0.0.1:1/pine", max: 3, applicationName: "pine-api" });
    try {
      const options = pool.options as unknown as Record<string, unknown>;
      expect(options.statement_timeout).toBe(15_000);
      expect(options.connectionTimeoutMillis).toBe(POOL_CONNECTION_TIMEOUT_MS);
      expect(POOL_CONNECTION_TIMEOUT_MS).toBeLessThan(DEFAULT_LEASE_TTL_MS / 3);
      expect(options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });
});
