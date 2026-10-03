import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChainEvent } from "@pine/shared/chain-events";
import { conditionalTokensAbi, realityV3Abi } from "@pine/shared/abi/external";
import { GNOSIS_EXTERNAL } from "@pine/shared/deployment";
import { SCENARIO_ADDRESSES, claimCreated, EventBuilder, scenarioClaimsAndEvidence, scenarioManyClaims, scenarioOracle } from "@pine/shared/testing/read-model-scenarios";
import type { Address, Hex32 } from "@pine/shared/types";
import { ALL_TOPIC0S, createDecoder, DecodeError, EVENT_SPECS, type RawLog } from "../src/decode.js";
import { encodeChainEvent } from "./encode.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

interface Fixture {
  name: string;
  signature: string;
  topic0: string;
  header: { number: string; hash: string; timestamp: number };
  log: { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string };
  castDecodedData: string[];
  stateCheck?: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const fixtures = (readJson("gnosis-logs.json") as { fixtures: Fixture[] }).fixtures;
const verification = readJson("topic0-verification.json") as {
  contracts: Record<string, { address: string; eip1967Implementation: string | null; events: { signature: string; topic0: string; inBytecode: boolean }[] }>;
};

const BIGINT_FIELDS = new Set(["blockNumber", "bond", "maxPrevious", "submissionId", "minBond", "nonce", "bounty", "bountyAdded"]);

function expectedEvent(raw: Record<string, unknown>): ChainEvent {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (BIGINT_FIELDS.has(key) && typeof value === "string") out[key] = BigInt(value);
    else if (key === "payoutNumerators" && Array.isArray(value)) out[key] = value.map((item) => BigInt(String(item)));
    else out[key] = value;
  }
  return out as unknown as ChainEvent;
}

function rawOf(fixture: Fixture): RawLog {
  return {
    address: fixture.log.address as RawLog["address"],
    topics: fixture.log.topics as RawLog["topics"],
    data: fixture.log.data as RawLog["data"],
    blockNumber: BigInt(fixture.log.blockNumber),
    blockHash: fixture.log.blockHash as RawLog["blockHash"],
    transactionHash: fixture.log.transactionHash as RawLog["transactionHash"],
    logIndex: Number(fixture.log.logIndex),
  };
}

const gnosisDecoder = createDecoder(100, {
  claimRegistry: SCENARIO_ADDRESSES.claimRegistry,
  evidenceRegistry: SCENARIO_ADDRESSES.evidenceRegistry,
  reality: GNOSIS_EXTERNAL.seer.realitio,
  conditionalTokens: GNOSIS_EXTERNAL.seer.conditionalTokens,
  klerosHomeProxy: GNOSIS_EXTERNAL.kleros.homeProxy,
});

describe("decoding real Gnosis logs (committed fixtures)", () => {
  it("covers every required event kind with real, non-synthetic logs", () => {
    const names = fixtures.map((fixture) => fixture.name);
    for (const required of ["reality-LogNewAnswer", "reality-LogNotifyOfArbitrationRequest", "reality-LogFinalize", "ctf-ConditionResolution"]) expect(names).toContain(required);
    expect(names.some((name) => name.startsWith("kleros-"))).toBe(true);
    expect(JSON.stringify(fixtures)).not.toContain("synthetic");
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} decodes into the independently derived ChainEvent (topic0 and field order)`, () => {
      const spec = EVENT_SPECS.find((item) => item.topic0 === fixture.log.topics[0]);
      expect(spec?.topic0).toBe(fixture.topic0);
      expect(fixture.log.blockHash).toBe(fixture.header.hash);
      expect(gnosisDecoder.decode(rawOf(fixture), fixture.header.timestamp)).toEqual(expectedEvent(fixture.expected));
    });
  }

  it("the arbitrator's bond-0 LogNewAnswer follows LogFinalize in the same transaction (reference assumption)", () => {
    const finalize = fixtures.find((fixture) => fixture.name === "reality-LogFinalize")!;
    const answer = fixtures.find((fixture) => fixture.name === "reality-LogNewAnswer-arbitrator")!;
    expect(answer.log.transactionHash).toBe(finalize.log.transactionHash);
    expect(Number(answer.log.logIndex)).toBe(Number(finalize.log.logIndex) + 1);
    expect(expectedEvent(answer.expected)).toMatchObject({ bond: 0n, ts: answer.header.timestamp });
  });
});

describe("topic0 verification against deployed bytecode", () => {
  const expectedAddresses: Record<string, string> = {
    reality: GNOSIS_EXTERNAL.seer.realitio,
    conditionalTokens: GNOSIS_EXTERNAL.seer.conditionalTokens,
    klerosHomeProxy: GNOSIS_EXTERNAL.kleros.homeProxy,
  };
  for (const [source, record] of Object.entries(verification.contracts)) {
    it(`${source}: every requested topic0 was found in the deployed code and equals the decoder's`, () => {
      expect(record.address).toBe(expectedAddresses[source]);
      const requested = EVENT_SPECS.filter((spec) => spec.source === source);
      expect(requested.length).toBe(record.events.length);
      for (const spec of requested) {
        const entry = record.events.find((event) => event.topic0 === spec.topic0);
        expect(entry, `${source}.${spec.name}`).toBeDefined();
        expect(entry?.inBytecode).toBe(true);
        expect(entry?.signature.startsWith(`${spec.name}(`)).toBe(true);
      }
    });
  }

  it("requests exactly the 19 topic0s of chain-events.ts", () => {
    expect(ALL_TOPIC0S.length).toBe(19);
    expect(new Set(ALL_TOPIC0S).size).toBe(19);
  });
});

