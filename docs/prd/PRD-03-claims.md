# PRD-03: Claims module (feature `claims`)

Implements the customer journey of SPEC §3 steps 1–6 and §8 (immutable claim presentation, durable market-to-commit links,
agent discovery) for ADR-0001 D2, D5, D6, D9, D13 and SEC-CLAIM, SEC-AGENT, SEC-TX (publication plans). The module is a
`RouteModule` (`packages/api/src/contracts/app.ts`) registered by the platform; it receives everything through `AppContext`.

## 1. Lane and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `claims` | `packages/api/src/modules/claims`, `packages/api/migrations/claims` |

Frozen and used as-is: `packages/shared/src` (claim document, question renderer, tx-plan allowlist/verifier, deployment manifest,
read model, canonical encoding), `packages/api/src/contracts/*`, `policies/catalog/*`. Tests use `src/contracts/testing.ts`
(`createTestContext`, `buildTestApp`, fakes, `MemoryReadModel`) and must not need the platform implementation.

## 2. Policy catalog
- At module registration, load `policies/catalog/catalog.json` (path resolved from the repository root relative to this package)
  and every referenced file; refuse to start (throw) if a file's SHA-256 differs from the catalog, a file exceeds 262144 bytes, ids
  or versions are malformed, or a version appears twice.
- Publishable iff: status `approved`, or status `draft` and `config.claims.allowDraftPolicies`; and the id is in
  `config.claims.enabledPolicyFamilies`; and the id is not `SC-001` (always `FEATURE_DISABLED`, any status).
- Policy-parameter schemas (zod, per id@version, in this module): BOT-001 requires `sourceRequirement` (text ≤ 1000),
  `startingStates` (text ≤ 4000) and `simulatedAdapters` (array ≤ 20 of text ≤ 100); FUNC-001 accepts an empty object or the
  optional `formatDefinition` (text ≤ 4000). Unknown keys are refused. These schemas never change for a published version.
- Routes (public, `config.pine.public`): `GET /api/v1/policies` (id, version, title, family, sha256, cid, status, publishable),
  `GET /api/v1/policies/:id/:version` (metadata plus the text), `GET /api/v1/policies/:id/:version/parameters.schema.json`
  (JSON Schema generated with `z.toJSONSchema`).

## 3. GitHub browsing (session + linked GitHub; `quotas.consume(github_calls_per_hour)` per upstream call)
`GET /api/v1/github/repos?page`, `GET /api/v1/github/repos/:owner/:name`, `.../pulls?state&page`, `.../pulls/:number`,
`.../pulls/:number/commits`, `.../commits/:sha`. Map `GitHubGatewayError` codes: GITHUB_NOT_LINKED → FORBIDDEN (message tells the
user to connect GitHub), REPO_NOT_PUBLIC → UNPROCESSABLE, NOT_FOUND → NOT_FOUND, NOT_A_MEMBER → UNPROCESSABLE, RATE_LIMITED →
RATE_LIMITED, UPSTREAM → UPSTREAM_UNAVAILABLE. Path parameters are validated (owner/name charset, 40-hex sha, positive ints).

## 4. Drafts (session; owner-only; `claim_drafts_per_day` on create)
`POST /api/v1/drafts`, `GET /api/v1/drafts`, `GET|PUT|DELETE /api/v1/drafts/:id`. A draft stores the user's inputs:
repository (owner/name), target commit, optional base commit, membership ref (`pull` number or `branch` name), policy id/version,
title, requirement, violation, scope, allowed inputs, assumptions, fault model, regression flag, exclusions, policy parameters,
environment (runtime, dependencies, configuration, external state, reproduction), evidence window (seconds) and min bond (wei
string). Inputs are validated with the same text rules as the claim document (`safeText`, title rules) so errors surface early.
Another user's draft id returns NOT_FOUND (no existence oracle). Drafts are mutable; documents are not.

## 5. Preview (freezes a document)
`POST /api/v1/drafts/:id/preview` (session):
1. Policy publishable (2); GitHub: `getRepo` (public), `verifyCommitMembership` for the target commit (and for `baseCommit` when
   present, against the same ref), repository identity = numeric id.
2. Deadlines: `evidenceDeadline = roundUpToMinute(now + window)` with `config.claims.min/max` bounds; `revealDeadline =
   evidenceDeadline + config.claims.revealWindowSeconds`; min bond within API bounds (1–100 xDAI, default from config).
3. Build the `ClaimDocument` (`@pine/shared/claim-document`): random 32-byte `nonce`, `creator = session.wallet`, addresses from
   `config` (registry, evidence registry, Seer factory, collateral, realitio, arbitrator, timeout), `openingTime = revealDeadline`,
   `disclosure.liveSystemImpact: "none"` (the request must include an explicit boolean attestation; refuse otherwise),
   `createdAt = now` (seconds). Encode with `encodeClaimDocument` (≤ 256 KiB).
