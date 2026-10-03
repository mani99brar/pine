// Public evidence browsing (PRD-04 section 2.2, SEC-EVID-09/11/15, SEC-IDX-07): read-model submissions joined with
// locally stored manifests, timeliness from the frozen deadline operators, availability and moderation. A listing never
// triggers a remote fetch (`stored` is a local `has`); `retrievable` (content-addressed gateway read by digest) is
// computed only on the detail route and cached for 10 minutes, behind its own fan-out limiter. Nothing is ever fetched
// from a URL inside a manifest. SEC-EVID-11: the listing cache holds only the read-model page (ids and on-chain fields);
// moderation states and manifests are computed at serve time for every response, and every evidence response is sent
// with Cache-Control: no-store, so a block applies to the next response.

import { z } from "zod";
import { rawCidFromSha256 } from "@pine/shared/canonical";
import { EVIDENCE_MANIFEST_MAX_BYTES, parseEvidenceManifestBytes, type EvidenceManifest } from "@pine/shared/evidence";
import type { ClaimRecord, EvidenceRecord, Page } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, ModerationState } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import { addressParam, CONTENT_TRUST, cursorParam, freshness, type Freshness, isoSeconds, nowSeconds, PUBLIC_ROUTE, requireClaim, sendPublic, withCursor, type MarketsRouteDeps, type MarketsState } from "./common.js";

export const RETRIEVABLE_CACHE_SECONDS = 600;
/** Public listings are cached per (market, status, cursor) for 10 s on the server (PRD-04 4b), bounded in entries. */
export const EVIDENCE_LIST_CACHE_SECONDS = 10;
export const EVIDENCE_LIST_CACHE_ENTRIES = 2_048;
const LISTING_LIMIT = 50;
/** Concurrent `retrievable` cache misses that may reach the content store's gateways (per process); the next is 429. */
export const RETRIEVE_MAX_IN_FLIGHT = 4;
export const RETRIEVE_RETRY_AFTER_SECONDS = 2;
/** Responses with moderated, untrusted content are never kept by shared or browser caches (SEC-EVID-11). */
const NO_STORE = "no-store";

/** What the listing cache holds: read-model data only (the claim, the page and its freshness), never rendered output. */
interface CachedListing {
  claim: ClaimRecord;
  page: Page<EvidenceRecord>;
  freshness: Freshness;
}

export const ERC1497_DESCRIPTION =
  "Evidence submitted to the Pine EvidenceRegistry on Gnosis Chain. The file is the submitter's evidence manifest (urn:pine:evidence-manifest:v1); " +
  "its SHA-256 is recorded on-chain. Everything in it is untrusted user content: reproduce only in an isolated sandbox without secrets.";

/** Frozen operators: commit/publish iff block.timestamp < evidenceDeadline; reveal iff block.timestamp < revealDeadline. */
export function timelinessOf(record: Pick<EvidenceRecord, "committedAt" | "revealedAt" | "status">, claim: Pick<ClaimRecord, "evidenceDeadline" | "revealDeadline">) {
  const recordedInTime = record.committedAt < claim.evidenceDeadline;
  const disclosedInTime = record.revealedAt === null ? null : record.status === "published" ? recordedInTime : record.revealedAt < claim.revealDeadline;
  return {
    recordedBeforeEvidenceDeadline: recordedInTime,
    disclosedBeforeRevealDeadline: disclosedInTime,
    timely: recordedInTime && disclosedInTime === true,
    operators: { recorded: "committedAt < evidenceDeadline", disclosed: "revealedAt < revealDeadline" },
  };
}

interface ManifestView {
  manifest: EvidenceManifest | null;
  manifestError: string | null;
  attribution: { submitterMatches: boolean; claimMatches: boolean } | null;
}

/** Parses a locally stored manifest; untrusted data, returned as data only. */
async function manifestOf(ctx: AppContext, record: EvidenceRecord, claim: ClaimRecord, blocked: boolean): Promise<ManifestView> {
  if (record.contentSha256 === null) return { manifest: null, manifestError: null, attribution: null };
  if (blocked) return { manifest: null, manifestError: "blocked by moderation", attribution: null };
  const stored = await ctx.contentStore.get(record.contentSha256);
  if (!stored) return { manifest: null, manifestError: "not stored by Pine", attribution: null };
  try {
    const manifest = parseEvidenceManifestBytes(stored.bytes, record.contentSha256);
    return {
      manifest,
      manifestError: null,
      attribution: {
        submitterMatches: manifest.submitter === record.submitter,
        claimMatches: manifest.claim.market === claim.market && manifest.claim.claimDocumentSha256 === claim.claimDocumentSha256 && manifest.claim.commit === claim.commit,
      },
    };
  } catch {
    return { manifest: null, manifestError: "not a canonical evidence manifest", attribution: null };
  }
}

