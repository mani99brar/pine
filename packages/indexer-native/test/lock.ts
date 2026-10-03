// Cross-process lock for the test files that open an in-memory Postgres (features/indexers/decisions.md, test memory).
// Each PGlite instance peaks at several hundred MB and vitest runs test files in parallel fork processes, so every such
// file imports this module FIRST: its top-level await blocks the file's remaining imports until no other file holds the
// lock. The lock is an atomic mkdir under os.tmpdir() (lane-specific name) holding the owner pid; a dead owner, or an
// earlier file of this same fork process (a fork runs one file at a time), is taken over. Released in afterAll and, as a
// fallback, on process exit. Reference: packages/api/src/platform/gateways/testing/suite-lock.ts (commit 8b00834).

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const LOCK_DIR = path.join(os.tmpdir(), "pine-indexer-native-tests.lock");
const PID_FILE = path.join(LOCK_DIR, "pid");
const WAIT_LIMIT_MS = 30 * 60_000;
const POLL_MS = 200;
// A directory without a pid file belongs to a writer between mkdir and writeFile; only a long-stale one is taken over.
const ORPHAN_MS = 30_000;

async function canTakeOver(): Promise<boolean> {
  const owner = Number(await readFile(PID_FILE, "utf8").catch(() => "0"));
  if (owner > 0) {
    if (owner === process.pid) return true;
    try {
      process.kill(owner, 0);
      return false;
    } catch {
      return true;
    }
  }
  const info = await stat(LOCK_DIR).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > ORPHAN_MS;
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(PID_FILE, String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await canTakeOver()) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the indexer-native test lock");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function release(): void {
  try {
    if (readFileSync(PID_FILE, "utf8") === String(process.pid)) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Already released or taken over.
  }
}

await acquire();
process.once("exit", release);
afterAll(() => {
  release();
});
