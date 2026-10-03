// Preview (PRD-03 §5): freezes an immutable claim document, its digest/CID and the on-chain question. Publication must
// use exactly these bytes (SEC-CLAIM-04); nothing is recomputed later.

import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { rawCidFromBytes } from "@pine/shared/canonical";
import { CLAIM_DOCUMENT_SCHEMA_ID, ClaimDocumentError, encodeClaimDocument, type ClaimDocument } from "@pine/shared/claim-document";
import type { DeploymentManifest } from "@pine/shared/deployment";
import { EVIDENCE_MANIFEST_SCHEMA_ID } from "@pine/shared/evidence";
import { renderQuestion, tokenNames } from "@pine/shared/question";
import type { Address, Hex32 } from "@pine/shared/types";
import type { CommitMembershipRef } from "../../contracts/app.js";
import { ApiError } from "../../contracts/errors.js";
import {
  auditIp,
  CREATE_CLAIM_GAS_ESTIMATE,
  evidenceWindowBounds,
  isoSeconds,
  MAX_UINT32,
  MIN_BOND_LOWER,
  MIN_BOND_UPPER,
  nowSeconds,
  planExpiry,
  roundUpToMinute,
  sessionOf,
} from "./common.js";
import { one, sql, ts } from "./db.js";
import { currentInput, findDraft, validateDraftPolicy } from "./drafts.js";
import { githubCall } from "./github.js";
import type { ClaimsRouteDeps } from "./state.js";

/** Fixed texts of policy C7 plus the min-bond and liveness notes of ADR D7. Platform-authored. */
export const PUBLICATION_DISCLOSURES: readonly { code: string; text: string }[] = [
  { code: "no_is_not_certification", text: "\"No\" means that no qualifying counterexample was submitted in time. It is not a certification that the software is correct, safe or complete." },
  { code: "price_is_not_probability", text: "A market price reflects the defined submission-and-resolution event, not the probability that the software has no defects." },
  { code: "liquidity_is_not_bounty", text: "Liquidity is not a bounty: it is not reserved for researchers, can be traded against by anyone, and may be withdrawable by whoever provided it." },
  { code: "invalid_is_not_refund", text: "Invalid is not a refund. In Seer categorical markets an invalid result pays only the Invalid outcome token." },
  { code: "deadlines_are_not_trading_cutoffs", text: "Evidence deadlines are not trading cutoffs; outcome tokens may remain transferable and tradable after them." },
  { code: "min_bond", text: "The minimum bond is the smallest bond Reality.eth accepts for the first answer; anyone can answer by posting it, and each later answer must at least double the previous bond." },
  { code: "liveness", text: "Pine runs no keeper and holds no keys: it never answers, bonds or funds arbitration. Resolution depends on interested parties answering, disputing and finalizing the question." },
];

export const ARBITRATION_NOTE =
  "A Kleros dispute (arbitration requested on Reality.eth) adds about 16-20 days; the arbitration fee is paid on Ethereum (0.1674 ETH at research time, subject to change).";

const previewBody = z.object({ attestLiveSystemImpactNone: z.boolean() }).strict();

export interface PreviewResult {
  previewId: string;
  documentSha256: Hex32;
  cid: string;
  document: ClaimDocument;
  question: string;
  tokenNames: readonly [string, string];
  planExpiresAt: number;
  timeline: Record<string, unknown>;
  costs: Record<string, unknown>;
  disclosures: readonly { code: string; text: string }[];
}

export function timelineOf(evidenceDeadline: number, revealDeadline: number, manifest: DeploymentManifest) {
  const earliestFinalization = revealDeadline + manifest.seer.questionTimeoutSeconds;
  return {
    evidenceDeadline: { unix: evidenceDeadline, iso: isoSeconds(evidenceDeadline), operator: "commit/publish evidence while block.timestamp < evidenceDeadline" },
    revealDeadline: { unix: revealDeadline, iso: isoSeconds(revealDeadline), operator: "reveal evidence while block.timestamp < revealDeadline" },
    answersOpen: { unix: revealDeadline, iso: isoSeconds(revealDeadline), operator: "answers accepted once block.timestamp >= revealDeadline" },
    earliestFinalization: {
      unix: earliestFinalization,
      iso: isoSeconds(earliestFinalization),
      note: `Opening time plus the ${manifest.seer.questionTimeoutSeconds}-second answer timeout; every new answer restarts the timeout.`,
    },
    arbitration: ARBITRATION_NOTE,
  };
}

