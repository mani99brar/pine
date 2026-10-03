// Cross-process lock for the claims test files. Each file imports this module FIRST: its top-level await blocks the
// file's remaining (heavy) imports until no other claims test file holds an in-memory Postgres (PGlite costs
// ~400 MB), so concurrent vitest workers wait cheaply instead of exhausting memory. The lock itself (atomic mkdir,
// atomic stale takeover) is in ./lock-core.ts, tested on a temporary path by lock.test.ts.

import os from "node:os";
import path from "node:path";
import { createDirLock } from "./lock-core.js";

const suiteLock = createDirLock({ lockPath: path.join(os.tmpdir(), "pine-claims-module-tests.lock") });

export async function releaseSuiteLock(): Promise<void> {
  await suiteLock.release();
}

await suiteLock.acquire();
// If afterAll never ran (e.g. every test filtered out); a dead pid is also detected as stale by the next waiter.
process.once("exit", () => suiteLock.releaseSync());
