// Strict log decoding (PRD-05 section 2.3, SEC-IDX-05): every fetched log of a configured address must decode under the
// ABI event its topic0 names (viem decodeEventLog, strict) and its values must lie in the frozen ChainEvent domain (zod).
// Any failure is an integrity error (DecodeError -> halt), never a skip: a log the contract itself emitted cannot fail.
// External events (Reality, CTF, Kleros) accept the full on-chain domain of each field (Reality `ts` is the block
// timestamp, CTF bounds outcome slots to 256), so these domain checks run on every decoded external log before tracking
// is decided and cannot be used to halt (operator-settled). Untracked ids are decided later, in order, inside applyEvents.

import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from "viem";
import { z } from "zod";
import type { ChainEvent, EventEnvelope, KlerosHomeStage } from "@pine/shared/chain-events";
import { claimRegistryAbi, evidenceRegistryAbi } from "@pine/shared/abi/generated";
import { conditionalTokensAbi, klerosHomeProxyAbi, realityV3Abi } from "@pine/shared/abi/external";
import type { Address, Hex, Hex32 } from "@pine/shared/types";

export interface IndexedAddresses {
  claimRegistry: Address;
  evidenceRegistry: Address;
  reality: Address;
  conditionalTokens: Address;
  klerosHomeProxy: Address;
}

export type SourceName = keyof IndexedAddresses;

/** The events requested per source (chain-events.ts). */
export const SOURCE_EVENTS: Record<SourceName, { abi: Abi; events: readonly string[] }> = {
  claimRegistry: { abi: claimRegistryAbi as Abi, events: ["ClaimCreated"] },
  evidenceRegistry: { abi: evidenceRegistryAbi as Abi, events: ["EvidenceCommitted", "EvidenceRevealed", "EvidencePublished"] },
  reality: {
    abi: realityV3Abi as Abi,
    events: ["LogNewAnswer", "LogAnswerReveal", "LogNotifyOfArbitrationRequest", "LogCancelArbitration", "LogFinalize", "LogReopenQuestion", "LogFundAnswerBounty"],
  },
  conditionalTokens: { abi: conditionalTokensAbi as Abi, events: ["ConditionResolution"] },
  klerosHomeProxy: {
    abi: klerosHomeProxyAbi as Abi,
    events: ["RequestNotified", "RequestRejected", "RequestAcknowledged", "RequestCanceled", "ArbitrationFailed", "ArbitratorAnswered", "ArbitrationFinished"],
  },
};

interface EventSpec {
  source: SourceName;
  name: string;
  abiEvent: AbiEvent;
  topic0: Hex32;
}

function eventSpecs(): EventSpec[] {
  const specs: EventSpec[] = [];
  for (const source of Object.keys(SOURCE_EVENTS) as SourceName[]) {
    const { abi, events } = SOURCE_EVENTS[source];
    for (const name of events) {
      const matches = abi.filter((item): item is AbiEvent => item.type === "event" && item.name === name);
      if (matches.length !== 1 || !matches[0]) throw new Error(`ABI event ${source}.${name} must exist exactly once`);
      specs.push({ source, name, abiEvent: matches[0], topic0: toEventSelector(matches[0]).toLowerCase() as Hex32 });
    }
  }
  return specs;
}

export const EVENT_SPECS: readonly EventSpec[] = eventSpecs();

/** Every topic0 the indexer requests, over all sources. */
export const ALL_TOPIC0S: readonly Hex32[] = [...new Set(EVENT_SPECS.map((spec) => spec.topic0))];

/** The topic0s requested from one source. */
export function topic0sOf(source: SourceName): Hex32[] {
  return EVENT_SPECS.filter((spec) => spec.source === source).map((spec) => spec.topic0);
}

