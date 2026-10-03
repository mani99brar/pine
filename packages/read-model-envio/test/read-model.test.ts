// Unit tests of createEnvioReadModel: configuration (URL and transport rules), query construction, response validation,
// cursor handling, status(), transport failures (streamed byte cap, timeouts), the unpaginated-list cap and redaction.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidCursorError } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import { createEnvioReadModel, EnvioReadModelError, type FetchLike, type FetchResponseLike } from "../src/index.js";
import { UNPAGINATED_MAX_ROWS } from "../src/queries.js";
import { createFakeHasura, jsonResponse } from "./fake-hasura.js";
import { loadSnapshots, type EntitySnapshot, type Row } from "./snapshots.js";

// No userinfo (refused, see "configuration"); the query-string key stands for any credential an operator might put there.
const URL = "https://envio.test/v1/graphql?apiKey=url-api-key";
const SECRET = "super-secret-admin-value";
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

const snapshot = (name: string): EntitySnapshot => {
  const found = loadSnapshots().find((item) => item.scenario === name);
  if (!found) throw new Error(`missing snapshot ${name}`);
  return structuredClone(found);
};

function modelOver(data: EntitySnapshot, maxResponseBytes?: number) {
  const fake = createFakeHasura(data, { url: URL, adminSecret: SECRET });
  return { fake, model: createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch: fake.fetch, ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }) }) };
}

/** A fetch that answers every request with the result of `respond`. */
function scripted(respond: () => Promise<FetchResponseLike>): { fetch: FetchLike; calls: Parameters<FetchLike>[] } {
  const calls: Parameters<FetchLike>[] = [];
  return {
    calls,
    fetch: async (...args) => {
      calls.push(args);
      return respond();
    },
  };
}

const ok = (payload: unknown) => async () => jsonResponse(payload);
const textResponse = (text: string, status = 200): FetchResponseLike => ({ ok: status === 200, status, body: new Response(text).body });

async function caught(promise: Promise<unknown>): Promise<EnvioReadModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnvioReadModelError);
    return error as EnvioReadModelError;
  }
  throw new Error("expected a rejection");
}

