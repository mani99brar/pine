// Job claims.reconcile-publications (PRD-03 §6): moves open publications forward with compare-and-set transitions only.
// Confirmation comes from the finalized read model plus the receipt of the indexed creation transaction; user-reported
// hashes are hints. expired/failed are decided only from read-model coverage, never from the chain head alone.
// A publication becomes `mined` only from finalized evidence, so a `mined` publication is never reopened (PRD-07 §3b).

import type { TransactionReceipt } from "viem";
import type { Address, Hex32 } from "@pine/shared/types";
import type { AppContext, AuditEntry, JobDefinition } from "../../contracts/app.js";
import { flushAudit, outboxInsert } from "./audit.js";
import { DAY } from "./common.js";
import { msOf, rows, sql, ts } from "./db.js";
import { publicationColumns, toPublication, transitionPublication, type PublicationRow, type PublicationState } from "./publications.js";
import { claimCreatedMarkets, fetchReceipt } from "./receipts.js";
import type { ClaimsState } from "./state.js";

const BATCH = 100;
/** Receipt lookups per publication per run (PRD-03 §8c): reported hashes are user input, so their cost is capped. */
export const MAX_RECEIPTS_PER_PUBLICATION = 5;

type Outcome = "confirmed" | "mined" | "expired" | "failed" | "unchanged";

async function reconcileOne(
  ctx: AppContext,
  state: ClaimsState,
  publication: PublicationRow,
  coverage: { halted: boolean; indexedBlock: bigint; indexedBlockTimestamp: number },
  signal?: AbortSignal,
): Promise<Outcome> {
  const registry = state.manifest.pine.claimRegistry;
  const audit = (action: string, details: Record<string, unknown>): AuditEntry => ({ actorUserId: null, action, subjectType: "claim_publication", subjectId: publication.id, details, ip: null });
  // The transition and its outbox row in one statement, then the flush (SEC-OPS-07).
  const move = async (from: readonly PublicationState[], to: PublicationState, fields: { market?: Address; failureReason?: string }, details: Record<string, unknown>): Promise<boolean> => {
    const moved = await transitionPublication(ctx.db, publication.id, from, to, ctx.clock.now(), fields, audit(`claim.publication.${to}`, { from: publication.state, via: "reconcile", ...details }));
    if (moved) await flushAudit(ctx, signal);
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
  // A `mined` publication rests on a finalized success, which no reorg can undo: it only waits for confirmation above.
  if (publication.state === "mined") return "unchanged";

  // 2. Recorded hashes (hints). A receipt counts only when its block is at or below the read model's covered (finalized)
  //    block (PRD-03 §8d): a newer one leaves the hint `unknown` and it is fetched again later. `unknown` hints are
  //    fetched least recently checked first; `succeeded`, `reverted` and `unrelated` hints are final. At most
  //    MAX_RECEIPTS_PER_PUBLICATION lookups per publication per run (reported hashes are user input, so their cost is capped).
  const cutoffMs = (publication.evidenceDeadline - DAY) * 1000;
  const hints = await rows<{ tx_hash: string; status: string; missing_ms: unknown }>(
    ctx.db,
    sql`SELECT tx_hash, status, ${msOf(sql`missing_at`)} AS missing_ms FROM claim_publication_txs
        WHERE publication_id = ${publication.id}::uuid ORDER BY checked_at NULLS FIRST, reported_at, tx_hash`,
  );
  let budget = MAX_RECEIPTS_PER_PUBLICATION;
  const finalized = (receipt: TransactionReceipt) => receipt.blockNumber <= coverage.indexedBlock;
  const hintWhere = (txHash: string, status: string) => sql`publication_id = ${publication.id}::uuid AND tx_hash = ${txHash} AND status = ${status}`;

  const succeeded = hints.some((hint) => hint.status === "succeeded");
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
      // The hint's status, the transition and its audit entry commit together: a crash never leaves a succeeded hint
      // on a planned row or a transition without its outbox row.
      const moved = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE claim_publication_txs SET status = 'succeeded', checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
        const row = await transitionPublication(tx, publication.id, ["planned", "submitted"], "mined", now, { market });
        if (row) await outboxInsert(tx, audit("claim.publication.mined", { from: publication.state, via: "reconcile", market, txHash: hint.tx_hash }), now);
        return row;
      });
      if (moved) {
        await flushAudit(ctx, signal);
        return "mined";
      }
      return "unchanged";
    }
    anyReverted = true;
    await ctx.db.execute(sql`UPDATE claim_publication_txs SET status = 'reverted', reason = ${"transaction reverted"}, checked_at = ${ts(now)}, missing_at = NULL WHERE ${where}`);
  }
  const uncertain = unknown.some((hint) => !settled.has(hint.tx_hash));

  // 3. Coverage: once the finalized read model has passed evidenceDeadline - 1 day, any successful createClaim would
  //    already be indexed (the registry refuses later creation), so absence is final.
  const covered = !coverage.halted && coverage.indexedBlockTimestamp > publication.evidenceDeadline - DAY;
  if (!covered || succeeded || uncertain || indexedUnconfirmed) return "unchanged";
  if (anyReverted) return (await move(["planned", "submitted"], "failed", { failureReason: "transaction reverted" }, { reason: "reverted" })) ? "failed" : "unchanged";
  return (await move(["planned", "submitted"], "expired", {}, { reason: "not created before the on-chain minimum window" })) ? "expired" : "unchanged";
}

export async function reconcilePublications(ctx: AppContext, state: ClaimsState, signal?: AbortSignal): Promise<Record<Outcome | "errors", number>> {
  const counts: Record<Outcome | "errors", number> = { confirmed: 0, mined: 0, expired: 0, failed: 0, unchanged: 0, errors: 0 };
  // Entries an audit outage left in the outbox, before anything else (also when no publication is open).
  await flushAudit(ctx, signal);
  const status = await ctx.readModel.status();
  const open = await rows<Parameters<typeof toPublication>[0]>(
    ctx.db,
    sql`SELECT ${publicationColumns} FROM claim_publications WHERE state IN ('planned', 'submitted', 'mined') ORDER BY reconciled_at NULLS FIRST, id LIMIT ${BATCH}`,
  );
  for (const raw of open) {
    if (signal?.aborted) break;
    const publication = toPublication(raw);
    try {
      counts[await reconcileOne(ctx, state, publication, status, signal)] += 1;
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
