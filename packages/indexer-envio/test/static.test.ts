// Static and pure checks (no createTestIndexer, so no test lock): handler purity (SEC-IDX-03), the test-lock rule,
// package boundaries, the snapshot format and its write rule, and configuration parsing.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import { parseTimeout } from "../src/lib/question.js";
import { buildSnapshot, committedSnapshot, eventsSha256, serializeSnapshot, snapshotPath } from "./snapshot.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("handlers are deterministic and side-effect free", () => {
  const sources = filesUnder(path.join(ROOT, "src"));

  it("SEC-IDX-03 no handler source performs I/O, reads clocks or randomness, or calls Envio effects", () => {
    expect(sources.length).toBeGreaterThanOrEqual(7);
    const forbidden = /\bfetch\s*\(|\bhttps?:\/\/|context\.effect|createEffect|Date\.now|new Date\b|Math\.random|setTimeout|setInterval|\bimport\s*\(|\brequire\s*\(/;
    for (const file of sources) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*)/.test(line))
        .join("\n");
      expect(forbidden.exec(code)?.[0], path.relative(ROOT, file)).toBeUndefined();
    }
  });

  /** Every module specifier of a source, in any form: multi-line and side-effect imports, `export … from`, `import()`, `require()`. */
  const specifiersOf = (code: string): string[] => ts.preProcessFile(code, true, true).importedFiles.map((item) => item.fileName);

  it("SEC-IDX-03 handler sources import only envio, viem and each other", () => {
    for (const file of sources) {
      const specifiers = specifiersOf(readFileSync(file, "utf8"));
      for (const specifier of specifiers) expect(["envio", "viem"].includes(specifier) || specifier.startsWith("../") || specifier.startsWith("./"), `${file}: ${specifier}`).toBe(true);
    }
  });

  it("the import check sees every import form (multi-line, side-effect, re-export, dynamic, require)", () => {
    const code = [
      'import {\n  request,\n} from "node:https";',
      'import "node:net";',
      'export { x } from "node:dgram";',
      'export * from "undici";',
      'const a = await import("node:http");',
      'const b = require("node:tls");',
      'import type { T } from "./local.js";',
    ].join("\n");
    expect(specifiersOf(code)).toEqual(["node:https", "node:net", "node:dgram", "undici", "node:http", "node:tls", "./local.js"]);
  });

  it("SEC-IDX-05 no handler registration accepts events from any address (no `wildcard`)", () => {
    let registrations = 0;
    for (const file of sources) {
      const code = readFileSync(file, "utf8");
      registrations += [...code.matchAll(/indexer\.onEvent\(\{ contract: "\w+", event: "\w+" \}/g)].length;
      expect(code, path.relative(ROOT, file)).not.toMatch(/wildcard/);
    }
    // One registration per event of config.yaml (1 + 3 + 7 + 1 + 7), each with exactly { contract, event }.
    expect(registrations).toBe(19);
  });

  it("process.env is read only once, for the question timeout", () => {
    const readers = sources.filter((file) => readFileSync(file, "utf8").includes("process.env"));
    expect(readers.map((file) => path.relative(ROOT, file))).toEqual(["src/lib/question.ts"]);
  });
});

describe("test and package boundaries", () => {
  it("every test file that runs createTestIndexer imports the cross-process lock first (decisions.md, test memory)", () => {
    const files = readdirSync(path.join(ROOT, "test")).filter((file) => file.endsWith(".test.ts"));
    // Heavy = imports the Envio runtime directly or through the differential harness.
    const heavy = files.filter((file) => /^import .* from "(envio|\.\/differential\.js)";$/m.test(readFileSync(path.join(ROOT, "test", file), "utf8")));
    expect(heavy.sort()).toEqual(["entities.test.ts", "handlers.test.ts", "timeout-invalid.test.ts", "timeout.test.ts"]);
    for (const file of heavy) {
      const firstImport = /^import [^\n]*$/m.exec(readFileSync(path.join(ROOT, "test", file), "utf8"))?.[0];
      expect(firstImport, file).toBe('import "./lock.js";');
    }
  });

  it("nothing in indexer-envio or read-model-envio imports @pine/api (decisions.md)", () => {
    const files = [...filesUnder(ROOT).filter((file) => !file.includes("node_modules")), ...filesUnder(path.join(ROOT, "../read-model-envio")).filter((file) => !file.includes("node_modules"))];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/from "@pine\/api/);
  });
});

