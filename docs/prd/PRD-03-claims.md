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
- The module is built by `createClaimsModule({ catalogDir })`; `claimsModule` (imported by `src/modules.ts`) is
  `createClaimsModule({ catalogDir: <repo>/policies/catalog })` resolved from this file's location. Tests pass a temporary copy of
  the catalog (never edit `policies/catalog`).
- At module registration, load `<catalogDir>/catalog.json`
  and every referenced file; refuse to start (throw) if a file's SHA-256 differs from the catalog, a file exceeds 262144 bytes, ids
  or versions are malformed, or a version appears twice.
- Publishable iff: status `approved`, or status `draft` and `config.claims.allowDraftPolicies`; and the id is in
  `config.claims.enabledPolicyFamilies`; and the id is not `SC-001` (always `FEATURE_DISABLED`, any status). The gate is applied at
  draft create and update, at preview and at publication (SEC-CLAIM-06).
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
2. Deadlines: `evidenceDeadline = roundUpToMinute(now + window)`; after rounding, `evidenceDeadline − now` must lie within
   `[max(3 days, config.claims.minEvidenceWindowSeconds), min(30 days, config.claims.maxEvidenceWindowSeconds)]`; `revealDeadline =
   evidenceDeadline + config.claims.revealWindowSeconds`; min bond within API bounds (1–100 xDAI, default from config).
3. Build the `ClaimDocument` (`@pine/shared/claim-document`): random 32-byte `nonce`, `creator = session.wallet`, every address
   and the timeout from the deployment manifest `buildDeploymentManifest(config.contracts)` (registry, evidence registry, Seer
   factory, collateral, realitio, arbitrator, timeout; never from `config.seer`, so preview and integrity use one source; at
   module registration assert that `config.seer` equals the manifest's values and throw otherwise), `openingTime = revealDeadline`,
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
6. Token names come from `tokenNames()` and the deployment manifest from `buildDeploymentManifest(config.contracts)`
   (`@pine/shared`); `CreateClaimParams.commit` is the `bytes20` `0x${commit}`. Drafts carry a monotonically increasing
   `revision`; the preview records it. Publications never cascade from drafts: deleting a draft that has a publication returns
   409 CONFLICT. Deleting a draft without publications deletes its previews in the same transaction (explicit DELETE, no FK
   cascade); a later `POST /publications` naming such a preview returns NOT_FOUND.

## 6. Publication (transaction plan, crash-safe state machine; SEC-TX-01..11)
- `POST /api/v1/publications {previewId, documentSha256}` (session). Fixed order on every request, new or retry: body validation →
  `compliance.assertAllowed(publish_claim)` (a refused wallet gets 451 even on a retry) → read model not stale/halted, else
  NOT_READY → owner's preview (else NOT_FOUND) → `409 CONFLICT` when the digest differs from the preview's or the draft was modified
  after the preview → publication row → chain re-check → content → plan. Idempotent per `(user, documentSha256)`: if a row exists it
  is reused; otherwise consume `publications_per_day` and then `INSERT ... ON CONFLICT (user_id, document_sha256) DO NOTHING
  RETURNING`; when the insert returns nothing (a concurrent identical request won), re-read and reuse the winner's row (never a 500
  and never a duplicate; two racing first requests may consume two quota units — accepted). On every request re-check the chain
  (`marketOf(creator, digest)` at the latest block and the read model) and, if a market exists, return it as `confirmed`/`mined`
  without any plan. When the plan offer has expired (see Expiry) the response is the stored publication with `planExpired: true` and
  no plan; publishing the same content again needs a new preview (new nonce, new digest). Store the document with
  `contentStore.put` (must succeed before any plan is returned), build the plan with
  `buildStep(buildDeploymentManifest(config.contracts), { allowlistId: "claimRegistry.createClaim", args: [params] })` and
  `newPlan`, and run `verifyPlan` before returning it.
- Expiry: a plan is offered only until `min(evidenceDeadline − 1 day − 15 min, previewCreatedAt + 24 h)` (the on-chain minimum
  window would otherwise make createClaim revert, and a stale preview must not go live with a much shorter window).
- States: `planned → submitted → mined → confirmed`, plus `failed` and `expired`. `POST /api/v1/publications/:id/submitted {txHash}`
  records a hint (idempotent; additional hashes from speed-up/replacement are accepted and kept). `GET /api/v1/publications/:id`.
- Job `claims.reconcile-publications` (every 30 s), compare-and-set transitions only:
  1. For every non-final publication, look up the claim by `(creator, documentSha256)` through `readModel.listClaims` (the native
     read model is finalized-only). If found, fetch the receipt of its indexed `createdTxHash` and confirm when the receipt has a
     `ClaimCreated` log from the configured registry with the same creator and digest → `confirmed` (market). This covers sped-up or
     replaced transactions, double sends and crashes before `/submitted`.
  2. Otherwise, for recorded hashes: a successful receipt with the matching log → `mined` (fast feedback; still not final); a
     reverted receipt → keep looking (another hash or an unreported transaction may still succeed) and record the redacted reason.
  3. Only when the read model is not halted and its `indexedBlockTimestamp` has passed `evidenceDeadline − 1 day` (so any successful
     createClaim would already be indexed) and step 1 found nothing and no recorded hash has a successful receipt: → `expired` if no
     recorded hash reverted, else `failed`.