/** topic0 of one event of one source. */
export function topic0Of(source: SourceName, name: string): Hex32 {
  const spec = EVENT_SPECS.find((item) => item.source === source && item.name === name);
  if (!spec) throw new Error(`unknown event ${source}.${name}`);
  return spec.topic0;
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

/** A raw log after shape validation (see rpc.ts), lowercase hex. */
export interface RawLog {
  address: Address;
  topics: Hex32[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex32;
  transactionHash: Hex32;
  logIndex: number;
}

export interface Decoder {
  /** Source of an address, or null when the address is not configured (the log is ignored, SEC-IDX-05). */
  sourceOf(address: Address): SourceName | null;
  /** Decodes one log of a configured address. Throws DecodeError on any ABI or domain violation. */
  decode(log: RawLog, blockTimestamp: number): ChainEvent;
}

// ------------------------------------------------------------------------------------------------------------- zod

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex32);
const uint = z.bigint().nonnegative();
/** A uint that the frozen ChainEvent type carries as a JS number: must be a safe integer, else the value is out of domain. */
const safeUint = z
  .bigint()
  .nonnegative()
  .max(BigInt(Number.MAX_SAFE_INTEGER))
  .transform((value) => Number(value));

const claimCreatedArgs = z.object({
  market: address,
  creator: address,
  claimDocumentSha256: bytes32,
  claim: z.object({
    creator: address,
    createdAt: uint,
    evidenceDeadline: safeUint,
    revealDeadline: safeUint,
    // ClaimRegistry enforces 1 <= repositoryId <= 2^53 - 1 (decisions.md).
    repositoryId: z.bigint().min(1n).max(BigInt(Number.MAX_SAFE_INTEGER)).transform((value) => Number(value)),
    commit: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    claimDocumentSha256: bytes32,
    policyDocumentSha256: bytes32,
    questionId: bytes32,
    conditionId: bytes32,
    marketNameHash: bytes32,
    minBond: uint,
    yesToken: address,
    noToken: address,
    invalidToken: address,
  }),
  title: z.string(),
  marketName: z.string(),
});

const evidenceCommittedArgs = z.object({ submissionId: uint, market: address, submitter: address, commitment: bytes32, committedAt: safeUint });
const evidenceRevealedArgs = z.object({ submissionId: uint, market: address, submitter: address, contentSha256: bytes32, committedAt: safeUint, revealedAt: safeUint });
const evidencePublishedArgs = z.object({ submissionId: uint, market: address, submitter: address, contentSha256: bytes32, publishedAt: safeUint });

const newAnswerArgs = z.object({ answer: bytes32, question_id: bytes32, history_hash: bytes32, user: address, bond: uint, ts: safeUint, is_commitment: z.boolean() });
const answerRevealArgs = z.object({ question_id: bytes32, user: address, answer_hash: bytes32, answer: bytes32, nonce: uint, bond: uint });
const arbitrationRequestArgs = z.object({ question_id: bytes32, user: address });
const cancelArbitrationArgs = z.object({ question_id: bytes32 });
const finalizeArgs = z.object({ question_id: bytes32, answer: bytes32 });
const reopenArgs = z.object({ question_id: bytes32, reopened_question_id: bytes32 });
const bountyArgs = z.object({ question_id: bytes32, bounty_added: uint, bounty: uint, user: address });
const conditionResolutionArgs = z.object({
  conditionId: bytes32,
  oracle: address,
  questionId: bytes32,
  outcomeSlotCount: safeUint,
  payoutNumerators: z.array(uint).max(256),
});
const klerosArgs = z.object({
  _questionID: bytes32,
  _requester: address.optional(),
  _maxPrevious: uint.optional(),
  _reason: z.string().optional(),
  _answer: bytes32.optional(),
});

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DecodeError(`${what}: value outside the ChainEvent domain at ${issue ? issue.path.join(".") : "?"}`);
  }
  return result.data;
}

// ------------------------------------------------------------------------------------------------------------- decoder

export function createDecoder(chainId: number, addresses: IndexedAddresses): Decoder {
  const byAddress = new Map<string, SourceName>();
  for (const source of Object.keys(addresses) as SourceName[]) {
    const value = addresses[source].toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error(`invalid ${source} address`);
    if (byAddress.has(value)) throw new Error("indexed addresses must be distinct");
    byAddress.set(value, source);
  }
  const specByKey = new Map<string, EventSpec>(EVENT_SPECS.map((spec) => [`${spec.source}:${spec.topic0}`, spec]));

  return {
    sourceOf(value) {
      return byAddress.get(value.toLowerCase()) ?? null;
    },
    decode(log, blockTimestamp) {
      const source = byAddress.get(log.address.toLowerCase());
      if (!source) throw new DecodeError("log of an unconfigured address");
      const topic0 = log.topics[0]?.toLowerCase();
      const spec = topic0 === undefined ? undefined : specByKey.get(`${source}:${topic0}`);
      if (!spec) throw new DecodeError(`${source} log at ${log.blockNumber}:${log.logIndex} has an unexpected topic0`);
      let args: unknown;
      try {
        const decoded = decodeEventLog({ abi: [spec.abiEvent], data: log.data, topics: log.topics as [Hex32, ...Hex32[]], strict: true });
        if (decoded.eventName !== spec.name) throw new Error("event name mismatch");
        args = decoded.args;
      } catch {
        // viem's error text is not logged; the position and event name are enough to investigate.
        throw new DecodeError(`${source}.${spec.name} log at ${log.blockNumber}:${log.logIndex} does not decode strictly`);
      }
      if (!Number.isSafeInteger(blockTimestamp) || blockTimestamp < 0) throw new DecodeError("block timestamp outside the domain");
      const envelope: EventEnvelope = {
        chainId,
        address: log.address.toLowerCase() as Address,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash.toLowerCase() as Hex32,
        blockTimestamp,
        transactionHash: log.transactionHash.toLowerCase() as Hex32,
        logIndex: log.logIndex,
      };
      return toChainEvent(spec, args, envelope);
    },
  };
}