describe("strict decoding and the ChainEvent domain", () => {
  const scenarioDecoder = createDecoder(100, SCENARIO_ADDRESSES);

  it("round-trips every event of the frozen scenarios through its ABI encoding", () => {
    const events = [...scenarioClaimsAndEvidence().events, ...scenarioOracle().events, ...scenarioManyClaims().events];
    for (const event of events) {
      expect(scenarioDecoder.decode(encodeChainEvent(event), event.blockTimestamp)).toEqual(event);
    }
  });

  it("a log whose data does not decode under its topic0 is a DecodeError", () => {
    const event = scenarioOracle().events.find((item) => item.kind === "RealityNewAnswer")!;
    const log = encodeChainEvent(event);
    expect(() => scenarioDecoder.decode({ ...log, data: log.data.slice(0, 66) as RawLog["data"] }, event.blockTimestamp)).toThrow(DecodeError);
    expect(() => scenarioDecoder.decode({ ...log, topics: log.topics.slice(0, 1) }, event.blockTimestamp)).toThrow(DecodeError);
  });

  it("a known topic0 under the wrong configured address is a DecodeError", () => {
    const event = scenarioOracle().events.find((item) => item.kind === "RealityNewAnswer")!;
    const log = encodeChainEvent(event);
    expect(() => scenarioDecoder.decode({ ...log, address: SCENARIO_ADDRESSES.conditionalTokens }, event.blockTimestamp)).toThrow(DecodeError);
  });

  it("SEC-IDX-05 an unconfigured (look-alike) address has no source", () => {
    expect(scenarioDecoder.sourceOf("0x000000000000000000000000000000000000dead")).toBeNull();
    expect(scenarioDecoder.sourceOf(SCENARIO_ADDRESSES.reality.toUpperCase().replace("0X", "0x") as RawLog["address"])).toBe("reality");
  });

  it("a ClaimCreated repositoryId outside 1..2^53-1 is outside the domain (halts)", () => {
    for (const repositoryId of [0, 2 ** 53]) {
      const b = new EventBuilder();
      const event = { ...claimCreated(b, "domain"), repositoryId };
      expect(() => scenarioDecoder.decode(encodeChainEvent(event), event.blockTimestamp)).toThrow(DecodeError);
    }
    const b = new EventBuilder();
    const max = { ...claimCreated(b, "domain-max"), repositoryId: Number.MAX_SAFE_INTEGER };
    expect(scenarioDecoder.decode(encodeChainEvent(max), max.blockTimestamp)).toEqual(max);
  });

  it("tracked external events accept the full on-chain domain (uint256 bonds, arbitrary reason text)", () => {
    const { events } = scenarioOracle();
    const answer = events.find((item) => item.kind === "RealityNewAnswer")!;
    const huge = { ...answer, bond: 2n ** 256n - 1n };
    expect(scenarioDecoder.decode(encodeChainEvent(huge), huge.blockTimestamp)).toEqual(huge);
    const rejected = events.find((item) => item.kind === "KlerosHome" && item.stage === "RequestRejected")!;
    const odd = { ...rejected, reason: "\u0000<script>\u202e", maxPrevious: 2n ** 255n };
    expect(scenarioDecoder.decode(encodeChainEvent(odd), odd.blockTimestamp)).toEqual(odd);
  });

  it("refuses duplicate or malformed configured addresses", () => {
    expect(() => createDecoder(100, { ...SCENARIO_ADDRESSES, evidenceRegistry: SCENARIO_ADDRESSES.claimRegistry })).toThrow();
    expect(() => createDecoder(100, { ...SCENARIO_ADDRESSES, reality: "0x1234" })).toThrow();
  });
});