export function registerPreviewRoutes({ app, ctx, state }: ClaimsRouteDeps): void {
  app.post(
    "/api/v1/drafts/:id/preview",
    { preHandler: app.requireSession, schema: { params: z.object({ id: z.uuid() }).strict(), body: previewBody } },
    async (request, reply) => {
      const session = sessionOf(request);
      if (request.body.attestLiveSystemImpactNone !== true) {
        throw new ApiError("UNPROCESSABLE", "Attest that no counterexample would demonstrate an exploitable flaw in a deployed system holding third-party funds or data", {
          issues: [{ path: ["attestLiveSystemImpactNone"], message: "must be true" }],
        });
      }
      const draft = await findDraft(ctx.db, session.userId, request.params.id);
      if (!draft) throw new ApiError("NOT_FOUND", "Draft not found");
      const input = currentInput(draft);
      const policy = validateDraftPolicy(state, ctx, input);
      const { manifest } = state;
      const userId = session.userId;

      // GitHub: public repository, numeric identity, proven membership of the target (and base) commit.
      const repo = await githubCall(ctx, userId, () => ctx.github.getRepo(userId, input.repository.owner, input.repository.name));
      // The gateway refuses non-public repositories (REPO_NOT_PUBLIC); this module never relies on that alone.
      if ((repo as { private?: unknown }).private !== false) throw new ApiError("UNPROCESSABLE", "Only public repositories are supported");
      const ref: CommitMembershipRef = input.membership.kind === "pull" ? { kind: "pull", number: input.membership.number } : { kind: "branch", name: input.membership.name };
      const membership = await githubCall(ctx, userId, () => ctx.github.verifyCommitMembership(userId, repo.owner, repo.name, input.commit, ref));
      if (membership.repoId !== repo.id) throw new ApiError("UNPROCESSABLE", "The commit membership was proven for a different repository");
      if (input.baseCommit !== null) {
        const baseCommit = input.baseCommit;
        // A pull request's base commit is never one of its commits: prove it is in the base branch history instead.
        let baseRef: CommitMembershipRef = ref;
        if (ref.kind === "pull") {
          const pull = await githubCall(ctx, userId, () => ctx.github.getPull(userId, repo.owner, repo.name, ref.number));
          baseRef = { kind: "branch", name: pull.baseRef };
        }
        const base = await githubCall(ctx, userId, () => ctx.github.verifyCommitMembership(userId, repo.owner, repo.name, baseCommit, baseRef));
        if (base.repoId !== repo.id) throw new ApiError("UNPROCESSABLE", "The base commit membership was proven for a different repository");
      }

      // Deadlines (ADR D6): round up to the minute, then the window must lie within the API bounds.
      const nowDate = ctx.clock.now();
      const now = nowSeconds(ctx);
      const window = input.evidenceWindowSeconds ?? ctx.config.claims.defaultEvidenceWindowSeconds;
      const evidenceDeadline = roundUpToMinute(now + window);
      const bounds = evidenceWindowBounds(ctx.config);
      const effective = evidenceDeadline - now;
      if (effective < bounds.min || effective > bounds.max) {
        throw new ApiError("UNPROCESSABLE", `The evidence window must be between ${bounds.min} and ${bounds.max - 60} seconds (the deadline is rounded up to the minute)`, {
          issues: [{ path: ["evidenceWindowSeconds"], message: `rounded window ${effective} s is outside ${bounds.min}..${bounds.max} s` }],
        });
      }
      const revealDeadline = evidenceDeadline + ctx.config.claims.revealWindowSeconds;
      if (revealDeadline > MAX_UINT32) throw new ApiError("UNPROCESSABLE", "Deadlines exceed the supported range");
      const minBond = input.minBondWei === null ? ctx.config.claims.defaultMinBondWei : BigInt(input.minBondWei);
      if (minBond < MIN_BOND_LOWER || minBond > MIN_BOND_UPPER) throw new ApiError("UNPROCESSABLE", "The minimum bond must be between 1 and 100 xDAI");
      const expiresAt = planExpiry(evidenceDeadline, now);
      if (expiresAt <= now) throw new ApiError("UNPROCESSABLE", "The evidence window is too short to publish");

      const document: ClaimDocument = {
        schema: CLAIM_DOCUMENT_SCHEMA_ID,
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex32,
        policy: { id: policy.id, version: policy.version, sha256: policy.sha256 },
        target: {
          host: "github.com",
          repository: { id: repo.id, ownerLogin: repo.owner, name: repo.name },
          commit: input.commit,
          baseCommit: input.baseCommit,
          membership: { method: membership.method, ref, verifiedAt: isoSeconds(Math.floor(membership.verifiedAt.getTime() / 1000)) },
        },
        claim: {
          title: input.title,
          requirement: input.requirement,
          violation: input.violation,
          scope: input.scope,
          allowedInputs: input.allowedInputs,
          assumptions: input.assumptions,
          faultModel: input.faultModel,
          regressionOnly: input.regressionOnly,
          exclusions: input.exclusions,
          policyParameters: input.policyParameters as ClaimDocument["claim"]["policyParameters"],
        },
        environment: input.environment,
        evidence: { chainId: manifest.chainId, registry: manifest.pine.evidenceRegistry, evidenceDeadline, revealDeadline, manifestSchema: EVIDENCE_MANIFEST_SCHEMA_ID },
        market: {
          chainId: manifest.chainId,
          claimRegistry: manifest.pine.claimRegistry,
          seerMarketFactory: manifest.seer.marketFactory,
          collateralToken: manifest.seer.collateralToken,
          realitio: manifest.seer.realitio,
          arbitrator: manifest.seer.arbitrator,
          questionTimeoutSeconds: manifest.seer.questionTimeoutSeconds,
          openingTime: revealDeadline,
          minBondWei: minBond.toString(10),
        },
        disclosure: { liveSystemImpact: "none" },
        creator: session.wallet.toLowerCase() as Address,
        createdAt: isoSeconds(now),
      };

      let encoded: { bytes: Uint8Array; sha256: Hex32 };
      let question: string;
      try {
        encoded = encodeClaimDocument(document);
        question = renderQuestion({
          evidenceRegistry: manifest.pine.evidenceRegistry,
          title: document.claim.title,
          evidenceDeadline,
          revealDeadline,
          repositoryId: repo.id,
          commit: document.target.commit,
          claimDocumentSha256: encoded.sha256,
          policyDocumentSha256: policy.sha256,
        });
      } catch (error) {
        if (error instanceof ClaimDocumentError || (error instanceof Error && error.name === "QuestionInputError")) {
          throw new ApiError("UNPROCESSABLE", "The claim cannot be composed from this draft", { issues: [{ path: [], message: error.message }] });
        }
        throw error;
      }
      const cid = rawCidFromBytes(encoded.bytes);
      const names = tokenNames(encoded.sha256);

      // Advisory only (not part of the document): a failing RPC leaves the estimate empty.
      const gasPriceWei = await ctx.chain.publicClient.getGasPrice().catch(() => null);

      const previewId = randomUUID();
      const inserted = await one<{ id: string }>(
        ctx.db,
        sql`INSERT INTO claim_previews (id, user_id, draft_id, draft_revision, document, document_sha256, document_cid, creator, question,
              policy_id, policy_version, evidence_deadline, reveal_deadline, plan_expires_at, created_at)
            SELECT ${previewId}::uuid, ${userId}::uuid, d.id, d.revision, ${Buffer.from(encoded.bytes)}, ${encoded.sha256}, ${cid}, ${document.creator}, ${question},
              ${policy.id}, ${policy.version}, ${String(evidenceDeadline)}::bigint, ${String(revealDeadline)}::bigint, ${String(expiresAt)}::bigint, ${ts(nowDate)}
            FROM claim_drafts d WHERE d.id = ${draft.id}::uuid AND d.user_id = ${userId}::uuid AND d.revision = ${draft.revision}
            RETURNING id::text AS id`,
      );
      // The draft changed (or vanished) while the preview was being composed: never freeze a document for stale inputs.
      if (!inserted) throw new ApiError("CONFLICT", "The draft changed while the preview was being prepared; try again");
      await ctx.audit.record({
        actorUserId: userId,
        action: "claim.preview.created",
        subjectType: "claim_preview",
        subjectId: previewId,
        details: { draftId: draft.id, draftRevision: draft.revision, documentSha256: encoded.sha256 },
        ip: auditIp(request),
      });

      const result: PreviewResult = {
        previewId,
        documentSha256: encoded.sha256,
        cid,
        document,
        question,
        tokenNames: names,
        planExpiresAt: expiresAt,
        timeline: timelineOf(evidenceDeadline, revealDeadline, manifest),
        costs: {
          estimatedGas: CREATE_CLAIM_GAS_ESTIMATE.toString(),
          gasPriceWei: gasPriceWei === null ? null : gasPriceWei.toString(),
          estimatedCostWei: gasPriceWei === null ? null : (gasPriceWei * CREATE_CLAIM_GAS_ESTIMATE).toString(),
          note: "Static estimate for creating the claim and its market. Funding the market is a separate transaction plan and is not included.",
        },
        disclosures: PUBLICATION_DISCLOSURES,
      };
      return reply.status(201).send({ ...result, draftRevision: draft.revision, planExpiresAtIso: isoSeconds(expiresAt) });
    },
  );
}
