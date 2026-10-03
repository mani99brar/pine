# markets lane: coverage matrix

Every required test of PRD-04 section 4 (markets and "both lanes"), every decision in `features/markets/decisions.md`
that binds this lane, and every markets-001 operator clarification, mapped to the test that fails if the behaviour is
removed. Format: `file` > test name. All files are in this directory and run under the `unit` check.

## PRD-04 section 4: markets

| Requirement | Test |
|---|---|
| Manifest validation: wrong submitter | `evidence-content.test.ts` > refuses a manifest naming another submitter |
| Manifest validation: wrong claim (market, document digest, commit) | `evidence-content.test.ts` > refuses a wrong claim: unregistered market, other document digest, other commit |
| Manifest validation: missing artifact / wrong size | `evidence-content.test.ts` > refuses a manifest whose artifact is not stored or has another size |
| Manifest validation: non-canonical | `evidence-content.test.ts` > refuses non-canonical and schema-invalid manifests |
| Manifest over 256 KiB in canonical form (413, nothing stored or consumed) | `evidence-content.test.ts` > refuses a schema-valid manifest over 256 KiB in canonical form with 413: nothing stored, no quota consumed |
| Manifest stored canonically, idempotent by digest, quotas once; locator URLs never fetched (SEC-EVID-09, network spy) | `evidence-content.test.ts` > stores the canonical manifest of the session wallet and is idempotent by digest |
| SEC-EVID-01 size limit enforced while streaming: 413, nothing stored, no quota | `evidence-content.test.ts` > SEC-EVID-01 aborts an oversized upload while streaming: 413, nothing stored, no quota consumed; > SEC-EVID-01 enforces a lower configured limit than one raw block; > accepts an upload of exactly the configured limit |
| SEC-EVID-03 `expectedSha256` mismatch 422 (field before or after the file) | `evidence-content.test.ts` > SEC-EVID-03 compares expectedSha256 only: a mismatch is 422 and nothing is stored or consumed; > SEC-EVID-03 accepts a matching expectedSha256 given after the file |
| SEC-EVID-08 `../../etc/passwd` + bidi file name never stored, returned or logged | `evidence-content.test.ts` > SEC-EVID-08 never stores, returns or logs a client file name (path traversal and bidi characters) |
| Declared media type allowlist, never sniffed | `evidence-content.test.ts` > checks the declared media type against the allowlist without sniffing (415) |
| Upload quotas consumed before storage, once per (user, digest); over quota stores nothing | `evidence-content.test.ts` > SEC-EVID-01 consumes upload quotas atomically before storing; a re-upload of the user's own content is answered from its row; > answers a re-submitted manifest of the same user from its row without storing or consuming again |
| Multipart only on the artifact route | `evidence-content.test.ts` > is the only multipart route, and it refuses JSON; every other route is JSON or public |
| SEC-TX-08 idempotent retries: same key+body identical plan, one quota unit; other body 409; (user, route) scope | `evidence-plans.test.ts` > SEC-TX-08 same key and body returns the identical plan and consumes one quota unit; another body is 409 |
| SEC-TX-08 racing first requests store one plan | `evidence-plans.test.ts` > SEC-TX-08 two concurrent first requests with one key store one plan and both return it |
| SEC-TX-08 Idempotency-Key format (400) | `evidence-plans.test.ts` > SEC-TX-08 requires a well-formed Idempotency-Key |
| QUOTA_EXCEEDED leaves no stored plan | `evidence-plans.test.ts` > a QUOTA_EXCEEDED leaves no stored plan |
| Reopen nonce for a second reopen (hand-computed ids) | `oracle-plans.test.ts` > re-creates the original question exactly; the nonce of a second reopen skips an existing id (hand-computed) |
| Reopen refusals (not too soon, not re-creatable, no free nonce 409) | `oracle-plans.test.ts` > refuses when the question did not settle too soon or cannot be re-created exactly; CONFLICT without a free nonce |
| No route accepts a salt; never stored or logged | `evidence-plans.test.ts` > no route accepts a salt: every JSON POST route of the module refuses it, and it is never stored or logged; `evidence-content.test.ts` > refuses unknown fields (a salt is never accepted anywhere) and missing files |
| Reveal template contains no salt; client builds/verifies the reveal itself; no plan stored | `evidence-plans.test.ts` > returns a salt-free template the client completes and verifies with its own copy of @pine/shared |
| Deadline margins (commit/publish `evidenceDeadline - 60 s`, reveal `revealDeadline - 60 s`) | `evidence-plans.test.ts` > enforces the 60 s submission margin before the evidence deadline (commit and publish); > is only for the submitter's own still-committed submission and before revealDeadline - 60 s |
| Every plan passes verifyPlan and binds to the registered market/question | `evidence-plans.test.ts` > returns a verified one-step commit plan bound to the registered market and the session wallet; > SEC-TX-01 binds what verifyPlan does not: the module refuses unregistered markets, verifyPlan the target; > returns a verified publish plan for a stored manifest of the session wallet; `oracle-plans.test.ts` > builds submitAnswer ... (verifies only for the claim question); > fund-bounty while open; resolve only after a final, non-too-soon answer (verifies only for the claim market); every other oracle plan test decodes with planFromWire and verifyPlan (`verifiedPlan`) |
| Unregistered markets / other registries refused | `evidence-plans.test.ts` > refuses unregistered markets and markets of another claim registry |
| Publish needs the session wallet's stored manifest for that claim | `evidence-plans.test.ts` > refuses when the manifest is not stored, belongs to another submitter or another claim |
| Reveal with unavailable content requires acknowledgement and warns (policy C4) | `evidence-plans.test.ts` > requires acknowledgement and warns when the manifest is not available to adjudicators |
| Evidence listing timeliness at the exact deadline second | `evidence-browse.test.ts` > is strict at the exact deadline second; > joins submissions with stored manifests, timeliness at the exact deadline, availability and the untrusted label |
| Listing never fetches remotely; unparsable manifests reported | `evidence-browse.test.ts` > SEC-EVID-09 never triggers a remote fetch from a listing, and reports unparsable content |
| `retrievable` only on the detail route, cached 10 min | `evidence-browse.test.ts` > computes retrievable through the content store only on the detail route and caches it for 10 minutes |
| Moderation: hidden excluded from listings, shown by id; blocked metadata only (SEC-EVID-11) | `evidence-browse.test.ts` > filters by status, excludes hidden submissions and shows blocked ones as metadata only; > shows hidden submissions by exact id with the reason |
| Public routes identical with or without a session | `evidence-browse.test.ts` > is public: identical responses with or without a session, and 404 for unknown markets (the session response comes from a second app with its own cache, so it is computed, not served from the first app's cache); `accounts.test.ts` > excludes hidden claims and evidence, refuses bad cursors, and is identical with or without a session |
| ERC-1497 output | `evidence-browse.test.ts` > returns ERC-1497 evidence JSON for Kleros jurors with mainnet instructions (no plan); > refuses undisclosed and blocked submissions |
| dueActions for every oracle state (not open, open, answered, pending arbitration per Kleros stage, rejected, finalized, answered too soon/reopen, resolved, withdraw) | `due-actions.test.ts` > every test of "dueActions for every oracle state"; end to end over indexed records: `oracle-plans.test.ts` > derives status, phase and dueActions from the shared full oracle scenario (arbitration, resolution, reopen); > follows Reality's current replacement after a reopen and offers the claim on the original question; > returns facts, derived status, phase, staleness and dueActions; account-specific actions only with an account |
| claimWinnings reconstruction against a hand-computed history | `oracle-history.test.ts` > matches a hand-computed history: last entry first, hash BEFORE each entry, raw commitment id; `oracle-plans.test.ts` > claimWinnings reconstructs the history from the current on-chain hash and refuses a mismatching chain |
| Notification idempotency | `notifications.test.ts` > notifies the claim creator and evidence submitters that have an account, idempotently; > notifies reveal closing, each arbitration stage change and the resolution, once each |
| NOT_READY when stale or halted | `evidence-plans.test.ts` > SEC-IDX-07 refuses with NOT_READY when the read model is stale or halted; > SEC-LEGAL-01 / SEC-IDX-07 refuses on compliance and on a stale or halted read model; `oracle-plans.test.ts` > SEC-IDX-07 NOT_READY when stale; SEC-LEGAL-01 compliance refusal |
| Compliance refusals | `evidence-plans.test.ts` > SEC-LEGAL-01 compliance refusals return no plan (blocked wallet 451, terms 403); `oracle-plans.test.ts` > SEC-IDX-07 NOT_READY when stale; SEC-LEGAL-01 compliance refusal |
| Malformed wei/integer input ("abc", "1.5", "-1", "", 79 digits) is 400 VALIDATION_FAILED, never 500, signed in or anonymous: `bond`, `amount` (zod 4 runs a refine after a failed regex; operator security fix) | `oracle-plans.test.ts` > bond (submit-answer) and amount (fund-bounty), signed in and anonymous |
| Malformed submission ids are 400 (reveal-template body, evidence detail and ERC-1497 params) | `oracle-plans.test.ts` > submission ids (reveal-template body, evidence detail and ERC-1497 params) |
| RPC failure never leaks the provider URL | `oracle-plans.test.ts` > maps RPC failures to UPSTREAM_UNAVAILABLE without leaking the provider URL |

## PRD-04 section 4a: markets-002 review fixes (markets lane)

| Requirement | Test |
|---|---|
| A revert is recorded only from a FINALIZED receipt (`reconcile.ts`) | `plan-store.test.ts` > records a revert only from a finalized receipt (an unfinalized revert may still be reorged away); > confirms other kinds only from a finalized successful receipt whose transaction equals the step (hash 7: unfinalized revert stays `unknown`) |
| Oracle helper routes refuse with NOT_READY when the read model LAGS (all nine routes; no eth_call, plan or quota; exact-lag boundary) | `oracle-plans.test.ts` > SEC-IDX-07 every oracle helper route refuses with NOT_READY while the read model lags (not only when halted) |
| Kleros RequestCanceled stage in dueActions (and home-side ArbitrationFailed) | `due-actions.test.ts` > RequestCanceled: a handled rejection needs no relay step; the question is open again and arbitration can be re-requested |
| A first answer below minBond is refused (exactly minBond accepted) | `oracle-plans.test.ts` > refuses a first answer below minBond (no plan stored; the quota precedes the build, PRD-04 4b) |
| HTTP/global fetch spy proves manifest locators are never fetched (fetch, http/https request/get, socket connect; the spy is shown live) | `evidence-browse.test.ts` > SEC-EVID-09 never fetches a manifest locator: no fetch, HTTP or socket attempt from the listing, detail or ERC-1497 routes; `evidence-content.test.ts` > stores the canonical manifest of the session wallet and is idempotent by digest |
| Upload quota consumed atomically BEFORE storage (quota state recorded at the moment of `put`); a re-upload of the user's own content answered from the existing row (no put, no quota); another user pays their own quota | `evidence-content.test.ts` > SEC-EVID-01 consumes upload quotas atomically before storing; a re-upload of the user's own content is answered from its row; > answers a re-submitted manifest of the same user from its row without storing or consuming again |
| `/markets/:market/oracle` 10 s per-key (market, account) server cache, bounded | `oracle-plans.test.ts` > caches the response per (market, account) for 10 s on the server: repeated requests make no new eth_call; `common.test.ts` > serves an entry until exactly ttl seconds after it was set; > never grows beyond maxEntries: expired entries go first, then the oldest |

## PRD-04 section 4b: markets-003 review fixes (markets lane and "both")

| Requirement | Test |
|---|---|
| `loadOracle` uses the RPC `reopened_questions(original)` id only when the read model's record for it has `reopens === claim.questionId` (or the original's `reopenedBy` names it); otherwise NOT_READY (status route and plan routes); an RPC naming another indexed Pine question is refused | `oracle-plans.test.ts` > uses Reality's reopened_questions id only when the read model links it to the claim's question; otherwise NOT_READY |
| Evidence upload: `evidence_bytes_per_day` consumed FIRST, then `evidence_uploads_per_day`, both before storage; the upload unit is not consumed when the byte quota refuses; when the count quota refuses, the bytes stay spent (deterministic gap of the frozen QuotaGateway, asserted: bytes 200, uploads 1) | `evidence-content.test.ts` > SEC-EVID-01 consumes upload quotas atomically before storing; a re-upload of the user's own content is answered from its row (quota state at `put` is `{ uploads: 1, bytes: 100 }`; byte refusal leaves uploads at 1; count refusal leaves bytes spent) |
| `storeOnce` answers a re-upload from the existing row only while `contentStore.has(sha256)`; otherwise stores again, consuming quota like a first upload (and refuses over quota without storing) | `evidence-content.test.ts` > SEC-EVID-01 stores a re-upload again, paying quota, when the content store no longer has the bytes of the user's row |
| `createOrReplayPlan` order: lookup (user, route, key) -> readiness -> `plans_per_day` -> build -> insert (compliance stays first, before the lookup) | code: `plans.ts` createOrReplayPlan; tests in the two rows below |
| Same-key replay succeeds while the read model is halted (and while it lags); a new key is NOT_READY and burns no quota | `evidence-plans.test.ts` > SEC-TX-08 a same-key replay returns the stored plan while the read model is halted or lagging (lookup before readiness) |
| An exhausted quota makes no RPC call (all nine oracle helper routes: 429 QUOTA_EXCEEDED, `chain.calls` empty, no plan) | `oracle-plans.test.ts` > an exhausted plans_per_day quota refuses every oracle helper route before any eth_call (quota before build) |
| Consequence of the mandated order: a build refused after the quota (422/404) spends its unit and stores no plan | `oracle-plans.test.ts` > refuses a first answer below minBond (no plan stored; the quota precedes the build, PRD-04 4b); `evidence-plans.test.ts` > refuses unregistered markets and markets of another claim registry; > refuses when the manifest is not stored, belongs to another submitter or another claim |
| Registration guard throws for a mismatching questionCategory/questionLanguage | `common.test.ts` > throws for a questionCategory or questionLanguage other than the ClaimRegistry constants |
| Registration guard throws for a Seer/Kleros address (and timeout, foreign chain id) different from the manifest; EIP-55 case accepted | `common.test.ts` > throws for a Seer or Kleros address that differs from the deployment manifest |
| Registration guard throws for maxUploadBytes outside 1..262144 (0, -1, 262145, 1.5, NaN; 1 and 262144 accepted) | `common.test.ts` > throws for evidence.maxUploadBytes outside 1..262144; positive control: > registers every route with the test configuration (positive control) |
| `GET /markets/:market/evidence` 10 s per-(market, status, cursor) server cache, bounded (`BoundedCache`, 2,048 entries) | `evidence-browse.test.ts` > caches a listing per (market, status, cursor) for 10 s on the server; bound: `common.test.ts` > never grows beyond maxEntries: expired entries go first, then the oldest |
| `/markets/:market/oracle` caps concurrent RPC fan-out: at most 4 in flight per process, checked after the 10 s cache lookup; a 5th concurrent miss is refused immediately with RATE_LIMITED (429) and Retry-After, never queued (4 scripted RPC promises held open, then released) | `oracle-plans.test.ts` > caps concurrent RPC fan-out at 4 cache misses: a 5th is refused at once with 429 and Retry-After, never queued (mutation-checked: fails with the cap raised to 40) |
| Fan-out slots are released after errors | `oracle-plans.test.ts` > releases a fan-out slot when the status computation fails (six failures in a row are 502, never 429) |
| An audited tx-hash hint is a NEW {stepId, txHash}; an identical repeated hint is an idempotent replay and is not audited (markets already followed this rule; no change needed) | `plan-store.test.ts` > records hints idempotently, moves planned -> submitted, and is owner-only (exact audit entries for hashes 1 and 2; repeats of 1 and 2 add none) |
| Funding-lane items of 4b (audit log, reconcile freshness gate) | funding lane; markets records plan-created, tx_reported and every reconcile CAS transition (since PRD-07 through the audit outbox, `audit.ts`) and decides expiry only while fresh with a successful `finalizedBlock()` (the finalized gate made explicit and tested in PRD-07) (`plan-store.test.ts` > never expires while the read model is stale, and concurrent runs move a plan once) |

