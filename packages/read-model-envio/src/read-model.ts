// ReadModel over Envio's Hasura GraphQL API (PRD-05 3.2, 3a). The only network access is a POST to the configured
// GraphQL URL (no redirects, bounded time, the body read as a stream under a byte cap); every response is validated with
// zod; errors never carry the URL, the admin secret, response bodies or underlying fetch/zod messages.

import { z } from "zod";
import type {
  ArbitrationRecord,
  ClaimRecord,
  ConditionResolutionRecord,
  EvidenceRecord,
  IndexerStatus,
  ListClaimsQuery,
  ListEvidenceQuery,
  OracleAnswerRecord,
  OracleQuestionRecord,
  Page,
  ReadModel,
} from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import { decodeClaimCursor, decodeEvidenceCursor, encodeClaimCursor, encodeEvidenceCursor } from "./cursor.js";
import { ENVIO_META, ENVIO_PROGRESS } from "./envio-meta.js";
import { EnvioReadModelError } from "./errors.js";
import {
  getArbitrationRequest,
  getClaimRequest,
  getConditionResolutionRequest,
  getEvidenceRequest,
  getOracleQuestionRequest,
  listClaimsByQuestionRequest,
  listClaimsRequest,
  listEvidenceRequest,
  listOracleAnswersRequest,
  statusRequest,
  type ClaimFilter,
  type GraphqlRequest,
  UNPAGINATED_MAX_ROWS,
} from "./queries.js";
import {
  arbitrationRecord,
  envelope,
  getArbitrationData,
  getClaimData,
  getConditionResolutionData,
  getEvidenceData,
  getOracleQuestionData,
  listClaimsData,
  listEvidenceData,
  listOracleAnswersData,
  statusData,
} from "./responses.js";

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  /** Read incrementally under the byte cap (never buffered whole first). */
  body: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal },
) => Promise<FetchResponseLike>;

export interface EnvioReadModelOptions {
  /** Hasura GraphQL endpoint of the Envio deployment (http or https, no userinfo). Never logged or echoed. */
  graphqlUrl: string;
  /**
   * Hasura admin secret (x-hasura-admin-secret), if the endpoint requires one. Requires an https graphqlUrl. The API
   * should not hold it: production reads through a select-only Hasura role (README, "Hasura access").
   */
  adminSecret?: string;
  /** Allow an admin secret over http://. Tests only (in-process fakes); never derive it from the environment. */
  allowInsecureTransport?: boolean;
  fetch?: FetchLike;
  /** Indexed chain (default 100, Gnosis). */
  chainId?: number;
  /** Per-request timeout, covering the response body (default 10 s). */
  timeoutMs?: number;
  /** Largest accepted response body, in bytes (default 8 MiB). */
  maxResponseBytes?: number;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const optionsSchema = z.object({
  graphqlUrl: z.string(),
  adminSecret: z.string().min(1).optional(),
  allowInsecureTransport: z.boolean().default(false),
  chainId: z.number().int().positive().default(100),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  maxResponseBytes: z.number().int().positive().default(8 * 1024 * 1024),
});

const lowerHex = (value: string): string => value.toLowerCase();

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer in 1..100");
}

