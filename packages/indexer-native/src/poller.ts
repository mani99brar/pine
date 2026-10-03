// The ingest layer (PRD-05 section 2.3): finalized blocks only, two RPC providers, a request plan filtered to what Pine
// tracks, strict decoding, single-transaction apply plus cursor, halt on any integrity conflict. It writes only through
// applyEvents and the cursor/halt tables.
//
// One cycle processes at most one range [cursor + 1, min(target, cursor + chunk)], possibly cut shorter:
//   1. both providers' `finalized` blocks; target = min(numbers); both must report the same hash at target (SEC-IDX-06);
//   2. the request PLAN, built on the primary (third-party spam on untracked questions is never requested):
//      a. ClaimRegistry, EvidenceRegistry and Kleros home-proxy logs of their topic0s, unfiltered;
//      b. tracked question ids = the ACTIVE stored ids (computed once per range from the cursor block's timestamp:
//         finalized questions and resolved conditions are pruned, see readActiveIds) + this range's ClaimCreated + reopen
//         replacements, found with LogReopenQuestion
//         filtered on topic2 (the reopened, already tracked id; the new id is topic1), repeated for newly found ids for
//         at most 8 rounds; if ids still appear, the range is cut just before the earliest block of the last round's
//         reopens (one block minimum), so the cut range is complete;
//      c. Reality logs filtered on topic1 in the tracked question ids, CTF ConditionResolution on topic1 in the tracked
//         condition ids, OR-lists of at most 100 ids per request.
//      Size-type failures split a request's block range in halves down to one block; other failures retry the same
//      request with capped backoff and the cycle gives up at the first request still failing. The processed range is
//      cut at the last whole block under 50,000 logs / 32 MB (minimum one block), so memory stays bounded;
//   3. the secondary runs exactly that (truncated) plan; when it forces a split, the refined requests run on BOTH
//      providers. Every request's full result set (blockNumber, blockHash, logIndex, transactionHash, address, topics,
//      data) must be identical. A difference, or a single-response anomaly of one provider (a log outside the requested
//      range, a duplicate or `removed` log, a wrong-shape result, a strict-decode failure of a log not yet cross-checked),
//      is re-checked: wait 10 s and re-run the plan (same active set) on both providers, at most 3 times; it halts
//      (`log_disagreement`, `invalid_rpc_data`, `decode_failure`) only if it persists;
//   4. headers (hash and timestamp) from both providers for every block with logs plus the range end; they must agree and
//      every log's blockHash must equal its block's canonical hash;
//   5. strict decoding of every log, merge-sorted by (blockNumber, logIndex), ONE applyEvents call and the cursor advance
//      in one transaction.

import type { ChainEvent } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import { applyEvents, lockCursor, OutOfOrderEventError } from "./apply.js";
import type { SqlExecutor } from "./db.js";
import { createDecoder, DecodeError, topic0Of, topic0sOf, type Decoder, type IndexedAddresses, type RawLog } from "./decode.js";
import type { IndexerMetrics } from "./metrics.js";
import { safeErrorMessage, type Redactor } from "./redact.js";
import { InvalidRpcDataError, RpcError, type BlockHeader, type RpcProvider } from "./rpc.js";
import { advanceCursor, CursorRegressionError, isHalted, readActiveIds, readCursor, recordBlock, recordHalt, recordObservation, type HaltReason } from "./store.js";

export interface Logger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