## PRD-04 section 4: both lanes (plan store, history arguments)

| Requirement | Test |
|---|---|
| Same-key retry / different body 409 | see SEC-TX-08 rows above |
| `/submitted` owner-only and idempotent (planned -> submitted) | `plan-store.test.ts` > records hints idempotently, moves planned -> submitted, and is owner-only; > accepts at most 20 hashes per step; repeating a known hash stays accepted |
| Confirmation from read-model facts (commit, publish, submitAnswer) | `plan-store.test.ts` > confirms an evidence commit from the read-model fact (no transaction hash needed); > ignores a commit by another submitter; > confirms a publish from the read-model published fact of that submitter and digest; > confirms submitAnswer from the indexed answer of that answerer with the same answer and bond |
| Confirmation from a finalized successful receipt with to/from/input/value equal to the step | `plan-store.test.ts` > confirms other kinds only from a finalized successful receipt whose transaction equals the step |
| Expiry per kind (commit `evidenceDeadline - 60 s`, oracle created + 1 h, + 1 h grace; 24 h cap) | `plan-store.test.ts` > expires per kind only after expires_at + 1 h: commit at evidenceDeadline - 60 s, oracle helpers at created + 1 h; `evidence-plans.test.ts` > returns a verified one-step commit plan ... (min with created + 24 h); > enforces the 60 s submission margin ... (publish expiresAt) |
| Partial execution -> failed; same-key retry after the outcome returns the stored plan with its state | `plan-store.test.ts` > partial execution becomes failed (claimWinnings on the replacement confirmed, the original claim never sent) |
| Compare-and-set: concurrent reconcile runs move a plan once; no expiry while stale | `plan-store.test.ts` > never expires while the read model is stale, and concurrent runs move a plan once |
| claimWinnings / reportArbitrationAnswer with a commitment entry (second-to-last hash, raw commitment id) | `oracle-history.test.ts` > use the second-to-last record's hash and the raw last answer (a commitment id stays a commitment id); `oracle-plans.test.ts` > reportArbitrationAnswer uses the second-to-last hash and the raw commitment id, self-checked against getHistoryHash |
| Request-time self-check refuses a mismatching chain | `oracle-history.test.ts` > refuses a hash that matches no indexed record, and the self-check catches any misread argument; `oracle-plans.test.ts` > claimWinnings reconstructs ... and refuses a mismatching chain; > reportArbitrationAnswer ... self-checked against getHistoryHash |

