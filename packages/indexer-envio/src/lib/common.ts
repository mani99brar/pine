// Helpers shared by the handlers. Pure and deterministic: handlers run twice (preload, then processing) and must
// never touch anything outside the handler context.

import type { EvmOnEventContext } from "envio";

/** Largest integer a frozen ChainEvent `number` field can hold (repositoryId, unix seconds). */
export const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const lower = (value: string): string => value.toLowerCase();

/** Entity id of a per-event child row (answers, arbitration stages): unique per log, ordered by (block, logIndex). */
export const logId = (prefix: string, block: number, logIndex: number): string => `${prefix}:${block}:${logIndex}`;

/** Pine registry values must lie in the frozen ChainEvent domain; a violation is a contract or provider fault and halts. */
export function assertSafeUint(value: bigint, field: string, min = 0n): void {
  if (value < min || value > MAX_SAFE) throw new DomainError(`${field} out of the ChainEvent domain`);
}

export interface EventPosition {
  chainId: number;
  block: { number: number; timestamp: number };
}

/**
 * Records the last applied block and its timestamp (status().indexedBlockTimestamp; Envio's _meta has no block
 * timestamp). Every event updates it, including ignored ones, exactly as MemoryReadModel.apply advances `indexed`.
 */
export function markProgress(context: Pick<EvmOnEventContext, "IndexerProgress">, event: EventPosition): void {
  context.IndexerProgress.set({
    id: String(event.chainId),
    blockNumber: BigInt(event.block.number),
    blockTimestamp: BigInt(event.block.timestamp),
  });
}