export interface PollerOptions {
  db: SqlExecutor;
  primary: RpcProvider;
  secondary: RpcProvider;
  chainId: number;
  questionTimeout: number;
  addresses: IndexedAddresses;
  /** First block to index (the ClaimRegistry deployment block). */
  deploymentBlock: bigint;
  redact: Redactor;
  logger: Logger;
  metrics?: IndexerMetrics;
  /** Range length in blocks (default 500, 1..2000). */
  chunkSize?: number;
  /** Cap of the processed range: logs (default 50,000) and estimated bytes (default 32 MB). */
  maxRangeLogs?: number;
  maxRangeBytes?: number;
  /** Attempts per request for non-size failures (default 3) and their backoff (default 500 ms doubling, capped at 5 s). */
  requestAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Provider differences and single-response anomalies: delay before a re-check (default 10 s) and re-checks before a halt (default 3). */
  recheckDelayMs?: number;
  recheckAttempts?: number;
  pollIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Injected clock (unix milliseconds) and sleep, for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CHUNK = 500;
export const MAX_RANGE = 2_000;
export const MAX_RANGE_LOGS = 50_000;
export const MAX_RANGE_BYTES = 32 * 1024 * 1024;
export const IDS_PER_REQUEST = 100;
export const MAX_REOPEN_ROUNDS = 8;
/** Arbitrary constant: "pnix" in ASCII; serializes range transactions across processes. */
export const INGEST_LOCK_KEY = 0x706e6978;

export type CycleResult =
  | { kind: "halted"; reason?: HaltReason }
  | { kind: "idle"; target: bigint }
  | { kind: "advanced"; from: bigint; to: bigint; events: number; caughtUp: boolean };

/** An integrity conflict: recorded as a halt, never retried. */
export class IntegrityError extends Error {
  constructor(
    readonly reason: HaltReason,
    message: string,
    readonly block: bigint | null = null,
  ) {
    super(message);
    this.name = "IntegrityError";
  }
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** A strict-decode failure of a log not yet cross-checked (a single-response anomaly): re-checked before a halt. */
class UnverifiedDecodeError extends DecodeError {}

class ConcurrentWriterError extends Error {
  constructor() {
    super("the cursor moved during the range (another writer?)");
    this.name = "ConcurrentWriterError";
  }
}

/** One request shape of the plan: exact addresses and positional topic OR-lists. */
export interface LogTemplate {
  name: string;
  addresses: Address[];
  topics: (Hex32[] | null)[];
}

/** One executed request of the plan and its (primary) result, clipped to the processed range. */
interface Leaf {
  template: LogTemplate;
  from: bigint;
  to: bigint;
  logs: RawLog[];
}

/** The ACTIVE stored ids of one processed range (computed once; every request of the range, on both providers, uses it). */
export interface ActiveIds {
  questions: readonly string[];
  conditions: readonly string[];
}

/** The effective bounds of a poller (production defaults unless overridden for tests). */
export interface PollerLimits {
  chunkSize: number;
  maxRangeLogs: number;
  maxRangeBytes: number;
  maxReopenRounds: number;
  idsPerRequest: number;
  requestAttempts: number;
  recheckAttempts: number;
  recheckDelayMs: number;
}

interface Plan {
  from: bigint;
  end: bigint;
  leaves: Leaf[];
  logCount: number;
  byteCount: number;
}

type Comparison = { equal: true } | { equal: false; detail: string; block: bigint };

interface VerifiedRange {
  plan: Plan;
  logs: RawLog[];
  headers: Map<bigint, BlockHeader>;
}

const logKey = (log: RawLog): string =>
  [log.blockNumber.toString(), log.blockHash, String(log.logIndex), log.transactionHash, log.address, log.topics.join(","), log.data].join("|").toLowerCase();

/** Rough JSON size of a log in a response (for the processed-range byte cap). */
const logBytes = (log: RawLog): number => 400 + log.data.length + log.topics.length * 70;

const isSizeError = (error: unknown): boolean => error instanceof RpcError && error.kind === "size";

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function matchesTemplate(template: LogTemplate, log: RawLog): boolean {
  if (!template.addresses.includes(log.address)) return false;
  return template.topics.every((list, index) => {
    if (list === null) return true;
    const topic = log.topics[index];
    return topic !== undefined && list.includes(topic);
  });
}

const byPosition = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }): number =>
  a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex;

export class Poller {
  private readonly decoder: Decoder;
  private readonly bounds: PollerLimits;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fixedTemplates: LogTemplate[];
  private started = false;
  private lastSuccessAt: number | null = null;

