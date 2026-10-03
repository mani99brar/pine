// GraphQL documents and variables for Envio's Hasura API. Every value travels as a variable (never spliced into the
// document); numerics are sent as decimal strings (Hasura parses numeric scalars from strings). Entity and field names
// are those of packages/indexer-envio/schema.graphql (test/queries.test.ts pins them against that file).

import { ENVIO_META, ENVIO_PROGRESS } from "./envio-meta.js";

export const CLAIM_FIELDS = [
  "id",
  "registry",
  "creator",
  "claimDocumentSha256",
  "policyDocumentSha256",
  "repositoryId",
  "commit",
  "questionId",
  "conditionId",
  "evidenceDeadline",
  "revealDeadline",
  "minBond",
  "title",
  "marketName",
  "marketNameHash",
  "yesToken",
  "noToken",
  "invalidToken",
  "createdAt",
  "createdBlock",
  "createdTxHash",
  "createdLogIndex",
] as const;

export const EVIDENCE_FIELDS = [
  "id",
  "registry",
  "submissionId",
  "market",
  "submitter",
  "status",
  "commitment",
  "contentSha256",
  "committedAt",
  "revealedAt",
  "committedTxHash",
  "committedBlock",
  "committedLogIndex",
] as const;

export const QUESTION_FIELDS = [
  "id",
  "markets",
  "openingTs",
  "minBond",
  "timeout",
  "bestAnswer",
  "bond",
  "finalizeTs",
  "pendingArbitration",
  "arbitrationRequestedBy",
  "answeredByArbitrator",
  "bounty",
  "reopenedBy",
  "reopens",
  "answerCount",
  "lastEventBlock",
] as const;

export const ANSWER_FIELDS = ["questionId", "answer", "historyHash", "answerer", "bond", "ts", "isCommitment", "revealedAnswer", "txHash", "blockNumber", "logIndex"] as const;

export const ARBITRATION_FIELDS = ["id", "stage", "requester", "rejectionReason", "arbitratorAnswer", "updatedAt"] as const;

export const STAGE_FIELDS = ["stage", "at", "txHash", "blockNumber", "logIndex"] as const;

export const RESOLUTION_FIELDS = ["id", "ctfQuestionId", "payoutNumerators", "resolvedAt", "txHash", "blockNumber"] as const;

const select = (fields: readonly string[]): string => fields.join(" ");

/**
 * Lists the ReadModel returns whole (claims of a question, answers, arbitration history) are capped at this many rows
 * (PRD-05 section 3a). Their queries ask for one extra row so the read model can throw instead of returning a silently
 * truncated list. Documented divergence: the native backend has no cap.
 */
export const UNPAGINATED_MAX_ROWS = 10_000;
const UNPAGINATED_LIMIT = UNPAGINATED_MAX_ROWS + 1;

export interface GraphqlRequest {
  /** Operation name: also the only request detail an error message may carry. */
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}

const request = (operationName: string, query: string, variables: Record<string, unknown>): GraphqlRequest => ({ operationName, query, variables });

// --------------------------------------------------------------------------------------------- Hasura expressions

export type Comparison = { _eq?: string; _gt?: string; _lt?: string; _lte?: string; _gte?: string };
export type BoolExp = { _and?: BoolExp[]; _or?: BoolExp[] } & { [field: string]: Comparison | BoolExp[] | undefined };
export type OrderBy = Record<string, "asc" | "desc">[];

const and = (parts: BoolExp[]): BoolExp => (parts.length === 1 ? parts[0]! : { _and: parts });

// ------------------------------------------------------------------------------------------------------- claims

export const getClaimRequest = (market: string): GraphqlRequest =>
  request("GetClaim", `query GetClaim($id: String!) { Claim_by_pk(id: $id) { ${select(CLAIM_FIELDS)} } }`, { id: market });

export interface ClaimFilter {
  creator?: string;
  claimDocumentSha256?: string;
  evidenceDeadlineAfter?: bigint;
  evidenceDeadlineAtOrBefore?: bigint;
}

export type ClaimKeyset = { order: "created_desc"; block: bigint; logIndex: bigint } | { order: "evidence_deadline_asc"; deadline: bigint; market: string };

export function listClaimsRequest(order: "created_desc" | "evidence_deadline_asc", filter: ClaimFilter, after: ClaimKeyset | null, limit: number): GraphqlRequest {
  const parts: BoolExp[] = [];
  if (filter.creator !== undefined) parts.push({ creator: { _eq: filter.creator } });
  if (filter.claimDocumentSha256 !== undefined) parts.push({ claimDocumentSha256: { _eq: filter.claimDocumentSha256 } });
  if (filter.evidenceDeadlineAfter !== undefined) parts.push({ evidenceDeadline: { _gt: filter.evidenceDeadlineAfter.toString() } });
  if (filter.evidenceDeadlineAtOrBefore !== undefined) parts.push({ evidenceDeadline: { _lte: filter.evidenceDeadlineAtOrBefore.toString() } });
  if (after?.order === "created_desc") {
    const block = after.block.toString();
    parts.push({ _or: [{ createdBlock: { _lt: block } }, { createdBlock: { _eq: block }, createdLogIndex: { _lt: after.logIndex.toString() } }] });
  } else if (after?.order === "evidence_deadline_asc") {
    const deadline = after.deadline.toString();
    parts.push({ _or: [{ evidenceDeadline: { _gt: deadline } }, { evidenceDeadline: { _eq: deadline }, id: { _gt: after.market } }] });
  }
  const orderBy: OrderBy = order === "created_desc" ? [{ createdBlock: "desc" }, { createdLogIndex: "desc" }] : [{ evidenceDeadline: "asc" }, { id: "asc" }];
  return request(
    "ListClaims",
    `query ListClaims($where: Claim_bool_exp!, $orderBy: [Claim_order_by!]!, $limit: Int!) { Claim(where: $where, order_by: $orderBy, limit: $limit) { ${select(CLAIM_FIELDS)} } }`,
    { where: and(parts.length === 0 ? [{}] : parts), orderBy, limit },
  );
}