// ------------------------------------------------------------------------------------- operator coverage gaps (indexers-004)

/**
 * Field layout per signature, written from the event declarations (docs/research/reality-kleros.md): which expected field
 * each indexed topic (topics[1..]) and each non-indexed value (cast decode-abi order) carries.
 */
const LAYOUTS: Record<string, { topics: string[]; data: string[] }> = {
  "LogNewAnswer(bytes32,bytes32,bytes32,address,uint256,uint256,bool)": { topics: ["questionId", "user"], data: ["answer", "historyHash", "bond", "ts", "isCommitment"] },
  "LogNotifyOfArbitrationRequest(bytes32,address)": { topics: ["questionId", "user"], data: [] },
  "LogFinalize(bytes32,bytes32)": { topics: ["questionId", "answer"], data: [] },
  "LogReopenQuestion(bytes32,bytes32)": { topics: ["questionId", "reopenedQuestionId"], data: [] },
  "ConditionResolution(bytes32,address,bytes32,uint256,uint256[])": { topics: ["conditionId", "oracle", "ctfQuestionId"], data: ["outcomeSlotCount", "payoutNumerators"] },
  "RequestNotified(bytes32,address,uint256)": { topics: ["questionId", "requester"], data: ["maxPrevious"] },
  "RequestAcknowledged(bytes32,address)": { topics: ["questionId", "requester"], data: [] },
  "ArbitratorAnswered(bytes32,bytes32)": { topics: ["questionId"], data: ["answer"] },
  "ArbitrationFinished(bytes32)": { topics: ["questionId"], data: [] },
};
const ADDRESS_FIELDS = new Set(["user", "oracle", "requester"]);

/** A cast decode-abi value ("10000 [1e4]", "false", "[0, 1, 0]", "0x..") as the fixture's expected JSON value. */
function castValue(value: string): unknown {
  if (value === "true" || value === "false") return value === "true";
  if (value.startsWith("[")) return value.slice(1, -1).split(",").map((item) => item.trim());
  if (value.startsWith("0x")) return value;
  return value.split(" ")[0];
}

describe("fixture expectations are tied to the raw chain data (operator gap 21)", () => {
  for (const fixture of fixtures) {
    it(`${fixture.name}: every indexed field equals its raw topic and every data field equals cast's decoding`, () => {
      const layout = LAYOUTS[fixture.signature];
      expect(layout, fixture.signature).toBeDefined();
      expect(fixture.log.topics).toHaveLength(1 + layout!.topics.length);
      layout!.topics.forEach((field, index) => {
        const topic = fixture.log.topics[index + 1]!;
        expect(fixture.expected[field], field).toBe(ADDRESS_FIELDS.has(field) ? `0x${topic.slice(26)}` : topic);
      });
      expect(fixture.castDecodedData).toHaveLength(layout!.data.length);
      layout!.data.forEach((field, index) => {
        const expected = fixture.expected[field];
        const fromCast = castValue(fixture.castDecodedData[index]!);
        expect(typeof expected === "number" ? String(expected) : expected, field).toEqual(fromCast);
      });
    });
  }

  it("a real LogReopenQuestion: topic1 is the NEW question id and topic2 the reopened one (contract state confirms it)", () => {
    const fixture = fixtures.find((item) => item.name === "reality-LogReopenQuestion")!;
    expect(fixture).toBeDefined();
    expect(fixture.stateCheck?.["reopened_questions(topic2)"]).toBe(fixture.log.topics[1]);
    expect(fixture.stateCheck?.["reopener_questions(topic1)"]).toBe(true);
    const event = gnosisDecoder.decode(rawOf(fixture), fixture.header.timestamp);
    expect(event).toMatchObject({ kind: "RealityQuestionReopened", questionId: fixture.log.topics[1], reopenedQuestionId: fixture.log.topics[2] });
  });

  it("every Reality event the plan filters carries question_id as its FIRST indexed field (topic1); ConditionResolution conditionId", () => {
    const realityNames = EVENT_SPECS.filter((spec) => spec.source === "reality").map((spec) => spec.name);
    expect([...realityNames].sort()).toEqual(["LogAnswerReveal", "LogCancelArbitration", "LogFinalize", "LogFundAnswerBounty", "LogNewAnswer", "LogNotifyOfArbitrationRequest", "LogReopenQuestion"]);
    for (const name of realityNames) {
      const item = realityV3Abi.find((entry) => entry.type === "event" && entry.name === name);
      expect(item, name).toBeDefined();
      const firstIndexed = (item as { inputs: readonly { name?: string; indexed?: boolean }[] }).inputs.find((input) => input.indexed === true);
      expect(firstIndexed?.name, name).toBe("question_id");
    }
    const resolution = conditionalTokensAbi.find((entry) => entry.type === "event" && entry.name === "ConditionResolution") as { inputs: readonly { name?: string; indexed?: boolean }[] };
    expect(resolution.inputs.find((input) => input.indexed === true)?.name).toBe("conditionId");
  });
});

