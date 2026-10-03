// Finality of every irreversible claims decision (PRD-07 §3f, §3g, SEC-IDX-01, SEC-IDX-06). One bound F per reconcile
// run, per integrity run and per request: the read model's finalizedBlock, or (Envio reports null) the chain's `finalized`
// block; null when that call fails, which means no final decision. The read model's indexedBlock is never finality: Envio
// serves rows above the finalized block. Every final decision goes through `isFinal`.

import type { IndexerStatus } from "@pine/shared/read-model";
import type { AppContext } from "../../contracts/app.js";

export interface Finality {
  /** F, or null when it could not be determined (no final decision). */
  bound: bigint | null;
  /** F !== null && block <= F. */
  isFinal(block: bigint): boolean;
}

export async function finalityOf(ctx: AppContext, status: Pick<IndexerStatus, "finalizedBlock">): Promise<Finality> {
  let bound = status.finalizedBlock;
  if (bound === null) {
    try {
      bound = await ctx.chain.finalizedBlock();
    } catch {
      bound = null;
    }
  }
  return { bound, isFinal: (block) => bound !== null && block <= bound };
}
