# PRD-07: Pre-deployment hardening (feature `hardening`)

Follow-up fixes found by the operator's independent security reviews and by feature reviews after the owning feature had merged.
Two lanes, launched separately with `launch hardening --workers <lane>`: `contracts-hardening` as soon as it is launched (the
contracts, deploy script and e2e suite are merged), `api-hardening` after the claims, markets and funding modules are merged.
Contracts are immutable once deployed, so every contract change here lands before any deployment.

## 1. Lanes and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `contracts-hardening` | `contracts/src/EvidenceRegistry.sol`, `contracts/test/{evidence-registry,claim-registry,fork,e2e}`, `contracts/script`, `scripts/fixtures` |
| `api-hardening` | `packages/api/src/modules/{claims,markets,funding}`, `packages/api/migrations/{claims,markets,funding}` (new files only) |

## 2. contracts-hardening
- EvidenceRegistry: replace the three `uint64(block.timestamp)` casts (commit, reveal, publish) with `SafeCast.toUint64`
  (behaviour unchanged; project rule for narrowing). This item is exempt from the "test that fails when the behaviour is
  removed" rule: each cast follows a strict check against a uint64 deadline returned by a validated ABI decode, so the SafeCast
  revert branch is unreachable and no test can distinguish the two; the change is verified by review and the existing suites
  must keep passing.
- Fork test (Gnosis block 48550000, within the RPC budget: one direct `createCategoricalMarket` plus one `createClaim`): a copycat
  Seer market created directly with Pine's question and swapped token names BEFORE `createClaim`; assert `createClaim` succeeds,
  Pine's record carries its own market and PY_/PN_ tokens, the questionId, conditionId and INVALID token equal the copycat's, the
  YES/NO wrappers differ, and the registry records only Pine's market.
- Regression tests: maximum-size `createClaim` on the fork (120-byte title, repositoryId 2^53 - 1, maximum windows, 10,000 xDAI
  min bond) stays below 5M gas (measured 3.37M first creation, 2.70M twin); a `Deploy.run()` dry run (no broadcast) produces
  exactly two CREATEs at nonces n and n+1 with the binding asserted.
- EvidenceRegistry invariant: an `afterInvariant` (or invariant) asserts that at least one honest reveal succeeded during the
  campaign, so the transition invariant cannot pass vacuously.
- e2e tightening: replace the bare `vm.expectRevert()` before `RealityProxy.resolve` with the specific not-finalized revert; fix
  or remove the vacuous `vm.getNonce(deployer) == 0` assertion; one `SeerImmutableMismatch` test per getter (eight); the vector
  script emits the Deploy.s.sol constants it relies on from `GNOSIS_EXTERNAL` into `PlanInputs.sol` and a test asserts the script's
  constants equal them; the vector script rewrites `fork-observations.json` canonically (sorted keys) and `--check` covers it.

## 3. api-hardening (markets and funding modules; run after markets-004 merged at a586a8f)
- Cooperative abort: every markets job (reconcile, watch) and the funding reconcile job checks `signal.aborted` between batches
  and stops promptly without starting another batch or leaving a half-applied state change; tests abort before and during a batch.
- markets/reconcile.ts decides `expired`/`failed` only when the read model is fresh AND `ctx.chain.finalizedBlock()` succeeded in
  this attempt (as funding does). Test: finalizedBlock() throws for a plan past expires_at + 1 h → plan state unchanged.
- funding/reconcile.ts: when a step compare-and-set returns no row because another run already confirmed the step, re-read the
  step and count it as confirmed, so expiry never records a partial execution as `expired` with confirmedSteps 0. Test with a
  step confirmed between read and CAS (injected pre-existing confirmation).