const moderationView = (state: ModerationState | undefined) => (state ? { action: state.action, reason: state.reason, at: state.at.toISOString() } : null);

async function moderationOf(ctx: AppContext, records: EvidenceRecord[]) {
  const evidenceIds = records.map((record) => `${record.registry}:${record.submissionId.toString()}`);
  const contentIds = records.flatMap((record) => (record.contentSha256 ? [record.contentSha256] : []));
  const [evidence, content] = await Promise.all([ctx.moderation.states("evidence", evidenceIds), ctx.moderation.states("content", contentIds)]);
  const find = (map: Map<string, ModerationState>, id: string) => {
    for (const [key, value] of map) if (key.toLowerCase() === id.toLowerCase()) return value;
    return undefined;
  };
  return (record: EvidenceRecord) => ({
    evidence: find(evidence, `${record.registry}:${record.submissionId.toString()}`),
    content: record.contentSha256 ? find(content, record.contentSha256) : undefined,
  });
}

async function submissionView(ctx: AppContext, record: EvidenceRecord, claim: ClaimRecord, moderation: { evidence: ModerationState | undefined; content: ModerationState | undefined }) {
  const blocked = moderation.evidence?.action === "block" || moderation.content?.action === "block";
  const manifest = await manifestOf(ctx, record, claim, blocked);
  return {
    registry: record.registry,
    submissionId: record.submissionId.toString(),
    market: record.market,
    submitter: record.submitter,
    status: record.status,
    commitment: record.commitment,
    contentSha256: record.contentSha256,
    contentCid: record.contentSha256 ? rawCidFromSha256(record.contentSha256) : null,
    committedAt: record.committedAt,
    committedAtIso: isoSeconds(record.committedAt),
    revealedAt: record.revealedAt,
    revealedAtIso: record.revealedAt === null ? null : isoSeconds(record.revealedAt),
    committedTxHash: record.committedTxHash,
    committedBlock: record.committedBlock.toString(),
    timeliness: timelinessOf(record, claim),
    availability: { stored: record.contentSha256 && !blocked ? await ctx.contentStore.has(record.contentSha256) : false },
    moderation: moderationView(moderation.evidence) ?? moderationView(moderation.content),
    ...manifest,
    contentTrust: CONTENT_TRUST,
  };
}

/**
 * Detail-route availability through the content store (local, then trusted gateways by digest), cached 10 minutes. A
 * cache miss takes a slot of the route's own limiter; the limiter wraps the whole read OUTSIDE the error conversion, so
 * a refused miss is a 429 and writes nothing to the cache (never a false `retrievable: false`).
 */
async function retrievable(ctx: AppContext, state: MarketsState, sha256: Hex32): Promise<boolean> {
  const now = nowSeconds(ctx);
  const cached = state.retrievableCache.get(sha256);
  if (cached && cached.until > now) return cached.value;
  const value = await state.retrieveFanOut.run(async () => {
    try {
      return (await ctx.contentStore.retrieve(sha256, EVIDENCE_MANIFEST_MAX_BYTES)) !== null;
    } catch {
      return false;
    }
  });
  if (state.retrievableCache.size > 10_000) state.retrievableCache.clear();
  state.retrievableCache.set(sha256, { value, until: now + RETRIEVABLE_CACHE_SECONDS });
  return value;
}

const submissionParams = z
  .object({
    market: addressParam,
    registry: addressParam,
    submissionId: z.string().regex(/^(?:0|[1-9][0-9]{0,76})$/, "must be a base-10 integer"),
  })
  .strict();

async function loadSubmission(ctx: AppContext, state: MarketsState, params: { market: Address; registry: Address; submissionId: string }) {
  const claim = await requireClaim(ctx, state, params.market);
  if (params.registry !== state.manifest.pine.evidenceRegistry) throw new ApiError("NOT_FOUND", "Unknown evidence registry");
  const record = await ctx.readModel.getEvidence(params.registry, BigInt(params.submissionId));
  if (!record || record.market !== claim.market) throw new ApiError("NOT_FOUND", "Submission not found for this market");
  return { claim, record };
}