## decisions.md (bindings of this lane)

| Decision | Test |
|---|---|
| Evidence: manifests <= 256 KiB, canonical, submitter-bound; artifacts <= 262144 bytes; no salt before reveal | manifest and artifact rows above |
| Oracle: Pine never answers or bonds; Kleros mainnet steps are instructions + ERC-1497 only | `due-actions.test.ts` > answered: ... arbitration on Ethereum as instructions only; `evidence-browse.test.ts` > returns ERC-1497 evidence JSON ... (no plan) |
| verifyPlan on every plan; idempotency key; reconciliation; NOT_READY when stale/halted | rows above |
| Idempotency-Key scoped to (user, route) with body hash, one quota unit per key | `evidence-plans.test.ts` > SEC-TX-08 same key and body ... |
| CAS success only from RETURNING rows; transaction handle only (code: `plans.ts` transitionPlan, `reconcile.ts`) | `plan-store.test.ts` > never expires while the read model is stale, and concurrent runs move a plan once; `evidence-plans.test.ts` > SEC-TX-08 two concurrent first requests ... |
| reopenQuestion targets the original; nonce = smallest free n in 0..15 via getTimeout | `oracle-plans.test.ts` > re-creates the original question exactly; the nonce of a second reopen ...; > refuses when ... CONFLICT without a free nonce |
| Artifact 413 before any store/quota; `expectedSha256` only compared (422) | SEC-EVID-01 / SEC-EVID-03 rows above |
| One plan-store contract: tables, `/api/v1/markets/plans/:planId/submitted`, per-kind expiry, partial = failed | plan-store rows above |
| Reveal plans never store calldata or salt; retries rebuild nothing server-side | `evidence-plans.test.ts` > returns a salt-free template ... (no markets_plans row); > no route accepts a salt ... |
| Account activity: claims and evidence only, answers deferred | `accounts.test.ts` > lists claims created and evidence submitted with one cursor over both lists |
| verifyPlan limits: 10,000 xDAI, maxApprovalAmount 0 | `evidence-plans.test.ts` > SEC-TX-03 at most 10,000 xDAI of value and no approvals at all; `oracle-plans.test.ts` > uses min bond for the first answer and refuses ... above the 10,000 xDAI limit ... |
| Step confirmation rule (finalized receipt + to/from/input/value; evidence/oracle facts) | plan-store confirmation rows above |
| No server-built reveal plan; template only; any `salt` refused | reveal-template and salt rows above |
| Reality history arguments: hash BEFORE each entry, raw answer; self-check against getHistoryHash | history rows above |
| Modules bind what verifyPlan does not (registered market for evidence steps) | `evidence-plans.test.ts` > SEC-TX-01 binds what verifyPlan does not ... |
| `markets.watch`: read-model facts only, <= 200 claims, rotating cursor | `notifications.test.ts` > notifies the claim creator ... (no eth_call); > processes at most 200 claims per run and rotates its persisted cursor; > never notifies while the read model is stale or halted |
| Literal bidi/zero-width characters never in test files | `forbidden` check (Trojan Source) over the `\u` escapes in `evidence-content.test.ts` |
| Public listings never fetch remotely; `retrievable` only on the detail route, 10 min cache | evidence-browse rows above |
| claimWinnings from the current on-chain hash and covering the original settled-too-soon question | `oracle-history.test.ts` > starts from the current on-chain hash after a partial claim ...; `oracle-plans.test.ts` > claimWinnings also covers the original settled-too-soon question after a reopen (hand-computed arguments) |
| Lane-local test app with @fastify/multipart (core options) and a capturing logger; module never registers multipart | `test/helpers.ts` buildMarketsTestApp (a second multipart registration by the module would throw at boot in every file); log assertions in SEC-EVID-08 and salt tests |
| Coverage matrix | this file |

