// Opaque keyset cursors: base64url(JSON {v: 1, scope, key}) with every key part validated on the way back in. A cursor
// is valid only for the order (scope) that produced it; anything else throws InvalidCursorError.

import { z } from "zod";
import { InvalidCursorError } from "@pine/shared/read-model";
import type { ClaimKeyset } from "./queries.js";

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).transform((value) => BigInt(value));
const market = z.string().regex(/^0x[0-9a-f]{40}$/);

const createdDesc = z.object({ v: z.literal(1), scope: z.literal("created_desc"), key: z.tuple([decimal, decimal]) });
const deadlineAsc = z.object({ v: z.literal(1), scope: z.literal("evidence_deadline_asc"), key: z.tuple([decimal, market]) });
const evidence = z.object({ v: z.literal(1), scope: z.literal("evidence"), key: z.tuple([decimal, decimal]) });

const encode = (scope: string, key: string[]): string => Buffer.from(JSON.stringify({ v: 1, scope, key }), "utf8").toString("base64url");

function parse(cursor: string): unknown {
  if (cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidCursorError();
  }
}

export function encodeClaimCursor(key: ClaimKeyset): string {
  return key.order === "created_desc" ? encode(key.order, [key.block.toString(), key.logIndex.toString()]) : encode(key.order, [key.deadline.toString(), key.market]);
}

export function decodeClaimCursor(cursor: string, order: "created_desc" | "evidence_deadline_asc"): ClaimKeyset {
  const value = parse(cursor);
  if (order === "created_desc") {
    const parsed = createdDesc.safeParse(value);
    if (!parsed.success) throw new InvalidCursorError();
    return { order, block: parsed.data.key[0], logIndex: parsed.data.key[1] };
  }
  const parsed = deadlineAsc.safeParse(value);
  if (!parsed.success) throw new InvalidCursorError();
  return { order, deadline: parsed.data.key[0], market: parsed.data.key[1] };
}

export function encodeEvidenceCursor(key: { block: bigint; logIndex: bigint }): string {
  return encode("evidence", [key.block.toString(), key.logIndex.toString()]);
}

export function decodeEvidenceCursor(cursor: string): { block: bigint; logIndex: bigint } {
  const parsed = evidence.safeParse(parse(cursor));
  if (!parsed.success) throw new InvalidCursorError();
  return { block: parsed.data.key[0], logIndex: parsed.data.key[1] };
}