export const listClaimsByQuestionRequest = (questionId: string): GraphqlRequest =>
  request(
    "ListClaimsByQuestion",
    `query ListClaimsByQuestion($where: Claim_bool_exp!, $orderBy: [Claim_order_by!]!, $limit: Int!) { Claim(where: $where, order_by: $orderBy, limit: $limit) { ${select(CLAIM_FIELDS)} } }`,
    { where: { questionId: { _eq: questionId } }, orderBy: [{ createdBlock: "asc" }, { createdLogIndex: "asc" }], limit: UNPAGINATED_LIMIT },
  );

// ----------------------------------------------------------------------------------------------------- evidence

/** EvidenceSubmission id: registry:submissionId (decimal), as the handlers build it. */
export const evidenceId = (registry: string, submissionId: bigint): string => `${registry}:${submissionId.toString()}`;

export const getEvidenceRequest = (registry: string, submissionId: bigint): GraphqlRequest =>
  request("GetEvidence", `query GetEvidence($id: String!) { EvidenceSubmission_by_pk(id: $id) { ${select(EVIDENCE_FIELDS)} } }`, { id: evidenceId(registry, submissionId) });

export interface EvidenceFilter {
  market?: string;
  submitter?: string;
  status?: "committed" | "revealed" | "published";
}

export function listEvidenceRequest(filter: EvidenceFilter, after: { block: bigint; logIndex: bigint } | null, limit: number): GraphqlRequest {
  const parts: BoolExp[] = [];
  if (filter.market !== undefined) parts.push({ market: { _eq: filter.market } });
  if (filter.submitter !== undefined) parts.push({ submitter: { _eq: filter.submitter } });
  if (filter.status !== undefined) parts.push({ status: { _eq: filter.status } });
  if (after) {
    const block = after.block.toString();
    parts.push({ _or: [{ committedBlock: { _gt: block } }, { committedBlock: { _eq: block }, committedLogIndex: { _gt: after.logIndex.toString() } }] });
  }
  return request(
    "ListEvidence",
    `query ListEvidence($where: EvidenceSubmission_bool_exp!, $orderBy: [EvidenceSubmission_order_by!]!, $limit: Int!) { EvidenceSubmission(where: $where, order_by: $orderBy, limit: $limit) { ${select(EVIDENCE_FIELDS)} } }`,
    { where: and(parts.length === 0 ? [{}] : parts), orderBy: [{ committedBlock: "asc" }, { committedLogIndex: "asc" }], limit },
  );
}

// ------------------------------------------------------------------------------------------------------- oracle

export const getOracleQuestionRequest = (questionId: string): GraphqlRequest =>
  request("GetOracleQuestion", `query GetOracleQuestion($id: String!) { OracleQuestion_by_pk(id: $id) { ${select(QUESTION_FIELDS)} } }`, { id: questionId });

export const listOracleAnswersRequest = (questionId: string): GraphqlRequest =>
  request(
    "ListOracleAnswers",
    `query ListOracleAnswers($where: OracleAnswer_bool_exp!, $orderBy: [OracleAnswer_order_by!]!, $limit: Int!) { OracleAnswer(where: $where, order_by: $orderBy, limit: $limit) { ${select(ANSWER_FIELDS)} } }`,
    { where: { questionId: { _eq: questionId } }, orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }], limit: UNPAGINATED_LIMIT },
  );

export const getArbitrationRequest = (questionId: string): GraphqlRequest =>
  request(
    "GetArbitration",
    `query GetArbitration($id: String!, $where: ArbitrationStage_bool_exp!, $orderBy: [ArbitrationStage_order_by!]!, $limit: Int!) { Arbitration_by_pk(id: $id) { ${select(ARBITRATION_FIELDS)} } ArbitrationStage(where: $where, order_by: $orderBy, limit: $limit) { ${select(STAGE_FIELDS)} } }`,
    { id: questionId, where: { questionId: { _eq: questionId } }, orderBy: [{ blockNumber: "asc" }, { logIndex: "asc" }], limit: UNPAGINATED_LIMIT },
  );

export const getConditionResolutionRequest = (conditionId: string): GraphqlRequest =>
  request("GetConditionResolution", `query GetConditionResolution($id: String!) { ConditionResolution_by_pk(id: $id) { ${select(RESOLUTION_FIELDS)} } }`, { id: conditionId });

// ------------------------------------------------------------------------------------------------------- status

export const statusRequest = (chainId: number): GraphqlRequest =>
  request(
    "Status",
    `query Status($progressId: String!) { ${ENVIO_META.root} { ${ENVIO_META.chainId} ${ENVIO_META.progressBlock} ${ENVIO_META.sourceBlock} } ${ENVIO_PROGRESS.entity}_by_pk(id: $progressId) { ${ENVIO_PROGRESS.blockNumber} ${ENVIO_PROGRESS.blockTimestamp} } }`,
    { progressId: String(chainId) },
  );