## Operator clarifications (operator-settled: 1-5 from markets-001, 6 from markets-002)

| Clarification | Test |
|---|---|
| 1. PGlite test files serialized by the cross-process lock (`pine-markets-module-tests.lock`), one context per file | `test/lock.ts`, `test/helpers.ts` (scheduling only) |
| 2. Bidi, zero-width and BOM characters only as `\u` escapes in tests | `forbidden` check |
| 3. Notifications at `GET /api/v1/accounts/me/notifications` and `POST /api/v1/accounts/me/notifications/:id/read`, session and owner only | `notifications.test.ts` > marks as read idempotently and hides other users' notifications |
| 4. `markets.watch` notifies only wallets with a `users` row | `notifications.test.ts` > notifies the claim creator and evidence submitters that have an account, idempotently |
| 5. Current question = eth_call `reopened_questions(original)`; an intermediate replacement is a known limitation | `oracle-plans.test.ts` > follows Reality's current replacement after a reopen ...; > re-creates the original question exactly; the nonce of a second reopen ... |
| 6. (markets-002 security fix) every refine after a regex is safe for any input: wei fields re-check the pattern before BigInt | `oracle-plans.test.ts` > bond (submit-answer) and amount (fund-bounty), signed in and anonymous |

Operator-settled in markets-003 (PRD-04 section 4a as revised after the design challenge): upload quota stays consumed
before storage (the frozen gateways cannot refund or delete); two identical concurrent FIRST uploads may consume twice
(accepted, not tested); the oracle status cache is 10 s per (market, account).

