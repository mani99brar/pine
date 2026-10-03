// The claims test lock's stale takeover (PRD-03 §8a/§8b), on a temporary lock path. No database: this file does not
// take the suite lock. Pids: a dead one is found by probing signal 0 for ESRCH; the live foreign owner is the parent
// process (never this process, which counts as self-owned); no child processes are spawned.

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirLock, isPidAlive, ownerOf } from "./test/lock-core.js";

function deadPid(): number {
  for (let pid = 999_999; pid < 999_999 + 10_000; pid += 1) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

let dir = "";
let lockPath = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pine-claims-lock-test-"));
  lockPath = path.join(dir, "suite.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lockOwnedBy(pid: number): Promise<void> {
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "pid"), String(pid));
}

const fast = { waitLimitMs: 300, pollMs: 10 };

describe("test lock stale takeover", () => {
  it("liveness: ESRCH is dead, EPERM and this process count as alive", () => {
    const dead = deadPid();
    expect(isPidAlive(dead)).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
    expect(process.ppid).not.toBe(process.pid);
    expect(isPidAlive(process.ppid)).toBe(true);
    // pid 1 belongs to root: signal 0 fails with EPERM for an unprivileged user (and succeeds for root); alive either way.
    expect(isPidAlive(1)).toBe(true);
  });

  it("takes over a dead owner's lock: the stale directory is removed and the lock is ours", async () => {
    const dead = deadPid();
    await lockOwnedBy(dead);
    const lock = createDirLock({ lockPath, ...fast });
    await lock.acquire();
    expect(await ownerOf(lockPath)).toBe(process.pid);
    // The renamed-aside stale directory is gone; nothing but our lock remains.
    expect(await readdir(dir)).toEqual(["suite.lock"]);
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("never takes over a live foreign owner's lock (waits, then times out, lock untouched)", async () => {
    await lockOwnedBy(process.ppid);
    const lock = createDirLock({ lockPath, ...fast });
    expect(await lock.takeOverStale()).toBe(false);
    await expect(lock.acquire()).rejects.toThrow(/timed out/);
    expect(await ownerOf(lockPath)).toBe(process.ppid);
    expect(await readdir(dir)).toEqual(["suite.lock"]);
  });

  it("treats a lock holding this process's pid as self-owned (never stale)", async () => {
    await lockOwnedBy(process.pid);
    const lock = createDirLock({ lockPath, ...fast });
    expect(await lock.takeOverStale()).toBe(false);
    expect(await ownerOf(lockPath)).toBe(process.pid);
  });

  it("puts back a live lock that another waiter created between the stale check and the rename", async () => {
    const dead = deadPid();
    await lockOwnedBy(dead);
    // Another waiter removes the dead lock and creates its own (live owner) after our stale check.
    const lock = createDirLock({
      lockPath,
      ...fast,
      beforeStaleRename: async () => {
        await rm(lockPath, { recursive: true, force: true });
        await lockOwnedBy(process.ppid);
      },
    });
    expect(await lock.takeOverStale()).toBe(false);
    // The live owner's lock is back in place and the aside copy is gone; only a dead owner's directory is removed.
    expect(await ownerOf(lockPath)).toBe(process.ppid);
    expect(await readdir(dir)).toEqual(["suite.lock"]);
  });

  it("a pid-less lock is stale only after the grace period", async () => {
    await mkdir(lockPath);
    const lock = createDirLock({ lockPath, ...fast, pidlessGraceMs: 60_000 });
    expect(await lock.takeOverStale()).toBe(false);
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(lockPath, old, old);
    await lock.acquire();
    expect(await ownerOf(lockPath)).toBe(process.pid);
    await lock.release();
  });

  it("release leaves a lock that is not ours in place", async () => {
    const lock = createDirLock({ lockPath, ...fast });
    await lock.acquire();
    // Simulate a takeover by another process after ours (our lock replaced by a live foreign owner's).
    await rm(lockPath, { recursive: true, force: true });
    await lockOwnedBy(process.ppid);
    await lock.release();
    expect(await ownerOf(lockPath)).toBe(process.ppid);
  });
});