  constructor(private readonly options: PollerOptions) {
    this.decoder = createDecoder(options.chainId, options.addresses);
    const chunk = options.chunkSize ?? DEFAULT_CHUNK;
    if (!Number.isInteger(chunk) || chunk < 1 || chunk > MAX_RANGE) throw new RangeError(`chunkSize must be an integer in 1..${MAX_RANGE}`);
    this.bounds = {
      chunkSize: chunk,
      maxRangeLogs: options.maxRangeLogs ?? MAX_RANGE_LOGS,
      maxRangeBytes: options.maxRangeBytes ?? MAX_RANGE_BYTES,
      maxReopenRounds: MAX_REOPEN_ROUNDS,
      idsPerRequest: IDS_PER_REQUEST,
      requestAttempts: options.requestAttempts ?? 3,
      recheckAttempts: options.recheckAttempts ?? 3,
      recheckDelayMs: options.recheckDelayMs ?? 10_000,
    };
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const address = (value: Address): Address => value.toLowerCase() as Address;
    this.fixedTemplates = [
      { name: "ClaimRegistry", addresses: [address(options.addresses.claimRegistry)], topics: [topic0sOf("claimRegistry")] },
      { name: "EvidenceRegistry", addresses: [address(options.addresses.evidenceRegistry)], topics: [topic0sOf("evidenceRegistry")] },
      { name: "KlerosHomeProxy", addresses: [address(options.addresses.klerosHomeProxy)], topics: [topic0sOf("klerosHomeProxy")] },
    ];
  }

  /** Range length in blocks. */
  get chunkSize(): number {
    return this.bounds.chunkSize;
  }

  /** The bounds this poller runs with (the values every code path below reads). */
  get limits(): PollerLimits {
    return { ...this.bounds };
  }

  /** True after a successful start and a successful cycle within the last `maxAgeMs`, and while not halted. */
  async isReady(maxAgeMs: number): Promise<boolean> {
    if (!this.started || this.lastSuccessAt === null || this.now() - this.lastSuccessAt > maxAgeMs) return false;
    return !(await isHalted(this.options.db, this.options.chainId));
  }

  /**
   * Startup checks: both providers must serve the configured chain id (SEC-IDX-06, fail closed: throws StartupError), and
   * the stored cursor hash must equal the canonical hash on both providers (mismatch: halt `finalized_conflict`).
   */
  async start(): Promise<void> {
    const { primary, secondary, chainId, db } = this.options;
    const ids = await Promise.all([primary.chainId(), secondary.chainId()]);
    for (const [index, id] of ids.entries()) {
      if (id !== chainId) throw new StartupError(`${index === 0 ? primary.label : secondary.label} RPC serves chain ${id}, expected ${chainId}`);
    }
    const cursor = await readCursor(db, chainId);
    const storedHash = cursor?.indexedBlockHash;
    if (cursor && storedHash) {
      try {
        // A wrong-shape header is a single-response anomaly: re-fetched from both providers before it halts.
        const [a, b] = await this.rechecked(() => Promise.all([this.call(() => primary.blockHeader(cursor.indexedBlock)), this.call(() => secondary.blockHeader(cursor.indexedBlock))]));
        for (const [provider, header] of [
          [primary, a],
          [secondary, b],
        ] as const) {
          if (header.hash !== storedHash) {
            throw new IntegrityError("finalized_conflict", `stored cursor block ${cursor.indexedBlock} hash differs from the ${provider.label} canonical hash`, cursor.indexedBlock);
          }
        }
      } catch (error) {
        if (error instanceof IntegrityError || error instanceof InvalidRpcDataError) await this.halt(error);
        else throw error;
      }
    }
    this.started = true;
    await this.refreshMetrics();
  }

