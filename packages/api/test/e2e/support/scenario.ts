// Steps of the SPEC section 3 customer journey shared by the e2e files. Each step goes through HTTP (Browser) or through
// the simulated chain (ChainSim mines the event the user's transaction would emit); assertions about the steps live in
// the test files.

import { decodeFunctionData, keccak256, toBytes } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { claimRegistryAbi } from "@pine/shared/abi/generated";
import type { ClaimCreatedEvent } from "@pine/shared/chain-events";
import type { ClaimDocument } from "@pine/shared/claim-document";
import { renderQuestion } from "@pine/shared/question";
import type { TxPlan, WireTxPlan } from "@pine/shared/tx-plan";
import type { Address, Hex32 } from "@pine/shared/types";
import type { Browser, E2e } from "./app.js";
import { addressOf, claimCreatedLog, newMarketLog, txHashOf } from "./chain.js";
import type { FakeRepo } from "./github.js";

/** Test-only EOAs (never funded anywhere; signatures are local). */
export const account = (seed: number): PrivateKeyAccount => privateKeyToAccount(`0x${seed.toString(16).padStart(64, "0")}`);

export const TARGET_COMMIT = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
export const BASE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const PULL_NUMBER = 2101;

export function seedRepository(e2e: E2e): FakeRepo {
  const repo: FakeRepo = {
    id: 427_016_914,
    owner: "kleros",
    ownerId: 1_001_001,
    name: "kleros-v2",
    defaultBranch: "main",
    pulls: new Map([[PULL_NUMBER, { headSha: TARGET_COMMIT, baseRef: "main", baseSha: BASE_COMMIT, commits: [TARGET_COMMIT] }]]),
  };
  e2e.github.addRepo(repo);
  return repo;
}

export function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { owner: "kleros", name: "kleros-v2" },
    commit: TARGET_COMMIT,
    baseCommit: null,
    membership: { kind: "pull", number: PULL_NUMBER },
    policy: { id: "BOT-001", version: "0.1.0" },
    title: "Reporter deposits never use arbitration funds or the operator gas reserve",
    requirement: "Each reporter-funding deposit's principal is allocated only from eligible bridging/reporter funds in scope.",
    violation: "A reachable sequence in which a positive reporter deposit draws principal from an arbitration allocation.",
    scope: { components: ["bots/gateway-balancer/src/reporter"], outOfScope: ["LI.FI execution"] },
    allowedInputs: "Configurations valid under config/example.json.",
    assumptions: ["Operator reserve may pay reporter transaction gas fees."],
    faultModel: "Process crash between any two persisted steps; RPC timeouts.",
    regressionOnly: false,
    exclusions: ["Gas fees paid from the operator reserve."],
    policyParameters: { sourceRequirement: "spec sections 2.2 and 4.2", startingStates: "Reachable from an empty journal", simulatedAdapters: ["lifi"] },
    environment: {
      runtime: "Node 24.21.0 on Linux x64",
      dependencies: "yarn.lock at the target commit",
      configuration: "config/example.json at the target commit",
      externalState: "Simulated chains; no live RPC",
      reproduction: { setup: "yarn install --immutable", command: "yarn test", notes: "" },
    },
    evidenceWindowSeconds: 7 * 86_400,
    minBondWei: null,
    ...overrides,
  };
}

