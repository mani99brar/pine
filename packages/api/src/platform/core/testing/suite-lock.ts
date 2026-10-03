// Cross-process lock for the platform-core test files that open an in-memory Postgres. Each PGlite harness peaks at
// several hundred MB, and vitest runs test files in parallel fork processes, so the full suite can exhaust memory on a
// small host (workers were SIGKILLed); the harness's database lock only serialises PGlite itself, after every import.
// Every such test file imports this module FIRST: its top-level await blocks the file's remaining imports until no other
// file holds the lock, so waiting workers stay small. The lock (dir-lock.ts) is installed and taken over atomically; a
// dead owner, or an earlier file of this same fork process (a fork runs one file at a time), is taken over.
// Released in afterAll and, as a fallback, on process exit.

import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { acquireDirLock, releaseDirLock } from "./dir-lock.js";

const LOCK_DIR = path.join(os.tmpdir(), "pine-platform-core-tests.lock");

await acquireDirLock(LOCK_DIR, { timeoutMs: 30 * 60_000, pollMs: 200, ownPid: "take", name: "platform-core test" });
process.once("exit", () => releaseDirLock(LOCK_DIR));
afterAll(() => {
  releaseDirLock(LOCK_DIR);
});
