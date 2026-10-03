import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRedactor, safeErrorMessage } from "../src/redact.js";

// This package's redactor (it must not import @pine/api) against the frozen API redactor (operator gap 22): the code is
// kept identical, and the pattern rules are exercised with NO registered secret.

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.join(here, relative), "utf8");

/** The code after the leading comment block, without the API-only `redactDeep` helper (audit details). */
function body(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => !line.startsWith("//") && line.trim() !== "");
  const code = lines.slice(start).join("\n");
  return code.replace(/\/\*\* Redacts every string inside a JSON-like value[\s\S]*?\n}\n/, "").trimEnd();
}

describe("redactor copy (SEC-OPS-03)", () => {
  it("is code-identical to the frozen packages/api/src/contracts/redact.ts (minus the API-only redactDeep)", () => {
    const api = read("../../api/src/contracts/redact.ts");
    expect(api).toContain("export function redactDeep");
    expect(body(read("../src/redact.ts"))).toBe(body(api));
  });

  const redact = createRedactor();
  it.each([
    ["an API key in a URL path", "POST https://gnosis-mainnet.g.alchemy.com/v2/AbCdEf0123456789xyz failed", "AbCdEf0123456789xyz"],
    ["an API key in a URL query", "GET https://rpc.example.io/?apikey=QwErTy0123456789 failed", "QwErTy0123456789"],
    ["postgres userinfo", "connect postgres://pine_indexer:Sup3rS3cret@db.internal:5432/pine refused", "Sup3rS3cret"],
    ["scheme-less userinfo", "auth admin:Sup3rS3cret@db.internal.example failed", "Sup3rS3cret"],
    ["a PEM private key", "key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY----- loaded", "MIIEvQIBADANBg"],
    ["a Bearer token", "header Bearer abcdefghijklmnop123 rejected", "abcdefghijklmnop123"],
    ["a JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U seen", "eyJzdWIiOiIxMjM0NTY3ODkwIn0"],
    ["an un-prefixed 32-byte hex secret", `raw ${"a1".repeat(32)} leaked`, "a1".repeat(32)],
    ["an apikey=value label", "request failed apikey=Zx9Zx9Zx9Zx9 retry", "Zx9Zx9Zx9Zx9"],
    ["a password: value label", 'config {"password": "hunter2hunter2"} invalid', "hunter2hunter2"],
  ])("removes %s without any registered secret", (_label, input, secret) => {
    const output = redact(input);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });

  it("keeps public chain data (0x-prefixed hashes and addresses) and plain text", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const address = `0x${"cd".repeat(20)}`;
    expect(redact(`log ${hash} from ${address} at block 42`)).toBe(`log ${hash} from ${address} at block 42`);
  });

  it("registered secrets are removed exactly, including their URL-encoded form; output is bounded", () => {
    const withSecret = createRedactor(["p@ss word/1234"]);
    expect(withSecret(`a p@ss word/1234 b ${encodeURIComponent("p@ss word/1234")} c`)).toBe("a [REDACTED] b [REDACTED] c");
    expect(createRedactor()("x".repeat(10_000)).length).toBeLessThanOrEqual(2_003);
  });

  it("safeErrorMessage keeps only the redacted name and message (no stack, no cause)", () => {
    const error = new Error("failed https://rpc.example.io/v2/K3yK3yK3yK3y0000", { cause: new Error("secret cause") });
    const message = safeErrorMessage(error, redact);
    expect(message).toBe("Error: failed https://rpc.example.io/[REDACTED]");
    expect(safeErrorMessage({ toString: () => "K3y" }, redact)).toBe("Unknown error");
  });
});
