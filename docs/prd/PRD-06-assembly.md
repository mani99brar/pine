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
  `GNOSIS_EXTERNAL`, assertions of the binding and of every Seer immutable, and a deployment record (addresses, block, chain id,
  constructor args, deployer) built in memory with `vm.serializeJson` and printed with `console.log` (forge's `broadcast/` output
  is the durable record): `contracts/foundry.toml` sets `fs_permissions = []` and `ffi = false` and stays unchanged, so no test
  or script reads or writes files. The ClaimRegistry constructor does not pin the factory (chain-005 security review, P2), so the
  script refuses to deploy unless `seerMarketFactory == 0x83183DA839Ce8228E31Ae41222EaD9EDBb5cDcf1` and its `EXTCODEHASH` equals
  `0x387f37b6df5c9faf28875b9b108cd4bf56c27152989d3362600516a2381e2fe6` (runtime code at block 48550000 and today, read on
  2026-10-02); its look-alike test `vm.etch`es a mock with identical getters AT the real factory address, so the code-hash branch
  (not the address check) must refuse it, with a code-hash-specific revert; the record also lists the code hashes of every external contract it relies on (Reality, RealityProxy, CTF,
  Wrapped1155Factory, sDAI, GnosisRouter, Algebra factory and position manager), read at deploy time. An internal `_deploy(deployer)` function holds the logic so tests run it under `vm.startPrank(deployer)`.
- `contracts/test/e2e` (Gnosis fork pinned at block 48550000, archive RPC `https://rpc.gnosischain.com` or `GNOSIS_RPC_URL`): deploy
  the REAL pair with the script logic; full lifecycle: `createClaim` → `commitEvidence` → (warp) `revealEvidence` → (warp past the
  reveal deadline) Reality `submitAnswer{value: bond}` (Yes and No variants) → warp past the 302400 s timeout → `RealityProxy.resolve`
  → CTF payouts as expected (Yes, No and an Invalid answer paying only the invalid slot); a funding round: `splitFromBase` → exact
  approval → `createAndInitializePoolIfNecessary` → single-sided YES `mint` → allowance consumed → a buyer swap moves YES out → payout
  accounting after resolution; and replay of TypeScript-built plan calldata (below) byte-for-byte. Algebra rounds liquidity
  down, so a mint may pull a few wei less than `amountDesired` (= the exact approval): assert the residual allowance is at most
  10 wei and only toward the position manager.
