// FROZEN. In-memory reference implementation of the read model: the executable specification of how chain events
// become records. Used directly as the test double in API tests, and as the oracle for the conformance suite that
// both real indexers must pass. Semantics mirror Reality.eth v3 (RealityETH-3.0.sol), Seer RealityProxy and the
// Kleros home proxy exactly; comments cite the contract behaviour each rule reproduces.

import { encodePacked, keccak256 } from "viem";
import type { ChainEvent } from "../chain-events.js";
import { compareEvents } from "../chain-events.js";
import {
  InvalidCursorError,
  type ArbitrationRecord,
  type ClaimRecord,
  type ConditionResolutionRecord,
  type EvidenceRecord,
  type IndexerStatus,
  type ListClaimsQuery,
  type ListEvidenceQuery,
  type OracleAnswerRecord,
  type OracleQuestionRecord,
  type Page,
  type ReadModel,
} from "../read-model.js";
import type { Address, Hex32 } from "../types.js";

export interface MemoryReadModelOptions {
  chainId: number;
  /** Seer MarketFactory.questionTimeout(), seconds. */
  questionTimeout: number;
}

export class OutOfOrderEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfOrderEventError";
  }
}

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

export class MemoryReadModel implements ReadModel {
  private readonly claims = new Map<Address, ClaimRecord>();
  private readonly evidence = new Map<string, EvidenceRecord>();
  private readonly questions = new Map<Hex32, OracleQuestionRecord>();
  private readonly answers = new Map<Hex32, OracleAnswerRecord[]>();
  private readonly arbitrations = new Map<Hex32, ArbitrationRecord>();
  private readonly resolutions = new Map<Hex32, ConditionResolutionRecord>();
  private readonly trackedConditions = new Set<Hex32>();
  private last: { blockNumber: bigint; logIndex: number } | null = null;
  private indexed: { block: bigint; timestamp: number; head: bigint | null; finalized: bigint | null } = { block: 0n, timestamp: 0, head: null, finalized: null };

  constructor(private readonly options: MemoryReadModelOptions) {}

  /** Applies events in (blockNumber, logIndex) order. Each event exactly once; an event at or before the last applied position throws. */
  apply(events: readonly ChainEvent[]): void {
    for (const event of events) {
      if (event.chainId !== this.options.chainId) continue;
      if (this.last && compareEvents(event, { ...event, ...this.last }) <= 0) {
        throw new OutOfOrderEventError(`Event at ${event.blockNumber}:${event.logIndex} is not after ${this.last.blockNumber}:${this.last.logIndex}`);
      }
      this.applyOne(event);
      this.last = { blockNumber: event.blockNumber, logIndex: event.logIndex };
      if (event.blockNumber > this.indexed.block) {
        this.indexed = { ...this.indexed, block: event.blockNumber, timestamp: event.blockTimestamp };
      }
    }
  }

  /** Advances the indexed cursor without events (an indexer that scanned empty blocks). */
  private halted = false;

  /** Test switch: simulate an indexer that stopped on an integrity failure (status().halted). */
  setHalted(halted: boolean): void {
    this.halted = halted;
  }

  markIndexed(block: bigint, timestamp: number, head: bigint | null = null, finalized: bigint | null = null): void {
    if (block < this.indexed.block) throw new OutOfOrderEventError("Indexed block cannot move backwards");
    this.indexed = { block, timestamp, head, finalized };
  }

