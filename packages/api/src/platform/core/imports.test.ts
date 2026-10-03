// decisions.md: SIWE signing helpers and fakes live only in *.test.ts files or testing/ directories, and production code
// never imports from a testing/ directory or contracts/testing.ts (which would pull viem/accounts and fakes into the API).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(CORE_DIR, "..", "..");

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "testing" ? [] : productionFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/** Every module specifier of static imports, re-exports, side-effect imports and dynamic import() calls. */
export function importSpecifiers(source: string): string[] {
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1] ?? ""));
}

const forbidden = (specifier: string) => /(^|\/)testing(\/|\.js$|$)/.test(specifier) || specifier.includes("contracts/testing");

describe("production code never imports test helpers", () => {
  const files = [path.join(SRC_DIR, "main.ts"), path.join(SRC_DIR, "migrate.ts"), ...productionFiles(CORE_DIR)];

  it("scans main.ts, migrate.ts and every non-test file of platform/core", () => {
    expect(files.map((file) => path.relative(SRC_DIR, file))).toEqual(expect.arrayContaining(["main.ts", "migrate.ts", "platform/core/server.ts", "platform/core/app.ts"]));
    expect(files.some((file) => file.includes(`${path.sep}testing${path.sep}`))).toBe(false);
  });

  it("no import specifier points into a testing/ directory or contracts/testing", () => {
    const offenders = files.flatMap((file) => importSpecifiers(readFileSync(file, "utf8")).filter(forbidden).map((specifier) => `${path.relative(SRC_DIR, file)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });

  it("the scanner recognises every import form it must refuse", () => {
    const sample = [
      'import { signIn } from "./testing/harness.js";',
      'export { x } from "../../contracts/testing.js";',
      'import "./testing/suite-lock.js";',
      'const m = await import("./testing/harness.js");',
      'import { ok } from "./limits.js";',
    ].join("\n");
    expect(importSpecifiers(sample).filter(forbidden)).toEqual(["./testing/harness.js", "../../contracts/testing.js", "./testing/suite-lock.js", "./testing/harness.js"]);
  });
});
