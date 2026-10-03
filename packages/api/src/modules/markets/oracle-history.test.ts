// Pure history reconstruction; no database (no suite lock: it holds no in-memory Postgres).
import { describe, expect, it } from "vitest";
import { concat, encodePacked, keccak256, toHex } from "viem";
import type { OracleAnswerRecord } from "@pine/shared/read-model";
import type { Address, Hex32 } from "@pine/shared/types";
import { claimWinningsArgs, HistoryMismatchError, reportArgs, verifyClaimArgs, verifyReportArgs } from "./history.js";

const ALICE = "0x00000000000000000000000000000000000a11ce" as Address;
const BOB = "0x0000000000000000000000000000000000000b0b" as Address;
const CAROL = "0x00000000000000000000000000000000000ca201" as Address;
const Q = `0x${"71".repeat(32)}` as Hex32;
const ZERO = `0x${"0".repeat(64)}` as Hex32;
const YES = ZERO;
const NO = `0x${"0".repeat(63)}1` as Hex32;
const XDAI = 10n ** 18n;

/** Independent of the module: raw byte concatenation (32 + 32 + 32 + 20 + 1 bytes), as Reality's abi.encodePacked lays them out. */
const independentHash = (previous: Hex32, answer: Hex32, bond: bigint, answerer: Address, isCommitment: boolean): Hex32 =>
  keccak256(concat([previous, answer, toHex(bond, { size: 32 }), answerer, isCommitment ? "0x01" : "0x00"]));

function record(previous: Hex32, fields: { answer: Hex32; bond: bigint; answerer: Address; isCommitment?: boolean; revealedAnswer?: Hex32 | null }, index: number): OracleAnswerRecord {
  const isCommitment = fields.isCommitment ?? false;
  return {
    questionId: Q,
    answer: fields.answer,
    historyHash: independentHash(previous, fields.answer, fields.bond, fields.answerer, isCommitment),
    answerer: fields.answerer,
    bond: fields.bond,
    ts: 1_800_000_000 + index,
    isCommitment,
    revealedAnswer: fields.revealedAnswer ?? (isCommitment ? null : fields.answer),
    txHash: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex32,
    blockNumber: BigInt(2_000 + index),
    logIndex: 0,
  };
}

/** A real-shaped history: answer, commitment (revealed), counter-answer, arbitrator answer (bond 0). */
function history(): { records: OracleAnswerRecord[]; commitmentId: Hex32 } {
  const answerHash = keccak256(encodePacked(["bytes32", "uint256"], [YES, 42n]));
  const commitmentId = keccak256(encodePacked(["bytes32", "bytes32", "uint256"], [Q, answerHash, 2n * XDAI]));
  const entries = [
    { answer: NO, bond: XDAI, answerer: ALICE },
    { answer: commitmentId, bond: 2n * XDAI, answerer: BOB, isCommitment: true, revealedAnswer: YES },
    { answer: NO, bond: 4n * XDAI, answerer: CAROL },
    { answer: YES, bond: 0n, answerer: BOB },
  ];
  const records: OracleAnswerRecord[] = [];
  let previous = ZERO;
  entries.forEach((entry, index) => {
    const next = record(previous, entry, index);
    records.push(next);
    previous = next.historyHash;
  });
  return { records, commitmentId };
}

describe("claimWinnings argument reconstruction", () => {
  it("matches a hand-computed history: last entry first, hash BEFORE each entry, raw commitment id", () => {
    const { records, commitmentId } = history();
    const [h1, h2, h3, h4] = records.map((item) => item.historyHash) as [Hex32, Hex32, Hex32, Hex32];
    const args = claimWinningsArgs(records, h4);
    expect(args).toEqual({
      historyHashes: [h3, h2, h1, ZERO],
      addrs: [BOB, CAROL, BOB, ALICE],
      bonds: [0n, 4n * XDAI, 2n * XDAI, XDAI],
      answers: [YES, NO, commitmentId, NO],
    });
    expect(verifyClaimArgs(h4, args!)).toBe(true);
  });

  it("starts from the current on-chain hash after a partial claim, and is null once everything was claimed", () => {
    const { records } = history();
    const [h1, h2] = records.map((item) => item.historyHash) as [Hex32, Hex32];
    const partial = claimWinningsArgs(records, h2);
    expect(partial?.historyHashes).toEqual([h1, ZERO]);
    expect(partial?.addrs).toEqual([BOB, ALICE]);
    expect(verifyClaimArgs(h2, partial!)).toBe(true);
    expect(claimWinningsArgs(records, ZERO)).toBeNull();
  });

  it("splits long histories into partial claims Reality can resume", () => {
    const { records } = history();
    const top = records[3]!.historyHash;
    const args = claimWinningsArgs(records, top, 2)!;
    expect(args.historyHashes).toEqual([records[2]!.historyHash, records[1]!.historyHash]);
    expect(verifyClaimArgs(top, args)).toBe(true);
  });

  it("refuses a hash that matches no indexed record, and the self-check catches any misread argument", () => {
    const { records } = history();
    expect(() => claimWinningsArgs(records, `0x${"ee".repeat(32)}`)).toThrow(HistoryMismatchError);
    const top = records[3]!.historyHash;
    const args = claimWinningsArgs(records, top)!;
    // Using the revealed answer instead of the raw commitment id breaks the chain.
    const tampered = { ...args, answers: args.answers.map((answer, index) => (index === 2 ? YES : answer)) };
    expect(verifyClaimArgs(top, tampered)).toBe(false);
    expect(verifyClaimArgs(`0x${"ee".repeat(32)}`, args)).toBe(false);
    const fakeHashes = records.map((item, index) => ({ ...item, historyHash: keccak256(toHex(`fake-${index}`)) }));
    expect(verifyClaimArgs(fakeHashes[3]!.historyHash, claimWinningsArgs(fakeHashes, fakeHashes[3]!.historyHash)!)).toBe(false);
  });
});

describe("reportArbitrationAnswer arguments", () => {
  it("use the second-to-last record's hash and the raw last answer (a commitment id stays a commitment id)", () => {
    const { records, commitmentId } = history();
    const beforeArbitration = records.slice(0, 2);
    const args = reportArgs(beforeArbitration)!;
    expect(args).toMatchObject({ lastHistoryHash: records[0]!.historyHash, lastAnswerOrCommitmentId: commitmentId, lastAnswerer: BOB, isCommitment: true });
    expect(verifyReportArgs(records[1]!.historyHash, args)).toBe(true);
    expect(verifyReportArgs(records[0]!.historyHash, args)).toBe(false);
    const three = reportArgs(records.slice(0, 3))!;
    expect(three).toMatchObject({ lastHistoryHash: records[1]!.historyHash, lastAnswerOrCommitmentId: NO, lastAnswerer: CAROL });
    expect(reportArgs([{ ...records[0]! }])?.lastHistoryHash).toBe(ZERO);
    expect(reportArgs([])).toBeNull();
  });
});