  private applyOne(event: ChainEvent): void {
    switch (event.kind) {
      case "ClaimCreated": {
        const market = lower(event.market);
        if (this.claims.has(market)) return; // The registry never emits twice for one market; first wins.
        const claim: ClaimRecord = {
          market,
          registry: lower(event.address),
          creator: lower(event.creator),
          claimDocumentSha256: lower(event.claimDocumentSha256),
          policyDocumentSha256: lower(event.policyDocumentSha256),
          repositoryId: event.repositoryId,
          commit: event.commit.toLowerCase(),
          questionId: lower(event.questionId),
          conditionId: lower(event.conditionId),
          evidenceDeadline: event.evidenceDeadline,
          revealDeadline: event.revealDeadline,
          minBond: event.minBond,
          title: event.title,
          marketName: event.marketName,
          marketNameHash: lower(event.marketNameHash),
          yesToken: lower(event.yesToken),
          noToken: lower(event.noToken),
          invalidToken: lower(event.invalidToken),
          createdAt: event.blockTimestamp,
          createdBlock: event.blockNumber,
          createdTxHash: lower(event.transactionHash),
          createdLogIndex: event.logIndex,
        };
        this.claims.set(market, claim);
        this.trackedConditions.add(claim.conditionId);
        const existing = this.questions.get(claim.questionId);
        if (existing) {
          // Seer reuses an identical Reality question for identical market parameters.
          existing.markets = [...new Set([...existing.markets, market])].sort();
        } else {
          this.questions.set(claim.questionId, this.newQuestion(claim.questionId, [market], claim.revealDeadline, claim.minBond, null));
        }
        return;
      }
      case "EvidenceCommitted": {
        const key = this.evidenceKey(event.address, event.submissionId);
        if (this.evidence.has(key)) return;
        this.evidence.set(key, {
          registry: lower(event.address),
          submissionId: event.submissionId,
          market: lower(event.market),
          submitter: lower(event.submitter),
          status: "committed",
          commitment: lower(event.commitment),
          contentSha256: null,
          committedAt: event.committedAt,
          revealedAt: null,
          committedTxHash: lower(event.transactionHash),
          committedBlock: event.blockNumber,
          committedLogIndex: event.logIndex,
        });
        return;
      }
      case "EvidenceRevealed": {
        const record = this.evidence.get(this.evidenceKey(event.address, event.submissionId));
        if (!record || record.status !== "committed") return; // Unknown or already disclosed: ignore (never crash).
        record.status = "revealed";
        record.contentSha256 = lower(event.contentSha256);
        record.revealedAt = event.revealedAt;
        return;
      }
      case "EvidencePublished": {
        const key = this.evidenceKey(event.address, event.submissionId);
        if (this.evidence.has(key)) return;
        this.evidence.set(key, {
          registry: lower(event.address),
          submissionId: event.submissionId,
          market: lower(event.market),
          submitter: lower(event.submitter),
          status: "published",
          commitment: null,
          contentSha256: lower(event.contentSha256),
          committedAt: event.publishedAt,
          revealedAt: event.publishedAt,
          committedTxHash: lower(event.transactionHash),
          committedBlock: event.blockNumber,
          committedLogIndex: event.logIndex,
        });
        return;
      }
      case "RealityNewAnswer": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        const answer: OracleAnswerRecord = {
          questionId: question.questionId,
          answer: lower(event.answer),
          historyHash: lower(event.historyHash),
          answerer: lower(event.user),
          bond: event.bond,
          ts: event.ts,
          isCommitment: event.isCommitment,
          revealedAnswer: event.isCommitment ? null : lower(event.answer),
          txHash: lower(event.transactionHash),
          blockNumber: event.blockNumber,
          logIndex: event.logIndex,
        };
        this.answersOf(question.questionId).push(answer);
        question.answerCount += 1;
        // _addAnswerToHistory: the bond level changes only when a bond is posted (arbitrator answers carry none).
        if (event.bond > 0n) question.bond = event.bond;
        if (!event.isCommitment) {
          question.bestAnswer = answer.answer;
          // submitAnswer: finalize_ts = ts + timeout. Arbitrator answer (bond 0, after LogFinalize): finalize_ts = ts.
          question.finalizeTs = event.bond > 0n ? event.ts + question.timeout : event.ts;
        }
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "RealityAnswerReveal": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        // submitAnswerReveal: commitment_id = keccak256(abi.encodePacked(question_id, answer_hash, bond)).
        const commitmentId = keccak256(
          encodePacked(["bytes32", "bytes32", "uint256"], [question.questionId, lower(event.answerHash), event.bond]),
        );
        const committed = this.answersOf(question.questionId).find((item) => item.isCommitment && item.answer === commitmentId);
        if (committed) committed.revealedAnswer = lower(event.answer);
        // Only the reveal of the current (highest) bond becomes the best answer and restarts the timeout.
        if (event.bond === question.bond) {
          question.bestAnswer = lower(event.answer);
          question.finalizeTs = event.blockTimestamp + question.timeout;
        }
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "RealityArbitrationRequested": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        question.pendingArbitration = true;
        question.arbitrationRequestedBy = lower(event.user);
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "RealityArbitrationCancelled": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        // cancelArbitration: not pending, finalize_ts = now + timeout.
        question.pendingArbitration = false;
        question.finalizeTs = event.blockTimestamp + question.timeout;
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "RealityArbitratorAnswered": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        // submitAnswerByArbitrator: best_answer = answer, finalize_ts = now, not pending.
        question.pendingArbitration = false;
        question.bestAnswer = lower(event.answer);
        question.finalizeTs = event.blockTimestamp;
        question.answeredByArbitrator = true;
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "RealityQuestionReopened": {
        const original = this.questions.get(lower(event.reopenedQuestionId));
        if (!original) return;
        const replacement = lower(event.questionId);
        original.reopenedBy = replacement;
        original.lastEventBlock = event.blockNumber;
        if (!this.questions.has(replacement)) {
          // reopenQuestion requires identical content, opening time, min bond and timeout.
          const record = this.newQuestion(replacement, original.markets, original.openingTs, original.minBond, original.questionId);
          record.lastEventBlock = event.blockNumber;
          this.questions.set(replacement, record);
        }
        return;
      }
      case "RealityBountyFunded": {
        const question = this.questions.get(lower(event.questionId));
        if (!question) return;
        question.bounty = event.bounty;
        question.lastEventBlock = event.blockNumber;
        return;
      }
      case "ConditionResolution": {
        const conditionId = lower(event.conditionId);
        if (!this.trackedConditions.has(conditionId) || this.resolutions.has(conditionId)) return;
        this.resolutions.set(conditionId, {
          conditionId,
          ctfQuestionId: lower(event.ctfQuestionId),
          payoutNumerators: [...event.payoutNumerators],
          resolvedAt: event.blockTimestamp,
          txHash: lower(event.transactionHash),
          blockNumber: event.blockNumber,
        });
        return;
      }
      case "KlerosHome": {
        const questionId = lower(event.questionId);
        if (!this.questions.has(questionId)) return;
        const existing = this.arbitrations.get(questionId);
        const entry = { stage: event.stage, at: event.blockTimestamp, txHash: lower(event.transactionHash) };
        const record: ArbitrationRecord = existing ?? {
          questionId,
          stage: event.stage,
          requester: null,
          rejectionReason: null,
          arbitratorAnswer: null,
          updatedAt: event.blockTimestamp,
          history: [],
        };
        record.stage = event.stage;
        if (event.requester) record.requester = lower(event.requester);
        if (event.stage === "RequestRejected") record.rejectionReason = event.reason;
        if (event.stage === "ArbitratorAnswered" && event.answer) record.arbitratorAnswer = lower(event.answer);
        record.updatedAt = event.blockTimestamp;
        record.history.push(entry);
        this.arbitrations.set(questionId, record);
        return;
      }
    }
  }

