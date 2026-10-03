// Evidence content intake (PRD-04 section 2.1, SEC-EVID-01/03/05/08/09): canonical, submitter-bound manifests and
// opaque artifacts. Bytes are never interpreted, rendered, extracted or fetched from any URL; file names are never
// stored or returned; quotas are consumed only after the bytes passed every check (before storage), and only once per
// (user, digest): a re-upload of the user's own content is answered from the stored row while the bytes are still stored.

import type { FastifyRequest } from "fastify";
import type { Multipart } from "@fastify/multipart";
import { z } from "zod";
import { canonicalJson, identify, RAW_CID_MAX_BYTES } from "@pine/shared/canonical";
import { encodeEvidenceManifest, EVIDENCE_MANIFEST_MAX_BYTES, evidenceManifestSchema, type EvidenceManifest } from "@pine/shared/evidence";
import type { Hex32 } from "@pine/shared/types";
import type { AppContext, SessionInfo } from "../../contracts/app.js";
import { ApiError, type ErrorIssue } from "../../contracts/errors.js";
import { auditIp, requireClaim, sessionOf, toJsonValue, type MarketsRouteDeps, type MarketsState } from "./common.js";
import { one, sql, toNumber, ts } from "./db.js";

/** JSON bodies of the manifest route may exceed the platform's 64 KiB default: canonical form <= 256 KiB, plus whitespace. */
export const MANIFEST_BODY_LIMIT = 2 * EVIDENCE_MANIFEST_MAX_BYTES;

const sha256Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex")
  .transform((value) => value.toLowerCase() as Hex32);

function zodIssues(error: z.ZodError): ErrorIssue[] {
  return error.issues.slice(0, 50).map((issue) => ({ path: issue.path.map((part) => (typeof part === "number" ? part : String(part))), message: issue.message }));
}

interface Upload {
  sha256: Hex32;
  cid: string;
  size: number;
}

async function previousUpload(ctx: AppContext, userId: string, sha256: Hex32): Promise<Upload | null> {
  const row = await one<{ sha256: string; cid: string; size: unknown }>(
    ctx.db,
    sql`SELECT sha256, cid, size::int AS size FROM markets_uploads WHERE user_id = ${userId}::uuid AND sha256 = ${sha256}`,
  );
  return row ? { sha256: row.sha256 as Hex32, cid: row.cid, size: toNumber(row.size) } : null;
}

/**
 * Stores verified bytes once per (user, digest). A digest this user already uploaded is answered from the existing
 * row (no store call, no quota) only while the content store still has the bytes; otherwise it is stored again and
 * paid for like a first upload. Quotas are consumed BEFORE storage (SEC-EVID-01: the frozen gateways can neither
 * refund nor delete, so nothing is stored that was not paid for), bytes first, then the upload count: the frozen
 * QuotaGateway has only consume(), so when the byte quota succeeds and the count quota refuses, those bytes stay spent
 * (a deterministic, self-inflicted gap bounded by the count quota; operator decision, PRD-04 4b). Then the bytes are
 * stored and the upload recorded (ON CONFLICT DO NOTHING). Two identical concurrent first uploads may both consume
 * (accepted).
 */
async function storeOnce(ctx: AppContext, request: FastifyRequest, session: SessionInfo, input: { bytes: Uint8Array; sha256: Hex32; kind: "manifest" | "artifact"; mediaType: string; maxBytes: number }): Promise<Upload> {
  const previous = await previousUpload(ctx, session.userId, input.sha256);
  if (previous && (await ctx.contentStore.has(input.sha256))) return previous;
  await ctx.quotas.consume(session.userId, "evidence_bytes_per_day", input.bytes.byteLength);
  await ctx.quotas.consume(session.userId, "evidence_uploads_per_day");
  const stored = await ctx.contentStore.put({ bytes: input.bytes, declaredMediaType: input.mediaType, maxBytes: input.maxBytes });
  if (stored.sha256.toLowerCase() !== input.sha256) throw new ApiError("INTEGRITY_FAILED", "Stored content does not match its digest");
  const inserted = await one<{ sha256: string }>(
    ctx.db,
    sql`INSERT INTO markets_uploads (user_id, sha256, cid, kind, size, created_at)
        VALUES (${session.userId}::uuid, ${input.sha256}, ${stored.cid}, ${input.kind}, ${input.bytes.byteLength}, ${ts(ctx.clock.now())})
        ON CONFLICT (user_id, sha256) DO NOTHING RETURNING sha256`,
  );
  // Audited once per first upload, and again when vanished content was stored (and paid for) anew.
  if (inserted || previous) {
    await ctx.audit.record({
      actorUserId: session.userId,
      action: `markets.evidence.${input.kind}_uploaded`,
      subjectType: "content",
      subjectId: input.sha256,
      details: { size: input.bytes.byteLength, cid: stored.cid, restored: previous !== null },
      ip: auditIp(request),
    });
  }
  return { sha256: stored.sha256.toLowerCase() as Hex32, cid: stored.cid, size: stored.size };
}