- Plan vectors without filesystem cheatcodes: the lane first captures the fork-dependent values with a probe test or `cast`
  calls at block 48550000 (deployer, predicted registry addresses, block timestamp, the market and its YES/NO/INVALID tokens and
  their order against sDAI, the sDAI shares minted per xDAI split) into a committed `scripts/fixtures/fork-observations.json`.
  `scripts/fixtures/export-plan-vectors.mts` reads it, builds a createClaim plan, commit and reveal plans and a ladder funding plan
  (split, approve, createAndInitializePoolIfNecessary, mint; ticks and sqrt prices computed in the script with integer math and
  documented; the funding module's planner is covered by its own tests and is not a dependency) with `@pine/shared/tx-plan`
  (`buildStep`/`newPlan`/`verifyPlan`, imported by relative path `../../packages/shared/src/*.ts`), and writes the JSON vectors in
  `scripts/fixtures/` plus a generated `contracts/test/e2e/generated/PlanVectors.sol` holding the same calldata as `bytes`
  constants. Run it as `pnpm --filter @pine/api exec node --import tsx ../../scripts/fixtures/export-plan-vectors.mts [--check]`
  (verified to resolve; the root has no `tsx`); `--check` regenerates both files and fails on any difference, and it is a gate of
  this lane (`vectors` check in policy.json). Determinism: every input (claim params, deployer label, salt, plan ids such as
  `"vector-create-claim"`, prices) is a constant in the script and emitted into `PlanVectors.sol`, so the probe and e2e tests take
  them from the generated file; JSON is written with sorted keys and bigints as decimal strings. Bare packages (viem) do not resolve
  from `scripts/fixtures/`: import `@pine/shared` code by relative path and, where a bare package is unavoidable, resolve it from
  `packages/shared` with `createRequire(new URL("../../packages/shared/package.json", import.meta.url))` and a dynamic `import()`.
  Ladder math: choose `lowerPrice`/`upperPrice` at exact tick prices (multiples of the spacing 60), compute ticks and sqrt prices with
  a BigInt port of TickMath, and initialise strictly outside the range as PRD-04 requires (YES = token0 →
  `getSqrtRatioAtTick(tickLower) − 1`; YES = token1 → `getSqrtRatioAtTick(tickUpper) + 1`); cover the other YES/sDAI orientation
  too when a second claim digest probed on the fork yields it (otherwise record the gap). Time-bound values (mint deadline, commit
  and reveal deadlines) derive from the observed fork timestamp, and the e2e test executes each step before them. The e2e test
  first asserts the observed fork values equal the constants, then replays each step with
  `vm.prank(account); target.call{value}(data)` byte for byte.
- Deployment-logic tests inherit the script contract (so `new` runs in the test's own frame under `vm.startPrank(deployer)` and
  the n / n+1 prediction holds), and every external read before the second CREATE is a `view` call (under broadcast a non-view
  call would consume a deployer nonce and break the binding only in production).
- Fork RPC budget: one fork per test contract in `setUp`, `vm.snapshotState`/`vm.revertToState` to run the Yes, No and Invalid
  variants from one deployed claim, `GNOSIS_RPC_URL` when set; never name a helper file or contract `IClaimRegistry` or
  `IEvidenceRegistry` (export-abis reads those artifacts by fixed path).

## 3. composition
- `packages/api/src/readmodel.ts`: `createReadModel` selects `@pine/indexer-native` (`secrets.readModel.kind === "native"`, a pg pool
  with the read-only URL) or `@pine/read-model-envio` (`kind === "envio"`), validating that the backend's chain id equals the config's.
- Database: when `PINE_E2E_DATABASE_URL` (a superuser URL of a disposable PostgreSQL 16 cluster) is set, the e2e suite runs on
  real Postgres with the production driver (`pg` Pool + drizzle): per test file a fresh database `pine_e2e_<random hex>`, roles
  `pine_api`, `pine_indexer`, `pine_readonly` pre-created idempotently WITH LOGIN (as a DBA would), migrations of the API and of
  `@pine/indexer-native` run as the database owner, the API connects as `pine_api` and the native read model as `pine_readonly`
  (proving the grants, including DML on gateways/claims/markets/funding tables created after platform `0002_`), and the database is
  dropped afterwards. Otherwise it uses PGlite. With `PINE_E2E_REQUIRE_PG=1` a missing URL fails the suite. On real Postgres the
  suite also runs the concurrency cases PGlite cannot show: a draft delete racing a first publication (no 500, no deadlock leaks
  to the client), concurrent quota consumption at the limit (never over-consumed), two job runners competing for one lease (at
  most one runs) and two identical publication requests (one row). The operator verifies
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

## 3a. assembly-004 review fixes (carried by assembly-005; composition)
- CI tests (coverage P1): assert that ci.yml triggers on both `push` and `pull_request`; that the fork/e2e forge commands that
  need `GNOSIS_RPC_URL` live only in their own job, which runs only when the secret is available; and that no other job
  references the secret. Each assertion fails when the property is removed (parse the YAML structure, not substrings).
- E2E database cleanup (coverage P1): a failed `DROP DATABASE` is reported (the suite fails in afterAll with a redacted message),
  never swallowed; a PostgreSQL test asserts that no `pine_e2e_*` database of the run remains after cleanup.
- Disposable-cluster guard: `bootstrapRoles` (which sets fixed test passwords on the production role names) refuses to run
  unless the database URL host is loopback (127.0.0.1, ::1, localhost) or `PINE_E2E_DISPOSABLE_CLUSTER=1` is set; test it.
- nginx: `log_format pine_noquery` moves to an http-context snippet (e.g. deploy/proxy/nginx-http.conf, included from the http
  block) so the server file passes `nginx -t`; deploy/README.md documents both includes.
- Static proxy checks: a test asserts in deploy/proxy/nginx.conf and Caddyfile the PRD-06 section 3 properties: same-origin API,
  a separate user-content host, per-IP limits on the user-content host, TLS, and no query strings in access logs.
- Least privilege (SEC-OPS-10): separate OS users for pine-api, pine-indexer-native and pine-migrate in deploy/systemd; each
  secrets file is readable only by its unit's user (0640 root:<user>); the env file headers and deploy/README.md agree.
- Allowance bound: a journey test asserts the residual allowance after the ladder mint is at most 10 wei and only toward the
  position manager (decision 6), failing if the approval amount grows.
- The PGlite configuration is verified as its own check (`e2e-pglite`), alongside the PostgreSQL run.
- gitleaks: not installed on the verification host; it stays a CI job and a launch gate (record as untested in the matrix).

## 4. Checks
- deploy-e2e: `forge build --root contracts` (build), `node scripts/forge-test-tap.mjs --match-path "test/e2e/**/*.sol"`
  (integration), `node scripts/export-abis.mjs --check` (typecheck), `node scripts/check-forbidden.mjs` (unit). The plan-vector
  `--check` is part of the e2e test setup (the Solidity test reads the committed vectors; the lane runs the script).
- composition: `pnpm -r typecheck` (typecheck), `pnpm exec eslint packages` (typecheck), `node scripts/check-forbidden.mjs` (unit),
  `pnpm --filter @pine/api exec vitest run test/e2e` (integration), `pnpm --filter @pine/api test` (unit, whole API suite).
