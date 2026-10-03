// Validation of every row kind, cursor scope, status field, query input and option, plus redaction of every error code
// and the default (production) fetch path. Each case goes through the public ReadModel methods over the Hasura fake
// serving the committed handler snapshots, with one field corrupted.

import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidCursorError } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import { createEnvioReadModel, EnvioReadModelError, type FetchLike, type FetchResponseLike } from "../src/index.js";
import { UNPAGINATED_MAX_ROWS } from "../src/queries.js";
import { createFakeHasura, jsonResponse } from "./fake-hasura.js";
import { loadSnapshots, type EntitySnapshot, type JsonValue, type Row } from "./snapshots.js";

const URL = "https://envio.test/v1/graphql?apiKey=url-api-key";
const SECRET = "super-secret-admin-value";
const MARKER = "MARKER-untrusted-row-text";
const UNSAFE = "9007199254740993"; // 2^53 + 1
const UPPER_ADDRESS = "0xABCDEF0000000000000000000000000000000001";

const snapshot = (name: string): EntitySnapshot => {
  const found = loadSnapshots().find((item) => item.scenario === name);
  if (!found) throw new Error(`missing snapshot ${name}`);
  return structuredClone(found);
};

function modelOver(data: EntitySnapshot) {
  const fake = createFakeHasura(data, { url: URL, adminSecret: SECRET });
  return { fake, model: createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch: fake.fetch }) };
}

async function caught(promise: Promise<unknown>): Promise<EnvioReadModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnvioReadModelError);
    return error as EnvioReadModelError;
  }
  throw new Error("expected a rejection");
}

/** No secret, URL part, row text or underlying message; no chained cause; bounded length. */
function expectRedacted(error: EnvioReadModelError, extra: string[] = []): void {
  const text = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
  for (const secret of [SECRET, "url-api-key", "envio.test", URL, MARKER, ...extra]) expect(text).not.toContain(secret);
  expect(error.cause).toBeUndefined();
  expect(error.message.length).toBeLessThanOrEqual(200);
}

type Mutation = readonly [label: string, mutate: (row: Row) => void];
const set = (field: string, value: JsonValue | undefined): ((row: Row) => void) => (row) => {
  if (value === undefined) delete row[field];
  else row[field] = value;
};

