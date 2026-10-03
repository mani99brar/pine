// The takeover rules of the cross-process test lock (decisions.md, test memory), on temporary lock directories; the
// real lock (test/lock.ts) is not taken here.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, LOCK_DEFAULTS, releaseLock } from "./lock-core.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lockDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pine-envio-lock-test-"));
  roots.push(root);
  return path.join(root, "lock");
}

function holdBy(dir: string, pid: number): void {
  mkdirSync(dir);
  writeFileSync(path.join(dir, "pid"), String(pid));
}

/** A live process other than this one, and a way to end it. */
async function otherProcess(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  return {
    pid: child.pid!,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

const owner = (dir: string) => readFileSync(path.join(dir, "pid"), "utf8");

describe("cross-process test lock", () => {
  it("waits up to 30 minutes by default, polling every 200 ms; a pid-less directory is an orphan after 30 s", () => {
    expect(LOCK_DEFAULTS).toEqual({ waitLimitMs: 30 * 60_000, pollMs: 200, orphanMs: 30_000 });
  });

  it("takes a free lock and records this process as the owner; release removes it", async () => {
    const dir = lockDir();
    await acquireLock(dir);
    expect(owner(dir)).toBe(String(process.pid));
    releaseLock(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("waits while another live process holds it, and takes it over once that process is dead", async () => {
    const dir = lockDir();
    const other = await otherProcess();
    holdBy(dir, other.pid);
    await expect(acquireLock(dir, { waitLimitMs: 300, pollMs: 20 })).rejects.toThrow(/timed out waiting/);
    expect(owner(dir)).toBe(String(other.pid));
    const waiting = acquireLock(dir, { waitLimitMs: 10_000, pollMs: 20 });
    await other.stop();
    await waiting;
    expect(owner(dir)).toBe(String(process.pid));
  });

  it("takes over a lock left by an earlier file of this same process", async () => {
    const dir = lockDir();
    holdBy(dir, process.pid);
    await acquireLock(dir, { waitLimitMs: 0 });
    expect(owner(dir)).toBe(String(process.pid));
  });

  it("takes over a stale directory without a pid file, but not a fresh one (a writer between mkdir and writeFile)", async () => {
    const dir = lockDir();
    mkdirSync(dir);
    await expect(acquireLock(dir, { waitLimitMs: 100, pollMs: 20, orphanMs: 60_000 })).rejects.toThrow(/timed out waiting/);
    const old = new Date(Date.now() - 120_000);
    utimesSync(dir, old, old);
    await acquireLock(dir, { waitLimitMs: 100, pollMs: 20, orphanMs: 60_000 });
    expect(owner(dir)).toBe(String(process.pid));
  });

  it("never releases a lock another process owns", async () => {
    const dir = lockDir();
    const other = await otherProcess();
    try {
      holdBy(dir, other.pid);
      releaseLock(dir);
      expect(owner(dir)).toBe(String(other.pid));
    } finally {
      await other.stop();
    }
  });
});