/** Validates a manifest object against the claim and the stored artifacts; returns the canonical bytes. */
export async function checkManifest(ctx: AppContext, state: MarketsState, session: SessionInfo, body: unknown): Promise<{ manifest: EvidenceManifest; bytes: Uint8Array; sha256: Hex32 }> {
  const parsed = evidenceManifestSchema.safeParse(body);
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "The evidence manifest does not match urn:pine:evidence-manifest:v1", { issues: zodIssues(parsed.error) });
  const manifest = parsed.data;
  // The stored bytes must be exactly what the client sent, in normal form: a manifest that the schema would rewrite
  // (mixed-case addresses or digests) is refused, so the digest the client commits to is the digest Pine stores.
  let canonicalInput: string;
  try {
    canonicalInput = canonicalJson(toJsonValue(body));
  } catch {
    throw new ApiError("VALIDATION_FAILED", "The evidence manifest is not representable as canonical JSON");
  }
  if (canonicalInput !== canonicalJson(toJsonValue(manifest))) {
    throw new ApiError("VALIDATION_FAILED", "The evidence manifest is not in canonical form (addresses, digests and the commit must be lowercase)");
  }
  const issues: ErrorIssue[] = [];
  if (manifest.submitter !== session.wallet.toLowerCase()) issues.push({ path: ["submitter"], message: "must equal the signed-in wallet" });
  if (manifest.claim.chainId !== ctx.config.chainId) issues.push({ path: ["claim", "chainId"], message: "must be the configured chain" });
  let claim;
  try {
    claim = await requireClaim(ctx, state, manifest.claim.market);
  } catch {
    claim = null;
    issues.push({ path: ["claim", "market"], message: "is not a registered claim market" });
  }
  if (claim) {
    if (manifest.claim.claimDocumentSha256 !== claim.claimDocumentSha256) issues.push({ path: ["claim", "claimDocumentSha256"], message: "does not match the claim" });
    if (manifest.claim.commit !== claim.commit) issues.push({ path: ["claim", "commit"], message: "does not match the claim" });
  }
  for (const [index, artifact] of manifest.artifacts.entries()) {
    const stored = await ctx.contentStore.get(artifact.sha256);
    if (!stored) issues.push({ path: ["artifacts", index, "sha256"], message: "artifact is not stored; upload it first" });
    else if (stored.record.size !== artifact.size) issues.push({ path: ["artifacts", index, "size"], message: "does not match the stored artifact" });
  }
  if (issues.length > 0) throw new ApiError("UNPROCESSABLE", "The evidence manifest does not match the claim, the submitter or the stored artifacts", { issues });
  try {
    const { bytes, sha256 } = encodeEvidenceManifest(manifest);
    return { manifest, bytes, sha256 };
  } catch {
    throw new ApiError("PAYLOAD_TOO_LARGE", "The evidence manifest exceeds 256 KiB in canonical form");
  }
}

interface UploadedFile {
  bytes: Uint8Array;
  mediaType: string;
}

/**
 * Reads the single file part with a hard byte limit while streaming: the first byte beyond the limit aborts with 413
 * (SEC-EVID-01). Fields may come before or after the file. The file name is never read.
 */
