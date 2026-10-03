// The fake's Hasura semantics, stated in fake-hasura.ts, tested directly (so the conformance run proves the read model
// against Hasura behaviour, not against a permissive stub).

import { describe, expect, it } from "vitest";
import { createFakeHasura } from "./fake-hasura.js";
import type { EntitySnapshot } from "./snapshots.js";

const URL = "https://envio.test/v1/graphql";

const DATA: EntitySnapshot = {
  scenario: "unit",
  eventsSha256: "0".repeat(64),
  entities: {
    Claim: [
      { id: "0x0000000000000000000000000000000000000002", createdBlock: "10", createdLogIndex: "0", evidenceDeadline: "9", creator: "0xaa", title: "two" },
      { id: "0x0000000000000000000000000000000000000001", createdBlock: "9", createdLogIndex: "1", evidenceDeadline: "100", creator: "0xbb", title: "one" },
      { id: "0x0000000000000000000000000000000000000003", createdBlock: "9", createdLogIndex: "0", evidenceDeadline: "100", creator: "0xaa", title: null },
    ],
    IndexerProgress: [{ id: "100", blockNumber: "10", blockTimestamp: "1800000000" }],
  },
};

async function query(query: string, variables: Record<string, unknown> = {}): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const fake = createFakeHasura(DATA, { url: URL });
  const response = await fake.fetch(URL, { method: "POST", headers: {}, body: JSON.stringify({ query, variables }), redirect: "error", signal: new AbortController().signal });
  return (await new Response(response.body).json()) as never;
}

const ids = (result: { data?: Record<string, unknown> }, root = "Claim") => (result.data?.[root] as { id: string }[]).map((row) => row.id.slice(-1));

describe("fake Hasura semantics", () => {
  it("returns BigInt (numeric) columns as decimal strings and nullable columns as null", async () => {
    const result = await query(`query { Claim_by_pk(id: "0x0000000000000000000000000000000000000003") { createdBlock title } }`);
    expect(result).toEqual({ data: { Claim_by_pk: { createdBlock: "9", title: null } } });
  });

  it("compares numerics numerically (\"10\" > \"9\"), from string or integer inputs", async () => {
    expect(ids(await query(`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, { w: { createdBlock: { _gt: "9" } } }))).toEqual(["2"]);
    expect(ids(await query(`query { Claim(where: {evidenceDeadline: {_lt: 10}}) { id } }`))).toEqual(["2"]);
    expect(ids(await query(`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, { w: { evidenceDeadline: { _gte: "100" }, createdLogIndex: { _lte: "0" } } }))).toEqual(["3"]);
    expect((await query(`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, { w: { createdBlock: { _gt: "1e3" } } })).errors).toHaveLength(1);
  });

  it("orders by several keys in both directions and applies limit after ordering", async () => {
    const orderBy = [{ createdBlock: "desc" }, { createdLogIndex: "desc" }];
    expect(ids(await query(`query ($o: [Claim_order_by!]!) { Claim(order_by: $o) { id } }`, { o: orderBy }))).toEqual(["2", "1", "3"]);
    expect(ids(await query(`query ($o: [Claim_order_by!]!, $l: Int!) { Claim(order_by: $o, limit: $l) { id } }`, { o: orderBy, l: 2 }))).toEqual(["2", "1"]);
    expect(ids(await query(`query { Claim(order_by: [{evidenceDeadline: asc}, {id: asc}]) { id } }`))).toEqual(["2", "1", "3"]);
  });

  it("evaluates _and/_or/_eq like Hasura bool_exp", async () => {
    const where = { _and: [{ creator: { _eq: "0xaa" } }, { _or: [{ createdBlock: { _lt: "9" } }, { createdBlock: { _eq: "9" }, createdLogIndex: { _lt: "1" } }] }] };
    expect(ids(await query(`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, { w: where }))).toEqual(["3"]);
    expect(ids(await query(`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, { w: {} }))).toHaveLength(3);
  });

  it("serves _meta rows with Int columns and the snapshot's progress block", async () => {
    expect(await query(`query { _meta { chainId progressBlock sourceBlock } }`)).toEqual({ data: { _meta: [{ chainId: 100, progressBlock: 10, sourceBlock: 50 }] } });
  });

  it("answers GraphQL errors for unknown fields, arguments, roots and mistyped or missing variables", async () => {
    for (const [text, variables] of [
      [`query { Claim { nope } }`, {}],
      [`query { Claim(where: {nope: {_eq: "1"}}) { id } }`, {}],
      [`query { Claim(distinct_on: id) { id } }`, {}],
      [`query { Nope { id } }`, {}],
      [`query ($w: String!) { Claim(where: $w) { id } }`, { w: {} }],
      [`query ($w: Claim_bool_exp!) { Claim(where: $w) { id } }`, {}],
      [`query { Claim(where: $w) { id } }`, { w: {} }],
      [`query ($id: Int!) { Claim_by_pk(id: $id) { id } }`, { id: 1 }],
      [`query { Claim(order_by: {id: sideways}) { id } }`, {}],
      [`query { Claim }`, {}],
      [`mutation { Claim { id } }`, {}],
    ] as const) {
      const result = await query(text, variables);
      expect(result.errors, text).toHaveLength(1);
      expect(result.data, text).toBeUndefined();
    }
  });

  it("refuses requests to any other URL", async () => {
    const fake = createFakeHasura(DATA, { url: URL });
    await expect(fake.fetch("https://elsewhere.test/", { method: "POST", headers: {}, body: "{}", redirect: "error", signal: new AbortController().signal })).rejects.toThrow();
  });
});