/** For each entity: the snapshot, the row to corrupt, the public call that reads it, and the corruptions. */
const CASES: readonly {
  entity: string;
  scenario: string;
  pick: (data: EntitySnapshot) => Row;
  read: (model: ReturnType<typeof createEnvioReadModel>, row: Row) => Promise<unknown>;
  mutations: readonly Mutation[];
}[] = [
  {
    entity: "OracleQuestion",
    scenario: "oracle",
    pick: (data) => data.entities.OracleQuestion![0]!,
    read: (model, row) => model.getOracleQuestion(String(row.id) as Hex32),
    mutations: [
      ["an uppercase address in markets", set("markets", [UPPER_ADDRESS])],
      ["an uppercase arbitrationRequestedBy", set("arbitrationRequestedBy", UPPER_ADDRESS)],
      ["a bestAnswer that is not hex32", set("bestAnswer", "0xabc")],
      ["an uppercase bestAnswer", set("bestAnswer", `0x${"AB".repeat(32)}`)],
      ["finalizeTs above 2^53", set("finalizeTs", UNSAFE)],
      ["finalizeTs as a JSON number above 2^53", set("finalizeTs", 1e20)],
      ["a negative finalizeTs", set("finalizeTs", "-1")],
      ["a negative timeout", set("timeout", "-1")],
      ["openingTs above 2^53", set("openingTs", UNSAFE)],
      ["a negative bond", set("bond", "-5")],
      ["pendingArbitration as a string", set("pendingArbitration", "true")],
      ["a missing answerCount", set("answerCount", undefined)],
      ["markets as an object", set("markets", { a: 1 })],
    ],
  },
  {
    entity: "OracleAnswer",
    scenario: "oracle",
    pick: (data) => data.entities.OracleAnswer![0]!,
    read: (model, row) => model.listOracleAnswers(String(row.questionId) as Hex32),
    mutations: [
      ["an uppercase answerer", set("answerer", UPPER_ADDRESS)],
      ["an answerer that is not an address", set("answerer", MARKER)],
      ["an answer that is not hex32", set("answer", "0x1234")],
      ["a revealedAnswer that is not hex32", set("revealedAnswer", "yes")],
      ["ts above 2^53", set("ts", UNSAFE)],
      ["a negative ts", set("ts", "-1")],
      ["a bond that is not a decimal", set("bond", "1e18")],
      ["isCommitment as a number", set("isCommitment", 0)],
      ["a txHash that is not hex32", set("txHash", "0x00")],
      ["a missing historyHash", set("historyHash", undefined)],
    ],
  },
  {
    entity: "Arbitration",
    scenario: "oracle",
    pick: (data) => data.entities.Arbitration![0]!,
    read: (model, row) => model.getArbitration(String(row.id) as Hex32),
    mutations: [
      ["an unknown stage", set("stage", "RequestInvented")],
      ["an uppercase requester", set("requester", UPPER_ADDRESS)],
      ["an arbitratorAnswer that is not hex32", set("arbitratorAnswer", "0x01")],
      ["updatedAt above 2^53", set("updatedAt", UNSAFE)],
      ["a negative updatedAt", set("updatedAt", "-1")],
      ["rejectionReason as a number", set("rejectionReason", 5)],
      ["a missing stage", set("stage", undefined)],
    ],
  },
  {
    entity: "ArbitrationStage",
    scenario: "oracle",
    pick: (data) => data.entities.ArbitrationStage![0]!,
    read: (model, row) => model.getArbitration(String(row.questionId) as Hex32),
    mutations: [
      ["an unknown stage", set("stage", "requestnotified")],
      ["a txHash that is not hex32", set("txHash", "0x1")],
      ["an uppercase txHash", set("txHash", `0x${"CD".repeat(32)}`)],
      ["at above 2^53", set("at", UNSAFE)],
      ["a negative at", set("at", "-1")],
      ["a missing logIndex", set("logIndex", undefined)],
      ["at as a boolean", set("at", true)],
    ],
  },
  {
    entity: "EvidenceSubmission",
    scenario: "claims-and-evidence",
    pick: (data) => data.entities.EvidenceSubmission![0]!,
    read: (model, row) => model.getEvidence(String(row.registry) as Address, BigInt(String(row.submissionId))),
    mutations: [
      ["an uppercase submitter", set("submitter", UPPER_ADDRESS)],
      ["an uppercase market", set("market", UPPER_ADDRESS)],
      ["an unknown status", set("status", "pending")],
      ["a commitment that is not hex32", set("commitment", "0xzz")],
      ["a contentSha256 that is not hex32", set("contentSha256", MARKER)],
      ["committedAt above 2^53", set("committedAt", UNSAFE)],
      ["a negative revealedAt", set("revealedAt", "-1")],
      ["a committedTxHash that is not hex32", set("committedTxHash", "0x")],
      ["a missing committedLogIndex", set("committedLogIndex", undefined)],
      ["status as a number", set("status", 1)],
    ],
  },
  {
    entity: "EvidenceSubmission (listEvidence)",
    scenario: "claims-and-evidence",
    pick: (data) => data.entities.EvidenceSubmission![0]!,
    read: (model) => model.listEvidence({ limit: 100 }),
    mutations: [
      ["an uppercase submitter", set("submitter", UPPER_ADDRESS)],
      ["an unknown status", set("status", "pending")],
      ["committedAt above 2^53", set("committedAt", UNSAFE)],
    ],
  },
  {
    entity: "ConditionResolution",
    scenario: "oracle",
    pick: (data) => data.entities.ConditionResolution![0]!,
    read: (model, row) => model.getConditionResolution(String(row.id) as Hex32),
    mutations: [
      ["resolvedAt above 2^53", set("resolvedAt", UNSAFE)],
      ["a negative resolvedAt", set("resolvedAt", "-1")],
      ["a txHash that is not hex32", set("txHash", "0x5d43")],
      ["an uppercase ctfQuestionId", set("ctfQuestionId", `0x${"EF".repeat(32)}`)],
      ["a negative payout numerator", set("payoutNumerators", ["-1", "0"])],
      ["a payout numerator that is not a decimal", set("payoutNumerators", ["0x1", "0"])],
      ["a blockNumber that is not a decimal", set("blockNumber", "1e3")],
      ["a missing resolvedAt", set("resolvedAt", undefined)],
    ],
  },
];