function expectRedacted(error: Error): void {
  const text = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
  for (const secret of [SECRET, "url-password", "url-api-key", "envio.test", URL]) expect(text).not.toContain(secret);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("configuration", () => {
  async function configurationError(options: Parameters<typeof createEnvioReadModel>[0]): Promise<EnvioReadModelError> {
    const error = await caught(Promise.resolve().then(() => createEnvioReadModel(options)));
    expect(error.code).toBe("configuration");
    expect(error.message).not.toContain(options.graphqlUrl);
    return error;
  }

  it("SEC-OPS-14 refuses a graphqlUrl with userinfo (user and password, user only, password only) without echoing it", async () => {
    for (const graphqlUrl of ["https://user:url-password@envio.test/v1/graphql", "https://url-password@envio.test/v1/graphql", "https://:url-password@envio.test/v1/graphql"]) {
      const error = await configurationError({ graphqlUrl, adminSecret: SECRET, fetch: scripted(ok({})).fetch });
      expect(error.message).toBe("Envio read model configuration: graphqlUrl must not embed credentials");
      expectRedacted(error);
    }
  });

  it("SEC-OPS-14 refuses an admin secret over http:// unless allowInsecureTransport is exactly true", async () => {
    const graphqlUrl = "http://envio.internal:8080/v1/graphql";
    const { fetch, calls } = scripted(ok({ data: { Claim_by_pk: null } }));
    for (const allowInsecureTransport of [undefined, false]) {
      const error = await configurationError({ graphqlUrl, adminSecret: SECRET, fetch, ...(allowInsecureTransport === undefined ? {} : { allowInsecureTransport }) });
      expect(error.message).toBe("Envio read model configuration: an admin secret requires an https graphqlUrl");
      expectRedacted(error);
    }
    // A truthy non-boolean is not "true" (no coercion from strings such as an environment value).
    await configurationError({ graphqlUrl, adminSecret: SECRET, fetch, allowInsecureTransport: "true" as unknown as boolean });
    expect(calls).toEqual([]);
    // Explicit opt-in (tests only): the secret is sent over http.
    await createEnvioReadModel({ graphqlUrl, adminSecret: SECRET, fetch, allowInsecureTransport: true }).getClaim("0x0000000000000000000000000000000000000001");
    expect(calls[0]![1].headers["x-hasura-admin-secret"]).toBe(SECRET);
    // Without a secret there is nothing to protect: http is accepted (e.g. a private network endpoint).
    await createEnvioReadModel({ graphqlUrl, fetch }).getClaim("0x0000000000000000000000000000000000000001");
    expect(calls[1]![1].headers["x-hasura-admin-secret"]).toBeUndefined();
  });

  it("the insecure-transport refusal does not depend on the environment (this run has VITEST and NODE_ENV=test set)", async () => {
    expect(process.env.VITEST).toBeDefined();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_INSECURE_TRANSPORT", "true");
    try {
      await configurationError({ graphqlUrl: "http://envio.internal/v1/graphql", adminSecret: SECRET, fetch: scripted(ok({})).fetch });
    } finally {
      vi.unstubAllEnvs();
    }
    for (const file of ["read-model.ts", "queries.ts", "responses.ts", "cursor.ts", "errors.ts", "envio-meta.ts", "index.ts"]) {
      expect(readFileSync(path.join(SRC, file), "utf8"), file).not.toMatch(/process\.env|import\.meta\.env/);
    }
  });
});

describe("query construction", () => {
  it("posts only to the configured URL, without redirects, with the admin secret header and variables (never spliced values)", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    const claims = (await model.listClaims({ order: "created_desc", limit: 1 })).items;
    const target = claims[0]!;
    await model.getClaim(target.market.toUpperCase().replace("0X", "0x") as Address);
    const request = fake.requests.at(-1)!;
    expect(request.url).toBe(URL);
    expect(request.headers["x-hasura-admin-secret"]).toBe(SECRET);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.operationName).toBe("GetClaim");
    expect(request.variables).toEqual({ id: target.market });
    expect(request.query).not.toContain(target.market);
  });

  it("builds listClaims filters, keyset and order as Hasura where/order_by/limit (limit + 1 to detect a next page)", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    const creator = "0x00000000000000000000000000000000000000AB" as Address;
    const first = await model.listClaims({ order: "evidence_deadline_asc", limit: 2, creator, evidenceDeadlineAfter: 5, evidenceDeadlineAtOrBefore: 1_900_100_000 });
    expect(fake.requests.at(-1)!.variables).toEqual({
      where: {
        _and: [
          { creator: { _eq: creator.toLowerCase() } },
          { evidenceDeadline: { _gt: "5" } },
          { evidenceDeadline: { _lte: "1900100000" } },
        ],
      },
      orderBy: [{ evidenceDeadline: "asc" }, { id: "asc" }],
      limit: 3,
    });
    expect(first.items).toEqual([]);

    const page = await model.listClaims({ order: "evidence_deadline_asc", limit: 2 });
    expect(page.nextCursor).not.toBeNull();
    await model.listClaims({ order: "evidence_deadline_asc", limit: 2, cursor: page.nextCursor! });
    const last = page.items[1]!;
    expect(fake.requests.at(-1)!.variables.where).toEqual({
      _or: [{ evidenceDeadline: { _gt: String(last.evidenceDeadline) } }, { evidenceDeadline: { _eq: String(last.evidenceDeadline) }, id: { _gt: last.market } }],
    });

    const created = await model.listClaims({ order: "created_desc", limit: 3 });
    await model.listClaims({ order: "created_desc", limit: 3, cursor: created.nextCursor!, claimDocumentSha256: `0x${"AA".repeat(32)}` as Hex32 });
    const tail = created.items[2]!;
    expect(fake.requests.at(-1)!.variables).toEqual({
      where: {
        _and: [
          { claimDocumentSha256: { _eq: `0x${"aa".repeat(32)}` } },
          { _or: [{ createdBlock: { _lt: String(tail.createdBlock) } }, { createdBlock: { _eq: String(tail.createdBlock) }, createdLogIndex: { _lt: String(tail.createdLogIndex) } }] },
        ],
      },
      orderBy: [{ createdBlock: "desc" }, { createdLogIndex: "desc" }],
      limit: 4,
    });
  });

  it("builds evidence, oracle, arbitration and resolution lookups by lowercase id", async () => {
    const { fake, model } = modelOver(snapshot("oracle"));
    const upper = `0x${"AB".repeat(32)}` as Hex32;
    await model.getEvidence("0x00000000000000000000000000000000000E01DE", 7n);
    expect(fake.requests.at(-1)!.variables).toEqual({ id: "0x00000000000000000000000000000000000e01de:7" });
    await model.listEvidence({ limit: 5, market: "0x00000000000000000000000000000000000000Ff", status: "revealed" });
    expect(fake.requests.at(-1)!.variables).toEqual({
      where: { _and: [{ market: { _eq: "0x00000000000000000000000000000000000000ff" } }, { status: { _eq: "revealed" } }] },
      orderBy: [{ committedBlock: "asc" }, { committedLogIndex: "asc" }],
      limit: 6,
    });
    await model.listOracleAnswers(upper);
    expect(fake.requests.at(-1)!.variables).toEqual({ where: { questionId: { _eq: upper.toLowerCase() } }, orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }], limit: 10_001 });
    await model.getArbitration(upper);
    expect(fake.requests.at(-1)!.variables).toEqual({
      id: upper.toLowerCase(),
      where: { questionId: { _eq: upper.toLowerCase() } },
      orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }],
      limit: 10_001,
    });
    await model.getConditionResolution(upper);
    expect(fake.requests.at(-1)!.variables).toEqual({ id: upper.toLowerCase() });
    await model.listClaimsByQuestion(upper);
    expect(fake.requests.at(-1)!.variables).toEqual({ where: { questionId: { _eq: upper.toLowerCase() } }, orderBy: [{ createdBlock: "asc" }, { createdLogIndex: "asc" }], limit: 10_001 });
  });

  it("SEC-OPS-14 sends exactly one POST per call, always to the configured URL with redirects refused", async () => {
    const { fake, model } = modelOver(snapshot("oracle"));
    const hash = `0x${"00".repeat(32)}` as Hex32;
    const calls = [
      () => model.status(),
      () => model.getClaim("0x0000000000000000000000000000000000000001"),
      () => model.listClaims({ order: "created_desc", limit: 1 }),
      () => model.listClaimsByQuestion(hash),
      () => model.getEvidence("0x0000000000000000000000000000000000000001", 1n),
      () => model.listEvidence({ limit: 1 }),
      () => model.getOracleQuestion(hash),
      () => model.listOracleAnswers(hash),
      () => model.getArbitration(hash),
      () => model.getConditionResolution(hash),
    ];
    for (const call of calls) await call();
    expect(fake.requests).toHaveLength(calls.length);
    expect(new Set(fake.requests.map((request) => request.url))).toEqual(new Set([URL]));
    expect(fake.requests.map((request) => request.operationName)).toEqual([
      "Status",
      "GetClaim",
      "ListClaims",
      "ListClaimsByQuestion",
      "GetEvidence",
      "ListEvidence",
      "GetOracleQuestion",
      "ListOracleAnswers",
      "GetArbitration",
      "GetConditionResolution",
    ]);
  });

  it("rejects limits outside 1..100 and non-integer deadlines before any request", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    for (const limit of [0, 101, 1.5, Number.NaN]) {
      await expect(model.listClaims({ order: "created_desc", limit })).rejects.toThrow(RangeError);
      await expect(model.listEvidence({ limit })).rejects.toThrow(RangeError);
    }
    await expect(model.listClaims({ order: "created_desc", limit: 5, evidenceDeadlineAfter: 1.5 })).rejects.toThrow(RangeError);
    expect(fake.requests).toEqual([]);
  });
});

