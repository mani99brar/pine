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
- Audit atomicity (SEC-OPS-07, both lanes): the audit entry for a plan insert, a new tx-hash hint and every state transition is
  never lost. If `ctx.audit.record` can join the same database transaction (check the frozen gateway), write it in that
  transaction; otherwise store an `audit_pending` marker column/row in the same transaction as the write and clear it after
  `ctx.audit.record` succeeds, and have the module's reconcile job re-record pending entries (idempotent per entry id). A
  same-key replay of a plan whose creation audit is still pending re-records it. Tests: audit gateway throws once → entry
  recorded by the next reconcile or replay, exactly once.
- Public RPC/gateway fan-out caps: `GET /api/v1/markets/:market/liquidity` (funding) and the markets evidence detail route's
  `contentStore.retrieve` cache misses use the same non-blocking concurrency cap as positions/oracle (at most 4 in flight per
  process, a 5th miss refused immediately with ApiError RATE_LIMITED 429 and retryAfterSeconds). Deterministic tests.
- SEC-EVID-11: the evidence listing never serves manifest text of blocked evidence or content. Re-check moderation state for the
  cached entries at serve time (or drop cache entries on block) and send `Cache-Control: no-store` for listing responses that
  embed manifest text. Test: block after a cached listing → next listing omits the manifest.
- Tests: funding history items show reconciled plan state, step states and confirmedTxHash; loadOracle accepts a replacement
  linked only through the original's `reopenedBy` and refuses otherwise.
- Claims items (job abort for claims reconcile/integrity, catalog policy-text pinning) are carried by a later claims-hardening
  lane after the claims feature merges.

## 4. Checks
contracts-hardening: `forge build`, `export-abis --check`, the plan-vector `--check`, forge unit tests (claim-registry and
evidence-registry), the fork tests, the e2e tests, `check-forbidden`. api-hardening: `pnpm --filter @pine/api typecheck`,
`eslint packages/api/src`, `check-forbidden`, `vitest run src/modules/markets src/modules/funding` (single vitest worker in verification).
