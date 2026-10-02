#!/usr/bin/env node
// Runs `forge test --json` and prints a Node-TAP style summary that the workflow verifier parses
// (`# tests N`, `# pass N`, `# fail N`, `# skipped N`). Extra arguments are passed to forge
// (for example `--match-path 'test/registry/*'` or `--no-match-contract Fork`).
// Exit status: 0 only when forge exited 0, at least one test ran and none failed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "contracts");
const args = ["test", "--json", ...process.argv.slice(2)];
const run = spawnSync("forge", args, {
  cwd: contractsDir,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  env: process.env,
});

if (run.error) {
  console.error(`forge could not be started: ${run.error.message}`);
  process.exit(2);
}
if (run.stderr) process.stderr.write(run.stderr);

// forge prints the JSON result object on stdout; compiler output may precede it.
const stdout = run.stdout ?? "";
const start = stdout.indexOf("{");
let suites = null;
if (start !== -1) {
  try {
    suites = JSON.parse(stdout.slice(start));
  } catch {
    suites = null;
  }
}
if (suites === null || typeof suites !== "object") {
  process.stdout.write(stdout);
  console.error("Could not parse `forge test --json` output; no test evidence.");
  process.exit(run.status === 0 ? 2 : run.status ?? 2);
}

let pass = 0;
let fail = 0;
let skipped = 0;
let n = 0;
const lines = [];
for (const [suiteName, suite] of Object.entries(suites)) {
  for (const [testName, result] of Object.entries(suite.test_results ?? {})) {
    n += 1;
    const status = String(result.status ?? "").toLowerCase();
    const label = `${suiteName.split(":").pop()}::${testName}`;
    if (status === "success") {
      pass += 1;
      lines.push(`ok ${n} - ${label}`);
    } else if (status === "skipped") {
      skipped += 1;
      lines.push(`ok ${n} - ${label} # SKIP`);
    } else {
      fail += 1;
      lines.push(`not ok ${n} - ${label}`);
      const reason = result.reason ? String(result.reason) : "failed";
      lines.push(`  ---\n  reason: ${JSON.stringify(reason)}\n  counterexample: ${JSON.stringify(result.counterexample ?? null)}\n  ...`);
    }
  }
}

console.log("TAP version 13");
for (const line of lines) console.log(line);
console.log(`1..${n}`);
console.log(`# tests ${n}`);
console.log(`# pass ${pass}`);
console.log(`# fail ${fail}`);
console.log(`# skipped ${skipped}`);

if (run.status !== 0 || fail > 0 || pass === 0) process.exit(run.status && run.status !== 0 ? run.status : 1);