Operator-settled in markets-004 (PRD-04 section 4b): the byte quota is consumed before the upload-count quota, and bytes
spent when the count quota then refuses are an accepted, documented gap of the frozen QuotaGateway (tested above); plan
creation consumes `plans_per_day` before building, so a refused build spends one unit per key; public RPC fan-out is
capped at 4 concurrent misses per process (429, never queued).

### All operator-settled choices that bind this lane (restated)

- Evidence: manifests <= 256 KiB canonical and submitter-bound; artifacts <= 262144 bytes; no salt is ever received,
  stored or logged; no server-built reveal plan (salt-free template only, any `salt` refused); reveal template refused
  without stored content unless `unavailableContentAcknowledged: true`.
- Artifact uploads: 413 before any store or quota; `expectedSha256` only compared (422); quotas consumed before storage,
  bytes first then count (4b); a re-upload is answered from the user's row only while the bytes are still stored (4b).
- Oracle: Pine never answers or bonds; Kleros mainnet steps are instructions plus ERC-1497 JSON only; `reopenQuestion`
  targets the original claim question with the smallest free nonce in 0..15 (`getTimeout == 0`); the current question is
  Reality's `reopened_questions(original)`, accepted only when the read model links it to the claim (4b).
- Reality history arguments: hash BEFORE each entry, raw answer (commitment id), claimWinnings from the current on-chain
  history hash and covering the original settled-too-soon question; every claimWinnings/report plan self-checked.
- Plans: `verifyPlan` with 10,000 xDAI / approvals 0; Idempotency-Key per (user, route) with body hash; order
  compliance -> lookup -> readiness -> quota -> build -> insert (4b); NOT_READY when stale or halted; module binds the
  registered market and the session wallet.
- Plan store: `markets_plans`/`markets_plan_steps`, `/api/v1/markets/plans/:planId/submitted`, per-kind expiry,
  confirmation from finalized receipts (or read-model facts for commit/publish/submitAnswer), revert only from a
  finalized receipt, partial execution = failed; only new hints are audited.
