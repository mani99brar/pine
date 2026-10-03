// The cross-process lock of test/lock.ts as plain functions over a lock directory, so its takeover rules are unit-tested
// (test/lock.test.ts) without taking the real lock. The lock is an atomic mkdir holding the owner pid; a dead owner, or
// an earlier file of this same fork process (a fork runs one file at a time), is taken over
// (features/indexers/decisions.md, test memory).

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LockOptions {
  waitLimitMs?: number;
  pollMs?: number;
  /** A directory without a pid file belongs to a writer between mkdir and writeFile; only a long-stale one is taken over. */
  orphanMs?: number;
}

export const LOCK_DEFAULTS = { waitLimitMs: 30 * 60_000, pollMs: 200, orphanMs: 30_000 } as const;

async function canTakeOver(dir: string, orphanMs: number): Promise<boolean> {
  const owner = Number(await readFile(path.join(dir, "pid"), "utf8").catch(() => "0"));
  if (owner > 0) {
    if (owner === process.pid) return true;
    try {
      process.kill(owner, 0);
      return false;
    } catch {
      return true;
    }
  }
  const info = await stat(dir).catch(() => null);
  return info !== null && Date.now() - info.mtimeMs > orphanMs;
}

export async function acquireLock(dir: string, options: LockOptions = {}): Promise<void> {
  const { waitLimitMs, pollMs, orphanMs } = { ...LOCK_DEFAULTS, ...options };
  const deadline = Date.now() + waitLimitMs;
  for (;;) {
    try {
      await mkdir(dir);
      await writeFile(path.join(dir, "pid"), String(process.pid));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await canTakeOver(dir, orphanMs)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the indexer-envio test lock");
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Removes the lock only if this process owns it. */
export function releaseLock(dir: string): void {
  try {
    if (readFileSync(path.join(dir, "pid"), "utf8") === String(process.pid)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already released or taken over.
  }
}
