# PRD-06: Assembly, end-to-end verification and operations (feature `assembly`)

Runs in two md-manager runs of this one feature (`launch assembly --workers <lane>`): the `deploy-e2e` lane as soon as feature
`chain` is merged into `main` (it needs only the contracts and `@pine/shared`), and the `composition` lane after `platform`,
`claims`, `markets` and `indexers` are merged. It wires the real pieces together, proves the whole path on a Gnosis fork and
in-process, and documents deployment. Everything it touches that other features own is read-only; it owns only the paths below.

## 1. Lanes and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `deploy-e2e` | `contracts/script`, `contracts/test/e2e`, `scripts/fixtures` |
| `composition` | `packages/api/src/readmodel.ts`, `packages/api/test/e2e`, `deploy`, `README.md` (repository root), `docs/operations`, `.github/workflows` |

## 2. deploy-e2e
- `contracts/script/Deploy.s.sol`: explicit deployer (`vm.startBroadcast(deployer)` only in `run()`), prediction
  `vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1)`, EvidenceRegistry first, then ClaimRegistry with `ExpectedSeer` from
  `GNOSIS_EXTERNAL`, assertions of the binding and of every Seer immutable, a JSON deployment record (addresses, block, chain id,
  constructor args, deployer). The ClaimRegistry constructor does not pin the factory (chain-005 security review, P2), so the
  script refuses to deploy unless `seerMarketFactory == 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` and its `EXTCODEHASH` equals
  `0x387f37b6df5c9faf28875b9b108cd4bf56c27152989d3362600516a2381e2fe6` (runtime code at block 48550000 and today, read on
  2026-10-02); the record also lists the code hashes of every external contract it relies on (Reality, RealityProxy, CTF,
  Wrapped1155Factory, sDAI, GnosisRouter, Algebra factory and position manager), read at deploy time. An internal `_deploy(deployer)` function holds the logic so tests run it under `vm.startPrank(deployer)`.
- `contracts/test/e2e` (Gnosis fork pinned at block 48550000, archive RPC `https://rpc.gnosischain.com` or `GNOSIS_RPC_URL`): deploy
  the REAL pair with the script logic; full lifecycle: `createClaim` → `commitEvidence` → (warp) `revealEvidence` → (warp past the
  reveal deadline) Reality `submitAnswer{value: bond}` (Yes and No variants) → warp past the 302400 s timeout → `RealityProxy.resolve`
  → CTF payouts as expected (Yes, No and an Invalid answer paying only the invalid slot); a funding round: `splitFromBase` → exact
  approval → `createAndInitializePoolIfNecessary` → single-sided YES `mint` → allowance consumed → a buyer swap moves YES out → payout
  accounting after resolution; and replay of TypeScript-built plan calldata (below) byte-for-byte. Algebra rounds liquidity
  down, so a mint may pull a few wei less than `amountDesired` (= the exact approval): assert the residual allowance is at most
  10 wei and only toward the position manager.
- `scripts/fixtures/export-plan-vectors.mjs` (run by the lane with `node --import tsx`, output committed under
  `scripts/fixtures/`): generates calldata for a createClaim plan, commit and reveal plans and a ladder funding plan (split,
  approve, createAndInitializePoolIfNecessary, mint) with `@pine/shared/tx-plan` `buildStep`/`newPlan` for fixed inputs (ticks and
  sqrt prices computed in the script with integer math and documented; the funding module's own planner is covered by its unit and
  property tests and is not a dependency of this lane), so the Solidity e2e test executes exactly what a wallet would be asked to
  sign. A `--check` mode regenerates and compares.

## 3. composition
- `packages/api/src/readmodel.ts`: `createReadModel` selects `@pine/indexer-native` (`secrets.readModel.kind === "native"`, a pg pool
  with the read-only URL) or `@pine/read-model-envio` (`kind === "envio"`), validating that the backend's chain id equals the config's.