  /** Runs cycles until the signal aborts: immediately again after an advance, the poll interval when idle or halted, backoff after errors. */
  async run(signal: AbortSignal): Promise<void> {
    const pollInterval = this.options.pollIntervalMs ?? 5_000;
    const base = this.options.backoffBaseMs ?? 1_000;
    const max = this.options.backoffMaxMs ?? 60_000;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = await this.runCycle();
        failures = 0;
        if (result.kind === "advanced" && !result.caughtUp) continue;
        await this.sleep(pollInterval);
      } catch (error) {
        failures += 1;
        this.options.metrics?.errors.inc({ kind: error instanceof RpcError ? "rpc" : "other" });
        this.options.logger.warn({ error: safeErrorMessage(error, this.options.redact), failures }, "indexer cycle failed; backing off");
        await this.sleep(Math.min(max, base * 2 ** Math.min(failures - 1, 30)));
      }
    }
  }

  /** One cycle (at most one range). Integrity conflicts are recorded as halts; transient errors throw. */
  async runCycle(): Promise<CycleResult> {
    if (!this.started) throw new StartupError("start() must succeed before cycles run");
    const { db, chainId } = this.options;
    if (await isHalted(db, chainId)) {
      await this.refreshMetrics();
      return { kind: "halted" };
    }
    this.options.metrics?.cycles.inc();
    try {
      const result = await this.cycle();
      this.lastSuccessAt = this.now();
      await this.refreshMetrics();
      return result;
    } catch (error) {
      if (error instanceof IntegrityError || error instanceof DecodeError || error instanceof InvalidRpcDataError || error instanceof OutOfOrderEventError || error instanceof CursorRegressionError) {
        const reason = await this.halt(error);
        await this.refreshMetrics();
        return { kind: "halted", reason };
      }
      throw error;
    }
  }

  private async cycle(): Promise<CycleResult> {
    const { db, chainId, primary } = this.options;
    const target = await this.rechecked(() => this.agreedFinalized());
    const head = await this.call(() => primary.latestBlockNumber());
    await recordObservation(db, chainId, target.number, head);

    const cursor = await readCursor(db, chainId);
    const indexed = cursor?.indexedBlock ?? 0n;
    const from = indexed + 1n > this.options.deploymentBlock ? indexed + 1n : this.options.deploymentBlock;
    if (from > target.number) return { kind: "idle", target: target.number };
    const chunk = BigInt(this.bounds.chunkSize);
    const rangeEnd = from + chunk - 1n < target.number ? from + chunk - 1n : target.number;

    // The active filter set, ONCE per processed range, judged at the cursor block's timestamp (chain time both providers
    // confirmed when that block ended a range; never the wall clock). Re-checks and splits reuse it unchanged.
    const active = await readActiveIds(db, cursor?.indexedBlockTimestamp ?? 0);
    const { plan, logs, headers } = await this.rechecked(() => this.verifiedRange(from, rangeEnd, active, target));
    const to = plan.end;

    const events: ChainEvent[] = [];
    for (const log of logs) {
      const header = headers.get(log.blockNumber);
      if (!header || header.hash !== log.blockHash) {
        throw new IntegrityError("log_hash_mismatch", `log ${log.blockNumber}:${log.logIndex} blockHash differs from the canonical header`, log.blockNumber);
      }
      events.push(this.decoder.decode(log, header.timestamp));
    }
    events.sort(byPosition);

    const end = headers.get(to);
    if (!end) throw new InvalidRpcDataError(`missing header for block ${to}`);
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [INGEST_LOCK_KEY]);
      if (await isHalted(tx, chainId)) throw new ConcurrentWriterError();
      const locked = await lockCursor(tx, chainId);
      if (locked.indexedBlock !== indexed) throw new ConcurrentWriterError();
      // ONE call for the whole range: the cursor-position guard would skip lower-logIndex logs of a later call.
      await applyEvents(tx, events, { chainId, questionTimeout: this.options.questionTimeout });
      for (const number of new Set(events.map((event) => event.blockNumber))) {
        const header = headers.get(number);
        if (!header) throw new InvalidRpcDataError(`missing header for block ${number}`);
        await recordBlock(tx, chainId, number, header.hash, header.timestamp);
      }
      await advanceCursor(tx, { chainId, block: to, blockHash: end.hash, blockTimestamp: end.timestamp });
    });
    this.options.logger.info({ from: from.toString(), to: to.toString(), requests: plan.leaves.length, logs: logs.length, bytes: plan.byteCount, events: events.length }, "range applied");
    return { kind: "advanced", from, to, events: events.length, caughtUp: to === target.number };
  }

  /**
   * Runs `attempt` and re-runs it (both providers, after the re-check delay) while it fails with a provider difference or
   * a single-response anomaly, at most `recheckAttempts` times; the last failure is thrown (and recorded as a halt).
   * Integrity conflicts that are not single-response anomalies (finalized hash, header or log hash mismatches) are not
   * re-checked.
   */
  private async rechecked<T>(attempt: () => Promise<T>): Promise<T> {
    for (let recheck = 0; ; recheck += 1) {
      try {
        return await attempt();
      } catch (error) {
        const recheckable = error instanceof InvalidRpcDataError || error instanceof UnverifiedDecodeError || (error instanceof IntegrityError && error.reason === "log_disagreement");
        if (!recheckable || recheck >= this.bounds.recheckAttempts) throw error;
        this.options.metrics?.errors.inc({ kind: error instanceof IntegrityError ? "provider_difference" : "provider_anomaly" });
        this.options.logger.warn({ detail: safeErrorMessage(error, this.options.redact), recheck: recheck + 1 }, "providers returned different or anomalous data; re-checking");
        await this.sleep(this.bounds.recheckDelayMs);
      }
    }
  }

  /**
   * One attempt at a verified range: the plan on the primary, its cross-check on the secondary, then the headers (hash and
   * timestamp from both providers) of every block with logs plus the range end.
   */
  private async verifiedRange(from: bigint, rangeEnd: bigint, active: ActiveIds, target: BlockHeader): Promise<VerifiedRange> {
    const { primary, secondary } = this.options;
    const plan = await this.buildPlan(from, rangeEnd, active);
    const comparison = await this.crossCheck(plan);
    if (!comparison.equal) throw new IntegrityError("log_disagreement", comparison.detail, comparison.block);
    const logs = this.mergeLeaves(plan);
    const to = plan.end;

    // Headers only for blocks with logs plus the range end, confirmed by both providers.
    const blockNumbers = [...new Set([...logs.map((log) => log.blockNumber), to])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const headers = new Map<bigint, BlockHeader>();
    for (const number of blockNumbers) {
      const a = await this.call(() => primary.blockHeader(number));
      const b = await this.call(() => secondary.blockHeader(number));
      if (a.number !== number || b.number !== number) throw new InvalidRpcDataError(`header for block ${number} has another number`);
      if (a.hash !== b.hash || a.timestamp !== b.timestamp) throw new IntegrityError("header_disagreement", `providers disagree on the header of block ${number}`, number);
      headers.set(number, a);
    }
    if (to === target.number && headers.get(to)?.hash !== target.hash) {
      throw new IntegrityError("rpc_disagreement", `header of finalized block ${to} differs from the agreed finalized hash`, to);
    }
    return { plan, logs, headers };
  }

  /** Both providers' finalized blocks; target = the lower one; both must report the same hash for it. */
  private async agreedFinalized(): Promise<BlockHeader> {
    const { primary, secondary } = this.options;
    const a = await this.call(() => primary.finalizedBlock());
    const b = await this.call(() => secondary.finalizedBlock());
    let target: BlockHeader;
    let other: BlockHeader;
    if (a.number === b.number) {
      target = a;
      other = b;
    } else if (a.number < b.number) {
      target = a;
      other = await this.call(() => secondary.blockHeader(a.number));
    } else {
      target = b;
      other = await this.call(() => primary.blockHeader(b.number));
    }
    if (other.number !== target.number || other.hash !== target.hash) {
      throw new IntegrityError("rpc_disagreement", `providers disagree on the hash of finalized block ${target.number}`, target.number);
    }
    return target;
  }

  // ----------------------------------------------------------------------------------------------------- the request plan

  /** Builds the plan on the primary: fixed sources, then the active ids plus this range's new ids. */
  private async buildPlan(from: bigint, rangeEnd: bigint, active: ActiveIds): Promise<Plan> {
    const plan: Plan = { from, end: rangeEnd, leaves: [], logCount: 0, byteCount: 0 };
    const reality = this.options.addresses.reality.toLowerCase() as Address;
    const conditionalTokens = this.options.addresses.conditionalTokens.toLowerCase() as Address;

    // a. Pine and arbitration logs, unfiltered.
    const questions = new Set<string>(active.questions);
    const conditions = new Set<string>(active.conditions);
    for (const template of this.fixedTemplates) {
      const logs = await this.collect(plan, template);
      if (template.name !== "ClaimRegistry") continue;
      for (const log of logs) {
        const event = this.decodeUnverified(log);
        if (event.kind !== "ClaimCreated") continue;
        questions.add(event.questionId);
        conditions.add(event.conditionId);
      }
    }

    // b. Reopen replacements of tracked questions (topic2 = the reopened id, topic1 = the new id), bounded rounds.
    const reopenTopic0 = topic0Of("reality", "LogReopenQuestion");
    let frontier = [...questions].sort();
    for (let round = 1; frontier.length > 0; round += 1) {
      const found: RawLog[] = [];
      for (const ids of chunked(frontier, this.bounds.idsPerRequest)) {
        found.push(...(await this.collect(plan, { name: `LogReopenQuestion round ${round}`, addresses: [reality], topics: [[reopenTopic0], null, ids as Hex32[]] })));
      }
      const next: string[] = [];
      let earliest: bigint | null = null;
      for (const log of found) {
        const replacement = log.topics[1];
        if (log.blockNumber > plan.end || replacement === undefined || questions.has(replacement)) continue;
        questions.add(replacement);
        next.push(replacement);
        if (earliest === null || log.blockNumber < earliest) earliest = log.blockNumber;
      }
      if (round === this.bounds.maxReopenRounds && earliest !== null) {
        // Ids still appear: the replacements found in this round may themselves be reopened later in the range, at or
        // after their own creation. Cutting before the earliest of them keeps the cut range complete; the next cycle
        // starts there with every earlier replacement stored. When that is the range's first block, the range becomes
        // that one block, complete because a question cannot be reopened in the block that created it (reopening needs
        // the question finalized, which needs a later block or a same-block arbitrator answer).
        const cut = earliest > plan.from ? earliest - 1n : plan.from;
        this.cutPlan(plan, cut);
        this.options.logger.warn({ cutAt: cut.toString() }, "reopen chain deeper than the round limit; range cut");
        break;
      }
      frontier = next.sort();
    }

    // c. Reality and CTF logs of the tracked ids only.
    for (const ids of chunked([...questions].sort(), this.bounds.idsPerRequest)) {
      await this.collect(plan, { name: "Reality", addresses: [reality], topics: [topic0sOf("reality"), ids as Hex32[]] });
    }
    for (const ids of chunked([...conditions].sort(), this.bounds.idsPerRequest)) {
      await this.collect(plan, { name: "ConditionalTokens", addresses: [conditionalTokens], topics: [topic0sOf("conditionalTokens"), ids as Hex32[]] });
    }
    return plan;
  }

  /** Decodes a primary log before its cross-check: a failure is a single-response anomaly (re-checked before a halt). */
  private decodeUnverified(log: RawLog): ChainEvent {
    try {
      return this.decoder.decode(log, 0);
    } catch (error) {
      if (error instanceof DecodeError) throw new UnverifiedDecodeError(error.message);
      throw error;
    }
  }

  /** Runs one template over [plan.from, plan.end] on the primary, splitting on size failures; returns its logs. */
  private async collect(plan: Plan, template: LogTemplate): Promise<RawLog[]> {
    const pending: [bigint, bigint][] = [[plan.from, plan.end]];
    const own: Leaf[] = [];
    while (pending.length > 0) {
      const [from, requestedTo] = pending.shift()!;
      if (from > plan.end) continue;
      const to = requestedTo > plan.end ? plan.end : requestedTo;
      let logs: RawLog[];
      try {
        logs = await this.fetchLogs(this.options.primary, template, from, to);
      } catch (error) {
        if (isSizeError(error) && to > from) {
          const mid = from + (to - from) / 2n;
          pending.unshift([from, mid], [mid + 1n, to]);
          continue;
        }
        throw error;
      }
      const leaf: Leaf = { template, from, to, logs };
      plan.leaves.push(leaf);
      own.push(leaf);
      for (const log of logs) {
        plan.logCount += 1;
        plan.byteCount += logBytes(log);
      }
      if (plan.logCount > this.bounds.maxRangeLogs || plan.byteCount > this.bounds.maxRangeBytes) this.cutByVolume(plan);
    }
    return own.filter((leaf) => leaf.from <= plan.end).flatMap((leaf) => leaf.logs);
  }

  /** Cuts the processed range at the last whole block under the volume cap (minimum one block). */
  private cutByVolume(plan: Plan): void {
    const { maxRangeLogs: maxLogs, maxRangeBytes: maxBytes } = this.bounds;
    const perBlock = new Map<bigint, { count: number; bytes: number }>();
    for (const leaf of plan.leaves) {
      for (const log of leaf.logs) {
        const entry = perBlock.get(log.blockNumber) ?? { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += logBytes(log);
        perBlock.set(log.blockNumber, entry);
      }
    }
    let count = 0;
    let bytes = 0;
    for (const block of [...perBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const entry = perBlock.get(block)!;
      if (count + entry.count > maxLogs || bytes + entry.bytes > maxBytes) {
        this.cutPlan(plan, block > plan.from ? block - 1n : plan.from);
        return;
      }
      count += entry.count;
      bytes += entry.bytes;
    }
  }

  /** Lowers the processed range end and drops every request and log above it. */
  private cutPlan(plan: Plan, end: bigint): void {
    if (end >= plan.end) return;
    plan.end = end;
    plan.leaves = plan.leaves.filter((leaf) => leaf.from <= end);
    plan.logCount = 0;
    plan.byteCount = 0;
    for (const leaf of plan.leaves) {
      if (leaf.to > end) leaf.to = end;
      leaf.logs = leaf.logs.filter((log) => log.blockNumber <= end);
      for (const log of leaf.logs) {
        plan.logCount += 1;
        plan.byteCount += logBytes(log);
      }
    }
  }

  /**
   * Runs the plan's requests on the secondary and compares each result set with the primary's. A size failure on the
   * secondary splits the request, and the halves run on both providers.
   */
  private async crossCheck(plan: Plan): Promise<Comparison> {
    const refined: Leaf[] = [];
    for (const leaf of plan.leaves) {
      const pending: { from: bigint; to: bigint; primary: RawLog[] | null }[] = [{ from: leaf.from, to: leaf.to, primary: leaf.logs }];
      while (pending.length > 0) {
        const item = pending.shift()!;
        let primaryLogs = item.primary;
        let secondaryLogs: RawLog[];
        try {
          primaryLogs ??= await this.fetchLogs(this.options.primary, leaf.template, item.from, item.to);
          secondaryLogs = await this.fetchLogs(this.options.secondary, leaf.template, item.from, item.to);
        } catch (error) {
          if (isSizeError(error) && item.to > item.from) {
            const mid = item.from + (item.to - item.from) / 2n;
            pending.unshift({ from: item.from, to: mid, primary: null }, { from: mid + 1n, to: item.to, primary: null });
            continue;
          }
          throw error;
        }
        const a = primaryLogs.map(logKey).sort();
        const b = secondaryLogs.map(logKey).sort();
        if (a.length !== b.length || a.some((key, index) => key !== b[index])) {
          return {
            equal: false,
            detail: `providers returned different logs for ${leaf.template.name} in blocks ${item.from}..${item.to} (${a.length} vs ${b.length})`,
            block: item.from,
          };
        }
        refined.push({ template: leaf.template, from: item.from, to: item.to, logs: primaryLogs });
      }
    }
    plan.leaves = refined;
    return { equal: true };
  }

  /** All logs of the plan, each position once (a reopen log is returned by two requests), sorted by position. */
  private mergeLeaves(plan: Plan): RawLog[] {
    const byPositionKey = new Map<string, RawLog>();
    for (const leaf of plan.leaves) {
      for (const log of leaf.logs) {
        const id = `${log.blockHash}:${log.logIndex}`;
        const existing = byPositionKey.get(id);
        if (existing && logKey(existing) !== logKey(log)) throw new InvalidRpcDataError(`two different logs at ${log.blockNumber}:${log.logIndex}`);
        byPositionKey.set(id, log);
      }
    }
    return [...byPositionKey.values()].sort(byPosition);
  }

  /**
   * One eth_getLogs request with retries of non-size failures. Logs outside the requested range or duplicated are invalid
   * data (a single-response anomaly: re-checked, then a halt); logs of other addresses or topics than requested are
   * ignored (SEC-IDX-05).
   */
  private async fetchLogs(provider: RpcProvider, template: LogTemplate, from: bigint, to: bigint): Promise<RawLog[]> {
    const logs = await this.call(() => provider.getLogs({ addresses: template.addresses, topics: template.topics, fromBlock: from, toBlock: to }), true);
    const seen = new Set<string>();
    const kept: RawLog[] = [];
    for (const log of logs) {
      if (log.blockNumber < from || log.blockNumber > to) throw new InvalidRpcDataError(`${provider.label} eth_getLogs returned a log outside ${from}..${to}`);
      const id = `${log.blockHash}:${log.logIndex}`;
      if (seen.has(id)) throw new InvalidRpcDataError(`${provider.label} eth_getLogs returned duplicate logs`);
      seen.add(id);
      if (matchesTemplate(template, log)) kept.push(log);
    }
    return kept;
  }

  /** Retries RpcErrors with capped backoff; size failures of splittable requests propagate at once (the caller splits). */
  private async call<T>(fn: () => Promise<T>, splittable = false): Promise<T> {
    const attempts = this.bounds.requestAttempts;
    const base = this.options.retryBaseMs ?? 500;
    const max = this.options.retryMaxMs ?? 5_000;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof RpcError) || (splittable && error.kind === "size") || attempt >= attempts) throw error;
        await this.sleep(Math.min(max, base * 2 ** (attempt - 1)));
      }
    }
  }

  // ----------------------------------------------------------------------------------------------------- halts, metrics

  private async halt(error: unknown): Promise<HaltReason> {
    const reason: HaltReason =
      error instanceof IntegrityError
        ? error.reason
        : error instanceof DecodeError
          ? "decode_failure"
          : error instanceof InvalidRpcDataError
            ? "invalid_rpc_data"
            : error instanceof CursorRegressionError
              ? "finalized_conflict"
              : "apply_conflict";
    const detail = safeErrorMessage(error, this.options.redact);
    const block = error instanceof IntegrityError ? error.block : null;
    await recordHalt(this.options.db, this.options.chainId, reason, detail, block);
    this.options.logger.error({ reason, detail, block: block === null ? null : block.toString() }, "indexer halted on an integrity conflict");
    return reason;
  }

  private async refreshMetrics(): Promise<void> {
    const metrics = this.options.metrics;
    if (!metrics) return;
    const { db, chainId } = this.options;
    const cursor = await readCursor(db, chainId);
    metrics.halted.set((await isHalted(db, chainId)) ? 1 : 0);
    if (!cursor) return;
    metrics.indexedBlock.set(Number(cursor.indexedBlock));
    if (cursor.finalizedBlock !== null) metrics.finalizedBlock.set(Number(cursor.finalizedBlock));
    if (cursor.headBlock !== null) metrics.headBlock.set(Number(cursor.headBlock));
    if (cursor.indexedBlockTimestamp > 0) metrics.lagSeconds.set(Math.max(0, Math.floor(this.now() / 1000) - cursor.indexedBlockTimestamp));
  }
}
