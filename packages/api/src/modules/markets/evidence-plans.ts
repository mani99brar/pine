// Evidence plans (PRD-04 section 2.2, SEC-EVID, SEC-TX): commit and publish plans, and the salt-free reveal template.
// Pine never receives a salt: every body schema is strict, so a request carrying `salt` is refused before any handler
// code runs; the reveal is built and verified by the client with its own @pine/shared.

import { z } from "zod";
import { EVIDENCE_COMMITMENT_TYPE, parseEvidenceManifestBytes } from "@pine/shared/evidence";
import { buildStep, newPlan, verifyPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import { ApiError } from "../../contracts/errors.js";
import {
  addressParam,
  assertReadModelReady,
  CONTENT_TRUST,
  hex32Param,
  isoSeconds,
  MARKETS_PLAN_LIMITS,
  nowSeconds,
  planContextOf,
  requireClaim,
  sessionOf,
  SUBMISSION_MARGIN_SECONDS,
  ZERO_HASH,
  type MarketsRouteDeps,
} from "./common.js";
import { createOrReplayPlan } from "./plans.js";

export const REVEAL_FUNCTION = "revealEvidence(uint256,bytes32,bytes32)";

export const UNAVAILABLE_MANIFEST_WARNING =
  "The manifest is not stored by Pine, so adjudicators may be unable to obtain it. Policy C4: an unobtainable manifest is inadmissible. " +
  "Upload the manifest (POST /api/v1/evidence/manifests) or pin it elsewhere before revealing.";

const nonzero = (value: Hex32) => value !== ZERO_HASH;

const commitBody = z.object({ market: addressParam, commitment: hex32Param.refine(nonzero, "must be nonzero") }).strict();
const publishBody = z.object({ market: addressParam, contentSha256: hex32Param.refine(nonzero, "must be nonzero") }).strict();
const revealTemplateBody = z
  .object({
    submissionId: z.string().regex(/^[1-9][0-9]{0,76}$/, "must be a positive base-10 integer"),
    contentSha256: hex32Param.refine(nonzero, "must be nonzero"),
    unavailableContentAcknowledged: z.boolean().optional(),
  })
  .strict();

function assertBefore(now: number, deadline: number, what: string): void {
  if (now >= deadline - SUBMISSION_MARGIN_SECONDS) {
    throw new ApiError("UNPROCESSABLE", `The ${what} window has closed (Pine stops offering plans ${SUBMISSION_MARGIN_SECONDS} s before the deadline)`);
  }
}

export function registerEvidencePlanRoutes({ app, ctx, state }: MarketsRouteDeps): void {
  const manifest = state.manifest;
  const guard = { preHandler: app.requireSession };

  app.post("/api/v1/evidence/plans/commit", { ...guard, schema: { body: commitBody } }, async (request, reply) => {
    const { market, commitment } = request.body;
    const result = await createOrReplayPlan(ctx, request, {
      route: "evidence.commit",
      action: "submit_evidence",
      body: { market, commitment },
      async build(planId, session) {
        const claim = await requireClaim(ctx, state, market);
        assertBefore(nowSeconds(ctx), claim.evidenceDeadline, "evidence");
        const account = session.wallet.toLowerCase() as Address;
        const step = buildStep(manifest, { id: "commit", allowlistId: "evidenceRegistry.commitEvidence", args: [claim.market, commitment] });
        const plan = newPlan(manifest, planId, account, [step]);
        verifyPlan(plan, manifest, planContextOf(claim, []), MARKETS_PLAN_LIMITS);
        return {
          kind: "evidence_commit",
          market: claim.market,
          plan,
          expiresAt: claim.evidenceDeadline - SUBMISSION_MARGIN_SECONDS,
          details: {
            evidenceDeadline: claim.evidenceDeadline,
            operator: "block.timestamp < evidenceDeadline",
            commitmentFormula: `keccak256(abi.encode(keccak256("${EVIDENCE_COMMITMENT_TYPE}"), chainId, registry, market, submitter, contentSha256, salt))`,
            note: "Keep the salt secret and safe: it is needed to reveal and Pine never receives or stores it.",
          },
          facts: { commitment },
        };
      },
    });
    return reply.status(result.statusCode).send(result.body);
  });

  app.post("/api/v1/evidence/plans/publish", { ...guard, schema: { body: publishBody } }, async (request, reply) => {
    const { market, contentSha256 } = request.body;
    const result = await createOrReplayPlan(ctx, request, {
      route: "evidence.publish",
      action: "submit_evidence",
      body: { market, contentSha256 },
      async build(planId, session) {
        const claim = await requireClaim(ctx, state, market);
        assertBefore(nowSeconds(ctx), claim.evidenceDeadline, "evidence");
        const account = session.wallet.toLowerCase() as Address;
        const stored = await ctx.contentStore.get(contentSha256);
        if (!stored) throw new ApiError("UNPROCESSABLE", "The manifest is not stored; upload it first (POST /api/v1/evidence/manifests)");
        let parsed;
        try {
          parsed = parseEvidenceManifestBytes(stored.bytes, contentSha256);
        } catch {
          throw new ApiError("UNPROCESSABLE", "The stored content is not a canonical evidence manifest");
        }
        if (parsed.submitter !== account || parsed.claim.market !== claim.market || parsed.claim.chainId !== ctx.config.chainId) {
          throw new ApiError("UNPROCESSABLE", "The manifest names another submitter or claim");
        }
        const step = buildStep(manifest, { id: "publish", allowlistId: "evidenceRegistry.publishEvidence", args: [claim.market, contentSha256] });
        const plan = newPlan(manifest, planId, account, [step]);
        verifyPlan(plan, manifest, planContextOf(claim, []), MARKETS_PLAN_LIMITS);
        return {
          kind: "evidence_publish",
          market: claim.market,
          plan,
          expiresAt: claim.evidenceDeadline - SUBMISSION_MARGIN_SECONDS,
          details: { evidenceDeadline: claim.evidenceDeadline, operator: "block.timestamp < evidenceDeadline", contentSha256 },
          facts: { contentSha256 },
        };
      },
    });
    return reply.status(result.statusCode).send(result.body);
  });

  // No plan, no persistence and no salt: a template the client completes and verifies itself.
  app.post("/api/v1/evidence/reveal-template", { ...guard, schema: { body: revealTemplateBody } }, async (request) => {
    const session = sessionOf(request);
    const { contentSha256, unavailableContentAcknowledged } = request.body;
    const submissionId = BigInt(request.body.submissionId);
    await ctx.compliance.assertAllowed(request, session, "submit_evidence");
    await assertReadModelReady(ctx);
    const registry = manifest.pine.evidenceRegistry;
    const record = await ctx.readModel.getEvidence(registry, submissionId);
    if (!record || record.submitter !== session.wallet.toLowerCase()) throw new ApiError("NOT_FOUND", "No indexed submission of yours with this id");
    if (record.status !== "committed" || record.commitment === null) throw new ApiError("CONFLICT", "This submission is already disclosed");
    const claim = await requireClaim(ctx, state, record.market);
    const now = nowSeconds(ctx);
    assertBefore(now, claim.revealDeadline, "reveal");
    const warnings: { code: string; text: string }[] = [];
    const stored = await ctx.contentStore.get(contentSha256);
    if (!stored) {
      if (unavailableContentAcknowledged !== true) {
        throw new ApiError("UNPROCESSABLE", "The manifest is not stored by Pine; store it first or set unavailableContentAcknowledged: true", {
          issues: [{ path: ["unavailableContentAcknowledged"], message: UNAVAILABLE_MANIFEST_WARNING }],
        });
      }
      warnings.push({ code: "manifest_unavailable", text: UNAVAILABLE_MANIFEST_WARNING });
    } else {
      try {
        const parsed = parseEvidenceManifestBytes(stored.bytes, contentSha256);
        if (parsed.submitter !== record.submitter || parsed.claim.market !== record.market) {
          warnings.push({ code: "manifest_mismatch", text: "The stored manifest names another submitter or claim; adjudicators may treat it as inadmissible." });
        }
      } catch {
        warnings.push({ code: "not_a_manifest", text: "The stored content is not a canonical evidence manifest; adjudicators may treat it as inadmissible." });
      }
    }
    const expiresAt = claim.revealDeadline - SUBMISSION_MARGIN_SECONDS;
    return {
      template: {
        chainId: ctx.config.chainId,
        registry,
        function: REVEAL_FUNCTION,
        submissionId: submissionId.toString(),
        contentSha256,
        commitment: record.commitment,
        market: record.market,
        account: record.submitter,
        revealDeadline: claim.revealDeadline,
        revealDeadlineIso: isoSeconds(claim.revealDeadline),
        operator: "block.timestamp < revealDeadline",
        expiresAt,
        expiresAtIso: isoSeconds(expiresAt),
      },
      warnings,
      instructions: [
        "Compute computeEvidenceCommitment({ chainId, registry, market, submitter: account, contentSha256, salt }) locally with your own salt.",
        "Continue only if the result equals `commitment`; otherwise the reveal reverts (CommitmentMismatch).",
        "Build the step with your own @pine/shared/tx-plan: buildStep(manifest, { allowlistId: \"evidenceRegistry.revealEvidence\", args: [submissionId, contentSha256, salt] }), then newPlan and verifyPlan before sending.",
        "Never send the salt to Pine or any other server.",
      ],
      contentTrust: CONTENT_TRUST,
    };
  });
}
