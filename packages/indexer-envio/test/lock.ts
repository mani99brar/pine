// Cross-process lock for the indexer-envio test files that run createTestIndexer (the Envio runtime and its in-memory
// store per file). vitest runs test files in parallel fork processes, so every such file imports this module FIRST:
// its top-level await blocks the file's remaining imports until no other file holds the lock, so waiting workers stay
// small (features/indexers/decisions.md, test memory). The lock is an atomic mkdir under os.tmpdir() holding the owner
// pid; a dead owner, or an earlier file of this same fork process (a fork runs one file at a time), is taken over
// (rules in lock-core.ts, tested by lock.test.ts). Released in afterAll and, as a fallback, on process exit.

import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { acquireLock, releaseLock } from "./lock-core.js";

export const LOCK_DIR = path.join(os.tmpdir(), "pine-indexer-envio-tests.lock");

await acquireLock(LOCK_DIR);
process.once("exit", () => releaseLock(LOCK_DIR));
afterAll(() => {
  releaseLock(LOCK_DIR);
});