describe("entity snapshots", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("sort entities and rows by id, write bigints as decimal strings and undefined as null, and bind the events' SHA-256", () => {
    const events = scenarioOracle().events;
    const snapshot = buildSnapshot("x", events, {
      Zeta: [{ id: "b", value: 2n ** 70n, missing: undefined } as { id: string }],
      Alpha: [{ id: "b", flag: true } as { id: string }, { id: "a", list: ["1", "2"] } as { id: string }],
    });
    expect(Object.keys(snapshot.entities)).toEqual(["Alpha", "Zeta"]);
    expect(snapshot.entities.Alpha!.map((row) => row.id)).toEqual(["a", "b"]);
    expect(snapshot.entities.Zeta).toEqual([{ id: "b", missing: null, value: "1180591620717411303424" }]);
    expect(snapshot.eventsSha256).toBe(eventsSha256(events));
    expect(snapshot.eventsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the events hash changes with any event field (order-sensitive, bigint-aware)", () => {
    const events = scenarioOracle().events;
    const base = eventsSha256(events);
    expect(eventsSha256(scenarioOracle().events)).toBe(base);
    expect(eventsSha256([...events].reverse())).not.toBe(base);
    expect(eventsSha256([{ ...events[0]!, blockNumber: events[0]!.blockNumber + 1n }, ...events.slice(1)])).not.toBe(base);
  });

  it("are written only with UPDATE_SNAPSHOTS=1; otherwise the committed file is read and never touched", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pine-envio-snapshot-"));
    dirs.push(dir);
    const events = scenarioOracle().events;
    const actual = buildSnapshot("unit", events, { A: [{ id: "a" }] });
    vi.stubEnv("UPDATE_SNAPSHOTS", "");
    expect(committedSnapshot("unit", actual, dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    vi.stubEnv("UPDATE_SNAPSHOTS", "1");
    expect(committedSnapshot("unit", actual, dir)).toBe(serializeSnapshot(actual));
    vi.stubEnv("UPDATE_SNAPSHOTS", "");
    const changed = buildSnapshot("unit", events, { A: [{ id: "b" }] });
    expect(committedSnapshot("unit", changed, dir)).toBe(serializeSnapshot(actual));
    expect(readFileSync(snapshotPath("unit", dir), "utf8")).toBe(serializeSnapshot(actual));
  });
});

describe("schema.graphql", () => {
  const schema = readFileSync(path.join(ROOT, "schema.graphql"), "utf8");
  const fieldLines = () => {
    const lines: string[] = [];
    let inType = false;
    for (const raw of schema.split("\n")) {
      const line = raw.replace(/#.*$/, "").trim();
      if (/^type \w+ \{$/.test(line)) inType = true;
      else if (line === "}") inType = false;
      else if (inType && /^\w+\s*:/.test(line)) lines.push(line);
    }
    return lines;
  };

  it("has no list-typed fields (no Postgres arrays; lists are Json, PRD-05 3.1/3a)", () => {
    const fields = fieldLines();
    expect(fields.length).toBeGreaterThan(80);
    for (const line of fields) expect(line, line).not.toMatch(/:\s*\[/);
  });

  it("declares no @derivedFrom (virtual list) fields", () => {
    expect(schema).not.toMatch(/@derivedFrom/);
  });
});

describe("ENVIO_QUESTION_TIMEOUT", () => {
  it("defaults to Seer's 302400 s and accepts positive integers", () => {
    expect(parseTimeout(undefined)).toBe(302_400n);
    expect(parseTimeout("")).toBe(302_400n);
    expect(parseTimeout("86400")).toBe(86_400n);
  });

  it("refuses anything else (fail closed at load)", () => {
    for (const raw of ["0", "-1", "1.5", "1e5", " 5", "abc", "12345678901"]) expect(() => parseTimeout(raw), raw).toThrow();
  });
});