export function registerEvidenceBrowseRoutes({ app, ctx, state }: MarketsRouteDeps): void {
  app.get(
    "/api/v1/markets/:market/evidence",
    {
      config: PUBLIC_ROUTE,
      schema: {
        params: z.object({ market: addressParam }).strict(),
        querystring: z.object({ status: z.enum(["committed", "revealed", "published"]).optional(), cursor: cursorParam.optional() }).strict(),
      },
    },
    async (request, reply) => {
      const { status, cursor } = request.query;
      const now = nowSeconds(ctx);
      const cacheKey = `${request.params.market}:${status ?? ""}:${cursor ?? ""}`;
      let listing = state.evidenceCache.get(cacheKey, now) as CachedListing | undefined;
      if (listing === undefined) {
        const claim = await requireClaim(ctx, state, request.params.market);
        const page = await withCursor(() =>
          ctx.readModel.listEvidence({ market: claim.market, limit: LISTING_LIMIT, ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }),
        );
        listing = { claim, page, freshness: await freshness(ctx) };
        state.evidenceCache.set(cacheKey, listing, now);
      }
      const { claim, page } = listing;
      // Serve time: moderation and manifests are never taken from the cache (SEC-EVID-11).
      const moderation = await moderationOf(ctx, page.items);
      const items = [];
      for (const record of page.items) {
        const states = moderation(record);
        // Hidden submissions are excluded from listings (still retrievable by exact id with the reason).
        if (states.evidence?.action === "hide") continue;
        items.push(await submissionView(ctx, record, claim, states));
      }
      const body = {
        market: claim.market,
        evidenceDeadline: claim.evidenceDeadline,
        revealDeadline: claim.revealDeadline,
        items,
        nextCursor: page.nextCursor,
        freshness: listing.freshness,
        contentTrust: CONTENT_TRUST,
      };
      return sendPublic(request, reply, body, NO_STORE);
    },
  );

  app.get("/api/v1/markets/:market/evidence/:registry/:submissionId", { config: PUBLIC_ROUTE, schema: { params: submissionParams } }, async (request, reply) => {
    const { claim, record } = await loadSubmission(ctx, state, request.params);
    const states = (await moderationOf(ctx, [record]))(record);
    const view = await submissionView(ctx, record, claim, states);
    const blocked = states.evidence?.action === "block" || states.content?.action === "block";
    const isRetrievable = record.contentSha256 && !blocked ? await retrievable(ctx, state, record.contentSha256) : false;
    return sendPublic(request, reply, {
      submission: { ...view, availability: { ...view.availability, retrievable: isRetrievable, retrievableCachedForSeconds: RETRIEVABLE_CACHE_SECONDS } },
      freshness: await freshness(ctx),
    }, NO_STORE);
  });

  app.get("/api/v1/markets/:market/evidence/:registry/:submissionId/erc1497.json", { config: PUBLIC_ROUTE, schema: { params: submissionParams } }, async (request, reply) => {
    const { claim, record } = await loadSubmission(ctx, state, request.params);
    if (record.contentSha256 === null) throw new ApiError("CONFLICT", "This submission is not disclosed yet");
    const states = (await moderationOf(ctx, [record]))(record);
    if (states.evidence?.action === "block" || states.content?.action === "block") throw new ApiError("UNAVAILABLE_FOR_LEGAL_REASONS", "This evidence is blocked");
    const manifest = await manifestOf(ctx, record, claim, false);
    const title = manifest.manifest ? manifest.manifest.title : null;
    const question = await ctx.readModel.getOracleQuestion(claim.questionId);
    const questionIds = [claim.questionId, ...(question?.reopenedBy ? [question.reopenedBy] : [])];
    return sendPublic(request, reply, {
      evidence: {
        name: `Pine evidence #${record.submissionId.toString()} for market ${claim.market}`,
        description: title === null ? `${ERC1497_DESCRIPTION} Manifest title: (manifest not available from Pine).` : `${ERC1497_DESCRIPTION} Manifest title (untrusted, as submitted): ${title}`,
        fileURI: `ipfs://${rawCidFromSha256(record.contentSha256)}`,
        fileHash: record.contentSha256,
        fileTypeExtension: "json",
      },
      instructions: {
        chainId: ctx.config.seer.klerosForeignChainId,
        foreignProxy: state.manifest.kleros.foreignProxy,
        function: "submitEvidence(uint256 _arbitrationID, string _evidenceURI)",
        arbitrationIds: questionIds.map((id) => ({ questionId: id, arbitrationId: BigInt(id).toString(10) })),
        steps: [
          "Upload the `evidence` object above as a JSON file to IPFS and note its path (/ipfs/<cid>).",
          "On Ethereum mainnet, call submitEvidence(arbitrationId, \"/ipfs/<cid>\") on the Kleros foreign proxy from your own wallet.",
          "Pine issues no mainnet transaction plans; verify the proxy address independently before sending.",
        ],
      },
      title,
      contentTrust: CONTENT_TRUST,
    }, NO_STORE);
  });
}