- Responses carrying plans use `planToWire` (`@pine/shared/tx-plan`); tests decode the HTTP response body with `planFromWire` and then
  run `verifyPlan` on the decoded plan (never on the in-memory plan).
- Every transition is audited.

## 7. Integrity of on-chain claims (SEC-CLAIM-03..08, SEC-IDX-08)
Job `claims.verify-integrity` (every 60 s) processes claims from the read model that have no final integrity record:
retrieve the document with `contentStore.retrieve(claimDocumentSha256, 262144)`; `parseClaimDocumentBytes(bytes, digest)`; and
require `document.creator == claim.creator`, repository id, commit, policy sha256 (and the policy exists in the catalog with that
digest, any status), deadlines, min bond, evidence registry, claim registry, title, `marketName == renderQuestion(...)`, and the
document's constant fields equal the deployment manifest (`market.seerMarketFactory`, `collateralToken`, `realitio`, `arbitrator`,
`questionTimeoutSeconds`, both chain ids). Cross-check the creation receipt (`createdTxHash`): it contains Seer's `NewMarket` event
from the configured factory for the same market (SEC-IDX-08). Record
`verified` or `mismatch` (field list) or `document_unavailable` (retry with backoff for 7 days, then final). Only `verified` claims
appear in listings and agent feeds; detail endpoints show every claim with its integrity status. Inputs the frozen TypeScript
renderer refuses (e.g. a `repositoryId` above 2^53 − 1 created by a direct contract call) are a `mismatch` on `question`, never a
job error. Transient failures (RPC, receipt fetch, content-store exceptions other than "not found") are not results: the claim stays
`pending` with backoff and the run continues with the next claim.

## 7a. Listing index
A table owned by this module (`claims_index`: market, integrity status, creator, claim digest, repository id, policy id, deadlines,
created block and log index; NO moderation data) is written by `claims.verify-integrity` and is the only source for public
listings, agent feeds and the integrity backlog, with keyset cursors over (created block, log index). Moderation is applied to each
page at read time with `ctx.moderation.states(pageIds)` (hidden items are dropped from lists, so a page may hold fewer than `limit`
items; detail endpoints annotate them), so a hide applied at any time takes effect immediately. The `phase` filter accepts only the
time-based phases `evidence_open`, `reveal_open` and `closed`, computed in SQL from deadlines with `ctx.clock.now()` as a bound
parameter; each item reports its finer phase from the read model (bounded fan-out: at most `limit` items).

The integrity job runs in two phases so that a run that stops partway never loses claims:
1. Discovery: page `listClaims({ order: "created_desc", limit: 100 })` from the head, collecting claims until the first one already
   in `claims_index` or the end; then insert ALL collected claims as `pending` rows in ONE transaction (`ON CONFLICT (market) DO
   NOTHING`). Any error during the walk inserts nothing, so the next run starts again from the head. Invariant (the read model is
   finalized-only and append-only): every claim older than an indexed claim is indexed.
2. Verification: select rows in `pending`, or in `document_unavailable` whose `next_attempt_at <= now`, ordered by (created block,
   log index), at most 50 per run; each claim is verified independently in its own try/catch and its result is written with a
   compare-and-set update in its own transaction (`getClaim` supplies the read-model record). One claim's failure never aborts the
   others. Required test: a run that throws during discovery and a run whose verification fails for one claim, each followed by a
   clean run, end with every claim indexed and verified.

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
- `GET /api/v1/schemas/claim-document.json` and `/evidence-manifest.json` (from the frozen zod schemas via
  `z.toJSONSchema(schema, { io: "input", target: "draft-7" })`; the frozen schemas contain transforms, so never use them as Fastify
  response schemas). The served documents add a top-level `$comment` stating that text-safety rules, title rules and cross-field
  rules are enforced server-side only. The schema test registers a separate `Fastify({ ajv: { customOptions: { removeAdditional:
  false, coerceTypes: false, useDefaults: false } } })` instance whose body schema is the served JSON Schema (with `$schema`
  removed) and injects the fixtures: valid ones pass, structurally tampered ones (missing required field, unknown property where
  closed, wrong type, pattern violation) fail. The refinements JSON Schema cannot express are tested against the frozen parse
  functions instead.

