#!/usr/bin/env node
// Smoke test of the running local stack (scripts/dev-stack/up.sh), without a browser. DEVELOPMENT ONLY: it signs with
// anvil's public dev account #1 (derived from anvil's public test mnemonic; private key 0x59c6...690d) and sends
// transactions ONLY to the local anvil fork, after checking that the RPC is loopback and answers as anvil.
//
// Journey: /healthz, /readyz, policies, /.well-known/pine.json (deployment hash = this client's own manifest), SIWE login
// (the server-issued EIP-4361 message, signed locally), session, GitHub link (start -> dev control "approve" -> callback),
// repos and PRs, draft, preview, publication plan (planFromWire + verifyPlan with the client's own manifest), the
// createClaim transaction on anvil, /submitted, reconciliation to `confirmed`, the claim listed in GET /api/v1/claims,
// then a YES-ladder funding plan (risk acknowledgement, verified, every step sent and reported).
//
// Usage: node scripts/dev-stack/smoke.mjs [--skip-funding]
// Env overrides: SMOKE_API_URL (http://127.0.0.1:3000), SMOKE_ORIGIN (http://localhost:3004),
//                SMOKE_CONTROL_URL (http://127.0.0.1:3999), SMOKE_RPC_URL (http://127.0.0.1:8545)
/* global process, console, fetch, URL, setTimeout */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = path.join(ROOT, "scripts", "dev-stack", ".state");
const API = process.env.SMOKE_API_URL ?? "http://127.0.0.1:3000";
const ORIGIN = process.env.SMOKE_ORIGIN ?? "http://localhost:3004";
const CONTROL = process.env.SMOKE_CONTROL_URL ?? "http://127.0.0.1:3999";
const RPC = process.env.SMOKE_RPC_URL ?? "http://127.0.0.1:8545";
const SKIP_FUNDING = process.argv.includes("--skip-funding");
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
const ANVIL_ACCOUNT_1 = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
// Login pine-labs (sees the seeded repos) under the smoke test's own GitHub user id, so it never collides with the dev
// control server's default identity (190455201) that a browser session may have linked.
const GITHUB_IDENTITY = { githubUserId: 190_455_299, login: "pine-labs" };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// ------------------------------------------------------------------------------------------------ module loading
// viem and @pine/shared (TypeScript sources) resolve from packages/api, through tsx's ESM API.
const apiRequire = createRequire(path.join(ROOT, "packages", "api", "package.json"));
const tsxApi = await import(pathToFileURL(apiRequire.resolve("tsx/esm/api").replace(/index\.cjs$/, "index.mjs")).href);
const parentURL = pathToFileURL(path.join(ROOT, "packages", "api", "package.json")).href;
const load = (specifier) => tsxApi.tsImport(specifier, parentURL);
const viem = await load("viem");
const { mnemonicToAccount } = await load("viem/accounts");
const { planFromWire, verifyPlan } = await load("@pine/shared/tx-plan");
const { buildDeploymentManifest, deploymentHash } = await load("@pine/shared/deployment");
const { claimRegistryAbi } = await load("@pine/shared/abi/generated");

// ------------------------------------------------------------------------------------------------ report
const results = [];
const started = Date.now();
let aborted = false;

function show(status, name, detail) {
  results.push({ status, name, detail });
  const seconds = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`${status.padEnd(4)} ${seconds}s  ${name}${detail ? `  -- ${detail}` : ""}`);
}