4. Compose the question with `renderQuestion` and the token names; compute digest and CID.
5. Persist an immutable `preview` row (user, draft, document bytes, digest, expiry = the plan expiry of §6) and return
   `{ documentSha256, cid, document, question, tokenNames, timeline, costs, disclosures }` where timeline gives evidence close,
   reveal close (= answers open), earliest finalization (opening + timeout), and the arbitration note (Kleros ~16–20 days, fee
   paid on Ethereum, 0.1674 ETH at research time, subject to change); costs give the estimated gas (static estimate 1.8M gas × the
   chain's current gas price via `ctx.chain.publicClient.getGasPrice`) and state that funding is separate; disclosures are the fixed
   texts of policy C7 (No is not certification, price is not a probability, liquidity is not a bounty, invalid is not a refund,
   deadlines are not trading cutoffs) plus the min-bond and liveness notes of ADR D7.

## 6. Publication (transaction plan, crash-safe state machine; SEC-TX-01..11)
- `POST /api/v1/publications {previewId}` (session; `compliance.assertAllowed(publish_claim)`; `publications_per_day`; read model
  not stale/halted else NOT_READY): idempotent per `(user, documentSha256)` — a retry returns the same publication and plan.
  Store the document in `contentStore.put` (must succeed before any plan is returned), then build the plan with
  `buildStep(manifest, { allowlistId: "claimRegistry.createClaim", args: [params] })` and `newPlan`, and run `verifyPlan` on it
  before returning it (a builder bug must fail closed). Plan expiry: `evidenceDeadline − 1 day (on-chain minimum window) − 15 min`;
  after expiry the publication becomes `expired` and a new preview is required. If `marketOf(creator, digest)` (eth_call at the
  latest block) is already nonzero, the publication is `confirmed` with that market and no plan is returned.
- States: `planned → submitted → confirmed | failed | expired`. `POST /api/v1/publications/:id/submitted {txHash}` records the hash
  (idempotent; same hash only). `GET /api/v1/publications/:id` returns state, plan, market when confirmed.
- Job `claims.reconcile-publications` (every 30 s): for `submitted`: fetch the receipt; `success` with a `ClaimCreated` log emitted by
  the configured registry whose creator and digest match → `confirmed` (market); `reverted` → `failed` with a redacted reason;
  unknown after the plan expiry → `expired`. For `planned` past expiry → `expired`. Transitions are compare-and-set updates
  (`WHERE state = <expected>`), so concurrent jobs or retries never double-apply. Every transition is audited.

## 7. Integrity of on-chain claims (SEC-CLAIM-03..08, SEC-IDX-08)
Job `claims.verify-integrity` (every 60 s) processes claims from the read model that have no final integrity record:
retrieve the document with `contentStore.retrieve(claimDocumentSha256, 262144)`; `parseClaimDocumentBytes(bytes, digest)`; and
require `document.creator == claim.creator`, repository id, commit, policy sha256 (and the policy exists in the catalog with that
digest, any status), deadlines, min bond, evidence registry, claim registry, title, `marketName == renderQuestion(...)`. Record
`verified` or `mismatch` (field list) or `document_unavailable` (retry with backoff for 7 days, then final). Only `verified` claims
appear in listings and agent feeds; detail endpoints show every claim with its integrity status.

## 8. Public claim and agent endpoints (`config.pine.public`; no cookies; ETag; responses include indexer staleness)
- `GET /api/v1/claims?phase&repositoryId&creator&cursor&limit` and `GET /api/v1/claims/:market`: platform facts from the read model,
  integrity, moderation (`hide` excluded from lists, shown with reason on detail; `block` shows metadata only), derived oracle status
  (`deriveOracleStatus`), phase (`evidence_open` until evidenceDeadline, `reveal_open` until revealDeadline, `oracle_open`,
  `pending_arbitration`, `finalized`, `resolved` when a ConditionResolution exists), and `stale` when the read model lags.
- `GET /.well-known/pine.json`: API version, chain id, deployment manifest and `deploymentHash`, commitment typehash and ABI types,
  timing operators (`commit: block.timestamp < evidenceDeadline`, `reveal: block.timestamp < revealDeadline`, `answers: block.timestamp >= revealDeadline`),
  schema URLs, feed URLs, policy catalog URL, and the fixed sandbox warning.
- `GET /api/v1/agents/claims?phase&cursor&limit` (verified claims only) and `GET /api/v1/agents/claims/:market`: `platform` fields
  (chain facts, deadlines with operators, oracle status, integrity, outcome tokens, document and policy digests and CIDs and
  user-content URLs `userContentOrigin/c/<sha256>`), `userSupplied` (document fields) with `contentTrust: "untrusted"`,
  evidence submission instructions (registry address, `computeCommitment` formula, salt rules, manifest schema id, size limits),
  and the warning "Reproduce only in an isolated sandbox without secrets, keys or network access to production systems."
- `GET /api/v1/schemas/claim-document.json` and `/evidence-manifest.json` (from the frozen zod schemas via `z.toJSONSchema`).

## 9. Required tests (vitest with the frozen harness; name SEC ids in negative tests)
Catalog digest tampering refuses startup; SC-001 FEATURE_DISABLED; draft policies refused when `allowDraftPolicies` is false;
draft IDOR; GitHub error mapping; membership failure blocks preview; preview determinism except nonce/createdAt; attestation
required; deadline rounding and bounds; publication idempotency (same plan twice), plan passes `verifyPlan`, compliance and quota
refusals, NOT_READY when stale; content stored before a plan is returned; reconcile transitions incl. a receipt from the wrong
creator/registry (not confirmed), reverted tx, expiry, and concurrent reconcile runs; integrity: verified, mismatch per field,
document unavailable, a copycat market by another creator flagged; listings exclude hidden/unverified; agent endpoints are public,
never read cookies and label untrusted content; well-known document contents; schema endpoints validate the fixtures.

## 10. Checks
`pnpm --filter @pine/api typecheck`, `pnpm exec eslint packages/api/src` (typecheck), `node scripts/check-forbidden.mjs` (unit),
`pnpm --filter @pine/api exec vitest run src/modules/claims` (unit).
