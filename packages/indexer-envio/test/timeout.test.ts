import "./lock.js";

// ENVIO_QUESTION_TIMEOUT reaches the handlers (OracleQuestion.timeout and every finalizeTs derived from it). Each test
// file runs in its own fork process and the handlers read the variable once when Envio loads them, so it is set here,
// before this file's first createTestIndexer(), and compared with MemoryReadModel using the same timeout.

import { afterAll, describe, expect, it, vi } from "vitest";
import { scenarioOracle, SCENARIO_QUESTION_TIMEOUT } from "@pine/shared/testing/read-model-scenarios";
import { expectEquivalent, runEnvio } from "./differential.js";

const TIMEOUT = 86_400;
vi.stubEnv("ENVIO_QUESTION_TIMEOUT", String(TIMEOUT));
afterAll(() => {
  vi.unstubAllEnvs();
});

describe("ENVIO_QUESTION_TIMEOUT in the handlers", () => {
  it("a configured timeout of 86400 s sets every question's timeout and finalizeTs = ts + 86400, as the reference computes", async () => {
    expect(TIMEOUT).not.toBe(SCENARIO_QUESTION_TIMEOUT);
    const events = scenarioOracle().events;
    const indexer = await runEnvio(events);
    await expectEquivalent(events, indexer, TIMEOUT);
    const questions = await indexer.OracleQuestion.getAll();
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) expect(question.timeout).toBe(BigInt(TIMEOUT));
    const answer = events.find((event) => event.kind === "RealityNewAnswer" && !event.isCommitment && event.bond > 0n);
    if (answer?.kind !== "RealityNewAnswer") throw new Error("scenarioOracle has a bonded answer");
    const answered = await indexer.OracleQuestion.getOrThrow(answer.questionId);
    expect(answered.answerCount).toBeGreaterThan(0n);
  });
});