- Audit atomicity (SEC-OPS-07, both modules; operator decisions after the design challenge):
  - Audited events are exactly the existing ones: plan created, a NEW tx-hash hint (`tx_reported`, which is also the audit of
    the planned→submitted move; no separate `submitted` entry), and the reconcile transitions confirmed, failed and expired.
    Existing audit tests stay as they are.
  - `ctx.audit` is record-only (frozen `AuditLog.record`); never cast or duck-type it to reach a platform method.
  - The markets evidence upload audits (`markets.evidence.{artifact,manifest}_uploaded`, evidence-content.ts) go through the
    markets outbox too: an outbox CTE on the `markets_uploads` INSERT for a first upload, and a plain single-statement outbox
    INSERT for a restored upload whose INSERT conflicts. Their entries keep today's action and details, so the existing
    evidence-content tests stay unchanged; add a test that an audit outage during an upload loses no entry.
  - `flushAudit` is single-flight per module and database handle inside one process (one in-flight promise chain; a call while a
    flush runs waits for it and then flushes again), so in-process concurrent triggers never double-record; at-least-once is
    the cross-process guarantee.
  - One outbox table per module in a new migration (`markets_audit_outbox`, `funding_audit_outbox`: id uuid PK, entry jsonb,
    created_at). Each audited write inserts its outbox row in the SAME SQL statement as the write (an extra CTE:
    `WITH moved AS (UPDATE … RETURNING …) INSERT INTO …_audit_outbox SELECT … FROM moved`), so no multi-statement transaction
    is needed. A `flushAudit(ctx, signal)` helper reads `SELECT id, entry FROM …_audit_outbox ORDER BY created_at, id LIMIT 50`
    and for each row: checks `signal.aborted`, awaits `ctx.audit.record(entry)`, then `DELETE … WHERE id = $1`; when `record`
    throws, the row stays and the flush stops (no claim step, no re-insert). It runs after each audited write, on a same-key
    replay, and at the START of every reconcile run (before any early return for "no open plans").
  - Audit `details` are unchanged (no outbox id; the existing exact-match audit tests stay as they are). The guarantee is
    at-least-once: a crash or a concurrent flusher can only duplicate an entry, never lose one; duplicates are identified by the
    event's natural key ((action, subjectId), plus stepId and txHash for tx_reported). Document this in the coverage matrix.
  - Tests: the audit gateway throws once → the outbox row remains, and the entry is recorded exactly once by the next flush
    (after a later write, a replay, or a reconcile run with no open plans) and the row is deleted; several pending entries for one
    plan all survive an outage; an abort between entries leaves the unrecorded rows in the outbox.
- Public RPC/gateway fan-out caps: `GET /api/v1/markets/:market/liquidity` (funding) and the markets evidence detail route's
  `contentStore.retrieve` cache misses each get their OWN per-route limiter (at most 4 in flight per route per process; do not
  share the oracle limiter), refusing a 5th concurrent miss immediately with ApiError RATE_LIMITED 429 and retryAfterSeconds.
  The limiter wraps the call OUTSIDE any try/catch that converts errors into `retrievable: false`; a refused call writes
  nothing to the cache. Deterministic tests (hold 4 promises, the 5th gets 429, the cache holds no false entry, release).
- SEC-EVID-11: the evidence listing caches only the read-model page (ids and on-chain fields), never rendered manifest text;
  moderation states and manifests are computed at serve time for each response. `sendPublic` takes a cache-control parameter
  and the listing is sent with `Cache-Control: no-store`. Tests: block evidence, and separately block content, after a cached
  listing → the next listing omits the manifest; the header is no-store.
- Cooperative abort is largely present (markets reconcile, watch notifications, funding reconcile check `signal.aborted` per
  item): the work is tests. "Before" aborts the signal before the run; "during" aborts from inside a fake (a scripted chain
  response or read-model call of the first item) and asserts the second item is untouched. Each existing check is shown
  necessary by a mutation run (delete it → the test fails), recorded in the coverage matrix.
- Tests: funding history items show reconciled plan state, step states and confirmedTxHash; loadOracle accepts a replacement
  linked only through the original's `reopenedBy` and refuses otherwise.
- Claims items (job abort for claims reconcile/integrity, catalog policy-text pinning) are carried by a later claims-hardening
  lane after the claims feature merges.

## 3c. hardening-a-001 review fixes (carried by hardening-a-002; markets and funding)
- Single-flight flush test (both modules): hold the first flush at `ctx.audit.record`, queue a second outbox row, call
  `flushAudit` again, release; assert both entries are recorded exactly once and the outbox is empty when the second call
  resolves (fails if flushAudit returns the in-flight promise without draining again).
- Separate limiters: a test fills the 4 oracle slots and asserts the evidence-detail retrieve still gets a slot (and the reverse),
  failing if `retrieveFanOut` were replaced by the oracle limiter; likewise the liquidity limiter vs the positions limiter.
- flushAudit robustness: the single-flight entry is cleared on rejection as well as fulfilment (a rejected drain never wedges
  later flushes); test with a drain that rejects once.
- Request path: audited writes trigger the flush without awaiting it (fire-and-forget, errors caught and logged through the
  redactor), so an audit backlog or a slow audit store never delays or fails the user's request; the outbox row is already
  committed with the write. Test: an audit store that never resolves does not delay the plan response.
  Test-harness rule (operator decision after the design challenge): the module test helpers inside the owned paths
  (markets `test/helpers.ts`, funding `test/harness.ts` and their inject wrappers) await the module's single-flight flush
  after each response, so the existing exact-match audit tests keep passing unchanged; the "never resolves" test uses a raw
  inject. Single-flight is one in-flight promise plus a coalesced "rerun requested" flag, cleared in `finally`.