  private newQuestion(questionId: Hex32, markets: Address[], openingTs: number, minBond: bigint, reopens: Hex32 | null): OracleQuestionRecord {
    return {
      questionId,
      markets: [...markets].sort(),
      openingTs,
      minBond,
      timeout: this.options.questionTimeout,
      bestAnswer: null,
      bond: 0n,
      finalizeTs: 0,
      pendingArbitration: false,
      arbitrationRequestedBy: null,
      answeredByArbitrator: false,
      bounty: 0n,
      reopenedBy: null,
      reopens,
      answerCount: 0,
      lastEventBlock: 0n,
    };
  }

  private evidenceKey(registry: Address, submissionId: bigint): string {
    return `${lower(registry)}:${submissionId.toString()}`;
  }

  private answersOf(questionId: Hex32): OracleAnswerRecord[] {
    let list = this.answers.get(questionId);
    if (!list) {
      list = [];
      this.answers.set(questionId, list);
    }
    return list;
  }

  // ------------------------------------------------------------------------------------------------- queries

  async status(): Promise<IndexerStatus> {
    return {
      backend: "memory",
      chainId: this.options.chainId,
      indexedBlock: this.indexed.block,
      indexedBlockTimestamp: this.indexed.timestamp,
      headBlock: this.indexed.head,
      finalizedBlock: this.indexed.finalized,
      halted: this.halted,
    };
  }

  async getClaim(market: Address): Promise<ClaimRecord | null> {
    const claim = this.claims.get(lower(market));
    return claim ? structuredClone(claim) : null;
  }

