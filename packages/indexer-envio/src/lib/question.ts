// OracleQuestion construction shared by ClaimCreated and LogReopenQuestion (MemoryReadModel.newQuestion).

import type { OracleQuestion } from "envio";

/**
 * Seer MarketFactory.questionTimeout() in seconds (302400 on Gnosis), identical for reopened questions. Read once at
 * load from ENVIO_QUESTION_TIMEOUT so every handler run of a deployment sees the same value; invalid values refuse to start.
 */
export const QUESTION_TIMEOUT = parseTimeout(process.env.ENVIO_QUESTION_TIMEOUT);

export function parseTimeout(raw: string | undefined): bigint {
  if (raw === undefined || raw === "") return 302_400n;
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) throw new Error("ENVIO_QUESTION_TIMEOUT must be a positive integer number of seconds");
  return BigInt(raw);
}

export function sortedMarkets(markets: readonly string[]): string[] {
  return [...new Set(markets)].sort();
}

/** The Json `markets` column back as a list; anything else is a corrupted row. */
export function marketsOf(question: OracleQuestion): string[] {
  const value: unknown = question.markets;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`OracleQuestion ${question.id} has a malformed markets list`);
  }
  return value;
}

export function newQuestion(id: string, markets: readonly string[], openingTs: bigint, minBond: bigint, reopens: string | null): OracleQuestion {
  return {
    id,
    markets: sortedMarkets(markets),
    openingTs,
    minBond,
    timeout: QUESTION_TIMEOUT,
    bestAnswer: undefined,
    bond: 0n,
    finalizeTs: 0n,
    pendingArbitration: false,
    arbitrationRequestedBy: undefined,
    answeredByArbitrator: false,
    bounty: 0n,
    reopenedBy: undefined,
    reopens: reopens ?? undefined,
    answerCount: 0n,
    lastEventBlock: 0n,
  };
}