/** GitHub linking through the real routes: start -> (user approves on github.com) -> callback; returns the redirect. */
export async function linkGitHub(browser: Browser, identity: { githubUserId: number; login: string }) {
  const start = await browser.send("POST", "/api/v1/auth/github/start");
  if (start.statusCode !== 200) throw new Error(`github start failed: ${start.statusCode} ${start.body}`);
  const { authorizationUrl } = start.json<{ authorizationUrl: string }>();
  const { code, state } = browser.e2e.github.authorize(authorizationUrl, identity);
  const before = browser.session;
  const callback = await browser.send("GET", `/api/v1/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  return { start, callback, authorizationUrl, previousSession: before };
}

export interface PreviewBody {
  previewId: string;
  documentSha256: Hex32;
  cid: string;
  document: ClaimDocument;
  question: string;
  planExpiresAt: number;
}

export interface PublicationBody {
  publication: { id: string; state: string; market: Address | null; planId: string; creator: Address };
  plan: WireTxPlan | null;
  planExpired: boolean;
}

export async function createDraft(browser: Browser, body = draftBody()): Promise<string> {
  const response = await browser.send("POST", "/api/v1/drafts", { body });
  if (response.statusCode !== 201) throw new Error(`draft failed: ${response.statusCode} ${response.body}`);
  return response.json<{ draft: { id: string } }>().draft.id;
}

export async function createPreview(browser: Browser, draftId: string): Promise<PreviewBody> {
  const response = await browser.send("POST", `/api/v1/drafts/${draftId}/preview`, { body: { attestLiveSystemImpactNone: true } });
  if (response.statusCode !== 201) throw new Error(`preview failed: ${response.statusCode} ${response.body}`);
  return response.json<PreviewBody>();
}

/** The market and outcome tokens the registry/factory would create for a document (deterministic per digest). */
export function onChainIdentity(digest: Hex32) {
  return {
    market: addressOf(`market:${digest}`),
    questionId: keccak256(toBytes(`question:${digest}`)),
    conditionId: keccak256(toBytes(`condition:${digest}`)),
    yesToken: addressOf(`yes:${digest}`),
    noToken: addressOf(`no:${digest}`),
    invalidToken: addressOf(`invalid:${digest}`),
  };
}

/**
 * The user's wallet sends the createClaim step: the chain "executes" exactly the calldata of the plan (decoded from the
 * plan's bytes, not from the API's response fields), the registry emits ClaimCreated (with Seer's NewMarket in the
 * same receipt), and the finalized block is indexed.
 */
export async function mineCreateClaim(e2e: E2e, plan: TxPlan, txHash: Hex32 = txHashOf(`create:${plan.planId}`)): Promise<ClaimCreatedEvent> {
  const step = plan.steps[0];
  if (!step || step.allowlistId !== "claimRegistry.createClaim") throw new Error("not a createClaim plan");
  const decoded = decodeFunctionData({ abi: claimRegistryAbi, data: step.data });
  const [params] = decoded.args as unknown as [
    { claimDocumentSha256: Hex32; policyDocumentSha256: Hex32; repositoryId: bigint; commit: `0x${string}`; evidenceDeadline: bigint; revealDeadline: bigint; minBond: bigint; title: string },
  ];
  const digest = params.claimDocumentSha256.toLowerCase() as Hex32;
  const ids = onChainIdentity(digest);
  const marketName = renderQuestion({
    evidenceRegistry: e2e.manifest.pine.evidenceRegistry,
    title: params.title,
    evidenceDeadline: Number(params.evidenceDeadline),
    revealDeadline: Number(params.revealDeadline),
    repositoryId: Number(params.repositoryId),
    commit: params.commit.slice(2).toLowerCase(),
    claimDocumentSha256: digest,
    policyDocumentSha256: params.policyDocumentSha256.toLowerCase() as Hex32,
  });
  const [event] = await e2e.chain.mine(
    [
      {
        kind: "ClaimCreated",
        address: e2e.manifest.pine.claimRegistry,
        ...ids,
        creator: plan.account,
        claimDocumentSha256: digest,
        policyDocumentSha256: params.policyDocumentSha256.toLowerCase() as Hex32,
        repositoryId: Number(params.repositoryId),
        commit: params.commit.slice(2).toLowerCase(),
        evidenceDeadline: Number(params.evidenceDeadline),
        revealDeadline: Number(params.revealDeadline),
        minBond: params.minBond,
        title: params.title,
        marketName,
        marketNameHash: keccak256(toBytes(marketName)),
      },
    ],
    { txHash },
  );
  const created = event as ClaimCreatedEvent;
  e2e.rpc.receipts.set(txHash, {
    status: "success",
    blockNumber: created.blockNumber,
    from: plan.account,
    to: e2e.manifest.pine.claimRegistry,
    logs: [newMarketLog(created, e2e.manifest.seer.marketFactory), claimCreatedLog(created)],
  });
  e2e.rpc.markets.set(`${plan.account}|${digest}`, created.market);
  // The verifying client learns the registered market from its own registry lookup.
  e2e.planContext.markets.set(created.market, [created.yesToken, created.noToken, created.invalidToken]);
  e2e.planContext.questionIds.add(created.questionId);
  return created;
}

export interface PublishedClaim {
  event: ClaimCreatedEvent;
  preview: PreviewBody;
  publicationId: string;
}

/** Draft -> preview -> publication plan -> mined createClaim -> reconciliation and integrity jobs. */
export async function publishClaim(browser: Browser, body = draftBody()): Promise<PublishedClaim> {
  const e2e = browser.e2e;
  const draftId = await createDraft(browser, body);
  const preview = await createPreview(browser, draftId);
  const response = await browser.send("POST", "/api/v1/publications", { body: { previewId: preview.previewId, documentSha256: preview.documentSha256 } });
  if (response.statusCode !== 200) throw new Error(`publication failed: ${response.statusCode} ${response.body}`);
  const publication = response.json<PublicationBody>();
  const verified = e2e.plans.at(-1);
  if (!publication.plan || !verified || verified.plan.planId !== publication.plan.planId) throw new Error("no verified publication plan");
  const event = await mineCreateClaim(e2e, verified.plan);
  await e2e.runJob("claims.reconcile-publications");
  await e2e.runJob("claims.verify-integrity");
  return { event, preview, publicationId: publication.publication.id };
}
