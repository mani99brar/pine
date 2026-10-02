import { describe, expect, it } from "vitest";
import { formatUtc, renderQuestion, tokenNames, validateTitle, QuestionInputError, type QuestionInput } from "./question.js";
import { QUESTION_VECTORS, TOKEN_NAME_VECTORS, UTC_FORMAT_VECTORS } from "./testing/vectors.js";

describe("question renderer", () => {
  it("matches the frozen token-name vectors", () => {
    for (const vector of TOKEN_NAME_VECTORS) expect(tokenNames(vector.claimDocumentSha256)).toEqual(vector.tokenNames);
  });
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
  it("produces a question that is valid inside Seer's Reality template-2 JSON and Seer's encoded question", () => {
    for (const vector of QUESTION_VECTORS) {
      const question = renderQuestion(vector.input as unknown as QuestionInput);
      // Seer: encodedQuestion = marketName + U+241F + '"Yes","No"' + U+241F + category + U+241F + lang; Reality template 2:
      const parts = `${question}\u241f"Yes","No"\u241fmisc\u241fen_US`.split("\u241f");
      expect(parts.length).toBe(4);
      const json = `{"title": "${parts[0]}", "type": "single-select", "outcomes": [${parts[1]}], "category": "${parts[2]}", "lang": "${parts[3]}"}`;
      const parsed = JSON.parse(json) as { title: string; outcomes: string[]; category: string; lang: string };
      expect(parsed.title).toBe(question);
      expect(parsed.outcomes).toEqual(["Yes", "No"]);
      expect(Object.keys(parsed)).toEqual(["title", "type", "outcomes", "category", "lang"]);
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
