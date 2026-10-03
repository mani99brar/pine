// Reality.eth v3 answer history (PRD-04 section 2.3): pure reconstruction of claimWinnings / reportArbitrationAnswer
// arguments from indexed LogNewAnswer records, and the same verification Reality runs (_verifyHistoryInputOrRevert),
// so a misread argument is refused before it can reach a wallet.
//
// h_i = keccak256(abi.encodePacked(h_{i-1}, answer_i, bond_i, answerer_i, isCommitment_i)), h_0 = 0x0.
// OracleAnswerRecord.historyHash is h_i (the hash AFTER the entry); the argument for an entry is h_{i-1}.

import { encodePacked, keccak256 } from "viem";
import type { OracleAnswerRecord } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";

export const NULL_HASH: Hex32 = `0x${"0".repeat(64)}`;

/** At most this many history entries go into one claimWinnings call; Reality accepts partial claims and resumes. */
export const MAX_CLAIM_ENTRIES = 64;

export function historyHashAfter(previous: Hex32, answer: Hex32, bond: bigint, answerer: Address, isCommitment: boolean): Hex32 {
  return keccak256(encodePacked(["bytes32", "bytes32", "uint256", "address", "bool"], [previous, answer, bond, answerer, isCommitment]));
}

export interface ClaimWinningsArgs {
  historyHashes: Hex32[];
  addrs: Address[];
  bonds: bigint[];
  answers: Hex32[];
}

export class HistoryMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryMismatchError";
  }
}

/** The hash before record `index` (the previous record's historyHash, 0x0 for the first answer). */
const hashBefore = (records: readonly OracleAnswerRecord[], index: number): Hex32 => (index === 0 ? NULL_HASH : records[index - 1]!.historyHash.toLowerCase() as Hex32);

/**
 * Arguments for claimWinnings, last entry first, starting at the entry whose hash equals the current on-chain history
 * hash (after a partial claim only the still-unclaimed entries remain). Null when everything was claimed (hash 0).
 */
export function claimWinningsArgs(records: readonly OracleAnswerRecord[], onChainHistoryHash: Hex32, maxEntries = MAX_CLAIM_ENTRIES): ClaimWinningsArgs | null {
  const current = onChainHistoryHash.toLowerCase() as Hex32;
  if (current === NULL_HASH) return null;
  let start = -1;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]!.historyHash.toLowerCase() === current) {
      start = index;
      break;
    }
  }
  if (start < 0) throw new HistoryMismatchError("the on-chain history hash matches no indexed answer");
  const args: ClaimWinningsArgs = { historyHashes: [], addrs: [], bonds: [], answers: [] };
  for (let index = start; index >= 0 && args.answers.length < maxEntries; index -= 1) {
    const record = records[index]!;
    args.historyHashes.push(hashBefore(records, index));
    args.addrs.push(record.answerer.toLowerCase() as Address);
    args.bonds.push(record.bond);
    args.answers.push(record.answer.toLowerCase() as Hex32);
  }
  return args;
}

/**
 * Mirrors Reality's claimWinnings input check: starting from `onChainHistoryHash`, each entry must hash (with either
 * is_commitment value) to the running hash, which then becomes the entry's history-hash argument.
 */
export function verifyClaimArgs(onChainHistoryHash: Hex32, args: ClaimWinningsArgs): boolean {
  let last = onChainHistoryHash.toLowerCase() as Hex32;
  if (args.historyHashes.length === 0 || ![args.addrs, args.bonds, args.answers].every((list) => list.length === args.historyHashes.length)) return false;
  for (let index = 0; index < args.historyHashes.length; index += 1) {
    const before = args.historyHashes[index]!;
    const answer = args.answers[index]!;
    const bond = args.bonds[index]!;
    const answerer = args.addrs[index]!;
    if (historyHashAfter(before, answer, bond, answerer, true) !== last && historyHashAfter(before, answer, bond, answerer, false) !== last) return false;
    last = before;
  }
  return true;
}

export interface ReportArgs {
  lastHistoryHash: Hex32;
  lastAnswerOrCommitmentId: Hex32;
  lastAnswerer: Address;
  /** Not an argument: used for the self-check. */
  bond: bigint;
  isCommitment: boolean;
}

/** reportArbitrationAnswer(questionId, h_{n-1}, answer_n, answerer_n) from the last indexed answer. */
export function reportArgs(records: readonly OracleAnswerRecord[]): ReportArgs | null {
  if (records.length === 0) return null;
  const last = records[records.length - 1]!;
  return {
    lastHistoryHash: hashBefore(records, records.length - 1),
    lastAnswerOrCommitmentId: last.answer.toLowerCase() as Hex32,
    lastAnswerer: last.answerer.toLowerCase() as Address,
    bond: last.bond,
    isCommitment: last.isCommitment,
  };
}

export function verifyReportArgs(onChainHistoryHash: Hex32, args: ReportArgs): boolean {
  return historyHashAfter(args.lastHistoryHash, args.lastAnswerOrCommitmentId, args.bond, args.lastAnswerer, args.isCommitment) === onChainHistoryHash.toLowerCase();
}