/** Runs one step; a failed required step skips everything after it (the journey is one story). */
async function step(name, fn, { required = true } = {}) {
  if (aborted) {
    show("SKIP", name);
    return undefined;
  }
  try {
    const detail = await fn();
    show("PASS", name, typeof detail === "string" ? detail : "");
    return detail;
  } catch (error) {
    show("FAIL", name, error instanceof Error ? error.message : String(error));
    if (required) aborted = true;
    return undefined;
  }
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, seconds, probe) {
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await probe();
    if (result.done) return result.value;
    last = result.note ?? last;
    await sleep(2_000);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${label}${last ? ` (last: ${last})` : ""}`);
}

// ------------------------------------------------------------------------------------------------ browser-like HTTP
const jar = new Map();

function storeCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || attributes.some((attribute) => /^\s*expires=thu, 01 jan 1970/i.test(attribute));
    if (value === "" || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

/** Same-origin browser semantics: cookies, and on unsafe methods Origin + Sec-Fetch-Site + x-pine-csrf (+ JSON). */
async function api(method, pathname, { body, headers = {}, redirect = "follow" } = {}) {
  const unsafe = method !== "GET" && method !== "HEAD";
  const all = { accept: "application/json", ...headers };
  if (jar.size > 0) all.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  if (unsafe) Object.assign(all, { origin: ORIGIN, "sec-fetch-site": "same-origin", "x-pine-csrf": "1" });
  if (body !== undefined) all["content-type"] = "application/json";
  const response = await fetch(`${API}${pathname}`, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body), redirect });
  storeCookies(response);
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: parseJson(text), text };
}

function parseJson(text) {
  try {
    return text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

const brief = (response) => `${response.status} ${response.text.slice(0, 300)}`;

async function control(method, pathname, body) {
  const response = await fetch(`${CONTROL}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

// ------------------------------------------------------------------------------------------------ chain (local anvil only)
const deployment = JSON.parse(readFileSync(path.join(STATE_DIR, "deployment.json"), "utf8"));
const manifest = buildDeploymentManifest({ claimRegistry: deployment.claimRegistry, evidenceRegistry: deployment.evidenceRegistry, deploymentBlock: deployment.deploymentBlock }, 100);
const localChain = viem.defineChain({
  id: 100,
  name: "Gnosis (local anvil fork)",
  nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: 1 });
const wallet = account.address.toLowerCase();
const publicClient = viem.createPublicClient({ chain: localChain, transport: viem.http(RPC) });
const walletClient = viem.createWalletClient({ account, chain: localChain, transport: viem.http(RPC) });

async function assertLocalAnvil() {
  check(LOOPBACK.has(new URL(RPC).hostname), `refusing to send transactions: ${RPC} is not a loopback RPC`);
  const version = await publicClient.request({ method: "web3_clientVersion" });
  check(typeof version === "string" && version.toLowerCase().startsWith("anvil/"), "refusing to send transactions: the RPC is not anvil");
  check((await publicClient.getChainId()) === 100, "the local fork must report chain id 100");
}

/** Sends one verified plan step from anvil account #1 and waits for a successful receipt. */
async function sendStep(planStep) {
  await assertLocalAnvil();
  // Wallet-style headroom over the exact estimate: an Algebra mint in a block with a new timestamp writes one more oracle
  // timepoint than the estimate saw, and an exact limit then runs out of gas.
  const estimate = await publicClient.estimateGas({ account, to: planStep.to, data: planStep.data, value: planStep.value });
  const gas = (estimate * 13n) / 10n + 50_000n;
  const hash = await walletClient.sendTransaction({ to: planStep.to, data: planStep.data, value: planStep.value, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  check(receipt.status === "success", `transaction ${hash} reverted`);
  return receipt;
}

const findPlan = (value) => {
  if (Array.isArray(value)) return value.map(findPlan).find((item) => item) ?? null;
  if (value && typeof value === "object") {
    if (value.plan && typeof value.plan === "object" && Array.isArray(value.plan.steps)) return value.plan;
    for (const item of Object.values(value)) {
      const found = findPlan(item);
      if (found) return found;
    }
  }
  return null;
};

// ------------------------------------------------------------------------------------------------ journey
const state = {};
console.log(`Pine dev-stack smoke test: API ${API}, origin ${ORIGIN}, wallet ${wallet} (anvil #1), ClaimRegistry ${manifest.pine.claimRegistry}`);

await step("GET /healthz", async () => {
  const response = await api("GET", "/healthz");
  check(response.status === 200, brief(response));
});

await step("GET /readyz", async () => {
  const response = await api("GET", "/readyz");
  check(response.status === 200 && response.json?.status === "ready", brief(response));
  return JSON.stringify(response.json.checks);
});

await step("GET /api/v1/policies", async () => {
  const response = await api("GET", "/api/v1/policies");
  check(response.status === 200, brief(response));
  const text = JSON.stringify(response.json);
  check(text.includes("BOT-001") && text.includes("FUNC-001"), "BOT-001 / FUNC-001 missing from the catalog");
  return `${(response.json.items ?? response.json.policies ?? []).length} policies`;
}, { required: false });

await step("GET /.well-known/pine.json matches the client's own deployment manifest", async () => {
  const response = await api("GET", "/.well-known/pine.json");
  check(response.status === 200, brief(response));
  check(response.json.chainId === 100, "chain id");
  check(String(response.json.deploymentHash).toLowerCase() === deploymentHash(manifest), "deploymentHash differs from the manifest built from deployment.json");
}, { required: false });

await step("GET /api/openapi.json", async () => {
  const response = await api("GET", "/api/openapi.json");
  check(response.status === 200 && typeof response.json?.openapi === "string", brief(response));
  return `${Object.keys(response.json.paths ?? {}).length} paths`;
}, { required: false });

await step("SIWE challenge + verify (anvil account #1, EOA signature)", async () => {
  check(wallet === ANVIL_ACCOUNT_1, "mnemonic derivation did not give anvil account #1");
  const challenge = await api("POST", "/api/v1/auth/siwe/challenge", { body: { address: account.address } });
  check(challenge.status === 200, `challenge: ${brief(challenge)}`);
  check(jar.has("__Host-pine_presession"), "no pre-session cookie");
  const { message } = challenge.json;
  const expected = [`localhost:3004 wants you to sign in with your Ethereum account:`, account.address, `URI: ${ORIGIN}`, "Version: 1", "Chain ID: 100"];
  for (const part of expected) check(message.includes(part), `SIWE message lacks "${part}"`);
  const signature = await account.signMessage({ message });
  const verify = await api("POST", "/api/v1/auth/siwe/verify", { body: { message, signature } });
  check(verify.status === 200, `verify: ${brief(verify)}`);
  check(jar.has("__Host-pine_session") && jar.get("__Host-pine_session").startsWith("pine_s1_"), "no pine_s1_ session cookie");
  check(!jar.has("__Host-pine_presession"), "pre-session cookie not cleared");
  state.session = jar.get("__Host-pine_session");
});

await step("GET /api/v1/auth/session", async () => {
  const response = await api("GET", "/api/v1/auth/session");
  check(response.status === 200, brief(response));
  check(response.json.wallet === wallet && response.json.termsAccepted === true, JSON.stringify(response.json));
});

await step("GitHub link: start -> dev control authorize -> callback (session rotated)", async () => {
  const start = await api("POST", "/api/v1/auth/github/start");
  check(start.status === 200, `start: ${brief(start)}`);
  const authorizationUrl = new URL(start.json.authorizationUrl);
  check(authorizationUrl.origin === "https://github.com" && authorizationUrl.searchParams.get("code_challenge_method") === "S256", "unexpected authorization URL");
  check(authorizationUrl.searchParams.get("redirect_uri") === `${ORIGIN}/api/v1/auth/github/callback`, `redirect_uri is ${authorizationUrl.searchParams.get("redirect_uri")}`);
  const approved = await control("POST", "/dev/github/authorize", { authorizationUrl: start.json.authorizationUrl, ...GITHUB_IDENTITY });
  check(approved.status === 200, `dev control: ${JSON.stringify(approved.json)}`);
  check(approved.json.callbackUrl?.startsWith(`${ORIGIN}/api/v1/auth/github/callback?`), "callbackUrl missing");
  const callback = new URL(approved.json.callbackUrl);
  const before = jar.get("__Host-pine_session");
  const response = await api("GET", `${callback.pathname}${callback.search}`, { redirect: "manual" });
  check(response.status === 303, `callback: ${brief(response)}`);
  check(response.headers.get("location") === `${ORIGIN}/settings?github=linked`, `redirected to ${response.headers.get("location")} (is ${GITHUB_IDENTITY.githubUserId} linked to another wallet?)`);
  state.githubLinked = true;
  check(jar.get("__Host-pine_session") !== before, "session was not rotated");
  const session = await api("GET", "/api/v1/auth/session");
  check(session.json?.githubLogin === GITHUB_IDENTITY.login && session.json?.githubUserId === GITHUB_IDENTITY.githubUserId, JSON.stringify(session.json));
  return `linked as ${GITHUB_IDENTITY.login}, redirect ${response.headers.get("location")}`;
});

await step("GET /api/v1/github/repos + pulls", async () => {
  const repos = await api("GET", "/api/v1/github/repos");
  check(repos.status === 200, brief(repos));
  const names = repos.json.items.map((item) => item.fullName);
  check(names.includes("pine-labs/keeper-bot"), `repos: ${names.join(", ")}`);
  const pulls = await api("GET", "/api/v1/github/repos/pine-labs/keeper-bot/pulls");
  check(pulls.status === 200 && pulls.json.items.length === 2, `pulls: ${brief(pulls)}`);
  const pull = await api("GET", "/api/v1/github/repos/pine-labs/keeper-bot/pulls/12");
  check(pull.status === 200 && /^[0-9a-f]{40}$/.test(pull.json.headSha), brief(pull));
  const commits = await api("GET", "/api/v1/github/repos/pine-labs/keeper-bot/pulls/12/commits");
  check(commits.status === 200 && commits.json.items.length === 2, brief(commits));
  state.repo = repos.json.items.find((item) => item.fullName === "pine-labs/keeper-bot");
  state.headSha = pull.json.headSha;
  return `${names.join(", ")}; PR #12 head ${state.headSha.slice(0, 10)}`;
});

await step("POST /api/v1/drafts", async () => {
  const body = {
    repository: { owner: "pine-labs", name: "keeper-bot" },
    commit: state.headSha,
    baseCommit: null,
    membership: { kind: "pull", number: 12 },
    policy: { id: "BOT-001", version: "0.1.0" },
    title: `Keeper retry budget never spends the operator gas reserve (${new Date().toISOString().slice(0, 19)})`,
    requirement: "Every retried keeper run is paid from the retry budget only; the operator gas reserve is never used for retries.",
    violation: "A reachable sequence of failed runs after which a retry spends funds from the operator gas reserve.",
    scope: { components: ["src/keeper/retry.ts", "src/keeper/loop.ts"], outOfScope: ["RPC provider outages"] },
    allowedInputs: "Configurations valid under config/example.json.",
    assumptions: ["The operator gas reserve is configured and funded."],
    faultModel: "Process crash between any two persisted steps; RPC timeouts.",
    regressionOnly: false,
    exclusions: ["Gas price spikes above the configured cap."],
    policyParameters: { sourceRequirement: "README section Retry budget", startingStates: "Reachable from an empty journal", simulatedAdapters: ["rpc"] },
    environment: {
      runtime: "Node 24 on Linux x64",
      dependencies: "package-lock.json at the target commit",
      configuration: "config/example.json at the target commit",
      externalState: "Simulated chain; no live RPC",
      reproduction: { setup: "npm ci", command: "npm test", notes: "" },
    },
    evidenceWindowSeconds: 3 * 86_400,
    minBondWei: null,
  };
  const response = await api("POST", "/api/v1/drafts", { body });
  check(response.status === 201, brief(response));
  state.draftId = response.json.draft.id;
  return `draft ${state.draftId}`;
});

await step("POST /api/v1/drafts/:id/preview", async () => {
  const response = await api("POST", `/api/v1/drafts/${state.draftId}/preview`, { body: { attestLiveSystemImpactNone: true } });
  check(response.status === 201, brief(response));
  state.preview = response.json;
  check(state.preview.document.target.repository.id === state.repo.id, "repository id");
  return `document ${state.preview.documentSha256.slice(0, 18)}..., cid ${state.preview.cid.slice(0, 16)}...`;
});

await step("POST /api/v1/publications -> plan verified with planFromWire + verifyPlan", async () => {
  const body = { previewId: state.preview.previewId, documentSha256: state.preview.documentSha256 };
  const response = await waitFor("a publication plan", 60, async () => {
    const attempt = await api("POST", "/api/v1/publications", { body });
    if (attempt.status === 503) return { done: false, note: brief(attempt) };
    return { done: true, value: attempt };
  });
  check(response.status === 200 && response.json.plan, brief(response));
  const plan = planFromWire(response.json.plan);
  const total = verifyPlan(plan, manifest, { markets: new Map(), questionIds: new Set() }, { maxTotalValueWei: 0n, maxApprovalAmount: 0n });
  check(total === 0n, "createClaim plan carries value");
  check(plan.account === wallet, "plan account is not the signed-in wallet");
  check(plan.deploymentHash === deploymentHash(manifest), "plan deploymentHash differs from the client's manifest");
  check(plan.steps.length === 1 && plan.steps[0].allowlistId === "claimRegistry.createClaim" && plan.steps[0].to === manifest.pine.claimRegistry, "unexpected plan steps");
  state.publicationId = response.json.publication.id;
  state.createPlan = plan;
  return `publication ${state.publicationId}, plan ${plan.planId}`;
});

await step("send createClaim to anvil (account #1) + POST /submitted", async () => {
  const receipt = await sendStep(state.createPlan.steps[0]);
  const [created] = viem.parseEventLogs({ abi: claimRegistryAbi, logs: receipt.logs, eventName: "ClaimCreated" });
  check(created, "no ClaimCreated event in the receipt");
  state.market = created.args.market.toLowerCase();
  state.claim = created.args.claim;
  const submitted = await api("POST", `/api/v1/publications/${state.publicationId}/submitted`, { body: { txHash: receipt.transactionHash } });
  check(submitted.status === 200, brief(submitted));
  return `tx ${receipt.transactionHash.slice(0, 18)}... block ${receipt.blockNumber}, market ${state.market}, state ${submitted.json.publication.state}`;
});

await step("publication reconciled to confirmed (indexer + claims.reconcile-publications)", async () => {
  const publication = await waitFor("state confirmed", 150, async () => {
    const response = await api("GET", `/api/v1/publications/${state.publicationId}`);
    const current = response.json?.publication;
    return current?.state === "confirmed" ? { done: true, value: current } : { done: false, note: current?.state ?? brief(response) };
  });
  check(publication.market === state.market, "confirmed market differs");
  return `market ${publication.market}`;
});

await step("claim listed in GET /api/v1/claims (integrity verified)", async () => {
  const item = await waitFor("the claim in the public list", 240, async () => {
    const response = await api("GET", "/api/v1/claims");
    const found = response.json?.items?.find((entry) => String(entry.market).toLowerCase() === state.market);
    if (found) return { done: true, value: found };
    const detail = await api("GET", `/api/v1/claims/${state.market}`);
    return { done: false, note: `detail ${detail.status} integrity ${detail.json?.claim?.integrity?.status ?? "?"}` };
  });
  const detail = await api("GET", `/api/v1/claims/${state.market}`);
  check(detail.status === 200 && detail.json.claim.integrity.status === "verified", brief(detail));
  return `"${item.title}" integrity ${detail.json.claim.integrity.status}`;
});

await step("user-content server serves the claim document as an attachment", async () => {
  const response = await fetch(`http://127.0.0.1:3001/c/${state.preview.documentSha256}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  check(response.status === 200 && bytes.byteLength > 0, `status ${response.status}`);
  check(response.headers.get("content-type") === "application/octet-stream", "content-type");
  check((response.headers.get("content-disposition") ?? "").startsWith("attachment"), "content-disposition");
  check(response.headers.get("x-content-type-options") === "nosniff", "nosniff");
  return `${bytes.byteLength} bytes`;
}, { required: false });

await step("dev IPFS fake received the pinned documents (pin outbox)", async () => {
  const health = await waitFor("pinned blocks", 75, async () => {
    const response = await control("GET", "/dev/health");
    return response.json?.ipfs?.blocks > 0 ? { done: true, value: response.json } : { done: false, note: JSON.stringify(response.json?.ipfs) };
  });
  return JSON.stringify(health.ipfs);
}, { required: false });

if (!SKIP_FUNDING) {
  await step("GET /api/v1/markets/:market/liquidity (public)", async () => {
    const response = await api("GET", `/api/v1/markets/${state.market}/liquidity`);
    check(response.status === 200, brief(response));
  }, { required: false });

  await step("funding ladder plan: risk acknowledgement 409 -> verified plan -> steps sent and reported", async () => {
    const budget = 10n * 10n ** 18n;
    const ladder = { market: state.market, budgetWei: budget.toString(), lowerPrice: "0.05", upperPrice: "0.5" };
    const refused = await api("POST", "/api/v1/funding/plans/ladder", { body: { ...ladder, riskAcknowledgement: { budgetWei: ladder.budgetWei, maxLossIfYesShares: "0" } }, headers: { "idempotency-key": `smoke-ack-${Date.now()}` } });
    check(refused.status === 409, `expected 409 with the computed figures: ${brief(refused)}`);
    const maxLoss = refused.json.error.issues.find((issue) => issue.path.at(-1) === "maxLossIfYesShares")?.message ?? "";
    check(/^[1-9]\d*$/.test(maxLoss), `no computed maxLossIfYesShares: ${brief(refused)}`);
    const response = await api("POST", "/api/v1/funding/plans/ladder", { body: { ...ladder, riskAcknowledgement: { budgetWei: ladder.budgetWei, maxLossIfYesShares: maxLoss } }, headers: { "idempotency-key": `smoke-ladder-${Date.now()}` } });
    check(response.status === 200, brief(response));
    const wire = findPlan(response.json);
    check(wire, "no plan in the ladder response");
    const plan = planFromWire(wire);
    const context = {
      markets: new Map([[state.market, [state.claim.yesToken, state.claim.noToken, state.claim.invalidToken].map((address) => address.toLowerCase())]]),
      questionIds: new Set([state.claim.questionId.toLowerCase()]),
    };
    const total = verifyPlan(plan, manifest, context, { maxTotalValueWei: budget, maxApprovalAmount: 10n ** 30n });
    check(total === budget, `plan value ${total} differs from the budget`);
    const sent = [];
    for (const planStep of plan.steps) {
      const receipt = await sendStep(planStep);
      const reported = await api("POST", `/api/v1/funding/plans/${plan.planId}/submitted`, { body: { stepId: planStep.id, txHash: receipt.transactionHash } });
      check(reported.status === 200, `submitted ${planStep.id}: ${brief(reported)}`);
      sent.push(planStep.allowlistId);
    }
    const final = await api("GET", `/api/v1/funding/plans/${plan.planId}`);
    return `${sent.join(" -> ")}; plan state ${final.json?.state ?? final.status}`;
  }, { required: false });
}

// ------------------------------------------------------------------------------------------------ cleanup
// One GitHub user id can be linked to one wallet only: unlink, so the default dev identity stays free for the browser.
if (state.githubLinked) {
  aborted = false;
  await step("cleanup: DELETE /api/v1/auth/github (frees the dev GitHub identity; ends the session)", async () => {
    const response = await api("DELETE", "/api/v1/auth/github");
    check(response.status === 204, brief(response));
  }, { required: false });
}

// ------------------------------------------------------------------------------------------------ summary
const count = (status) => results.filter((result) => result.status === status).length;
console.log(`\nSUMMARY: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped (${((Date.now() - started) / 1000).toFixed(0)}s)`);
process.exit(count("FAIL") > 0 ? 1 : 0);
