// zod schemas for every GraphQL response (CLAUDE.md: validate external input at the boundary). Hasura semantics:
// Envio BigInt columns are Postgres numeric, which Hasura serializes as decimal strings (stringified numerics); a plain
// JSON number is accepted only when it is a safe integer, so no value can arrive with silently lost precision.
// Addresses and hashes must already be lowercase: the handlers store them so, and anything else is a foreign row.

import { z } from "zod";
import type {
  ArbitrationRecord,
  ClaimRecord,
  ConditionResolutionRecord,
  EvidenceRecord,
  OracleAnswerRecord,
  OracleQuestionRecord,
} from "@pine/shared/read-model";
import type { KlerosHomeStage } from "@pine/shared/chain-events";
import type { Address, Hex32 } from "@pine/shared/types";
import { ENVIO_META, ENVIO_PROGRESS } from "./envio-meta.js";

const address = z.string().regex(/^0x[0-9a-f]{40}$/).transform((value) => value as Address);
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/).transform((value) => value as Hex32);

/** A numeric column: decimal string (or a safe-integer JSON number) -> bigint. */
export const numeric = z.union([z.string().regex(/^-?(0|[1-9][0-9]*)$/).max(80), z.number().refine(Number.isSafeInteger)]).transform((value) => BigInt(value));
/** A numeric column the record exposes as a JS number (unix seconds, log index, repositoryId): must be a safe integer. */
export const safeNumber = numeric.refine((value) => value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)).transform(Number);
const nonNegative = numeric.refine((value) => value >= 0n);
const nonNegativeNumber = safeNumber.refine((value) => value >= 0);

const STAGES = ["RequestNotified", "RequestRejected", "RequestAcknowledged", "RequestCanceled", "ArbitrationFailed", "ArbitratorAnswered", "ArbitrationFinished"] as const satisfies readonly KlerosHomeStage[];

export const claimRow = z
  .object({
    id: address,
    registry: address,
    creator: address,
    claimDocumentSha256: hex32,
    policyDocumentSha256: hex32,
    repositoryId: nonNegativeNumber,
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    questionId: hex32,
    conditionId: hex32,
    evidenceDeadline: nonNegativeNumber,
    revealDeadline: nonNegativeNumber,
    minBond: nonNegative,
    title: z.string(),
    marketName: z.string(),
    marketNameHash: hex32,
    yesToken: address,
    noToken: address,
    invalidToken: address,
    createdAt: nonNegativeNumber,
    createdBlock: nonNegative,
    createdTxHash: hex32,
    createdLogIndex: nonNegativeNumber,
  })
  .transform(({ id, ...rest }): ClaimRecord => ({ market: id, ...rest }));

export const evidenceRow = z
  .object({
    id: z.string(),
    registry: address,
    submissionId: nonNegative,
    market: address,
    submitter: address,
    status: z.enum(["committed", "revealed", "published"]),
    commitment: hex32.nullable(),
    contentSha256: hex32.nullable(),
    committedAt: nonNegativeNumber,
    revealedAt: nonNegativeNumber.nullable(),
    committedTxHash: hex32,
    committedBlock: nonNegative,
    committedLogIndex: nonNegativeNumber,
  })
  .refine((row) => row.id === `${row.registry}:${row.submissionId.toString()}`, "id does not match registry:submissionId")
  .transform(({ id: _id, ...rest }): EvidenceRecord => rest);

export const questionRow = z
  .object({
    id: hex32,
    markets: z.array(address),
    openingTs: nonNegativeNumber,
    minBond: nonNegative,
    timeout: nonNegativeNumber,
    bestAnswer: hex32.nullable(),
    bond: nonNegative,
    finalizeTs: nonNegativeNumber,
    pendingArbitration: z.boolean(),
    arbitrationRequestedBy: address.nullable(),
    answeredByArbitrator: z.boolean(),
    bounty: nonNegative,
    reopenedBy: hex32.nullable(),
    reopens: hex32.nullable(),
    answerCount: nonNegativeNumber,
    lastEventBlock: nonNegative,
  })
  .transform(({ id, ...rest }): OracleQuestionRecord => ({ questionId: id, ...rest }));

export const answerRow = z
  .object({
    questionId: hex32,
    answer: hex32,
    historyHash: hex32,
    answerer: address,
    bond: nonNegative,
    ts: nonNegativeNumber,
    isCommitment: z.boolean(),
    revealedAnswer: hex32.nullable(),
    txHash: hex32,
    blockNumber: nonNegative,
    logIndex: nonNegativeNumber,
  })
  .transform((row): OracleAnswerRecord => row);

const arbitrationRow = z.object({
  id: hex32,
  stage: z.enum(STAGES),
  requester: address.nullable(),
  rejectionReason: z.string().nullable(),
  arbitratorAnswer: hex32.nullable(),
  updatedAt: nonNegativeNumber,
});

const stageRow = z.object({ stage: z.enum(STAGES), at: nonNegativeNumber, txHash: hex32, blockNumber: nonNegative, logIndex: nonNegativeNumber });

export const resolutionRow = z
  .object({
    id: hex32,
    ctfQuestionId: hex32,
    payoutNumerators: z.array(z.string().regex(/^(0|[1-9][0-9]*)$/).max(80)).transform((values) => values.map((value) => BigInt(value))),
    resolvedAt: nonNegativeNumber,
    txHash: hex32,
    blockNumber: nonNegative,
  })
  .transform(({ id, ...rest }): ConditionResolutionRecord => ({ conditionId: id, ...rest }));

// ------------------------------------------------------------------------------------------------- query results

export const getClaimData = z.object({ Claim_by_pk: claimRow.nullable() });
export const listClaimsData = z.object({ Claim: z.array(claimRow) });
export const getEvidenceData = z.object({ EvidenceSubmission_by_pk: evidenceRow.nullable() });
export const listEvidenceData = z.object({ EvidenceSubmission: z.array(evidenceRow) });
export const getOracleQuestionData = z.object({ OracleQuestion_by_pk: questionRow.nullable() });
export const listOracleAnswersData = z.object({ OracleAnswer: z.array(answerRow) });
export const getConditionResolutionData = z.object({ ConditionResolution_by_pk: resolutionRow.nullable() });

export const getArbitrationData = z.object({ Arbitration_by_pk: arbitrationRow.nullable(), ArbitrationStage: z.array(stageRow) });

export function arbitrationRecord({ Arbitration_by_pk: row, ArbitrationStage: stages }: z.output<typeof getArbitrationData>): ArbitrationRecord | null {
  return row === null
    ? null
    : {
        questionId: row.id,
        stage: row.stage,
        requester: row.requester,
        rejectionReason: row.rejectionReason,
        arbitratorAnswer: row.arbitratorAnswer,
        updatedAt: row.updatedAt,
        history: stages.map((stage) => ({ stage: stage.stage, at: stage.at, txHash: stage.txHash })),
      };
}

export const statusData = z.object({
  [ENVIO_META.root]: z.array(
    z.object({
      [ENVIO_META.chainId]: z.number().int(),
      [ENVIO_META.progressBlock]: nonNegative,
      [ENVIO_META.sourceBlock]: nonNegative.nullable(),
    }),
  ),
  [`${ENVIO_PROGRESS.entity}_by_pk` as const]: z
    .object({ [ENVIO_PROGRESS.blockNumber]: nonNegative, [ENVIO_PROGRESS.blockTimestamp]: nonNegativeNumber })
    .nullable(),
});

/** The GraphQL envelope: data or errors (contents of errors are never surfaced, only their count). */
export const envelope = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() });
