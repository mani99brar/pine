// Job claims.reconcile-publications (PRD-03 §6): moves open publications forward with compare-and-set transitions only.
// Confirmation comes from the finalized read model plus the receipt of the indexed creation transaction; user-reported
// hashes are hints. expired/failed are decided only from read-model coverage, never from the chain head alone.

import type { TransactionReceipt } from "viem";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, JobDefinition } from "../../contracts/app.js";
import { DAY } from "./common.js";
import { msOf, rows, sql, ts } from "./db.js";
import { marketOnChain, publicationColumns, toPublication, transitionPublication, type PublicationRow, type PublicationState } from "./publications.js";
import { claimCreatedMarkets, fetchReceipt } from "./receipts.js";
import type { ClaimsState } from "./state.js";

const BATCH = 100;
/** Receipt lookups per publication per run (PRD-03 §8c): reported hashes are user input, so their cost is capped. */
export const MAX_RECEIPTS_PER_PUBLICATION = 5;

type Outcome = "confirmed" | "mined" | "reopened" | "expired" | "failed" | "unchanged";

async function reconcileOne(ctx: AppContext, state: ClaimsState, publication: PublicationRow, coverage: { halted: boolean; indexedBlock: bigint; indexedBlockTimestamp: number }): Promise<Outcome> {
  const registry = state.manifest.pine.claimRegistry;
  const audit = (action: string, details: Record<string, unknown>) =>
    ctx.audit.record({ actorUserId: null, action, subjectType: "claim_publication", subjectId: publication.id, details, ip: null });
  const move = async (from: readonly PublicationState[], to: PublicationState, fields: { market?: Address; failureReason?: string }, details: Record<string, unknown>): Promise<boolean> => {
    const moved = await transitionPublication(ctx.db, publication.id, from, to, ctx.clock.now(), fields);
    if (moved) await audit(`claim.publication.${to}`, { from: publication.state, via: "reconcile", ...details });
    return moved !== null;
  };

  // 1. The finalized read model: claim by (creator, digest), confirmed by its indexed creation receipt.
  const page = await ctx.readModel.listClaims({ creator: publication.creator, claimDocumentSha256: publication.documentSha256, order: "created_desc", limit: 10 });
  // An indexed claim whose receipt cannot be confirmed (yet) means step 1 did not find "nothing": never expire it.
  let indexedUnconfirmed = false;
  for (const claim of page.items) {
    if (claim.registry !== registry || claim.creator !== publication.creator || claim.claimDocumentSha256 !== publication.documentSha256) continue;
    indexedUnconfirmed = true;
    const receipt = await fetchReceipt(ctx, claim.createdTxHash);
    if (!receipt) continue;
    if (claimCreatedMarkets(receipt, registry, publication.creator, publication.documentSha256).includes(claim.market)) {
      return (await move(["planned", "submitted", "mined"], "confirmed", { market: claim.market }, { market: claim.market, txHash: claim.createdTxHash })) ? "confirmed" : "unchanged";
    }
  }

  // 2. Recorded hashes (hints). A receipt counts only when its block is at or below the read model's covered (finalized)
  //    block (PRD-03 §8d): a newer one leaves the hint `unknown` and it is fetched again later. `succeeded` hints are
  //    re-checked first (a recorded success that disappeared reopens the publication below), then `unknown` hints, least
  //    recently checked first; `reverted` and `unrelated` hints are final. At most MAX_RECEIPTS_PER_PUBLICATION lookups
  //    per publication per run (reported hashes are user input, so their cost is capped).
  const cutoffMs = (publication.evidenceDeadline - DAY) * 1000;
  const hints = await rows<{ tx_hash: string; status: string; missing_ms: unknown }>(
    ctx.db,
    sql`SELECT tx_hash, status, ${msOf(sql`missing_at`)} AS missing_ms FROM claim_publication_txs
        WHERE publication_id = ${publication.id}::uuid ORDER BY checked_at NULLS FIRST, reported_at, tx_hash`,
  );
  let budget = MAX_RECEIPTS_PER_PUBLICATION;
  const finalized = (receipt: TransactionReceipt) => receipt.blockNumber <= coverage.indexedBlock;
  const hintWhere = (txHash: string, status: string) => sql`publication_id = ${publication.id}::uuid AND tx_hash = ${txHash} AND status = ${status}`;

  const succeeded = new Set(hints.filter((hint) => hint.status === "succeeded").map((hint) => hint.tx_hash));
  // Hints whose recorded success disappeared in this run: unknown again, so they hold back expiry like any unknown hint.
  const reopenedHints = new Set<string>();
  for (const txHash of [...succeeded]) {
    if (budget === 0) break;
    budget -= 1;
    const now = ctx.clock.now();
    let receipt;
    try {
      receipt = await fetchReceipt(ctx, txHash as Hex32);
    } catch {
      continue; // transient: the recorded success stands until a lookup answers
    }
    if (receipt && finalized(receipt) && claimCreatedMarkets(receipt, registry, publication.creator, publication.documentSha256).length > 0) {
      await ctx.db.execute(sql`UPDATE claim_publication_txs SET checked_at = ${ts(now)} WHERE ${hintWhere(txHash, "succeeded")}`);
      continue;
    }
    await ctx.db.execute(sql`UPDATE claim_publication_txs SET status = 'unknown', checked_at = ${ts(now)}, missing_at = NULL WHERE ${hintWhere(txHash, "succeeded")}`);
    succeeded.delete(txHash);
    reopenedHints.add(txHash);
  }

  let anyReverted = hints.some((hint) => hint.status === "reverted");
  // An unknown hint holds back expiry until a lookup after the cutoff found no receipt for it (a transaction mined
  // after the cutoff can no longer create the claim).
  const settled = new Set(hints.filter((hint) => hint.status === "unknown" && hint.missing_ms !== null && Number(String(hint.missing_ms)) > cutoffMs).map((hint) => hint.tx_hash));
  const unknown = hints.filter((hint) => hint.status === "unknown");
  for (const hint of unknown) {
    if (budget === 0) break;
    budget -= 1;
    const now = ctx.clock.now();
    const where = hintWhere(hint.tx_hash, "unknown");
    let receipt;
    try {
      receipt = await fetchReceipt(ctx, hint.tx_hash as Hex32);
    } catch {
      settled.delete(hint.tx_hash);
      await ctx.db.execute(sql`UPDATE claim_publication_txs SET checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
      continue;
    }
    if (!receipt) {
      if (now.getTime() > cutoffMs) settled.add(hint.tx_hash);
      else settled.delete(hint.tx_hash);
      await ctx.db.execute(sql`UPDATE claim_publication_txs SET checked_at = ${ts(now)}, missing_at = ${ts(now)} WHERE ${where}`);
      continue;
    }
    if (!finalized(receipt)) {
      // Mined above the covered block: neither success nor failure yet (a reorg may still drop or change it).
      settled.delete(hint.tx_hash);
      await ctx.db.execute(sql`UPDATE claim_publication_txs SET checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
      continue;
    }
    settled.add(hint.tx_hash);
    if (receipt.status === "success") {
      const market = claimCreatedMarkets(receipt, registry, publication.creator, publication.documentSha256)[0];
      if (!market) {
        await ctx.db.execute(sql`UPDATE claim_publication_txs SET status = 'unrelated', checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
        continue;
      }
      // The hint's status and the transition commit together: a crash never leaves a succeeded hint on a planned row.
      const moved = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE claim_publication_txs SET status = 'succeeded', checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
        return transitionPublication(tx, publication.id, ["planned", "submitted"], "mined", now, { market });
      });
      if (moved) {
        await audit("claim.publication.mined", { from: publication.state, via: "reconcile", market, txHash: hint.tx_hash });
        return "mined";
      }
      return "unchanged";
    }
    anyReverted = true;
    await ctx.db.execute(sql`UPDATE claim_publication_txs SET status = 'reverted', reason = ${"transaction reverted"}, checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
  }
  const uncertain = reopenedHints.size > 0 || unknown.some((hint) => !settled.has(hint.tx_hash));

  // 2a. A `mined` publication whose success is no longer backed by anything (no succeeded hint, nothing indexed, no
  //     market at the latest block) returns to the plan-able state instead of staying `mined` forever (PRD-03 §8d).
  if (publication.state === "mined" && succeeded.size === 0 && !indexedUnconfirmed) {
    if ((await marketOnChain(ctx, state.manifest, publication.creator, publication.documentSha256)) !== null) return "unchanged";
    const to: PublicationState = hints.length > 0 ? "submitted" : "planned";
    const moved = await transitionPublication(ctx.db, publication.id, ["mined"], to, ctx.clock.now(), { clearMarket: true });
    if (!moved) return "unchanged";
    await audit("claim.publication.reopened", { from: "mined", to, via: "reconcile", market: publication.market });
    return "reopened";
  }

  // 3. Coverage: once the finalized read model has passed evidenceDeadline - 1 day, any successful createClaim would
  //    already be indexed (the registry refuses later creation), so absence is final.
  const covered = !coverage.halted && coverage.indexedBlockTimestamp > publication.evidenceDeadline - DAY;
  if (!covered || succeeded.size > 0 || uncertain || indexedUnconfirmed) return "unchanged";
  if (anyReverted) return (await move(["planned", "submitted", "mined"], "failed", { failureReason: "transaction reverted" }, { reason: "reverted" })) ? "failed" : "unchanged";
  return (await move(["planned", "submitted", "mined"], "expired", {}, { reason: "not created before the on-chain minimum window" })) ? "expired" : "unchanged";
}

export async function reconcilePublications(ctx: AppContext, state: ClaimsState, signal?: AbortSignal): Promise<Record<Outcome | "errors", number>> {
  const counts: Record<Outcome | "errors", number> = { confirmed: 0, mined: 0, reopened: 0, expired: 0, failed: 0, unchanged: 0, errors: 0 };
  const status = await ctx.readModel.status();
  const open = await rows<Parameters<typeof toPublication>[0]>(
    ctx.db,
    sql`SELECT ${publicationColumns} FROM claim_publications WHERE state IN ('planned', 'submitted', 'mined') ORDER BY reconciled_at NULLS FIRST, id LIMIT ${BATCH}`,
  );
  for (const raw of open) {
    if (signal?.aborted) break;
    const publication = toPublication(raw);
    try {
      counts[await reconcileOne(ctx, state, publication, status)] += 1;
    } catch {
      // Transient (RPC, read model): the row stays as it is and the next run retries it.
      counts.errors += 1;
    }
    await ctx.db.execute(sql`UPDATE claim_publications SET reconciled_at = ${ts(ctx.clock.now())} WHERE id = ${publication.id}::uuid`);
  }
  for (const [outcome, count] of Object.entries(counts)) if (count > 0) ctx.metrics.increment("claims_reconcile", { outcome });
  return counts;
}

export function reconcileJob(stateFor: (ctx: AppContext) => ClaimsState): JobDefinition {
  return {
    name: "claims.reconcile-publications",
    intervalMs: 30_000,
    async run(ctx, signal) {
      await reconcilePublications(ctx, stateFor(ctx), signal);
    },
  };
}