## 8a. Review fixes carried by claims-006 (claims-005 review)
- Listing eligibility (SEC-CLAIM-06 intent), computed at query time, never stored: migration `0002_` stores only fixed facts —
  `parameters_valid boolean` (decided once at verification against the per-version parameter schema) and the policy sha256 if
  `0001` lacks it. Listings and feeds filter in SQL with `integrity = 'verified' AND parameters_valid AND policy_sha256 =
  ANY($publishable)`, where `$publishable` is the set of currently publishable policy digests from the memoized catalog/config
  loader (status `approved`, or `draft` with `allowDraftPolicies`; family enabled; never `SC-001`). Detail endpoints compute the
  same `listable` flag. A config or catalog change takes effect at the next request; a claim created directly on-chain with
  SC-001 or malformed parameters is never listed.
- A first `POST /publications` racing a `DELETE /drafts/:id`: a foreign-key violation (23503) on the publication insert maps to
  NOT_FOUND ("Preview not found"), never 500. drizzle wraps driver errors, so the code is read through the `cause` chain. The
  test makes the race deterministic by replacing `ctx.quotas.consume` with a fake that deletes the draft and its previews before
  resolving.
- Agent feeds: `GET /api/v1/agents/claims` caps `limit` at 25; list items carry digests, CIDs, URLs and the platform facts but not
  the document body; parsed verified documents are cached by digest (immutable; LRU of 500). ETags (agent feeds, claim lists and
  details) are computed before the expensive work from everything that can change the response: per item the market key, its
  moderation state, its clock-derived phase (or deadlines plus the bound `now` bucket), integrity, `listable`, oracle status and
  resolution facts, plus the read model's indexed block; a matching `If-None-Match` returns 304 cheaply.
- A `block`-moderated claim never exposes its user-content URL (agent detail included).
- Moderated public resources (claim lists, claim details, agent feeds) use `Cache-Control: no-cache` with the ETag so a hide or
  block takes effect immediately even behind a shared cache; policies may stay `max-age=300`.
- Stored drafts are read tolerantly (a draft saved under an older rule still lists and loads) and revalidated with the current
  rules at update and preview, returning a validation error instead of 500.
- The test lock's stale takeover: rename the stale directory to a unique name, re-read the pid inside the renamed directory and,
  if that process is alive (another waiter took over first), put it back when the lock path is free or simply wait and retry;
  only a confirmed-dead owner's directory is removed.

## 9. Required tests (vitest with the frozen harness; name SEC ids in negative tests)
Catalog digest tampering refuses startup; SC-001 FEATURE_DISABLED; draft policies refused when `allowDraftPolicies` is false;
draft IDOR; GitHub error mapping; membership failure blocks preview; preview determinism except nonce/createdAt; attestation
required; deadline rounding and bounds; publication idempotency (same plan twice), plan passes `verifyPlan`, compliance and quota
refusals, NOT_READY when stale; content stored before a plan is returned; reconcile transitions incl. a receipt from the wrong
creator/registry (not confirmed), reverted tx, expiry, and concurrent reconcile runs; integrity: verified, mismatch per field,
document unavailable, a copycat market by another creator flagged, discovery and verification resuming after a partial run (7a),
a renderer-refused input recorded as `mismatch`; listings exclude hidden/unverified; agent endpoints are public, return identical
responses (status, body, no `Set-Cookie`) with and without `x-test-session` and a `Cookie` header (the harness sets the session from
that header on every route; cookie parsing itself is proven by the platform), and label untrusted content; well-known document contents; schema endpoints validate the fixtures.
Also: SC-001 refused at draft creation; 409 on a digest mismatch and on a draft edited after preview; a retried publication after the
claim exists returns the market and no plan; reconciliation confirms through the read model when the user reported a different
(replaced) hash, reported nothing (crash before `/submitted`), or reported a reverted duplicate; `expired` only after chain time passes
evidenceDeadline − 1 day; quota consumed only for new publications; two concurrent identical first requests yield one row and the
same response (no 500); a retry after the plan offer expired returns `planExpired: true` without a plan; compliance refusal on a retry;
deleting a draft without publications removes its previews; preview-to-publish 24 h cap; NOT_READY when the read model is halted;
module registration throws when `config.seer` differs from the manifest.
claims-006 additions: SC-001 refused at preview and at publication (rows inserted directly for the setup; FEATURE_DISABLED and no
preview, publication or plan created); the integrity run verifies at most 50 claims per run, oldest first (assert the count and the
order after one run), and the backoff grows across attempts and is capped at 1 h; a content-store exception other than "not
found" leaves the claim `pending` while the other claims are verified; every publication transition (created, submitted, mined
on request and in reconcile, confirmed, failed, expired) writes its audit entry; `listable` false for an SC-001 claim and for
malformed parameters; the FK race maps to NOT_FOUND; blocked claims expose no user-content URL; moderated resources send
`no-cache`.

## 10. Checks
`pnpm --filter @pine/api typecheck`, `pnpm exec eslint packages/api/src` (typecheck), `node scripts/check-forbidden.mjs` (unit),
`pnpm --filter @pine/api exec vitest run src/modules/claims` (unit).