  async listClaims(query: ListClaimsQuery): Promise<Page<ClaimRecord>> {
    assertLimit(query.limit);
    let items = [...this.claims.values()];
    if (query.creator) items = items.filter((claim) => claim.creator === lower(query.creator!));
    if (query.claimDocumentSha256) items = items.filter((claim) => claim.claimDocumentSha256 === lower(query.claimDocumentSha256!));
    if (query.evidenceDeadlineAfter !== undefined) items = items.filter((claim) => claim.evidenceDeadline > query.evidenceDeadlineAfter!);
    if (query.evidenceDeadlineAtOrBefore !== undefined) items = items.filter((claim) => claim.evidenceDeadline <= query.evidenceDeadlineAtOrBefore!);
    const keyOf = (claim: ClaimRecord): (string | bigint | number)[] =>
      query.order === "created_desc" ? [claim.createdBlock, claim.createdLogIndex] : [claim.evidenceDeadline, claim.market];
    const compare = (a: ClaimRecord, b: ClaimRecord): number => {
      if (query.order === "created_desc") {
        if (a.createdBlock !== b.createdBlock) return a.createdBlock > b.createdBlock ? -1 : 1;
        return b.createdLogIndex - a.createdLogIndex;
      }
      if (a.evidenceDeadline !== b.evidenceDeadline) return a.evidenceDeadline - b.evidenceDeadline;
      return a.market < b.market ? -1 : a.market > b.market ? 1 : 0;
    };
    items.sort(compare);
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor, query.order);
      items = items.filter((claim) => compareKeys(keyOf(claim), after, query.order === "created_desc" ? "desc" : "asc") > 0);
    }
    return paginate(items, query.limit, (claim) => encodeCursor(query.order, keyOf(claim)));
  }

  async listClaimsByQuestion(questionId: Hex32): Promise<ClaimRecord[]> {
    return [...this.claims.values()]
      .filter((claim) => claim.questionId === lower(questionId))
      .sort((a, b) => (a.createdBlock !== b.createdBlock ? (a.createdBlock < b.createdBlock ? -1 : 1) : a.createdLogIndex - b.createdLogIndex))
      .map((claim) => structuredClone(claim));
  }

  async getEvidence(registry: Address, submissionId: bigint): Promise<EvidenceRecord | null> {
    const record = this.evidence.get(this.evidenceKey(registry, submissionId));
    return record ? structuredClone(record) : null;
  }

  async listEvidence(query: ListEvidenceQuery): Promise<Page<EvidenceRecord>> {
    assertLimit(query.limit);
    let items = [...this.evidence.values()];
    if (query.market) items = items.filter((record) => record.market === lower(query.market!));
    if (query.submitter) items = items.filter((record) => record.submitter === lower(query.submitter!));
    if (query.status) items = items.filter((record) => record.status === query.status);
    items.sort((a, b) => (a.committedBlock !== b.committedBlock ? (a.committedBlock < b.committedBlock ? -1 : 1) : a.committedLogIndex - b.committedLogIndex));
    const keyOf = (record: EvidenceRecord) => [record.committedBlock, record.committedLogIndex];
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor, "evidence");
      items = items.filter((record) => compareKeys(keyOf(record), after, "asc") > 0);
    }
    return paginate(items, query.limit, (record) => encodeCursor("evidence", keyOf(record)));
  }

  async getOracleQuestion(questionId: Hex32): Promise<OracleQuestionRecord | null> {
    const record = this.questions.get(lower(questionId));
    return record ? structuredClone(record) : null;
  }

  async listOracleAnswers(questionId: Hex32): Promise<OracleAnswerRecord[]> {
    return (this.answers.get(lower(questionId)) ?? []).map((answer) => structuredClone(answer));
  }

  async getArbitration(questionId: Hex32): Promise<ArbitrationRecord | null> {
    const record = this.arbitrations.get(lower(questionId));
    return record ? structuredClone(record) : null;
  }

  async getConditionResolution(conditionId: Hex32): Promise<ConditionResolutionRecord | null> {
    const record = this.resolutions.get(lower(conditionId));
    return record ? structuredClone(record) : null;
  }
}

// ----------------------------------------------------------------------------------------------- pagination helpers

type KeyPart = string | bigint | number;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be an integer in 1..100");
}

function paginate<T>(items: T[], limit: number, cursorOf: (item: T) => string): Page<T> {
  const page = items.slice(0, limit).map((item) => structuredClone(item));
  const last = page.at(-1);
  return { items: page, nextCursor: items.length > limit && last !== undefined ? cursorOf(items[limit - 1]!) : null };
}

function encodeCursor(scope: string, key: KeyPart[]): string {
  const parts = key.map((part) => (typeof part === "bigint" ? `b${part.toString()}` : typeof part === "number" ? `n${part}` : `s${part}`));
  return Buffer.from(JSON.stringify({ v: 1, scope, key: parts }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, scope: string): KeyPart[] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; scope?: unknown; key?: unknown };
    if (parsed.v !== 1 || parsed.scope !== scope || !Array.isArray(parsed.key)) throw new Error("shape");
    return parsed.key.map((part: unknown) => {
      if (typeof part !== "string" || part.length < 2) throw new Error("part");
      const body = part.slice(1);
      if (part[0] === "b" && /^-?\d+$/.test(body)) return BigInt(body);
      if (part[0] === "n" && /^-?\d+$/.test(body)) return Number(body);
      if (part[0] === "s") return body;
      throw new Error("part");
    });
  } catch {
    throw new InvalidCursorError();
  }
}

/** >0 when `key` comes after `cursor` in the given direction. */
function compareKeys(key: KeyPart[], cursor: KeyPart[], direction: "asc" | "desc"): number {
  for (let index = 0; index < key.length; index += 1) {
    const a = key[index]!;
    const b = cursor[index];
    if (b === undefined || typeof a !== typeof b) throw new InvalidCursorError();
    if (a === b) continue;
    const ascending = a < b ? -1 : 1;
    return direction === "asc" ? ascending : -ascending;
  }
  return 0;
}