- Driver portability: CAS success from RETURNING rows only; explicit int8/count casts; transaction handle only.
- `markets.watch`: read-model facts only, <= 200 claims per run, rotating persisted cursor; notifications only for
  wallets with a `users` row, at `/api/v1/accounts/me/notifications`.
- Account activity: claims and evidence only (answers by wallet deferred).
- Public routes: listings never fetch remotely (`stored` via `has`; `retrievable` only on the detail route, 10 min);
  10 s server caches for the oracle status (per market, account) and the evidence listing (per market, status, cursor);
  RPC fan-out of the oracle status capped at 4 in flight.
- Tests: lane-local test app with @fastify/multipart (core options) and a capturing logger; the module never registers
  multipart; bidi/zero-width characters only as `\u` escapes; PGlite test files serialized by the cross-process lock.

## PRD-07 sections 3, 3c and 3d: api-hardening (markets module)

Each row names the test that fails when the behaviour is removed. "Mutation" is the change that was applied to production
code, run against the named tests (one vitest file filtered by test name, one worker, JSON reporter) and reverted; every
one listed was killed: EACH named test of the row failed under it, and the same tests passed unmutated (baseline run).
Ids M1..M28 are those of the hardening-a-003 mutation run (M1..M21 keep their hardening-a-002 meaning and were re-run;
M22..M28 are new).

