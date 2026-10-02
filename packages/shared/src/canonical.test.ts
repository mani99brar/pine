import { describe, expect, it } from "vitest";
import { canonicalJson, identify, rawCidFromSha256, sha256FromRawCid, sha256Hex } from "./canonical.js";

describe("canonical JSON (RFC 8785)", () => {
  it("sorts keys and normalises numbers", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1.0, y: 1e21 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":1e+21,"z":1}}');
  });
  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: undefined } as never)).toThrow();
    expect(() => canonicalJson({ a: new Date(0) } as never)).toThrow();
  });
});

describe("content identity", () => {
  it("matches the well-known raw CID of the empty block", () => {
    const id = identify(new Uint8Array());
    expect(id.sha256).toBe("0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(id.cid).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(rawCidFromSha256(id.sha256)).toBe(id.cid);
    expect(sha256FromRawCid(id.cid!)).toBe(id.sha256);
    expect(identify(new Uint8Array(262_145)).cid).toBeNull();
    expect(identify(new Uint8Array(262_144)).cid).not.toBeNull();
  });
  it("refuses non-raw CIDs", () => {
    expect(sha256FromRawCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBeNull();
    expect(sha256FromRawCid("not a cid")).toBeNull();
  });
  it("hashes bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
