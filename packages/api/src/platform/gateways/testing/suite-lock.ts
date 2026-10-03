// Cross-process lock for the gateways test files that open an in-memory Postgres. Each PGlite harness peaks at several
// hundred MB, and vitest runs test files in parallel fork processes, so the full suite can exhaust memory on a small host
// (the verifier saw workers SIGKILLed). Every such test file imports this module FIRST: its top-level await blocks the
// file's remaining imports until no other file holds the lock, so waiting workers stay small. The lock is an atomic
// mkdir under os.tmpdir() holding the owner pid; a dead owner, or an earlier file of this same fork process (a fork runs
// one file at a time), is taken over. Released in afterAll and, as a fallback, on process exit.

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const LOCK_DIR = path.join(os.tmpdir(), "pine-platform-gateways-tests.lock");
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
    if (Date.now() > deadline) throw new Error("timed out waiting for the gateways test lock");
    let created = false;
    try {
      await mkdir(LOCK_DIR);
      created = true;
      await writeFile(PID_FILE, String(process.pid));
      // Another waiter may have taken the directory over between mkdir and writeFile: own it only if the pid is ours.
      if ((await readFile(PID_FILE, "utf8").catch(() => "")) === String(process.pid)) return;
      continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT: the fresh directory was removed by a concurrent takeover; start over.
      if (created || code === "ENOENT") continue;
      if (code !== "EEXIST") throw error;
    }
    if (await canTakeOver()) {
      // Atomic takeover: only one waiter can rename the stale directory away; losers simply retry.
      const stale = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
      if (await rename(LOCK_DIR, stale).then(() => true, () => false)) await rm(stale, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
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
