// Test-only cross-process directory lock (never imported by production code). A lock is a directory holding the owner's
// pid. It is installed atomically: a staging directory that already contains the pid is renamed onto the lock path, so a
// visible lock always names its owner. A dead owner's lock is taken over by atomically renaming it aside and checking
// that the renamed lock still names that dead owner; when another waiter installed a fresh lock in between, the fresh
// lock is put back. This keeps one holder even when several waiters see the same SIGKILLed owner (each PGlite holder
// needs ~1 GB, so two concurrent holders can trigger the OOM killer and cascade).

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DirLockOptions {
  timeoutMs: number;
  pollMs: number;
  /** "take": a lock already held by this process is taken over (an earlier file of the same fork); "throw": refuse. */
  ownPid: "take" | "throw";
  name: string;
}

const pidFile = (dir: string) => path.join(dir, "pid");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The owner pid, 0 for a lock directory without a readable pid, null when there is no lock. */
async function owner(dir: string): Promise<number | null> {
  try {
    return Number((await readFile(pidFile(dir), "utf8")).trim()) || 0;
  } catch {
    return (await stat(dir).catch(() => null)) === null ? null : 0;
  }
}

async function tryInstall(dir: string): Promise<boolean> {
  const staging = `${dir}.${process.pid}.${randomUUID()}`;
  await mkdir(staging);
  await writeFile(pidFile(staging), String(process.pid));
  try {
    // Atomic; fails with ENOTEMPTY/EEXIST while another lock (always holding a pid file) is in place.
    await rename(staging, dir);
    return true;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM" || code === "EISDIR") return false;
    throw error;
  }
}

/** Removes the lock only if it still names `expected` (dead or this process). */
async function takeOver(dir: string, expected: number): Promise<void> {
  const grave = `${dir}.stale.${randomUUID()}`;
  try {
    await rename(dir, grave);
  } catch {
    return; // someone else took it over or released it
  }
  const found = await owner(grave);
  if (found === expected || found === 0 || found === null) {
    await rm(grave, { recursive: true, force: true });
    return;
  }
  // We moved a fresh lock installed after we read the dead owner's pid: put it back.
  await rename(grave, dir).catch(async () => {
    await rm(grave, { recursive: true, force: true });
  });
}

export async function acquireDirLock(dir: string, options: DirLockOptions): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await tryInstall(dir)) return;
    const current = await owner(dir);
    if (current === process.pid) {
      if (options.ownPid === "throw") throw new Error(`this process already holds the ${options.name} lock`);
      await takeOver(dir, current);
      continue;
    }
    if (current !== null && !alive(current)) {
      await takeOver(dir, current);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the ${options.name} lock`);
    await sleep(options.pollMs);
  }
}

/** Synchronous so it can run in a process "exit" handler. Removes the lock only when this process owns it. */
export function releaseDirLock(dir: string): void {
  try {
    if (readFileSync(pidFile(dir), "utf8").trim() === String(process.pid)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already released or taken over.
  }
}