describe("response validation of every row kind (SEC-IDX-05, read-model side)", () => {
  for (const { entity, scenario, pick, read, mutations } of CASES) {
    it(`${entity}: the untouched row validates`, async () => {
      const data = snapshot(scenario);
      await expect(read(modelOver(data).model, pick(data))).resolves.toBeTruthy();
    });

    for (const [label, mutate] of mutations) {
      it(`${entity}: rejects ${label} (invalid_response, redacted)`, async () => {
        const data = snapshot(scenario);
        const row = pick(data);
        const original = structuredClone(row);
        mutate(row);
        expect(row).not.toEqual(original);
        const error = await caught(read(modelOver(data).model, original));
        expect(error.code).toBe("invalid_response");
        expectRedacted(error);
      });
    }
  }
});

describe("redacted errors", () => {
  it("an invalid row's untrusted text (title, rejection reason) never reaches the error, which names only the failing field", async () => {
    const data = snapshot("claims-and-evidence");
    const claim = data.entities.Claim![0]!;
    claim.title = `${MARKER} title`;
    claim.marketName = `${MARKER} market`;
    claim.creator = `${MARKER}-creator`;
    const error = await caught(modelOver(data).model.getClaim(String(claim.id) as Address));
    expect(error.code).toBe("invalid_response");
    expect(error.message).toBe("Envio read model GetClaim: response failed validation at Claim_by_pk.creator");
    expectRedacted(error);

    const oracle = snapshot("oracle");
    const arbitration = oracle.entities.Arbitration![0]!;
    arbitration.rejectionReason = `${MARKER} reason`;
    arbitration.stage = `${MARKER}-stage`;
    const stageError = await caught(modelOver(oracle).model.getArbitration(String(arbitration.id) as Hex32));
    expect(stageError.code).toBe("invalid_response");
    expectRedacted(stageError);
  });

  it("no error code chains a cause or carries request or response details", async () => {
    const respond = (response: () => Promise<FetchResponseLike>): FetchLike => async () => response();
    const text = (body: string, status = 200): FetchResponseLike => ({ ok: status === 200, status, body: new Response(body).body });
    const model = (fetch: FetchLike, extra: { maxResponseBytes?: number; timeoutMs?: number } = {}) => createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET, fetch, ...extra });
    const id = "0x0000000000000000000000000000000000000001" as Address;
    const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(`aborted ${URL} ${SECRET}`))));
    const answer = snapshot("oracle").entities.OracleAnswer![0]!;
    const rows = Array.from({ length: UNPAGINATED_MAX_ROWS + 1 }, () => answer);
    const errors: [string, () => Promise<unknown>][] = [
      ["network", () => model(async () => Promise.reject(new TypeError(`fetch failed ${URL} ${SECRET} ${MARKER}`))).getClaim(id)],
      ["timeout", () => model(hang, { timeoutMs: 10 }).getClaim(id)],
      ["http", () => model(respond(async () => text(`${MARKER} ${SECRET}`, 500))).getClaim(id)],
      ["too_large", () => model(respond(async () => text(`{"data":"${MARKER}${" ".repeat(2_000)}"}`)), { maxResponseBytes: 100 }).getClaim(id)],
      ["invalid_json", () => model(respond(async () => text(`<html>${MARKER}</html>`))).getClaim(id)],
      ["graphql", () => model(respond(async () => jsonResponse({ errors: [{ message: `${MARKER} ${SECRET}` }] }))).getClaim(id)],
      ["invalid_response", () => model(respond(async () => jsonResponse({ data: { Claim_by_pk: { id: MARKER } } }))).getClaim(id)],
      ["too_many_rows", () => model(respond(async () => jsonResponse({ data: { OracleAnswer: rows } }))).listOracleAnswers(String(answer.questionId) as Hex32)],
    ];
    for (const [code, call] of errors) {
      const error = await caught(call());
      expect(error.code, code).toBe(code);
      expectRedacted(error);
    }
    const configuration = await caught(Promise.resolve().then(() => createEnvioReadModel({ graphqlUrl: `ftp://${MARKER}@envio.test/` })));
    expect(configuration.code).toBe("configuration");
    expectRedacted(configuration);
  });
});

