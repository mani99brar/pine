// Receipt inspection shared by reconciliation and integrity: strict decoding of ClaimCreated (Pine registry) and
// NewMarket (Seer factory) logs, filtered by the exact emitting address from the deployment manifest.

import { decodeEventLog, TransactionReceiptNotFoundError, type Log, type TransactionReceipt } from "viem";
import { claimRegistryAbi } from "@pine/shared/abi/generated";
import { seerMarketFactoryAbi } from "@pine/shared/abi/external";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext } from "../../contracts/app.js";

/** The receipt, or null when the node does not know the transaction. Other failures throw (transient). */
export async function fetchReceipt(ctx: AppContext, hash: Hex32): Promise<TransactionReceipt | null> {
  try {
    return await ctx.chain.publicClient.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  }
}

const lower = (value: unknown): string => String(value).toLowerCase();

/** Markets announced by ClaimCreated logs of `registry` in the receipt for (creator, digest). */
export function claimCreatedMarkets(receipt: TransactionReceipt, registry: Address, creator: Address, digest: Hex32): Address[] {
  if (receipt.status !== "success") return [];
  const markets: Address[] = [];
  for (const log of receipt.logs as Log[]) {
    if (lower(log.address) !== lower(registry)) continue;
    try {
      const decoded = decodeEventLog({ abi: claimRegistryAbi, eventName: "ClaimCreated", data: log.data, topics: log.topics, strict: true });
      const args = decoded.args as { market: string; creator: string; claimDocumentSha256: string; claim: { creator: string; claimDocumentSha256: string } };
      if (lower(args.creator) !== lower(creator) || lower(args.claim.creator) !== lower(creator)) continue;
      if (lower(args.claimDocumentSha256) !== lower(digest) || lower(args.claim.claimDocumentSha256) !== lower(digest)) continue;
      markets.push(lower(args.market) as Address);
    } catch {
      continue;
    }
  }
  return markets;
}

/** True when the receipt carries Seer's NewMarket for exactly this market from the configured factory (SEC-IDX-08). */
export function hasMatchingNewMarket(
  receipt: TransactionReceipt,
  factory: Address,
  expected: { market: Address; conditionId: Hex32; questionId: Hex32; marketName: string },
): boolean {
  if (receipt.status !== "success") return false;
  for (const log of receipt.logs as Log[]) {
    if (lower(log.address) !== lower(factory)) continue;
    try {
      const decoded = decodeEventLog({ abi: seerMarketFactoryAbi, eventName: "NewMarket", data: log.data, topics: log.topics, strict: true });
      const args = decoded.args as { market: string; marketName: string; conditionId: string; questionId: string };
      if (
        lower(args.market) === lower(expected.market) &&
        lower(args.conditionId) === lower(expected.conditionId) &&
        lower(args.questionId) === lower(expected.questionId) &&
        args.marketName === expected.marketName
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
