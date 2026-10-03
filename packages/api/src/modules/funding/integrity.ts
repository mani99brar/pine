// Inline claim integrity gate of the ladder plan (PRD-04 3.2 step 1; decisions: the claims lane's index is outside
// this feature). The claim document is retrieved by digest, parsed with the frozen canonical parser and compared field
// by field with the read-model ClaimRecord and the deployment manifest (PRD-03 section 7). Any failure is
// INTEGRITY_FAILED (409) naming the failed fields; never a plan.

import { CLAIM_DOCUMENT_MAX_BYTES, parseClaimDocumentBytes, type ClaimDocument } from "@pine/shared/claim-document";
import type { DeploymentManifest } from "@pine/shared/deployment";
import { renderQuestion } from "@pine/shared/question";
import type { ClaimRecord } from "@pine/shared/read-model";
import type { AppContext } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";

/** Bytes fetched for the document: one raw IPFS block. */
export const CLAIM_DOCUMENT_FETCH_MAX = 262_144;

const same = (a: string | number, b: string | number): boolean => String(a).toLowerCase() === String(b).toLowerCase();

/** Field names (dotted document paths) whose values disagree with the claim record or the manifest. */
export function claimDocumentMismatches(document: ClaimDocument, claim: ClaimRecord, manifest: DeploymentManifest): string[] {
  const checks: [string, boolean][] = [
    ["creator", same(document.creator, claim.creator)],
    ["target.repository.id", document.target.repository.id === claim.repositoryId],
    ["target.commit", same(document.target.commit, claim.commit)],
    ["policy.sha256", same(document.policy.sha256, claim.policyDocumentSha256)],
    ["evidence.evidenceDeadline", document.evidence.evidenceDeadline === claim.evidenceDeadline],
    ["evidence.revealDeadline", document.evidence.revealDeadline === claim.revealDeadline],
    ["market.openingTime", document.market.openingTime === claim.revealDeadline],
    ["market.minBondWei", document.market.minBondWei === claim.minBond.toString()],
    ["evidence.registry", same(document.evidence.registry, manifest.pine.evidenceRegistry)],
    ["market.claimRegistry", same(document.market.claimRegistry, manifest.pine.claimRegistry) && same(claim.registry, manifest.pine.claimRegistry)],
    ["claim.title", document.claim.title === claim.title],
    ["market.seerMarketFactory", same(document.market.seerMarketFactory, manifest.seer.marketFactory)],
    ["market.collateralToken", same(document.market.collateralToken, manifest.seer.collateralToken)],
    ["market.realitio", same(document.market.realitio, manifest.seer.realitio)],
    ["market.arbitrator", same(document.market.arbitrator, manifest.seer.arbitrator)],
    ["market.questionTimeoutSeconds", document.market.questionTimeoutSeconds === manifest.seer.questionTimeoutSeconds],
    ["market.chainId", document.market.chainId === manifest.chainId],
    ["evidence.chainId", document.evidence.chainId === manifest.chainId],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  let question: string | null;
  try {
    question = renderQuestion({
      evidenceRegistry: manifest.pine.evidenceRegistry,
      title: claim.title,
      evidenceDeadline: claim.evidenceDeadline,
      revealDeadline: claim.revealDeadline,
      repositoryId: claim.repositoryId,
      commit: claim.commit,
      claimDocumentSha256: claim.claimDocumentSha256,
      policyDocumentSha256: claim.policyDocumentSha256,
    });
  } catch {
    question = null;
  }
  if (question === null || question !== claim.marketName) failed.push("marketName");
  return failed;
}

export async function assertClaimIntegrity(ctx: AppContext, claim: ClaimRecord, manifest: DeploymentManifest): Promise<void> {
  let bytes: Uint8Array | null;
  try {
    bytes = await ctx.contentStore.retrieve(claim.claimDocumentSha256, Math.min(CLAIM_DOCUMENT_FETCH_MAX, CLAIM_DOCUMENT_MAX_BYTES));
  } catch {
    throw new ApiError("UPSTREAM_UNAVAILABLE", "The claim document could not be retrieved; try again shortly");
  }
  if (bytes === null) {
    throw new ApiError("INTEGRITY_FAILED", "The claim document is not available, so the claim cannot be verified", { issues: [{ path: ["claimDocument"], message: "document_unavailable" }] });
  }
  let document: ClaimDocument;
  try {
    document = parseClaimDocumentBytes(bytes, claim.claimDocumentSha256);
  } catch {
    throw new ApiError("INTEGRITY_FAILED", "The claim document is not a valid canonical claim document for this digest", { issues: [{ path: ["claimDocument"], message: "invalid" }] });
  }
  const failed = claimDocumentMismatches(document, claim, manifest);
  if (failed.length > 0) {
    throw new ApiError("INTEGRITY_FAILED", `The claim does not match its document: ${failed.join(", ")}`, {
      issues: failed.map((field) => ({ path: field.split("."), message: "mismatch" })),
    });
  }
}