- Database: when `PINE_E2E_DATABASE_URL` (a superuser URL of a disposable PostgreSQL 16 cluster) is set, the e2e suite runs on
  real Postgres with the production driver (`pg` Pool + drizzle): per test file a fresh database `pine_e2e_<random hex>`, roles
  `pine_api`, `pine_indexer`, `pine_readonly` pre-created idempotently WITH LOGIN (as a DBA would), migrations of the API and of
  `@pine/indexer-native` run as the database owner, the API connects as `pine_api` and the native read model as `pine_readonly`
  (proving the grants, including DML on gateways/claims/markets/funding tables created after platform `0002_`), and the database is
  dropped afterwards. Otherwise it uses PGlite. With `PINE_E2E_REQUIRE_PG=1` a missing URL fails the suite. The operator verifies
  this feature with both variables set (local PostgreSQL 16); CI provides a `postgres:16` service container.
- `packages/api/test/e2e`: boots the real `buildApp` with real platform-core, real gateways using injected fake `fetch`/RPC transports,
  all route modules, PGlite, and the native read model fed by `applyEvents` with scenario events; drives the customer journey of
  SPEC §3: SIWE login, GitHub link (fake GitHub), draft, preview, publication plan (verified), simulated ClaimCreated, reconciliation to
  `confirmed`, integrity `verified`, agent feed lists it, evidence manifest upload and commit/reveal plans, simulated reveal, oracle
  status and due actions, funding ladder plan verified, simulated resolution, redeem plan. Negative paths: CSRF, stale/halted read model
  (NOT_READY), SC-001 disabled, blocked content (451), compliance refusal (451), cookies ignored on public routes, no secret in any
  response or captured log line.
- `deploy/`: systemd units (api, indexer-native, migrate oneshot), environment templates without secrets, nginx/Caddy reverse-proxy
  example (same-origin API, separate user-content domain, per-IP limits on the user-content host, TLS), Postgres role bootstrap SQL
  (pine_migrator, pine_api, pine_indexer, pine_readonly), Kubo and pinning setup, backup and key-rotation procedures.
- `README.md` (root): what Pine is, architecture, packages, how to run tests, how to deploy, the launch gates of ADR-0001.
- `.github/workflows/ci.yml`: on push and pull request, with pinned action SHAs and `permissions: contents: read`: corepack pnpm
  12.8.1, `pnpm install --frozen-lockfile`, `pnpm audit --prod` (fails on high), `node scripts/check-forbidden.mjs`,
  `node scripts/export-abis.mjs --check` after `forge build --root contracts`, `pnpm -r typecheck`, `pnpm exec eslint packages`,
  `pnpm -r test`, forge unit tests via the TAP wrapper, the e2e suite against a `postgres:16` service with
  `PINE_E2E_REQUIRE_PG=1`, secret scanning (gitleaks, pinned SHA) over the whole history, and the fork tests in a separate job using
  a `GNOSIS_RPC_URL` secret.
- `docs/operations/`: runbooks for indexer halts, RPC disagreement, pin failures, stuck oracle steps (due actions), key rotation, incident
  response, evidence takedown (SEC-EVID-12), and the release checklist (launch gates): external audit and a published bug-bounty
  scope (SEC-SC-17); policy approval; legal review, terms, jurisdictions and a hosted sanctions provider; a signed staff trading
  and conflict-of-interest policy (SEC-LEGAL-07); GitHub App spike; real-Postgres lease test; Envio live conformance; an
  independently built and released client (web or CLI) that re-verifies every plan with its own build of `@pine/shared`, checks
  `eth_chainId`, re-renders the question, builds reveals locally and renders every SPEC §8 state (SEC-TX-01/02/05/07/10,
  SEC-AUTH-13); selection of the pilot claim; a named operational owner and on-call; a pilot measurement plan (valid findings,
  noise, latency, total cost). They also state that Pine executes no submitted code in v1, and that staging runs on an anvil fork
  where testers use throwaway keys only (a fork keeping chain id 100 could replay anything a real key signs there).

## 4. Checks
- deploy-e2e: `forge build --root contracts` (build), `node scripts/forge-test-tap.mjs --match-path "test/e2e/**/*.sol"`
  (integration), `node scripts/export-abis.mjs --check` (typecheck), `node scripts/check-forbidden.mjs` (unit). The plan-vector
  `--check` is part of the e2e test setup (the Solidity test reads the committed vectors; the lane runs the script).
- composition: `pnpm -r typecheck` (typecheck), `pnpm exec eslint packages` (typecheck), `node scripts/check-forbidden.mjs` (unit),
  `pnpm --filter @pine/api exec vitest run test/e2e` (integration), `pnpm --filter @pine/api test` (unit, whole API suite).