function deadlineBound(value: number | undefined, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a safe integer (unix seconds)`);
  return BigInt(value);
}

/**
 * Reads the body as a stream and stops (cancelling it) as soon as it exceeds maxBytes. An abort (the request timeout)
 * cancels the read too, so a body that stalls mid-way times out even when the fetch implementation ignores the signal.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, op: string, signal: AbortSignal): Promise<Uint8Array> {
  if (body === null) throw new EnvioReadModelError("invalid_json", op, "response has no body");
  if (signal.aborted) throw new Error("aborted");
  const reader = body.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => undefined);
        throw new EnvioReadModelError("too_large", op, `response larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Lists returned whole carry one extra row (queries.ts); more than the cap is an error, never a silent truncation. */
function capped<T>(rows: T[], op: string): T[] {
  if (rows.length > UNPAGINATED_MAX_ROWS) throw new EnvioReadModelError("too_many_rows", op, `more than ${UNPAGINATED_MAX_ROWS} rows`);
  return rows;
}

export function createEnvioReadModel(options: EnvioReadModelOptions): ReadModel {
  const parsed = optionsSchema.safeParse({ ...options, fetch: undefined });
  // Never echo the rejected values (the URL may carry an API key in its query, the secret is a secret).
  if (!parsed.success) throw new EnvioReadModelError("configuration", "configuration", "options must be valid");
  const { graphqlUrl, adminSecret, allowInsecureTransport, chainId, timeoutMs, maxResponseBytes } = parsed.data;
  const url = parseUrl(graphqlUrl);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) throw new EnvioReadModelError("configuration", "configuration", "graphqlUrl must be an http(s) URL");
  // Credentials in the URL would travel to every log line and proxy that sees it; use adminSecret (a header) instead.
  if (url.username !== "" || url.password !== "") throw new EnvioReadModelError("configuration", "configuration", "graphqlUrl must not embed credentials");
  if (adminSecret !== undefined && url.protocol !== "https:" && !allowInsecureTransport) {
    throw new EnvioReadModelError("configuration", "configuration", "an admin secret requires an https graphqlUrl");
  }
  const fetchImpl: FetchLike = options.fetch ?? (async (target, init) => globalThis.fetch(target, init));

  async function run<T>(request: GraphqlRequest, schema: z.ZodType<T>): Promise<T> {
    const op = request.operationName;
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (adminSecret !== undefined) headers["x-hasura-admin-secret"] = adminSecret;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let bytes: Uint8Array;
    try {
      let response: FetchResponseLike;
      try {
        response = await fetchImpl(graphqlUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ operationName: op, query: request.query, variables: request.variables }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw timedOut ? new EnvioReadModelError("timeout", op, `no response within ${timeoutMs} ms`) : new EnvioReadModelError("network", op, "request failed");
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined);
        throw new EnvioReadModelError("http", op, `HTTP ${Number.isInteger(response.status) ? response.status : "?"}`);
      }
      try {
        bytes = await readCapped(response.body, maxResponseBytes, op, controller.signal);
      } catch (error) {
        if (error instanceof EnvioReadModelError) throw error;
        throw timedOut ? new EnvioReadModelError("timeout", op, `no response within ${timeoutMs} ms`) : new EnvioReadModelError("network", op, "reading the response failed");
      }
    } finally {
      clearTimeout(timer);
      // Releases the connection of an abandoned (oversized or failed) response; a no-op after a complete read.
      controller.abort();
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new EnvioReadModelError("invalid_json", op, "response is not JSON");
    }
    const outer = envelope.safeParse(json);
    if (!outer.success) throw new EnvioReadModelError("invalid_response", op, "response is not a GraphQL result");
    if (outer.data.errors !== undefined && outer.data.errors.length > 0) throw new EnvioReadModelError("graphql", op, `endpoint returned ${outer.data.errors.length} GraphQL error(s)`);
    const data = schema.safeParse(outer.data.data);
    if (!data.success) {
      const paths = [...new Set(data.error.issues.map((issue) => issue.path.filter((part) => typeof part === "string").join(".")))].slice(0, 5);
      throw new EnvioReadModelError("invalid_response", op, `response failed validation at ${paths.join(", ") || "root"}`);
    }
    return data.data;
  }

  return {
    async status(): Promise<IndexerStatus> {
      const data = await run(statusRequest(chainId), statusData);
      const meta = data[ENVIO_META.root].find((row) => row[ENVIO_META.chainId] === chainId);
      if (!meta) throw new EnvioReadModelError("invalid_response", "Status", `chain ${chainId} is not indexed by this endpoint`);
      const progress = data[`${ENVIO_PROGRESS.entity}_by_pk`];
      const progressBlock = meta[ENVIO_META.progressBlock];
      const lastEventBlock = progress?.[ENVIO_PROGRESS.blockNumber] ?? 0n;
      return {
        backend: "envio",
        chainId,
        // Every served row is at or below both values; the larger one is the honest "fully applied" block.
        indexedBlock: progressBlock > lastEventBlock ? progressBlock : lastEventBlock,
        // _meta has no timestamp: this is the timestamp of the last block that carried an event, which is at or before
        // indexedBlock's own timestamp, so freshness is never overstated.
        indexedBlockTimestamp: progress?.[ENVIO_PROGRESS.blockTimestamp] ?? 0,
        headBlock: meta[ENVIO_META.sourceBlock] ?? null,
        // Envio serves rows block_lag (~40) blocks behind its source and rolls back reorgs; it does not track finality.
        finalizedBlock: null,
        // Envio stops on a handler error instead of reporting it here; an unreachable or failing endpoint throws.
        halted: false,
      };
    },

    async getClaim(market: Address): Promise<ClaimRecord | null> {
      return (await run(getClaimRequest(lowerHex(market)), getClaimData)).Claim_by_pk;
    },

    async listClaims(query: ListClaimsQuery): Promise<Page<ClaimRecord>> {
      assertLimit(query.limit);
      const after = query.cursor === undefined ? null : decodeClaimCursor(query.cursor, query.order);
      const filter: ClaimFilter = {};
      if (query.creator !== undefined) filter.creator = lowerHex(query.creator);
      if (query.claimDocumentSha256 !== undefined) filter.claimDocumentSha256 = lowerHex(query.claimDocumentSha256);
      const afterBound = deadlineBound(query.evidenceDeadlineAfter, "evidenceDeadlineAfter");
      const atOrBefore = deadlineBound(query.evidenceDeadlineAtOrBefore, "evidenceDeadlineAtOrBefore");
      if (afterBound !== undefined) filter.evidenceDeadlineAfter = afterBound;
      if (atOrBefore !== undefined) filter.evidenceDeadlineAtOrBefore = atOrBefore;
      const rows = (await run(listClaimsRequest(query.order, filter, after, query.limit + 1), listClaimsData)).Claim;
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? encodeClaimCursor(
              query.order === "created_desc"
                ? { order: "created_desc", block: last.createdBlock, logIndex: BigInt(last.createdLogIndex) }
                : { order: "evidence_deadline_asc", deadline: BigInt(last.evidenceDeadline), market: last.market },
            )
          : null;
      return { items, nextCursor };
    },

    async listClaimsByQuestion(questionId: Hex32): Promise<ClaimRecord[]> {
      return capped((await run(listClaimsByQuestionRequest(lowerHex(questionId)), listClaimsData)).Claim, "ListClaimsByQuestion");
    },

    async getEvidence(registry: Address, submissionId: bigint): Promise<EvidenceRecord | null> {
      return (await run(getEvidenceRequest(lowerHex(registry), submissionId), getEvidenceData)).EvidenceSubmission_by_pk;
    },

    async listEvidence(query: ListEvidenceQuery): Promise<Page<EvidenceRecord>> {
      assertLimit(query.limit);
      const after = query.cursor === undefined ? null : decodeEvidenceCursor(query.cursor);
      const filter: { market?: string; submitter?: string; status?: EvidenceRecord["status"] } = {};
      if (query.market !== undefined) filter.market = lowerHex(query.market);
      if (query.submitter !== undefined) filter.submitter = lowerHex(query.submitter);
      if (query.status !== undefined) filter.status = query.status;
      const rows = (await run(listEvidenceRequest(filter, after, query.limit + 1), listEvidenceData)).EvidenceSubmission;
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      const nextCursor = rows.length > query.limit && last !== undefined ? encodeEvidenceCursor({ block: last.committedBlock, logIndex: BigInt(last.committedLogIndex) }) : null;
      return { items, nextCursor };
    },

    async getOracleQuestion(questionId: Hex32): Promise<OracleQuestionRecord | null> {
      return (await run(getOracleQuestionRequest(lowerHex(questionId)), getOracleQuestionData)).OracleQuestion_by_pk;
    },

    async listOracleAnswers(questionId: Hex32): Promise<OracleAnswerRecord[]> {
      return capped((await run(listOracleAnswersRequest(lowerHex(questionId)), listOracleAnswersData)).OracleAnswer, "ListOracleAnswers");
    },

    async getArbitration(questionId: Hex32): Promise<ArbitrationRecord | null> {
      const data = await run(getArbitrationRequest(lowerHex(questionId)), getArbitrationData);
      capped(data.ArbitrationStage, "GetArbitration");
      return arbitrationRecord(data);
    },

    async getConditionResolution(conditionId: Hex32): Promise<ConditionResolutionRecord | null> {
      return (await run(getConditionResolutionRequest(lowerHex(conditionId)), getConditionResolutionData)).ConditionResolution_by_pk;
    },
  };
}
