// A cross-process directory lock (tests only), parameterised by its path so the stale-takeover logic can be tested on
// a temporary path (lock.test.ts) while ./lock.ts applies it to the claims test files.
//
// The lock is a directory (atomic mkdir) holding the owner pid. A stale lock (dead owner) is taken over atomically:
// the directory is renamed to a unique name first (only one waiter's rename can succeed), the pid is re-read inside the
// renamed directory, and only a confirmed-dead owner's directory is removed. If the renamed lock turns out to belong to
// a live process (another waiter took over in between), it is put back when the lock path is free; otherwise this
// waiter simply keeps waiting and retries.

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * Liveness by signal 0: ESRCH means no such process; EPERM means it exists but belongs to someone else (alive). The
 * current process counts as alive (a lock held by this process is never stale to it).
 */
export function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}

export interface DirLockOptions {
  /** The lock directory. */
  lockPath: string;
  waitLimitMs?: number;
  pollMs?: number;
  /** A lock directory without a pid file (owner died between mkdir and writeFile) is stale after this long. */
  pidlessGraceMs?: number;
  /** Test seam: runs after the stale check and before the rename (simulates another waiter taking over meanwhile). */
  beforeStaleRename?: () => Promise<void>;
}

export interface DirLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
  /** Moves a stale lock out of the way; true when the lock path may now be free. */
  takeOverStale(): Promise<boolean>;
  /** Synchronous best-effort release for process exit. */
  releaseSync(): void;
}

export async function ownerOf(dir: string): Promise<number | null> {
  const text = await readFile(path.join(dir, "pid"), "utf8").catch(() => null);
  const pid = text === null ? NaN : Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function createDirLock(options: DirLockOptions): DirLock {
  const lockPath = options.lockPath;
  const waitLimitMs = options.waitLimitMs ?? 30 * 60_000;
  const pollMs = options.pollMs ?? 200;
  const pidlessGraceMs = options.pidlessGraceMs ?? 30_000;
  let held = false;
  let released = false;

  /** True when `dir` is held by nobody alive: a dead pid, or no pid file for longer than the grace period. */
  async function isDead(dir: string): Promise<boolean> {
    const owner = await ownerOf(dir);
    if (owner !== null) return !isPidAlive(owner);
    const info = await stat(dir).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs > pidlessGraceMs;
  }

  async function takeOverStale(): Promise<boolean> {
    if (!(await isDead(lockPath))) return false;
    await options.beforeStaleRename?.();
    const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, aside);
    } catch (error) {
      // Another waiter moved or released it first: just retry the mkdir.
      if (errno(error) === "ENOENT") return true;
      throw error;
    }
    if (await isDead(aside)) {
      await rm(aside, { recursive: true, force: true });
      return true;
    }
    // A live owner's lock (re-created between our check and the rename): put it back as soon as the path is free.
    const deadline = Date.now() + waitLimitMs;
    for (;;) {
      try {
        await rename(aside, lockPath);
        return false;
      } catch (error) {
        if (errno(error) !== "EEXIST" && errno(error) !== "ENOTEMPTY") throw error;
      }
      // Its owner exited meanwhile: nothing left to restore.
      if (await isDead(aside)) {
        await rm(aside, { recursive: true, force: true });
        return false;
      }
      if (Date.now() > deadline) throw new Error("timed out restoring a live test lock");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function acquire(): Promise<void> {
    const deadline = Date.now() + waitLimitMs;
    for (;;) {
      try {
        await mkdir(lockPath);
        await writeFile(path.join(lockPath, "pid"), String(process.pid));
        held = true;
        released = false;
        return;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
      if (await takeOverStale()) continue;
      if (Date.now() > deadline) throw new Error("timed out waiting for the test lock");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function release(): Promise<void> {
    if (!held || released) return;
    released = true;
    // Remove only a lock that is ours: rename it aside first so a concurrent takeover never loses its fresh lock.
    if ((await ownerOf(lockPath)) !== process.pid) return;
    const aside = `${lockPath}.released-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockPath, aside);
    } catch {
      return;
    }
    if ((await ownerOf(aside)) === process.pid) {
      await rm(aside, { recursive: true, force: true });
    } else {
      // Not ours after all (re-created in between): put it back.
      await rename(aside, lockPath).catch(() => undefined);
    }
  }

  function releaseSync(): void {
    if (!held || released) return;
    try {
      if (readFileSync(path.join(lockPath, "pid"), "utf8") === String(process.pid)) rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }

  return { acquire, release, takeOverStale, releaseSync };
}
