import { describe, expect, it } from "vitest";
import { aadFor, createKeyRing, DecryptError } from "./crypto.js";
import { testKey } from "./testing/harness.js";

const USER_1 = "00000000-0000-4000-8000-000000000001";
const USER_2 = "00000000-0000-4000-8000-000000000002";

describe("token key ring (SEC-GH-06/07)", () => {
  const k1 = testKey("k1");
  const k2 = testKey("k2");

  it("round-trips with a random 96-bit IV per encryption and never stores plaintext", () => {
    const ring = createKeyRing({ current: k1, previous: [] });
    const a = ring.encrypt(USER_1, "access", "ghu_secretvalue");
    const b = ring.encrypt(USER_1, "access", "ghu_secretvalue");
    expect(a.iv.byteLength).toBe(12);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).toString("latin1")).not.toContain("ghu_secretvalue");
    expect(ring.decrypt(USER_1, "access", a)).toBe("ghu_secretvalue");
  });

  it("binds the AAD to user, provider, token kind and key id", () => {
    expect(aadFor(USER_1, "refresh", "k1").toString()).toBe(`pine:github:${USER_1}:refresh:k1`);
  });

  it("SEC-GH-06 a ciphertext swapped to another user fails to decrypt", () => {
    const ring = createKeyRing({ current: k1, previous: [] });
    const secret = ring.encrypt(USER_1, "access", "ghu_user1");
    expect(() => ring.decrypt(USER_2, "access", secret)).toThrow(DecryptError);
  });

  it("SEC-GH-06 a ciphertext moved to another token kind fails to decrypt", () => {
    const ring = createKeyRing({ current: k1, previous: [] });
    const secret = ring.encrypt(USER_1, "access", "ghu_user1");
    expect(() => ring.decrypt(USER_1, "refresh", secret)).toThrow(DecryptError);
  });

  it("SEC-GH-06 relabelling the key id or tampering with the ciphertext fails", () => {
    const ring = createKeyRing({ current: k2, previous: [{ id: "k1", key: k2.key }] });
    const secret = ring.encrypt(USER_1, "access", "ghu_user1");
    // Same key bytes under another id: the AAD differs, so authentication fails.
    expect(() => ring.decrypt(USER_1, "access", { ...secret, keyId: "k1" })).toThrow(DecryptError);
    const tampered = new Uint8Array(secret.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => ring.decrypt(USER_1, "access", { ...secret, ciphertext: tampered })).toThrow(DecryptError);
    expect(() => ring.decrypt(USER_1, "access", { ...secret, iv: new Uint8Array(8) })).toThrow(DecryptError);
  });

  it("SEC-GH-07 decrypts with a previous key after rotation and encrypts only with the current one", () => {
    const old = createKeyRing({ current: k1, previous: [] });
    const secret = old.encrypt(USER_1, "refresh", "ghr_old");
    const rotated = createKeyRing({ current: k2, previous: [k1] });
    expect(rotated.decrypt(USER_1, "refresh", secret)).toBe("ghr_old");
    expect(rotated.encrypt(USER_1, "refresh", "x").keyId).toBe("k2");
  });

  it("SEC-GH-07 a key removed from configuration decrypts nothing", () => {
    const old = createKeyRing({ current: k1, previous: [] });
    const secret = old.encrypt(USER_1, "access", "ghu_old");
    const retired = createKeyRing({ current: k2, previous: [] });
    expect(() => retired.decrypt(USER_1, "access", secret)).toThrow(DecryptError);
  });

  it("refuses keys that are not 32 bytes and duplicate key ids", () => {
    expect(() => createKeyRing({ current: { id: "k", key: new Uint8Array(31) }, previous: [] })).toThrow(/32 bytes/);
    expect(() => createKeyRing({ current: k1, previous: [{ id: "k1", key: k2.key }] })).toThrow(/unique/);
    expect(() => createKeyRing({ current: { id: "bad id", key: k1.key }, previous: [] })).toThrow(/key ids/);
  });
});
