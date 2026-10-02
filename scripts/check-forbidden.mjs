#!/usr/bin/env node
// Static security gate (SEC-SC-01, SEC-TX-04, SEC-TX-09, SEC-AUTH-02). Fails when a forbidden pattern appears in
// production sources. Tests may mention patterns (e.g. to assert their absence); only non-test source files are scanned.
// Usage: node scripts/check-forbidden.mjs   -> prints "# tests/# pass/# fail/# skipped" (TAP summary) and exits 1 on any hit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rules = [
  { name: "SEC-SC-01 no proxy/admin/pause primitives in contracts", dir: "contracts/src", ext: [".sol"],
    pattern: /\b(delegatecall|selfdestruct|tx\.origin|Ownable|AccessControl|Pausable|whenNotPaused|UUPS|Initializable|upgradeTo)\b/ },
  { name: "SEC-TX-09 no signing or key material in the API, txplan or shared code", dirs: ["packages/api/src", "packages/shared/src", "packages/indexer-native/src", "packages/read-model-envio/src"], ext: [".ts"],
    pattern: /(viem\/accounts|createWalletClient|privateKeyToAccount|mnemonicToAccount|signTypedData|eth_sign\b|personal_sign|signMessage\()/ },
  { name: "SEC-TX-04 no permit/Permit2/7702 authorizations", dirs: ["packages/api/src", "packages/shared/src"], ext: [".ts"],
    pattern: /\b(permit2?\s*\(|Permit2|signAuthorization|authorizationList)\b/i },
  { name: "SEC-AUTH-02 never use viem generateSiweNonce", dirs: ["packages/api/src"], ext: [".ts"], pattern: /generateSiweNonce/ },
  { name: "No dynamic code execution", dirs: ["packages/api/src", "packages/shared/src", "packages/indexer-native/src", "packages/read-model-envio/src", "packages/indexer-envio/src"], ext: [".ts"],
    pattern: /(\beval\s*\(|new Function\s*\(|child_process|\bvm\.runIn)/ },
  { name: "Trojan Source: no literal bidi or zero-width characters in source", dirs: ["packages", "contracts/src", "contracts/test", "contracts/script", "scripts"], ext: [".ts", ".mts", ".mjs", ".js", ".sol", ".json"],
    pattern: /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/, includeComments: true, includeTests: true },
  { name: "No unlimited approvals", dirs: ["packages/api/src", "packages/shared/src"], ext: [".ts"],
    pattern: /(maxUint256|MaxUint256|2n\s*\*\*\s*256n\s*-\s*1n|0xf{64}n)/ },
];

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".envio" || entry === "dist") continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const isTest = (file) => /(\.test\.ts|\.t\.sol|\/test\/|\/testing\/|contracts\.test\.ts)$/.test(file) || /\/(test|testing)\//.test(file);
let tests = 0, failed = 0;
const lines = [];
for (const rule of rules) {
  tests += 1;
  const hits = [];
  for (const dir of rule.dirs ?? [rule.dir]) {
    for (const file of walk(path.join(root, dir))) {
      if (!rule.ext.some((ext) => file.endsWith(ext)) || (isTest(file) && !rule.includeTests)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        const commentOnly = !rule.includeComments && (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
        if (!commentOnly && rule.pattern.test(line) && !line.includes("check-forbidden: allow")) hits.push(`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  if (hits.length) {
    failed += 1;
    lines.push(`not ok ${tests} - ${rule.name}`);
    for (const hit of hits) lines.push(`  # ${hit}`);
  } else {
    lines.push(`ok ${tests} - ${rule.name}`);
  }
}
console.log("TAP version 13");
for (const line of lines) console.log(line);
console.log(`1..${tests}`);
console.log(`# tests ${tests}`);
console.log(`# pass ${tests - failed}`);
console.log(`# fail ${failed}`);
console.log(`# skipped 0`);
process.exit(failed ? 1 : 0);
