// SEC-AUTH-02 / SEC-AUTH-09 (PRD-02 2.3): SIWE nonces, session and pre-session tokens are derived exactly from
// node:crypto randomBytes (16 bytes hex; 32 bytes base64url), never from Math.random or viem's generateSiweNonce.

import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const { newSiweNonce } = await import("./siwe.js");
const { newPresessionToken, newSessionToken } = await import("./sessions.js");
const randomBytes = vi.mocked(nodeCrypto.randomBytes);

afterEach(() => {
  randomBytes.mockClear();
});

describe("CSPRNG sources (SEC-AUTH-02, SEC-AUTH-09)", () => {
  it("SEC-AUTH-02 the SIWE nonce is randomBytes(16) as hex", () => {
    const bytes = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    randomBytes.mockImplementationOnce(((size: number) => {
      expect(size).toBe(16);
      return bytes;
    }) as typeof nodeCrypto.randomBytes);
    expect(newSiweNonce()).toBe("00112233445566778899aabbccddeeff");
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  for (const [name, make, prefix] of [
    ["session token", newSessionToken, "pine_s1_"],
    ["pre-session token", newPresessionToken, "pine_ps1_"],
  ] as const) {
    it(`SEC-AUTH-09 the ${name} is ${prefix} + base64url(randomBytes(32))`, () => {
      const bytes = Buffer.alloc(32, 0xfb);
      randomBytes.mockImplementationOnce(((size: number) => {
        expect(size).toBe(32);
        return bytes;
      }) as typeof nodeCrypto.randomBytes);
      expect(make()).toBe(`${prefix}${bytes.toString("base64url")}`);
      expect(randomBytes).toHaveBeenCalledTimes(1);
    });
  }
});
