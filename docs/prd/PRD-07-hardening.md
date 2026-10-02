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
  (behaviour unchanged; project rule for narrowing).
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

## 3. api-hardening
- Every module job (claims reconcile and integrity, markets reconcile and watch, funding reconcile) checks `signal.aborted`
  between batches and stops promptly; tests abort before and during a batch.
- Claims: at module registration put every digest-verified catalog policy text into `ctx.contentStore` (which pins it), so the
  `ipfs://<policy cid>` referenced by every immutable question stays retrievable; publication plans are refused until both the
  claim document and the policy text are stored; test it.
- Further findings of the operator's final API security review are appended here before the lane launches.

## 4. Checks
contracts-hardening: `forge build`, `export-abis --check`, the plan-vector `--check`, forge unit tests (claim-registry and
evidence-registry), the fork tests, the e2e tests, `check-forbidden`. api-hardening: `pnpm --filter @pine/api typecheck`,
`eslint packages/api/src`, `check-forbidden`, `vitest run src/modules` (single vitest worker in verification).