function toChainEvent(spec: EventSpec, args: unknown, env: EventEnvelope): ChainEvent {
  const what = `${spec.source}.${spec.name} at ${env.blockNumber}:${env.logIndex}`;
  switch (spec.name) {
    case "ClaimCreated": {
      const a = parse(claimCreatedArgs, args, what);
      // The registry emits the indexed copies from the same values as the struct; a difference is a contract or provider fault.
      if (a.creator !== a.claim.creator || a.claimDocumentSha256 !== a.claim.claimDocumentSha256) throw new DecodeError(`${what}: indexed fields disagree with the claim struct`);
      return {
        ...env,
        kind: "ClaimCreated",
        market: a.market,
        creator: a.creator,
        claimDocumentSha256: a.claimDocumentSha256,
        policyDocumentSha256: a.claim.policyDocumentSha256,
        repositoryId: a.claim.repositoryId,
        commit: a.claim.commit.slice(2).toLowerCase(),
        questionId: a.claim.questionId,
        conditionId: a.claim.conditionId,
        evidenceDeadline: a.claim.evidenceDeadline,
        revealDeadline: a.claim.revealDeadline,
        minBond: a.claim.minBond,
        title: a.title,
        marketName: a.marketName,
        marketNameHash: a.claim.marketNameHash,
        yesToken: a.claim.yesToken,
        noToken: a.claim.noToken,
        invalidToken: a.claim.invalidToken,
      };
    }
    case "EvidenceCommitted": {
      const a = parse(evidenceCommittedArgs, args, what);
      return { ...env, kind: "EvidenceCommitted", submissionId: a.submissionId, market: a.market, submitter: a.submitter, commitment: a.commitment, committedAt: a.committedAt };
    }
    case "EvidenceRevealed": {
      const a = parse(evidenceRevealedArgs, args, what);
      return {
        ...env,
        kind: "EvidenceRevealed",
        submissionId: a.submissionId,
        market: a.market,
        submitter: a.submitter,
        contentSha256: a.contentSha256,
        committedAt: a.committedAt,
        revealedAt: a.revealedAt,
      };
    }
    case "EvidencePublished": {
      const a = parse(evidencePublishedArgs, args, what);
      return { ...env, kind: "EvidencePublished", submissionId: a.submissionId, market: a.market, submitter: a.submitter, contentSha256: a.contentSha256, publishedAt: a.publishedAt };
    }
    case "LogNewAnswer": {
      const a = parse(newAnswerArgs, args, what);
      return { ...env, kind: "RealityNewAnswer", questionId: a.question_id, answer: a.answer, historyHash: a.history_hash, user: a.user, bond: a.bond, ts: a.ts, isCommitment: a.is_commitment };
    }
    case "LogAnswerReveal": {
      const a = parse(answerRevealArgs, args, what);
      return { ...env, kind: "RealityAnswerReveal", questionId: a.question_id, user: a.user, answerHash: a.answer_hash, answer: a.answer, nonce: a.nonce, bond: a.bond };
    }
    case "LogNotifyOfArbitrationRequest": {
      const a = parse(arbitrationRequestArgs, args, what);
      return { ...env, kind: "RealityArbitrationRequested", questionId: a.question_id, user: a.user };
    }
    case "LogCancelArbitration": {
      const a = parse(cancelArbitrationArgs, args, what);
      return { ...env, kind: "RealityArbitrationCancelled", questionId: a.question_id };
    }
    case "LogFinalize": {
      const a = parse(finalizeArgs, args, what);
      return { ...env, kind: "RealityArbitratorAnswered", questionId: a.question_id, answer: a.answer };
    }
    case "LogReopenQuestion": {
      const a = parse(reopenArgs, args, what);
      // topics[1] = the NEW question id, topics[2] = the question that was settled too soon.
      return { ...env, kind: "RealityQuestionReopened", questionId: a.question_id, reopenedQuestionId: a.reopened_question_id };
    }
    case "LogFundAnswerBounty": {
      const a = parse(bountyArgs, args, what);
      return { ...env, kind: "RealityBountyFunded", questionId: a.question_id, bountyAdded: a.bounty_added, bounty: a.bounty, user: a.user };
    }
    case "ConditionResolution": {
      const a = parse(conditionResolutionArgs, args, what);
      return {
        ...env,
        kind: "ConditionResolution",
        conditionId: a.conditionId,
        oracle: a.oracle,
        ctfQuestionId: a.questionId,
        outcomeSlotCount: a.outcomeSlotCount,
        payoutNumerators: [...a.payoutNumerators],
      };
    }
    default: {
      if (spec.source !== "klerosHomeProxy") throw new DecodeError(`${what}: no decoder for this event`);
      const stage = spec.name as KlerosHomeStage;
      const a = parse(klerosArgs, args, what);
      return {
        ...env,
        kind: "KlerosHome",
        stage,
        questionId: a._questionID,
        requester: a._requester ?? null,
        maxPrevious: a._maxPrevious ?? null,
        reason: a._reason ?? null,
        answer: a._answer ?? null,
      };
    }
  }
}