describe("the ChainEvent domain at its bounds (operator gap 12)", () => {
  const scenarioDecoder = createDecoder(100, SCENARIO_ADDRESSES);
  const MAX_UINT256 = 2n ** 256n - 1n;
  const pine = (): ChainEvent[] => scenarioClaimsAndEvidence().events;

  it.each([
    ["ClaimCreated", "evidenceDeadline"],
    ["ClaimCreated", "revealDeadline"],
    ["EvidenceCommitted", "committedAt"],
    ["EvidenceRevealed", "revealedAt"],
    ["EvidencePublished", "publishedAt"],
  ] as const)("%s.%s at 2^53 is a DecodeError (halt); at 2^53-1 it decodes", (kind, field) => {
    const event = pine().find((item) => item.kind === kind)!;
    expect(event, kind).toBeDefined();
    const over = { ...event, [field]: 2 ** 53 } as ChainEvent;
    expect(() => scenarioDecoder.decode(encodeChainEvent(over), over.blockTimestamp)).toThrow(DecodeError);
    const max = { ...event, [field]: Number.MAX_SAFE_INTEGER } as ChainEvent;
    expect(scenarioDecoder.decode(encodeChainEvent(max), max.blockTimestamp)).toEqual(max);
  });

  it("a ClaimCreated whose indexed creator or document hash differs from the claim struct is a DecodeError", () => {
    const b = new EventBuilder();
    const event = claimCreated(b, "indexed-mismatch");
    const log = encodeChainEvent(event);
    const otherCreator = `0x${"00".repeat(12)}${"77".repeat(20)}` as Hex32;
    expect(log.topics[2]).toBe(`0x${"00".repeat(12)}${event.creator.slice(2)}`);
    expect(() => scenarioDecoder.decode({ ...log, topics: [log.topics[0]!, log.topics[1]!, otherCreator, log.topics[3]!] }, event.blockTimestamp)).toThrow(/indexed fields disagree/);
    expect(() => scenarioDecoder.decode({ ...log, topics: [log.topics[0]!, log.topics[1]!, log.topics[2]!, `0x${"78".repeat(32)}`] }, event.blockTimestamp)).toThrow(/indexed fields disagree/);
  });

  it("attacker-chosen uint256 fields decode at 2^256-1: LogAnswerReveal nonce and bond, LogFundAnswerBounty, a 256-slot ConditionResolution", () => {
    const b = new EventBuilder();
    const questionId = `0x${"91".repeat(32)}` as Hex32;
    const user = `0x${"92".repeat(20)}` as Address;
    const reveal: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityAnswerReveal", questionId, user, answerHash: `0x${"93".repeat(32)}`, answer: `0x${"94".repeat(32)}`, nonce: MAX_UINT256, bond: MAX_UINT256 };
    const bounty: ChainEvent = { ...b.envelope(SCENARIO_ADDRESSES.reality), kind: "RealityBountyFunded", questionId, bountyAdded: MAX_UINT256, bounty: MAX_UINT256, user };
    const resolution: ChainEvent = {
      ...b.envelope(SCENARIO_ADDRESSES.conditionalTokens),
      kind: "ConditionResolution",
      conditionId: `0x${"95".repeat(32)}`,
      oracle: user,
      ctfQuestionId: `0x${"96".repeat(32)}`,
      outcomeSlotCount: 256,
      payoutNumerators: Array.from({ length: 256 }, () => MAX_UINT256),
    };
    for (const event of [reveal, bounty, resolution]) expect(scenarioDecoder.decode(encodeChainEvent(event), event.blockTimestamp)).toEqual(event);
  });
});