| Requirement | Test | Mutation (killed) |
|---|---|---|
| markets.reconcile checks `signal.aborted` between plans: abort before the run starts no plan (no confirmation, no `reconciled_at`) | `hardening.test.ts` > an abort before the run starts no plan: nothing confirmed, no reconciled_at written (through the registered job, `job.run(ctx, signal)`) | M1: delete `if (signal?.aborted) break;` in `reconcilePlans` |
| markets.reconcile abort during a batch: the plan in progress finishes (its transition and queued audit entry are one statement), the second plan is untouched; the aborted run does not flush, the next run records the entry | `hardening.test.ts` > an abort during the first plan finishes that plan and leaves the second untouched (abort from inside the first plan's `listEvidence`; registered job) | M1 |
| markets.watch checks the signal between listing pages: abort before the run lists no claim | `hardening.test.ts` > an abort before the run lists no claim, inserts nothing and keeps the cursor (registered `markets.watch` job, `job.run(ctx, signal)`) | M2: delete `&& !signal?.aborted` in the listing loop |
| markets.watch checks the signal between claims: abort during the first claim leaves the second untouched | `hardening.test.ts` > an abort during the first claim leaves the second claim untouched and the cursor where it was (abort from inside the first claim's `getOracleQuestion`; registered job) | M3: delete `if (signal?.aborted) break;` in the claim loop |
| markets.watch: an aborted run does not persist the rotated cursor past claims it never processed | same test (`markets_watch_state` stays empty) | M4: delete the post-loop `if (signal?.aborted) return …` |
| reconcile decides `expired`/`failed` only when the read model is fresh AND `finalizedBlock()` succeeded in this attempt | `hardening.test.ts` > finalizedBlock() throws for a plan past expires_at + 1 h: the plan state is unchanged; the next run expires it | M5: drop `context.finalized !== null &&` from the expiry condition |
| SEC-OPS-07 outbox: an outage keeps the row; the next write (a NEW hint) records it exactly once and deletes the row | `hardening.test.ts` > SEC-OPS-07 an audit outage keeps the plan-created entry in the outbox; the next write records it exactly once | M6: delete the flush after the hint write (`plans.ts`) |
| 3d SEC-OPS-07 atomicity, plan insert: the `markets.plan.created` outbox INSERT is a CTE of the plan INSERT; when it fails the request fails and neither the plan nor its steps are committed | `hardening.test.ts` > SEC-OPS-07 a plan insert whose outbox INSERT fails is refused and commits no plan and no step (outbox INSERTs made to fail with `ALTER TABLE markets_audit_outbox ADD CONSTRAINT outbox_fail CHECK (false) NOT VALID`, dropped in `finally`) | M24: the outbox INSERT as a separate statement after the plan insert |
| 3d atomicity, new hint: the `tx_reported` outbox INSERT is a CTE of the hint INSERT; when it fails the request fails, no hint is stored and the plan stays `planned` | `hardening.test.ts` > SEC-OPS-07 a new tx-hash hint whose outbox INSERT fails is refused: no hint stored, the plan stays planned | M25: the outbox INSERT as a separate statement after the hint insert |
| 3d atomicity, reconcile transition (`transitionPlan`, shared by confirmed, failed and expired): when the outbox INSERT fails the CAS is not committed (plan stays `planned`) and the next run moves and audits it | `hardening.test.ts` > SEC-OPS-07 a confirmed transition whose outbox INSERT fails is not committed; the next run confirms and audits it; > SEC-OPS-07 an expired transition whose outbox INSERT fails is not committed; the next run expires and audits it (`failed` is the same `transitionPlan` call as `expired`, only `to` differs) | M26: the outbox INSERT as a separate statement after the CAS; M9 |
| 3d atomicity, evidence upload: the first upload's outbox INSERT is a CTE of the `markets_uploads` INSERT (failure: request fails, no upload row); a restored upload's single-statement outbox INSERT failing fails the request (never a 201 without a queued entry) | `hardening.test.ts` > SEC-OPS-07 an evidence upload whose outbox INSERT fails is refused: no upload row (first upload), no silent loss (restored upload) | M27: the first-upload outbox INSERT as a separate statement after the upload insert; M28: the restored-upload outbox INSERT failure swallowed; M14; M15 |
| Flush on a same-key replay | `hardening.test.ts` > SEC-OPS-07 a same-key replay flushes an entry left by an outage | M7: delete the flush in `replay` |
| Flush at the START of every reconcile run, before the "no open plans" case | `hardening.test.ts` > SEC-OPS-07 a reconcile run with no open plans flushes an entry left by an outage | M8: delete the flush at the start of `reconcilePlans` |
| Several pending entries of one plan (created, tx_reported, confirmed) all survive an outage and are recorded once each with unchanged details; the reconcile transition queues its entry in the `transitionPlan` statement | `hardening.test.ts` > SEC-OPS-07 several pending entries of one plan (created, tx_reported, confirmed) all survive an outage (also killed by the two 3d transition tests) | M9: `transitionPlan` without the `queued` CTE (the confirmed entry is lost) |
| `flushAudit` checks `signal.aborted` before each entry: an abort between entries leaves the unrecorded rows | `hardening.test.ts` > SEC-OPS-07 an abort between entries leaves the unrecorded rows in the outbox | M10: delete `if (signal?.aborted) return;` in `drain` |
| 3c single-flight: one in-flight flush per module and database handle; a call while it runs sets the coalesced rerun flag and drains again before the shared promise settles; in-process triggers never double-record | `hardening.test.ts` > SEC-OPS-07 single-flight: a flush called while one is recording drains again; both entries are recorded once when it resolves (first flush held at `ctx.audit.record`, second row queued, second call, release) | M11: delete `running.rerun = true` (the second call returns the in-flight promise without draining again) |
| 3c flushAudit robustness: the single-flight entry is cleared in `finally`, so a rejected drain never wedges later flushes | `hardening.test.ts` > SEC-OPS-07 a drain that rejects clears the single-flight entry: the next flush still records the pending entry (record fails once and the failure path throws once) | M12: clear the entry only after a fulfilled drain |
| 3c request path: audited writes start the flush without awaiting it (`flushAuditInBackground`; errors caught and logged through `safeErrorMessage(…, ctx.redact)`); the outbox row is already committed with the write | `hardening.test.ts` > SEC-OPS-07 an audit store that never resolves does not delay the plan response; the committed row is recorded later (raw inject; a 5 s race) | M13: `await flushAudit(ctx)` after the plan insert |
| 3c request path: a failing background flush never fails the response; the error is logged through the redactor | `hardening.test.ts` > SEC-OPS-07 a failing background flush never fails the response and is logged redacted (the error text carries a configured secret) | M21: log `String(error)` instead of `safeErrorMessage(error, ctx.redact)` |
| 3c test-harness rule: `buildMarketsTestApp` wraps `app.inject` so every response waits for the module's in-flight flush (`settledAudit`, which requests no further drain); `rawInject` bypasses it | every existing exact-match audit test (`plan-store.test.ts`, `evidence-content.test.ts`, `oracle-plans.test.ts`) passes unchanged | test support, not production behaviour |
| Evidence upload audits through the outbox: CTE on the `markets_uploads` INSERT (first upload), one plain outbox INSERT for a restored upload whose INSERT conflicts; same action and details; an outage loses no entry | `hardening.test.ts` > SEC-OPS-07 an audit outage during evidence uploads loses no entry (first upload and restored upload) (M14 and M15 also kill the 3d upload test); `evidence-content.test.ts` audit assertions unchanged | M14: delete the restored-upload `queueAudit`; M15: drop the first-upload `queued` CTE |
| `ctx.audit` is record-only (frozen `AuditLog.record`); never cast or duck-typed | code: `audit.ts` calls only `ctx.audit.record` | review |
| Audit details unchanged (no outbox id); existing exact-match audit tests unchanged | `plan-store.test.ts`, `evidence-content.test.ts` (files unchanged, passing) | n/a |
| loadOracle accepts a replacement linked only through the original's `reopenedBy` and refuses one linked by neither | `hardening.test.ts` > accepts a replacement linked only through the original's reopenedBy, and refuses one linked by neither | M16: drop `&& original?.reopenedBy !== currentId` |
| Evidence detail `contentStore.retrieve` cache misses: own limiter, at most 4 in flight per process; a 5th concurrent miss is 429 RATE_LIMITED with Retry-After at once; the limiter wraps the call OUTSIDE the `retrievable: false` conversion, so a refused call caches nothing | `evidence-browse.test.ts` > caps concurrent retrieve cache misses at 4: a 5th is 429 at once and caches nothing; slots are released | M17: call the store without the limiter |
| 3c separate limiters: with the 4 oracle slots held, the detail route's retrieve still gets a slot; with the 4 retrieve slots held, the oracle status still gets one | `evidence-browse.test.ts` > four oracle misses holding every slot of the oracle limiter leave the evidence detail retrieve its own slot; > four retrieve misses holding every slot of the retrieve limiter leave the oracle status its own slot | M18: the detail route uses `state.oracleFanOut` instead of `retrieveFanOut` |
| SEC-EVID-11: the listing caches only the read-model page (claim, page, freshness); moderation and manifests are computed at serve time; the listing is sent with `Cache-Control: no-store` (`sendPublic` takes a cache-control parameter) | `evidence-browse.test.ts` > SEC-EVID-11 blocking the evidence after a cached listing removes the manifest from the next listing; sent with no-store; > SEC-EVID-11 blocking the content after a cached listing removes the manifest from the next listing | M19: listing sent as `public, max-age=10`; M20: moderation cached with the listing |
| Detail and ERC-1497 responses (they carry manifest text and moderation) are also `no-store` (safer reading; open assumption) | `evidence-browse.test.ts` > SEC-EVID-11 the detail and ERC-1497 routes are sent with no-store too | M22: detail route without `no-store`; M23: ERC-1497 route without `no-store` |

Outbox atomicity (3d): every audited write's outbox INSERT is part of the write's own SQL statement (a data-modifying CTE),
so the write and its pending entry commit or fail together; the restored upload, whose event has no row of its own, uses a
single-statement outbox INSERT and fails the request when it fails. A separate statement after the write is the only
placement that can lose an entry (write committed, entry not); M24..M27 apply exactly that and are killed. (A separate
statement BEFORE the write could only leave a spurious entry, never lose one, and is not distinguishable by these tests.)

At-least-once audit (SEC-OPS-07): a crash between `record` and the outbox `DELETE`, or a flusher in another API process,
can only duplicate an entry, never lose one. Duplicates are identified by the event's natural key: (action, subjectId) for
`markets.plan.created/confirmed/failed/expired` and `markets.evidence.*_uploaded` (plus `details.restored`), and (action,
subjectId, details.stepId, details.txHash) for `markets.plan.tx_reported`. A `record` failure stops the flush with the row
kept (no claim step, no re-insert). Flushes start (not awaited) after each audited write on the request path, on a
same-key replay (and a repeated hint or re-upload answered from its row), and are awaited at the start of every reconcile
run and after each reconcile transition. Each drain reads at most 50 entries.

Accepted (PRD-07 3c, recorded here as required):
- Outbox rows hold the request IP (`entry.ip`) until they are flushed, bounded by the flush cadence (the request's own
  background flush, the next audited write or replay, and every reconcile run), and are deletable by `pine_api` until
  flushed: inherent in the outbox design; accepted.
- The evidence listing's per-request cost: moderation queries and up to 50 manifest reads per response (nothing rendered
  is cached), bounded by the platform rate limit; accepted.

Operator-settled choices this lane keeps (PRD-07 sections 3/3c/3d, `features/hardening/decisions.md`):
- Audited events are exactly the existing ones (plan created; a NEW tx-hash hint `tx_reported`, which is also the audit of
  planned -> submitted; reconcile confirmed/failed/expired) plus the evidence upload audits through the same outbox.
- `ctx.audit` is record-only; one outbox table per module in a new migration; same-statement CTE inserts; at-least-once
  with unchanged details; `flushAudit` single-flight per module and database handle (one in-flight promise plus a
  coalesced rerun flag, cleared in `finally`).
- The request path never awaits the flush; the module test helpers await the module's single-flight flush after each
  response, and the "never resolves" test uses a raw inject.
- Per-route limiters (4 in flight per process), not shared with the oracle limiter; refusal is 429 RATE_LIMITED.
- 3d: outbox atomicity is tested by making the outbox INSERT fail on PGlite with a `CHECK (false) NOT VALID` constraint
  (test-only DDL, dropped after each test); no production change was needed for 3d.
- Contract changes are limited to the EvidenceRegistry SafeCast; each lane ships this coverage matrix and the independent
  coverage reviewer blocks on gaps.
- The API keys claims only by registry addresses (copycat markets sharing Pine's question, condition and INVALID token are
  accepted); verification runs vitest with one worker.

## Not covered by an executed check

- node-postgres driver behaviour (tests run on PGlite only).
- The real platform's multipart/CSRF/body-limit interplay (only the lane-local test app is exercised).
- Live Reality.eth acceptance of reconstructed claimWinnings/report/reopen arguments (mirrored self-checks and hand-computed ids only).
- Remote IPFS gateway retrieval behind `contentStore.retrieve` (MemoryContentStore remote map only).
- The accepted double consumption of two identical concurrent first uploads (a race, not exercised).
- dueActions omits `withdraw` while the current (reopened) question is not indexed yet (transient; the Reality balance
  is still shown under `chainReads.balance`). Since 4b the status route answers NOT_READY in that window unless the
  original's `reopenedBy` already names the replacement.
- (PRD-07) Moderation changes now apply to the next listing response (the cache holds only the read-model page). A
  submission indexed inside the 10 s window still appears only after the window.
- The fan-out cap is per process (several API processes multiply it); not exercised across processes.
- (PRD-07) Cross-process duplicate audit entries (two API processes flushing at once): accepted at-least-once, not exercised.
- (PRD-07) A crash between `record` and the outbox `DELETE` (duplicate entry): not exercised.
- (PRD-07) The retrieve and oracle limiters are per process (several API processes multiply them).
- (PRD-07) A rejected flush (an unexpected failure; an audit outage never rejects) at the start of a reconcile run
  propagates and the platform logs and retries the job; after a transition it counts as that plan's error. Not exercised.