- Cooperative abort tests go through the registered jobs (`job.run(ctx, signal)`) for markets watch and funding reconcile too.
- Record in the coverage matrix: outbox rows hold the request IP until flushed (bounded by the flush cadence) and are
  deletable by pine_api until flushed (inherent in the outbox design; accepted); the evidence listing's per-request cost
  (moderation queries and up to 50 manifest reads; bounded by the platform rate limit; accepted).

## 3d. hardening-a-002 review fixes (carried by hardening-a-003; markets and funding)
- Outbox atomicity test (coverage P1, SEC-OPS-07), both modules: make the outbox INSERT fail deterministically on PGlite
  (`ALTER TABLE <module>_audit_outbox ADD CONSTRAINT outbox_fail CHECK (false) NOT VALID`), then drive each audited write
  (markets: plan insert, new hint, transition, evidence upload; funding: plan insert, hint append, transition) and assert the
  request or transition fails and its plan, hint, transition or upload row was NOT committed. The tests fail if any outbox
  INSERT is moved into a separate statement. Map the COVERAGE.md SEC-OPS-07 rows to these tests.

## 3b. claims-hardening (claims module; run after claims-010 merged at 74659eb)
- Cooperative abort: claims reconcile and integrity jobs (including discovery and backfillParameters) check `signal.aborted`
  between items and stop promptly; tests abort before a run and from inside a fake during the first item (second untouched);
  mutation evidence that each check is needed.
- Policy-text pinning: `POST /publications` puts the digest-verified catalog policy text idempotently into `ctx.contentStore`
  (which pins it) next to the claim document before returning a plan, so the `ipfs://<policy cid>` referenced by every
  immutable question stays retrievable; registration may also put them. A plan is returned only after both puts succeeded
  (a failing put → 503 NOT_READY, no plan). Tests: after a plan is returned the store holds the policy bytes under its digest;
  a failing put returns no plan.
- SEC-GH-12 at publish: `assertRepositoryStillPublic` also compares the returned owner login and name (case-insensitive) with
  the frozen `document.target.repository`; a mismatch (renamed or transferred since preview) refuses with 409 CONFLICT
  ("repository changed since preview; create a new preview") and no plan. The publish recheck keeps consuming one
  `github_calls_per_hour` unit (it is a real upstream call; operator decision), and that refusal returns no plan. Tests.
- New-row path: a first `POST /publications` for a preview whose plan offer already expired (now >= planExpiresAt) is refused
  with 409 CONFLICT ("plan offer expired; create a new preview") without calling GitHub, consuming `publications_per_day` or
  inserting a row (no publication exists to return). Test.
- Integrity: `evaluateClaim` requires `claimCreatedMarkets(receipt, claim.registry, claim.creator, claim.documentSha256)` to
  include `claim.market` (the creation receipt proves registry, creator and digest; the read model is not trusted alone);
  otherwise `mismatch` on `creation`. A missing receipt or an RPC failure is a TransientError (retried with backoff, never a
  final verdict). Tests: a read model whose creator differs from the receipt's ClaimCreated event → mismatch; a null receipt →
  still pending with backoff.
- Verification starvation: each integrity run takes up to 50 never-attempted rows (attempts = 0, oldest first) AND up to 50
  retry rows (attempts > 0, ordered by next_attempt_at), so retries of unavailable documents can never crowd out new claims.
  Test: 60 always-due unavailable rows plus one new claim → the new claim is verified in the first run.
- Finality instead of reopen (operator decision after design challenge attempt 2): a publication becomes `mined` only from
  finalized evidence: the market from the finalized read model (`indexedMarket`), or a succeeded hint whose receipt is in a
  block at or below the read model's covered (finalized) block. A finalized success cannot be reorged, so reconcile step 2a
  (reopen of a `mined` publication) is REMOVED and a `mined` publication is never reopened. A `marketOf` hit at `latest` alone
  (on the request path or in reconcile) never moves the state and withholds the plan: POST /publications answers 503 NOT_READY
  with retryAfterSeconds 30 ("the claim is being created on chain; retry when it is final"), state unchanged, no plan.
- Rewritten tests (operator decision; the "keep every existing test passing" constraint does not apply to tests whose
  expectations encode behaviour this section replaces): in publication.test.ts the tests that expect `mined` from a latest-only
  `marketOf` hit (around lines 236, 432, 545, 806) now expect 503 NOT_READY, state unchanged and no plan, and `mined` only after
  the market is indexed; the "first request after expiry" part of the plan-expiry test now expects 409 CONFLICT; in
  reconcile.test.ts the reopen tests now assert a finalized `mined` publication is never reopened. Every rewritten test is
  listed in the completion with its reason; no other existing test may change.