describe("cursors of every scope (crafted cursors never reach the endpoint)", () => {
  const forged = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");
  const market = "0x0000000000000000000000000000000000000001";

  it("listEvidence rejects forged evidence-scope cursors with InvalidCursorError before any request", async () => {
    const { fake, model } = modelOver(snapshot("claims-and-evidence"));
    const valid = forged({ v: 1, scope: "evidence", key: ["1002", "0"] });
    await model.listEvidence({ limit: 1, cursor: valid });
    const before = fake.requests.length;
    for (const key of [["-1", "0"], ["1", "-1"], ["0x10", "0"], ["1", "0x10"], ["1e3", "0"], ["01", "0"], [1, 0], ["1", 0], ["1"], ["1", "0", "0"], ["9".repeat(79), "0"], ["1", "9".repeat(79)], [], null, "1,0"]) {
      await expect(model.listEvidence({ limit: 1, cursor: forged({ v: 1, scope: "evidence", key }) }), JSON.stringify(key)).rejects.toBeInstanceOf(InvalidCursorError);
    }
    for (const body of [{ v: 2, scope: "evidence", key: ["1", "0"] }, { scope: "evidence", key: ["1", "0"] }, { v: 1, scope: "created_desc", key: ["1", "0"] }, [1, 0], "x"]) {
      await expect(model.listEvidence({ limit: 1, cursor: forged(body) })).rejects.toBeInstanceOf(InvalidCursorError);
    }
    expect(fake.requests.length).toBe(before);
  });

  it("listClaims rejects evidence_deadline_asc cursors with a bad deadline or market part before any request", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    await model.listClaims({ order: "evidence_deadline_asc", limit: 1, cursor: forged({ v: 1, scope: "evidence_deadline_asc", key: ["5", market] }) });
    const before = fake.requests.length;
    for (const key of [
      ["-1", market],
      ["0x10", market],
      ["1e3", market],
      ["1.5", market],
      [5, market],
      ["9".repeat(79), market],
      ["5", "0x00000000000000000000000000000000000000AB"],
      ["5", "0x01"],
      ["5", 1],
      [market],
      ["5", market, "1"],
    ]) {
      await expect(model.listClaims({ order: "evidence_deadline_asc", limit: 1, cursor: forged({ v: 1, scope: "evidence_deadline_asc", key }) }), JSON.stringify(key)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    }
    for (const key of [["1", "-1"], ["0x1", "0"], ["1", "9".repeat(79)], ["1", "0", "0"]]) {
      await expect(model.listClaims({ order: "created_desc", limit: 1, cursor: forged({ v: 1, scope: "created_desc", key }) })).rejects.toBeInstanceOf(InvalidCursorError);
    }
    expect(fake.requests.length).toBe(before);
  });
});

describe("status() validates the endpoint's metadata (SEC-IDX-07)", () => {
  const status = (meta: unknown, progress: unknown) =>
    createEnvioReadModel({ graphqlUrl: URL, fetch: async () => jsonResponse({ data: { _meta: [meta], IndexerProgress_by_pk: progress } }) }).status();

  it("rejects an unsafe, negative or non-decimal progress timestamp or block, and a negative or non-numeric head", async () => {
    const meta = { chainId: 100, progressBlock: 10, sourceBlock: 50 };
    await expect(status(meta, { blockNumber: "10", blockTimestamp: "1800000000" })).resolves.toMatchObject({ indexedBlockTimestamp: 1_800_000_000, headBlock: 50n });
    for (const [label, metaRow, progress] of [
      ["blockTimestamp -1", meta, { blockNumber: "10", blockTimestamp: "-1" }],
      ["blockTimestamp 2^53 + 1", meta, { blockNumber: "10", blockTimestamp: UNSAFE }],
      ["blockTimestamp 1e20 (JSON number)", meta, { blockNumber: "10", blockTimestamp: 1e20 }],
      ["blockNumber -1", meta, { blockNumber: "-1", blockTimestamp: "1" }],
      ["sourceBlock -1", { ...meta, sourceBlock: "-1" }, null],
      ["sourceBlock 1.5", { ...meta, sourceBlock: 1.5 }, null],
      ["progressBlock -1", { ...meta, progressBlock: -1 }, null],
      ["chainId as a string", { ...meta, chainId: "100" }, null],
    ] as const) {
      const error = await caught(status(metaRow, progress));
      expect(error.code, label).toBe("invalid_response");
    }
  });
});

