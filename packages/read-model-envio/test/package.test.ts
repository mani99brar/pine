// Package-level guarantees: the live smoke script exists and is excluded from `test` (operator-settled scope), and the
// fake only serves snapshots bound to the exact events it is asked about.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scenarioClaimsAndEvidence, scenarioManyClaims, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import liveConfig from "../vitest.live.config.js";
import unitConfig from "../vitest.config.js";
import { eventsSha256, loadSnapshots, snapshotFor } from "./snapshots.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("test:live", () => {
  it("exists, runs the live config, and is not part of `test`", () => {
    expect(pkg.scripts["test:live"]).toBe("vitest run --config vitest.live.config.ts");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(unitConfig.test?.include).toEqual(["src/**/*.test.ts", "test/**/*.test.ts"]);
    expect(liveConfig.test?.include).toEqual(["live/**/*.live.ts"]);
    // The live file is not matched by the unit globs (it lives in live/ and is not a .test.ts file).
    expect("live/smoke.live.ts").not.toMatch(/^(src|test)\/.*\.test\.ts$/);
  });

  it("refuses to run without ENVIO_GRAPHQL_URL instead of passing vacuously", () => {
    expect(readFileSync(path.join(ROOT, "live/smoke.live.ts"), "utf8")).toMatch(/if \(url === undefined \|\| url === ""\) throw new Error/);
  });
});

describe("snapshot binding", () => {
  it("there is exactly one committed snapshot per frozen scenario, each bound to that scenario's events", () => {
    const snapshots = loadSnapshots();
    expect(snapshots.map((item) => item.scenario).sort()).toEqual(["claims-and-evidence", "many-claims", "oracle"]);
    expect(snapshotFor(scenarioClaimsAndEvidence().events).scenario).toBe("claims-and-evidence");
    expect(snapshotFor(scenarioOracle().events).scenario).toBe("oracle");
    expect(snapshotFor(scenarioManyClaims().events).scenario).toBe("many-claims");
  });

  it("the factory throws for events whose SHA-256 differs from every recorded hash", () => {
    const events = scenarioOracle().events;
    const tampered = [...events.slice(0, -1), { ...events.at(-1)!, logIndex: events.at(-1)!.logIndex + 1 }];
    expect(eventsSha256(tampered)).not.toBe(eventsSha256(events));
    expect(() => snapshotFor(tampered)).toThrow(/no committed entity snapshot/);
    expect(() => snapshotFor(events.slice(1))).toThrow(/no committed entity snapshot/);
  });
});
