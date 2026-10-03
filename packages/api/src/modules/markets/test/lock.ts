// Cross-process lock for the markets test files. Each file imports this module FIRST: its top-level await blocks the
// file's remaining (heavy) imports until no other markets test file holds an in-memory Postgres (one PGlite test file
// peaks near 1.25 GB RSS while it initialises), so concurrent vitest workers wait cheaply instead of exhausting
// memory. The lock is held until the worker process exits (vitest forks a fresh process per test file), because a
// closed PGlite's memory is only returned with the process: releasing in afterAll let the next file's init spike
// overlap a still-resident ~650 MB worker. A dead owner pid is taken over immediately (workers killed by a signal
// never run exit handlers). Races between waiters never fail a test file: at worst two files briefly overlap.
// waitForMemory() lets the holder wait (bounded) for enough available memory right before PGlite initialises, because
// other processes on a shared host can leave too little for its init spike. Scheduling only: no test outcome depends
// on this module.

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(os.tmpdir(), "pine-markets-module-tests.lock");
const PID_FILE = path.join(LOCK_DIR, "pid");
const WAIT_LIMIT_MS = 30 * 60_000;
/** Wait for this much available memory (os.freemem() is MemAvailable on Linux; PGlite's init spike is ~1 GB)... */
const MIN_AVAILABLE_BYTES = 1_500_000_000;
/** ...but never longer than this: then the file runs anyway. */
const MEMORY_WAIT_LIMIT_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const code = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

async function ownerPid(): Promise<number> {
  const owner = Number((await readFile(PID_FILE, "utf8").catch(() => "0")).trim());
  return Number.isSafeInteger(owner) && owner > 0 ? owner : 0;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
}

/** True when this process now holds the lock. Never throws for races with other waiters. */
async function tryTake(): Promise<boolean> {
  try {
    await mkdir(LOCK_DIR);
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await writeFile(PID_FILE, String(process.pid));
    return true;
  } catch (error) {
    // A racing stale takeover removed the directory between mkdir and writeFile: try again.
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

/** Removes the lock when its owner is dead (or is this process: a release that never ran in a reused worker). */
async function removeIfStale(): Promise<void> {
  const owner = await ownerPid();
  if (owner > 0) {
    if (owner !== process.pid && alive(owner)) return;
  } else {
    // No pid yet: the owner is between mkdir and writeFile, unless that was long ago.
    const info = await stat(LOCK_DIR).catch(() => null);
    if (info === null || Date.now() - info.mtimeMs <= 30_000) return;
  }
  // Re-read right before removing: another waiter may already have taken the stale lock over.
  if ((await ownerPid()) !== owner) return;
  await rm(LOCK_DIR, { recursive: true, force: true });
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    if (await tryTake()) return;
    await removeIfStale();
    if (Date.now() > deadline) throw new Error("timed out waiting for the markets test lock");
    await sleep(200);
  }
}

/** Called by the harness right before it creates the in-memory Postgres. */
export async function waitForMemory(): Promise<void> {
  const deadline = Date.now() + MEMORY_WAIT_LIMIT_MS;
  while (os.freemem() < MIN_AVAILABLE_BYTES && Date.now() < deadline) await sleep(1_000);
}

await acquire();
process.once("exit", () => {
  try {
    if (readFileSync(PID_FILE, "utf8") === String(process.pid)) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
});
