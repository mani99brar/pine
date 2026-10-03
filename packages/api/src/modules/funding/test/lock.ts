// Cross-process lock for the funding test files. Each file imports this module FIRST: its top-level await blocks the
// file's remaining (heavy) imports until no other funding test file holds an in-memory Postgres (PGlite costs
// ~400 MB), so concurrent vitest workers wait cheaply instead of exhausting memory.
//
// The lock is one file created exclusively (`wx`) holding the owner's pid. A lock whose owner died (e.g. a worker
// killed by the OOM killer) is taken over by renaming it to a unique name first: rename is atomic, so of several
// waiters only one moves it, and the mover checks that it moved the dead owner's lock (not a fresh one created in
// between) before deleting it.

import { readFileSync, rmSync } from "node:fs";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_FILE = path.join(os.tmpdir(), "pine-funding-module-tests.lockfile");
const WAIT_LIMIT_MS = 30 * 60_000;
/** A lock file without a readable pid (creation in progress) is stale only after this long. */
const EMPTY_LOCK_GRACE_MS = 30_000;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
}

/** The lock's content when it is stale (dead owner, or empty for too long); null when it is held or gone. */
async function staleContent(): Promise<string | null> {
  const content = await readFile(LOCK_FILE, "utf8").catch(() => null);
  if (content === null) return null;
  const owner = Number(content);
  if (Number.isSafeInteger(owner) && owner > 0) return owner === process.pid || !alive(owner) ? content : null;
  const info = await stat(LOCK_FILE).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > EMPTY_LOCK_GRACE_MS ? content : null;
}

async function takeOver(expected: string): Promise<void> {
  const moved = `${LOCK_FILE}.${process.pid}.${randomUUID()}`;
  try {
    await rename(LOCK_FILE, moved);
  } catch (error) {
    if (code(error) === "ENOENT") return; // Another waiter took it over first.
    throw error;
  }
  const content = await readFile(moved, "utf8").catch(() => null);
  // Moved a live owner's fresh lock by accident: put it back (link fails if a new lock already exists).
  if (content !== expected) await link(moved, LOCK_FILE).catch(() => undefined);
  await rm(moved, { force: true });
}

async function acquire(): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    try {
      await writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const stale = await staleContent();
    if (stale !== null) {
      await takeOver(stale);
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the funding test lock");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let held = false;
let released = false;

export async function releaseSuiteLock(): Promise<void> {
  if (!held || released) return;
  released = true;
  const owner = await readFile(LOCK_FILE, "utf8").catch(() => "");
  if (owner === String(process.pid)) await rm(LOCK_FILE, { force: true });
}

await acquire();
held = true;
process.once("exit", () => {
  // If afterAll never ran (e.g. every test filtered out); a dead pid is also detected as stale by the next waiter.
  if (released) return;
  try {
    if (readFileSync(LOCK_FILE, "utf8") === String(process.pid)) rmSync(LOCK_FILE, { force: true });
  } catch {
    // Already gone.
  }
});
