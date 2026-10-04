// VENDORED from packages/shared/src by frontend/scripts/sync-shared.mjs. Do not edit: change the original and re-run
// the script (CI runs it with --check).
// FROZEN shared primitive types.

import { z } from "zod";

/** 0x-prefixed 20-byte address. Stored lowercase; displayed EIP-55 checksummed. */
export type Address = `0x${string}`;
/** 0x-prefixed lowercase hex of exactly 32 bytes. */
export type Hex32 = `0x${string}`;
/** 0x-prefixed lowercase hex of any length. */
export type Hex = `0x${string}`;

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address")
  .transform((value) => value.toLowerCase() as Address);

export const hex32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((value) => value.toLowerCase() as Hex32);

/**
 * Git commit id: full 40-hex SHA-1, lowercase. GitHub has no SHA-256 repositories; accepting 64-hex ids would only
 * widen the input space (SEC-GH-15). On-chain (ClaimRegistry) it is a `bytes20`: pass `0x${commit}`.
 */
export const gitObjectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/, "must be a full 40-hex git commit id")
  .transform((value) => value.toLowerCase());

/** Unsigned integer amount in base units, as a decimal string at API edges. */
export const uintStringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,77})$/, "must be a non-negative base-10 integer without leading zeros")
  .transform((value) => BigInt(value));

/** Unix seconds as a JS number (safe: < 2^53). */
export const unixSecondsSchema = z.number().int().nonnegative().max(2 ** 40);

export type UnixSeconds = number;