- Audit atomicity (SEC-OPS-07): claims audit writes (publication created, hint reported, transitions, integrity verdicts) use a
  `claims_audit_outbox` with the flush design of section 3 (single-flight record-then-delete flush at the start of every claims
  job run and after each audited write, at-least-once, details unchanged). Rule for claims: the audited write and its outbox
  INSERT commit in the same transaction. Writes already inside `ctx.db.transaction` (publication insert, hint + mined,
  integrity writeResult) add the outbox INSERT as a second statement in that transaction, so statement shapes and the lock-order
  trace test stay unchanged; bare single-statement writes (tx_reported insert, a transition outside a transaction) use a CTE.
  Tests as in section 3.
  The claims test harness's per-test table truncation list includes `claims_audit_outbox` (and every new table of this lane).
- Tests: the 8d recovery assertion in `publication.test.ts` (recovery after the UPSTREAM outage) asserts the status code 200 and
  a non-null plan (the reconcile "retry after reopen" case no longer exists: reopen is removed); the existing-row order test (publish, make the repository
  private or GitHub rate-limited, advance past planExpiresAt, retry → 200, plan null, planExpired true, no GitHub call).

## 3e. hardening-cl-001 review fixes (carried by hardening-cl-002; claims)
- Outbox atomicity tests (coverage P1, SEC-OPS-07): with the outbox INSERT refused (`CHECK (false) NOT VALID` on
  claims_audit_outbox), drive EVERY audited write and assert the state, the hint status and the outbox are all unchanged:
  the reconcile hint→mined transaction (a finalized succeeded receipt), the request-side `mined` transition, the `submitted`
  transition (reached with a refusal that lets the hint CTE succeed, e.g. a constraint that rejects only the submitted
  action), the publication insert, the tx_reported hint, the `confirmed` transition and the integrity verdict. Each test fails
  if its outbox INSERT is moved out of the write's statement or transaction. Map the COVERAGE.md rows to these tests.

## 3f. hardening-cl-002 security follow-up (carried by hardening-cl-003; claims)
- Finality of every final decision (SEC-IDX-01, SEC-IDX-06; operator decision after the design challenge): compute one bound
  per reconcile run and per request, F = `status().finalizedBlock` ?? `await ctx.chain.finalizedBlock()` (null on failure,
  meaning no final decision), and route EVERY irreversible decision through one predicate `isFinal(block) = F !== null &&
  block <= F`: the request-path `mined` transition and reconcile step-1 `confirmed` (on the claim's creation block, with the
  read model serving the claim for this creator and digest), hint `succeeded`/`reverted` (replacing `coverage.indexedBlock`),
  and the expiry coverage. The read-model `indexedBlock` is never used as finality (Envio serves non-final rows and reports
  finalizedBlock null). Drop the hint→mined transaction entirely: a hint only sets its own status and withholds the plan
  (503 NOT_READY, retryAfterSeconds 30) or holds back expiry.
- Test harness default (operator decision): the claims helpers' markFresh/markIndexedAt pass finalized = indexedBlock
  (native-like), so existing tests keep their meaning; the Envio fallback (finalizedBlock null → `eth_getBlockByNumber`
  'finalized') is tested only in NEW tests that script that call. Tests: Envio-like status with the claim above the chain's
  finalized block → not mined/confirmed; at or below → mined/confirmed; finalizedBlock() failure → unchanged; a reverted or
  succeeded receipt above F → hint stays unknown; a succeeded receipt whose claim the read model does not serve → no plan, not
  mined. Existing tests that expected `mined` from a receipt alone are rewritten to this rule and listed in the completion; no
  other existing test may change beyond the harness default.
- Request path: POST /publications and POST /publications/:id/submitted trigger the audit flush without awaiting it (copy the
  markets flushAuditInBackground / settled-audit / raw-inject pattern unchanged; errors caught and logged through the redactor); the claims test helpers await the module's
  single-flight flush after each response so the existing audit tests stay unchanged; a test proves a never-resolving audit
  store does not delay the response.
- `outboxSelect` generates the outbox id per row (`gen_random_uuid()` in SQL, or one id per returned row), not one constant;
  test with a source returning two rows.

## 4. Checks
contracts-hardening: `forge build`, `export-abis --check`, the plan-vector `--check`, forge unit tests (claim-registry and
evidence-registry), the fork tests, the e2e tests, `check-forbidden`. api-hardening (and claims-hardening with `src/modules/claims`): `pnpm --filter @pine/api typecheck`,
`eslint packages/api/src`, `check-forbidden`, `vitest run src/modules/markets src/modules/funding` (single vitest worker in verification).
