// Every entity and field the read model queries exists in packages/indexer-envio/schema.graphql with the expected
// scalar kind, so a schema rename cannot silently break the read model (the fake rejects unknown fields too).

import { describe, expect, it } from "vitest";
import { ENVIO_PROGRESS } from "../src/envio-meta.js";
import { ANSWER_FIELDS, ARBITRATION_FIELDS, CLAIM_FIELDS, EVIDENCE_FIELDS, QUESTION_FIELDS, RESOLUTION_FIELDS, STAGE_FIELDS } from "../src/queries.js";
import { loadSchema } from "./fake-hasura.js";

const schema = loadSchema();

describe("queries match the indexer schema", () => {
  for (const [entity, fields] of [
    ["Claim", CLAIM_FIELDS],
    ["EvidenceSubmission", EVIDENCE_FIELDS],
    ["OracleQuestion", QUESTION_FIELDS],
    ["OracleAnswer", ANSWER_FIELDS],
    ["Arbitration", ARBITRATION_FIELDS],
    ["ArbitrationStage", STAGE_FIELDS],
    ["ConditionResolution", RESOLUTION_FIELDS],
    [ENVIO_PROGRESS.entity, [ENVIO_PROGRESS.blockNumber, ENVIO_PROGRESS.blockTimestamp]],
  ] as const) {
    it(`${entity} has every queried field`, () => {
      const types = schema.get(entity);
      expect(types, entity).toBeDefined();
      for (const field of fields) expect(types!.has(field), `${entity}.${field}`).toBe(true);
    });
  }

  it("stores every number the read model returns as BigInt and lists as Json (decisions.md)", () => {
    for (const [entity, types] of schema) {
      for (const [field, type] of types) {
        expect(type.base, `${entity}.${field}`).not.toBe("Int");
        expect(type.base, `${entity}.${field}`).not.toBe("Float");
      }
    }
    expect(schema.get("OracleQuestion")!.get("markets")!.base).toBe("Json");
    expect(schema.get("ConditionResolution")!.get("payoutNumerators")!.base).toBe("Json");
    expect(schema.get("Claim")!.get("repositoryId")!.base).toBe("BigInt");
  });
});
