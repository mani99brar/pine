import { describe, expect, it } from "vitest";
import { formatUtc, renderQuestion, validateTitle, QuestionInputError, type QuestionInput } from "./question.js";
import { QUESTION_VECTORS, UTC_FORMAT_VECTORS } from "./testing/vectors.js";

describe("question renderer", () => {
  it("matches the frozen date vectors", () => {
    for (const [seconds, text] of UTC_FORMAT_VECTORS) expect(formatUtc(seconds)).toBe(text);
  });
  it("matches the frozen question vectors and stays printable ASCII", () => {
    for (const vector of QUESTION_VECTORS) {
      const question = renderQuestion(vector.input as unknown as QuestionInput);
      expect(question).toBe(vector.question);
      expect(/^[\x20-\x7e]+$/.test(question)).toBe(true);
      expect(question.includes("\u241f")).toBe(false);
    }
  });
  it("rejects titles that could break the Reality JSON template or hide text", () => {
    for (const bad of ["", "a\"b", "a\\b", "line\nbreak", "tab\tx", "caf\u00e9", "bidi\u202e", "zero\u200bwidth", "sep\u241f", "x".repeat(121)]) {
      expect(() => validateTitle(bad)).toThrow(QuestionInputError);
    }
    expect(() => validateTitle("Reporter deposits never use arbitration funds")).not.toThrow();
  });
  it("rejects timestamps outside uint32", () => {
    expect(() => formatUtc(2 ** 32)).toThrow(QuestionInputError);
    expect(() => formatUtc(-1)).toThrow(QuestionInputError);
  });
});