describe("cursors", () => {
  it("reject garbage, tampered keys and cursors of another order with InvalidCursorError", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    const created = await model.listClaims({ order: "created_desc", limit: 2 });
    const deadline = await model.listClaims({ order: "evidence_deadline_asc", limit: 2 });
    const evidence = Buffer.from(JSON.stringify({ v: 1, scope: "evidence", key: ["1", "0"] })).toString("base64url");
    const forged = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");
    const requestsBefore = fake.requests.length;
    for (const cursor of [
      "not-a-cursor",
      "",
      "%%%",
      deadline.nextCursor!,
      evidence,
      forged({ v: 2, scope: "created_desc", key: ["1", "0"] }),
      forged({ v: 1, scope: "created_desc", key: ["1"] }),
      forged({ v: 1, scope: "created_desc", key: ["-1", "0"] }),
      forged({ v: 1, scope: "created_desc", key: ["1", "0x"] }),
      forged({ v: 1, scope: "created_desc", key: [1, 0] }),
      "A".repeat(600),
    ]) {
      await expect(model.listClaims({ order: "created_desc", limit: 2, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
    }
    await expect(model.listClaims({ order: "evidence_deadline_asc", limit: 2, cursor: created.nextCursor! })).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(model.listClaims({ order: "evidence_deadline_asc", limit: 2, cursor: forged({ v: 1, scope: "evidence_deadline_asc", key: ["1", "0xABC"] }) })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    await expect(model.listEvidence({ limit: 2, cursor: created.nextCursor! })).rejects.toBeInstanceOf(InvalidCursorError);
    expect(fake.requests.length).toBe(requestsBefore);
  });
});

describe("response validation", () => {
  const claimsData = () => snapshot("claims-and-evidence");
  const firstClaim = (data: EntitySnapshot): Row => data.entities.Claim![0]!;

  for (const [label, mutate] of [
    ["an uppercase address", (row: Row) => void (row.creator = String(row.creator).toUpperCase().replace("0X", "0x"))],
    ["a numeric that is not a decimal string", (row: Row) => void (row.minBond = "1e18")],
    ["a JSON number beyond 2^53", (row: Row) => void (row.minBond = 2 ** 60)],
    ["a timestamp beyond 2^53", (row: Row) => void (row.evidenceDeadline = (2n ** 53n).toString())],
    ["a negative block", (row: Row) => void (row.createdBlock = "-1")],
    ["a missing field", (row: Row) => void delete row.title],
    ["a null in a required field", (row: Row) => void (row.title = null)],
    ["a commit with 0x", (row: Row) => void (row.commit = `0x${String(row.commit).slice(2)}`)],
  ] as const) {
    it(`SEC-IDX-05 rejects a claim row with ${label}`, async () => {
      const data = claimsData();
      const row = firstClaim(data);
      mutate(row);
      const { model } = modelOver(data);
      const error = await caught(model.getClaim(String(row.id) as Address));
      expect(error.code).toBe("invalid_response");
      expectRedacted(error);
    });
  }

  it("rejects an evidence row whose id does not match registry:submissionId", async () => {
    const data = claimsData();
    const row = data.entities.EvidenceSubmission![0]!;
    const original = BigInt(String(row.submissionId));
    row.submissionId = "12345";
    const { model } = modelOver(data);
    expect((await caught(model.getEvidence(String(row.registry) as Address, original))).code).toBe("invalid_response");
  });

  it("rejects malformed Json lists (markets, payout numerators)", async () => {
    const oracle = snapshot("oracle");
    const question = oracle.entities.OracleQuestion![0]!;
    question.markets = "0xabc";
    const resolution = oracle.entities.ConditionResolution![0]!;
    resolution.payoutNumerators = [1, 0, 0];
    const { model } = modelOver(oracle);
    expect((await caught(model.getOracleQuestion(String(question.id) as Hex32))).code).toBe("invalid_response");
    expect((await caught(model.getConditionResolution(String(resolution.id) as Hex32))).code).toBe("invalid_response");
  });

  it("accepts safe-integer JSON numbers for numeric columns (Hasura without stringified numerics)", async () => {
    const data = claimsData();
    const row = firstClaim(data);
    const expected = await modelOver(structuredClone(data)).model.getClaim(String(row.id) as Address);
    row.createdBlock = Number(row.createdBlock);
    row.minBond = 5;
    const claim = await modelOver(data).model.getClaim(String(row.id) as Address);
    expect(claim).toEqual({ ...expected, minBond: 5n });
  });

  it("SEC-OPS-02 surfaces GraphQL errors by count only, never their text", async () => {
    const { fetch } = scripted(ok({ errors: [{ message: `field not found; secret ${SECRET} at ${URL}` }, { message: "x" }] }));
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch });
    const error = await caught(model.getClaim("0x0000000000000000000000000000000000000001"));
    expect(error.code).toBe("graphql");
    expect(error.message).toBe("Envio read model GetClaim: endpoint returned 2 GraphQL error(s)");
    expectRedacted(error);
  });

  it("rejects a missing admin secret through the endpoint's access error", async () => {
    const fake = createFakeHasura(snapshot("oracle"), { url: URL, adminSecret: SECRET });
    const model = createEnvioReadModel({ graphqlUrl: URL, fetch: fake.fetch });
    expect((await caught(model.status())).code).toBe("graphql");
    expect(fake.requests[0]!.headers["x-hasura-admin-secret"]).toBeUndefined();
  });

  for (const [label, response, code] of [
    ["HTTP 500", async () => textResponse(`upstream ${URL} failed`, 500), "http"],
    ["a non-JSON body", async () => textResponse(`<html>${SECRET}</html>`), "invalid_json"],
    ["a body that is not UTF-8", async () => ({ ok: true, status: 200, body: new Response(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])).body }), "invalid_json"],
    ["no body", async () => ({ ok: true, status: 200, body: null }), "invalid_json"],
    ["a body that is not a GraphQL result", ok([1, 2, 3]), "invalid_response"],
    ["data of the wrong shape", ok({ data: { Claim_by_pk: { id: 5 } } }), "invalid_response"],
    ["missing data", ok({}), "invalid_response"],
    ["an oversized body", async () => textResponse(" ".repeat(2_000)), "too_large"],
  ] as const) {
    it(`SEC-OPS-02 fails closed on ${label} with a redacted error`, async () => {
      const { fetch } = scripted(response);
      const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch, maxResponseBytes: 1_000 });
      const error = await caught(model.getClaim("0x0000000000000000000000000000000000000001"));
      expect(error.code).toBe(code);
      expectRedacted(error);
    });
  }

  it("SEC-OPS-02 never rethrows a fetch error (whose message may carry the URL or secret)", async () => {
    const { fetch } = scripted(async () => {
      throw new TypeError(`fetch failed for ${URL} with header ${SECRET}`);
    });
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch });
    const error = await caught(model.listOracleAnswers(`0x${"00".repeat(32)}`));
    expect(error.code).toBe("network");
    expect(error.cause).toBeUndefined();
    expectRedacted(error);
  });

  it("SEC-OPS-02 aborts after the timeout (10 s by default) and reports it without request details", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error(`aborted ${URL}`)));
      });
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch });
    const pending = caught(model.getClaim("0x0000000000000000000000000000000000000001"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(signal?.aborted).toBe(true);
    expect(error.code).toBe("timeout");
    expectRedacted(error);
  });

  it("SEC-OPS-14 refuses a non-http(s) or malformed GraphQL URL without echoing it", () => {
    for (const graphqlUrl of ["file:///etc/passwd", "not a url with url-password", "ftp://url-password@envio.test/"]) {
      try {
        createEnvioReadModel({ graphqlUrl });
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(EnvioReadModelError);
        expectRedacted(error as Error);
        expect((error as Error).message).not.toContain(graphqlUrl);
      }
    }
  });
});

