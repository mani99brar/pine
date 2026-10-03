// Error mapping of the draft-delete / first-publication races (PRD-03 §8a/§8b): wrapped driver errors (drizzle's
// DrizzleQueryError and plain `cause` chains) map to 409 or NOT_FOUND, never a 500. No database: the concurrent case on
// real Postgres belongs to the assembly e2e; the lock order itself is asserted in publication.test.ts.

import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../contracts/errors.js";
import { draftDeleteRaceError, publicationInsertRaceError } from "./races.js";

const pgError = (code: string): Error => Object.assign(new Error(`driver error ${code}`), { code });
const drizzleWrapped = (code: string): Error => new DrizzleQueryError("insert into claim_publications ...", [], pgError(code));
const doublyWrapped = (code: string): Error => new Error("transaction failed", { cause: drizzleWrapped(code) });

describe("race error mapping (cause chain)", () => {
  for (const wrap of [pgError, drizzleWrapped, doublyWrapped]) {
    it(`draft delete: 23503, 23001, 40P01 and 40001 are 409 CONFLICT (${wrap.name})`, () => {
      for (const code of ["23503", "23001", "40P01", "40001"]) {
        const mapped = draftDeleteRaceError(wrap(code));
        expect(mapped, code).toBeInstanceOf(ApiError);
        expect(mapped?.code, code).toBe("CONFLICT");
      }
      expect(draftDeleteRaceError(wrap("23505"))).toBeNull();
      expect(draftDeleteRaceError(wrap("57014"))).toBeNull();
    });

    it(`first publication insert: 23503 is NOT_FOUND "Preview not found"; 40P01 and 40001 are 409 (${wrap.name})`, () => {
      const missing = publicationInsertRaceError(wrap("23503"));
      expect(missing?.code).toBe("NOT_FOUND");
      expect(missing?.message).toBe("Preview not found");
      expect(publicationInsertRaceError(wrap("40P01"))?.code).toBe("CONFLICT");
      expect(publicationInsertRaceError(wrap("40001"))?.code).toBe("CONFLICT");
      expect(publicationInsertRaceError(wrap("23001"))).toBeNull();
      expect(publicationInsertRaceError(wrap("23505"))).toBeNull();
    });
  }

  it("errors without a SQLSTATE are not mapped (rethrown as 500 by the caller)", () => {
    expect(draftDeleteRaceError(new Error("boom"))).toBeNull();
    expect(publicationInsertRaceError(new Error("boom"))).toBeNull();
    expect(publicationInsertRaceError(null)).toBeNull();
  });
});
