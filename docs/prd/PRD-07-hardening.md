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
  - One outbox table per module in a new migration (`markets_audit_outbox`, `funding_audit_outbox`: id uuid PK, entry jsonb,
    created_at). Each audited write inserts its outbox row in the SAME SQL statement as the write (an extra CTE:
    `WITH moved AS (UPDATE … RETURNING …) INSERT INTO …_audit_outbox SELECT … FROM moved`), so no multi-statement transaction
    is needed. A `flushAudit(ctx, signal)` helper claims rows with `DELETE … RETURNING`, calls `ctx.audit.record` with the outbox
    id in `details`, and re-inserts a row whose record throws. It runs after each audited write, on a same-key replay, and at
    the START of every reconcile run (before any early return for "no open plans"), checking `signal.aborted` between entries.
  - The guarantee is at-least-once (a crash between record and claim can duplicate an entry; the outbox id in details lets an
    operator de-duplicate); document it so in the coverage matrix.
  - Tests: the audit gateway throws once → the entry is recorded by the next flush (after a later write, a replay, or a
    reconcile run with no open plans), with its outbox id; several pending entries for one plan all survive an outage.
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

## 4. Checks
contracts-hardening: `forge build`, `export-abis --check`, the plan-vector `--check`, forge unit tests (claim-registry and
evidence-registry), the fork tests, the e2e tests, `check-forbidden`. api-hardening: `pnpm --filter @pine/api typecheck`,
`eslint packages/api/src`, `check-forbidden`, `vitest run src/modules/markets src/modules/funding` (single vitest worker in verification).