describe("transport limits", () => {
  /**
   * A body far larger than any cap under test (64 MiB of spaces, pulled chunk by chunk; bounded so that a missing cap
   * fails the assertions instead of exhausting memory). Records what was pulled and whether it was cancelled.
   */
  function endless(chunkBytes: number) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled >= 64 * 1024 * 1024) return controller.close();
        state.pulled += chunkBytes;
        controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  }

  it("SEC-OPS-02 reads the body as a stream and cancels it once the byte cap is exceeded (never buffers it whole)", async () => {
    const { body, state } = endless(16 * 1024);
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch: scripted(async () => ({ ok: true, status: 200, body })).fetch, maxResponseBytes: 64 * 1024 });
    const error = await caught(model.getClaim("0x0000000000000000000000000000000000000001"));
    expect(error.code).toBe("too_large");
    expect(error.message).toBe("Envio read model GetClaim: response larger than 65536 bytes");
    await Promise.resolve();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(64 * 1024 + 3 * 16 * 1024);
  });

  it("the cap counts UTF-8 bytes, not characters (8 MiB by default)", async () => {
    const text = JSON.stringify({ data: { Claim_by_pk: null }, extensions: { note: "\u20ac".repeat(100) } });
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes).toBe(text.length + 200);
    const at = (maxResponseBytes: number) =>
      createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(async () => textResponse(text)).fetch, maxResponseBytes }).getClaim("0x0000000000000000000000000000000000000001");
    expect((await caught(at(text.length))).code).toBe("too_large");
    expect((await caught(at(bytes - 1))).code).toBe("too_large");
    await expect(at(bytes)).resolves.toBeNull();
    // Default: a body just above 8 MiB is refused, one at 8 MiB is read.
    const padded = (size: number) => `{"data":{"Claim_by_pk":null}}${" ".repeat(size - 29)}`;
    const big = (size: number) => createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(async () => textResponse(padded(size))).fetch }).getClaim("0x0000000000000000000000000000000000000001");
    await expect(big(8 * 1024 * 1024)).resolves.toBeNull();
    expect((await caught(big(8 * 1024 * 1024 + 1))).code).toBe("too_large");
  });

  it("SEC-OPS-02 the timeout covers a body that stalls after the headers, even if fetch ignores the abort signal", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"data":`));
      },
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch: scripted(async () => ({ ok: true, status: 200, body })).fetch });
    const pending = caught(model.getClaim("0x0000000000000000000000000000000000000001"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error.code).toBe("timeout");
    expect(cancelled).toBe(true);
    expectRedacted(error);
  });

  it("cancels the body of a non-2xx response instead of reading it", async () => {
    const { body, state } = endless(1024);
    const error = await caught(createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(async () => ({ ok: false, status: 503, body })).fetch }).status());
    expect(error.code).toBe("http");
    expect(error.message).toBe("Envio read model Status: HTTP 503");
    await Promise.resolve();
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(1024);
  });
});

describe("lists returned whole (documented divergence: capped at 10,000 rows, native has no cap)", () => {
  /** The oracle snapshot with `count` rows of `entity` for one question (copies of a real row with distinct keys). */
  function withRows(entity: "OracleAnswer" | "ArbitrationStage" | "Claim", count: number): { data: EntitySnapshot; questionId: string } {
    const data = snapshot("oracle");
    const questionId = entity === "Claim" ? String(data.entities.Claim![0]!.questionId) : String(data.entities[entity]![0]!.questionId);
    const template = data.entities[entity]!.find((row) => row.questionId === questionId)!;
    const rows: EntitySnapshot["entities"][string] = [];
    for (let index = 0; index < count; index += 1) {
      const hex = index.toString(16).padStart(40, "0");
      rows.push(
        entity === "Claim"
          ? { ...template, id: `0x${hex}`, createdBlock: String(1_000_000 + index), createdLogIndex: "0" }
          : { ...template, id: `${questionId}:${2_000_000 + index}:0`, blockNumber: String(2_000_000 + index), logIndex: "0" },
      );
    }
    data.entities[entity] = rows;
    return { data, questionId };
  }

  it("UNPAGINATED_MAX_ROWS is 10,000", () => {
    expect(UNPAGINATED_MAX_ROWS).toBe(10_000);
  });

  for (const [entity, op, call] of [
    ["OracleAnswer", "ListOracleAnswers", (model: ReturnType<typeof createEnvioReadModel>, id: string) => model.listOracleAnswers(id as Hex32).then((rows) => rows.length)],
    ["Claim", "ListClaimsByQuestion", (model: ReturnType<typeof createEnvioReadModel>, id: string) => model.listClaimsByQuestion(id as Hex32).then((rows) => rows.length)],
    ["ArbitrationStage", "GetArbitration", (model: ReturnType<typeof createEnvioReadModel>, id: string) => model.getArbitration(id as Hex32).then((record) => record!.history.length)],
  ] as const) {
    it(`${op} returns exactly 10,000 rows and throws too_many_rows at 10,001 (never a silent truncation)`, async () => {
      const full = withRows(entity, UNPAGINATED_MAX_ROWS);
      if (entity === "ArbitrationStage") expect(full.data.entities.Arbitration!.some((row) => row.id === full.questionId)).toBe(true);
      // 10,000 claim rows are ~9 MB: above the default 8 MiB byte cap, which then fails closed first (too_large).
      const { fake, model } = modelOver(full.data, 32 * 1024 * 1024);
      expect(await call(model, full.questionId)).toBe(UNPAGINATED_MAX_ROWS);
      expect(fake.requests.at(-1)!.variables.limit).toBe(UNPAGINATED_MAX_ROWS + 1);
      expect(fake.requests.at(-1)!.query).toMatch(/limit: \$limit/);
      const over = withRows(entity, UNPAGINATED_MAX_ROWS + 1);
      const error = await caught(call(modelOver(over.data, 32 * 1024 * 1024).model, over.questionId));
      expect(error.code).toBe("too_many_rows");
      expect(error.message).toBe(`Envio read model ${op}: more than 10000 rows`);
    });
  }

  it("with the default byte cap, an oversized whole list still fails closed (too_large before the row cap)", async () => {
    const over = withRows("Claim", UNPAGINATED_MAX_ROWS + 1);
    expect((await caught(modelOver(over.data).model.listClaimsByQuestion(over.questionId as Hex32))).code).toBe("too_large");
  });

  it("the cap does not apply to paginated lists, whose limit stays 1..100 (+1)", async () => {
    const { fake, model } = modelOver(snapshot("oracle"));
    await model.listClaims({ order: "created_desc", limit: 100 });
    await model.listEvidence({ limit: 100 });
    expect(fake.requests.map((request) => request.variables.limit)).toEqual([101, 101]);
  });
});

describe("status()", () => {
  const meta = (rows: unknown[], progress: unknown) => ok({ data: { _meta: rows, IndexerProgress_by_pk: progress } });

  it("reads _meta for the configured chain and the progress singleton", async () => {
    const { fetch, calls } = scripted(meta([{ chainId: 1, progressBlock: 9, sourceBlock: 9 }, { chainId: 100, progressBlock: 1_200, sourceBlock: "1240" }], { blockNumber: "1100", blockTimestamp: "1800000000" }));
    const status = await createEnvioReadModel({ graphqlUrl: URL, fetch }).status();
    expect(status).toEqual({ backend: "envio", chainId: 100, indexedBlock: 1_200n, indexedBlockTimestamp: 1_800_000_000, headBlock: 1_240n, finalizedBlock: null, halted: false });
    expect(JSON.parse(calls[0]![1].body).variables).toEqual({ progressId: "100" });
  });

  it("SEC-IDX-07 never reports an indexed block below the last applied event, nor a fresher timestamp than it knows; 0 before any event", async () => {
    const behind = await createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(meta([{ chainId: 100, progressBlock: 5, sourceBlock: null }], { blockNumber: 7, blockTimestamp: 70 })).fetch }).status();
    expect(behind).toMatchObject({ indexedBlock: 7n, indexedBlockTimestamp: 70, headBlock: null });
    const empty = await createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(meta([{ chainId: 100, progressBlock: 0, sourceBlock: 10 }], null)).fetch }).status();
    expect(empty).toMatchObject({ indexedBlock: 0n, indexedBlockTimestamp: 0 });
  });

  it("an endpoint reporting GraphQL errors makes status() throw: it never answers halted: false over an error", async () => {
    const error = await caught(createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(ok({ errors: [{ message: "database error" }] })).fetch }).status());
    expect(error.code).toBe("graphql");
    expect(error.message).toBe("Envio read model Status: endpoint returned 1 GraphQL error(s)");
    const partial = await caught(createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(ok({ data: null, errors: [{ message: "x" }] })).fetch }).status());
    expect(partial.code).toBe("graphql");
  });

  it("fails closed when the endpoint does not index the configured chain or answers malformed metadata", async () => {
    expect((await caught(createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(meta([{ chainId: 1, progressBlock: 1, sourceBlock: 1 }], null)).fetch }).status())).code).toBe(
      "invalid_response",
    );
    expect((await caught(createEnvioReadModel({ graphqlUrl: URL, fetch: scripted(meta([{ chainId: 100, progressBlock: "x", sourceBlock: 1 }], null)).fetch }).status())).code).toBe(
      "invalid_response",
    );
  });
});