async function readUpload(request: FastifyRequest, maxBytes: number, allowedTypes: readonly string[]): Promise<{ file: UploadedFile; expectedSha256: Hex32 | null }> {
  let file: UploadedFile | null = null;
  let expected: string | null = null;
  let parts: AsyncIterableIterator<Multipart>;
  try {
    parts = request.parts();
  } catch {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Upload artifacts as multipart/form-data");
  }
  try {
    for await (const part of parts) {
      if (part.type === "field") {
        if (part.fieldname !== "expectedSha256") throw new ApiError("VALIDATION_FAILED", "Unknown form field; only expectedSha256 and one file are accepted");
        if (expected !== null || part.valueTruncated || typeof part.value !== "string") throw new ApiError("VALIDATION_FAILED", "expectedSha256 must be given once");
        expected = part.value;
        continue;
      }
      if (file !== null) throw new ApiError("VALIDATION_FAILED", "Upload exactly one file");
      const mediaType = part.mimetype.toLowerCase();
      if (!allowedTypes.includes(mediaType)) {
        part.file.resume();
        throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "This media type is not accepted for evidence artifacts");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        const buffer = chunk as Buffer;
        size += buffer.byteLength;
        if (size > maxBytes) {
          part.file.destroy();
          throw new ApiError("PAYLOAD_TOO_LARGE", `Artifacts are limited to ${maxBytes} bytes`);
        }
        chunks.push(buffer);
      }
      // The platform's multipart fileSize limit truncates at the configured size: a truncated stream is oversized.
      if (part.file.truncated) throw new ApiError("PAYLOAD_TOO_LARGE", `Artifacts are limited to ${maxBytes} bytes`);
      file = { bytes: new Uint8Array(Buffer.concat(chunks, size)), mediaType };
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 413) throw new ApiError("PAYLOAD_TOO_LARGE", `Artifacts are limited to ${maxBytes} bytes`);
    if (status === 406 || status === 415) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Upload artifacts as multipart/form-data");
    throw new ApiError("BAD_REQUEST", "The upload could not be read");
  }
  if (!file) throw new ApiError("VALIDATION_FAILED", "Upload exactly one file");
  let expectedSha256: Hex32 | null = null;
  if (expected !== null) {
    const parsed = sha256Schema.safeParse(expected);
    if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "expectedSha256 must be 0x-prefixed 32-byte hex");
    expectedSha256 = parsed.data;
  }
  return { file, expectedSha256 };
}

export function registerEvidenceContentRoutes({ app, ctx, state }: MarketsRouteDeps): void {
  app.post(
    "/api/v1/evidence/manifests",
    { preHandler: app.requireSession, bodyLimit: MANIFEST_BODY_LIMIT, schema: { body: z.record(z.string(), z.unknown()) } },
    async (request, reply) => {
      const session = sessionOf(request);
      const { bytes, sha256 } = await checkManifest(ctx, state, session, request.body);
      const stored = await storeOnce(ctx, request, session, { bytes, sha256, kind: "manifest", mediaType: "application/json", maxBytes: EVIDENCE_MANIFEST_MAX_BYTES });
      return reply.status(201).send({ sha256: stored.sha256, cid: stored.cid, size: stored.size });
    },
  );

  app.post("/api/v1/evidence/artifacts", { preHandler: app.requireSession, config: { pine: { multipart: true } } }, async (request, reply) => {
    const session = sessionOf(request);
    const maxBytes = Math.min(ctx.config.evidence.maxUploadBytes, RAW_CID_MAX_BYTES);
    const { file, expectedSha256 } = await readUpload(request, maxBytes, ctx.config.evidence.allowedArtifactMediaTypes.map((type) => type.toLowerCase()));
    const identity = identify(file.bytes);
    if (expectedSha256 !== null && expectedSha256 !== identity.sha256) {
      throw new ApiError("UNPROCESSABLE", "expectedSha256 does not match the digest of the received bytes");
    }
    const stored = await storeOnce(ctx, request, session, { bytes: file.bytes, sha256: identity.sha256, kind: "artifact", mediaType: file.mediaType, maxBytes });
    return reply.status(201).send({ sha256: stored.sha256, cid: stored.cid, size: stored.size });
  });
}
