// EvidenceRegistry EvidenceCommitted / EvidenceRevealed / EvidencePublished (MemoryReadModel.applyOne).

import { indexer } from "envio";
import { assertSafeUint, lower, markProgress } from "../lib/common.js";

/** (registry, submissionId) identifies a submission. */
export const evidenceId = (registry: string, submissionId: bigint): string => `${lower(registry)}:${submissionId.toString()}`;

indexer.onEvent({ contract: "EvidenceRegistry", event: "EvidenceCommitted" }, async ({ event, context }) => {
  const id = evidenceId(event.srcAddress, event.params.submissionId);
  const existing = await context.EvidenceSubmission.get(id);
  markProgress(context, event);
  assertSafeUint(event.params.committedAt, "committedAt");
  if (existing) return;
  context.EvidenceSubmission.set({
    id,
    registry: lower(event.srcAddress),
    submissionId: event.params.submissionId,
    market: lower(event.params.market),
    submitter: lower(event.params.submitter),
    status: "committed",
    commitment: lower(event.params.commitment),
    contentSha256: undefined,
    committedAt: event.params.committedAt,
    revealedAt: undefined,
    committedTxHash: lower(event.transaction.hash),
    committedBlock: BigInt(event.block.number),
    committedLogIndex: BigInt(event.logIndex),
  });
});

indexer.onEvent({ contract: "EvidenceRegistry", event: "EvidenceRevealed" }, async ({ event, context }) => {
  const record = await context.EvidenceSubmission.get(evidenceId(event.srcAddress, event.params.submissionId));
  markProgress(context, event);
  assertSafeUint(event.params.committedAt, "committedAt");
  assertSafeUint(event.params.revealedAt, "revealedAt");
  if (!record || record.status !== "committed") return; // Unknown or already disclosed: ignore (never crash).
  context.EvidenceSubmission.set({ ...record, status: "revealed", contentSha256: lower(event.params.contentSha256), revealedAt: event.params.revealedAt });
});

indexer.onEvent({ contract: "EvidenceRegistry", event: "EvidencePublished" }, async ({ event, context }) => {
  const id = evidenceId(event.srcAddress, event.params.submissionId);
  const existing = await context.EvidenceSubmission.get(id);
  markProgress(context, event);
  assertSafeUint(event.params.publishedAt, "publishedAt");
  if (existing) return;
  context.EvidenceSubmission.set({
    id,
    registry: lower(event.srcAddress),
    submissionId: event.params.submissionId,
    market: lower(event.params.market),
    submitter: lower(event.params.submitter),
    status: "published",
    commitment: undefined,
    contentSha256: lower(event.params.contentSha256),
    committedAt: event.params.publishedAt,
    revealedAt: event.params.publishedAt,
    committedTxHash: lower(event.transaction.hash),
    committedBlock: BigInt(event.block.number),
    committedLogIndex: BigInt(event.logIndex),
  });
});