describe("query inputs and options fail closed", () => {
  it("rejects deadline filters that are not safe integers, before any request", async () => {
    const { fake, model } = modelOver(snapshot("many-claims"));
    for (const value of [1.5, Number.NaN, 2 ** 53, Number.POSITIVE_INFINITY, -(2 ** 53)]) {
      await expect(model.listClaims({ order: "evidence_deadline_asc", limit: 5, evidenceDeadlineAtOrBefore: value }), String(value)).rejects.toThrow(RangeError);
      await expect(model.listClaims({ order: "evidence_deadline_asc", limit: 5, evidenceDeadlineAfter: value }), String(value)).rejects.toThrow(RangeError);
    }
    expect(fake.requests).toEqual([]);
  });

  it("refuses an invalid timeoutMs, chainId or maxResponseBytes with code configuration, without echoing the value", async () => {
    for (const [field, value] of [
      ["timeoutMs", 0],
      ["timeoutMs", -1],
      ["timeoutMs", 1.5],
      ["timeoutMs", 120_001],
      ["chainId", 0],
      ["chainId", -100],
      ["chainId", 1.5],
      ["maxResponseBytes", 0],
      ["maxResponseBytes", -1],
      ["maxResponseBytes", 2.5],
    ] as const) {
      const error = await caught(Promise.resolve().then(() => createEnvioReadModel({ graphqlUrl: URL, fetch: async () => jsonResponse({}), [field]: value })));
      expect(error.code, `${field} ${value}`).toBe("configuration");
      expect(error.message).toBe("Envio read model configuration: options must be valid");
    }
    expect(() => createEnvioReadModel({ graphqlUrl: URL, timeoutMs: 120_000, chainId: 1, maxResponseBytes: 1 })).not.toThrow();
  });

  it("sends a checksummed submitter filter lowercased", async () => {
    const { fake, model } = modelOver(snapshot("claims-and-evidence"));
    const row = snapshot("claims-and-evidence").entities.EvidenceSubmission![0]!;
    const lower = String(row.submitter);
    const checksummed = `0x${lower.slice(2).toUpperCase()}` as Address;
    const page = await model.listEvidence({ limit: 10, submitter: checksummed });
    expect(fake.requests.at(-1)!.variables).toEqual({ where: { submitter: { _eq: lower } }, orderBy: [{ committedBlock: "asc" }, { committedLogIndex: "asc" }], limit: 11 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.submitter === lower)).toBe(true);
  });
});

describe("the default fetch (production path: no fetch option)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs once to the configured URL with redirects refused and an abort signal, and reads the body as a stream", async () => {
    const calls: [unknown, RequestInit][] = [];
    let pulled = 0;
    vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
      calls.push([url, init]);
      const bytes = new TextEncoder().encode(JSON.stringify({ data: { Claim_by_pk: null } }));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const model = createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET });
    await expect(model.getClaim("0x0000000000000000000000000000000000000001")).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["x-hasura-admin-secret"]).toBe(SECRET);
    expect(JSON.parse(String(init.body)).operationName).toBe("GetClaim");
    expect(pulled).toBe(1);
  });

  it("maps a fetch TypeError (as fetch raises on a redirect) to code network, redacted", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed: redirect mode is set to error (${URL}, ${SECRET})`);
    });
    const error = await caught(createEnvioReadModel({ graphqlUrl: URL, adminSecret: SECRET }).getClaim("0x0000000000000000000000000000000000000001"));
    expect(error.code).toBe("network");
    expectRedacted(error, ["redirect"]);
  });
});
