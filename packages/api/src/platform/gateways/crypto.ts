// AES-256-GCM encryption of stored GitHub secrets (SEC-GH-06/07). Random 96-bit IV per encryption; the AAD binds the
// ciphertext to its user, provider, kind and key id, so a ciphertext copied to another row (another user or kind) or
// relabelled with another key id fails authentication. Decryption accepts the current and every previous key.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PlatformSecrets } from "../../contracts/platform.js";

/** "pkce_verifier" protects the PKCE code verifier stored with an OAuth state (never a GitHub token). */
export type SecretKind = "access" | "refresh" | "pkce_verifier";

export interface EncryptedSecret {
  keyId: string;
  iv: Uint8Array;
  /** Ciphertext followed by the 16-byte GCM tag. */
  ciphertext: Uint8Array;
}

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function aadFor(userId: string, kind: SecretKind, keyId: string): Buffer {
  return Buffer.from(`pine:github:${userId.toLowerCase()}:${kind}:${keyId}`, "utf8");
}

export interface KeyRing {
  currentKeyId: string;
  /** Ids of keys that may decrypt but no longer encrypt. */
  previousKeyIds: string[];
  encrypt(userId: string, kind: SecretKind, plaintext: string): EncryptedSecret;
  /** Throws DecryptError for an unknown key id, wrong AAD, tampered ciphertext or malformed IV. */
  decrypt(userId: string, kind: SecretKind, secret: EncryptedSecret): string;
}

/** Validates the configured keys (32 bytes each, unique well-formed ids) and builds the key ring. */
export function createKeyRing(keys: PlatformSecrets["tokenEncryptionKeys"]): KeyRing {
  const all = [keys.current, ...keys.previous];
  const byId = new Map<string, Buffer>();
  for (const entry of all) {
    if (!KEY_ID_PATTERN.test(entry.id)) throw new Error("Token encryption key ids must match [A-Za-z0-9_.-]{1,64}");
    if (entry.key.byteLength !== 32) throw new Error("Token encryption keys must be exactly 32 bytes");
    if (byId.has(entry.id)) throw new Error("Token encryption key ids must be unique");
    byId.set(entry.id, Buffer.from(entry.key));
  }
  const currentKeyId = keys.current.id;
  return {
    currentKeyId,
    previousKeyIds: keys.previous.map((entry) => entry.id),
    encrypt(userId, kind, plaintext) {
      const key = byId.get(currentKeyId);
      if (!key) throw new Error("Current token encryption key is missing");
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aadFor(userId, kind, currentKeyId));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
      return { keyId: currentKeyId, iv: new Uint8Array(iv), ciphertext: new Uint8Array(body) };
    },
    decrypt(userId, kind, secret) {
      const key = byId.get(secret.keyId);
      if (!key) throw new DecryptError("Unknown token encryption key id");
      if (secret.iv.byteLength !== IV_BYTES || secret.ciphertext.byteLength < TAG_BYTES) throw new DecryptError("Malformed ciphertext");
      const body = Buffer.from(secret.ciphertext);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv), { authTagLength: TAG_BYTES });
        decipher.setAAD(aadFor(userId, kind, secret.keyId));
        decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));
        return Buffer.concat([decipher.update(body.subarray(0, body.byteLength - TAG_BYTES)), decipher.final()]).toString("utf8");
      } catch {
        throw new DecryptError("Token ciphertext failed authentication");
      }
    },
  };
}
