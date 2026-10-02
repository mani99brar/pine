# PRD-06: Assembly, end-to-end verification and operations (feature `assembly`)

Runs after features `chain`, `platform`, `claims`, `markets` and `indexers` are merged into `main`. It wires the real pieces
together, proves the whole path on a Gnosis fork and in-process, and documents deployment. Everything it touches that other
features own is read-only; it owns only the paths below.

## 1. Lanes and ownership
| Lane | Owns (path prefixes) |
|---|---|
| `deploy-e2e` | `contracts/script`, `contracts/test/e2e`, `scripts/fixtures` |
| `composition` | `packages/api/src/readmodel.ts`, `packages/api/test/e2e`, `deploy`, `README.md` (repository root), `docs/operations` |

## 2. deploy-e2e
- `contracts/script/Deploy.s.sol`: explicit deployer (`vm.startBroadcast(deployer)` only in `run()`), prediction
  `vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1)`, EvidenceRegistry first, then ClaimRegistry with `ExpectedSeer` from
  `GNOSIS_EXTERNAL`, assertions of the binding and of every Seer immutable, a JSON deployment record (addresses, block, chain id,
  constructor args, deployer). An internal `_deploy(deployer)` function holds the logic so tests run it under `vm.startPrank(deployer)`.
- `contracts/test/e2e` (Gnosis fork pinned at block 48550000, archive RPC `https://rpc.gnosischain.com` or `GNOSIS_RPC_URL`): deploy
  the REAL pair with the script logic; full lifecycle: `createClaim` → `commitEvidence` → (warp) `revealEvidence` → (warp past the
  reveal deadline) Reality `submitAnswer{value: bond}` (Yes and No variants) → warp past the 302400 s timeout → `RealityProxy.resolve`
  → CTF payouts as expected (Yes, No and an Invalid answer paying only the invalid slot); a funding round: `splitFromBase` → exact
  approval → `createAndInitializePoolIfNecessary` → single-sided YES `mint` → allowance consumed → a buyer swap moves YES out → payout
  accounting after resolution; and replay of TypeScript-built plan calldata (below) byte-for-byte.
- `scripts/fixtures/export-plan-vectors.mjs` (run by the lane, output committed under `scripts/fixtures/`): generates calldata for a
  createClaim plan and a ladder funding plan from the merged TypeScript builders (`@pine/shared/tx-plan` plus the funding module's
  pure planner) for fixed inputs, so the Solidity e2e test executes exactly what the API would ask a wallet to sign.

## 3. composition
- `packages/api/src/readmodel.ts`: `createReadModel` selects `@pine/indexer-native` (`secrets.readModel.kind === "native"`, a pg pool
  with the read-only URL) or `@pine/read-model-envio` (`kind === "envio"`), validating that the backend's chain id equals the config's.
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
- `docs/operations/`: runbooks for indexer halts, RPC disagreement, pin failures, stuck oracle steps (due actions), key rotation, incident
  response, and the release checklist (external audit, policy approval, legal review, GitHub App spike, real-Postgres lease test,
  Envio live conformance).

## 4. Checks
- deploy-e2e: `forge build --root contracts` (build), `node scripts/forge-test-tap.mjs --match-path "test/e2e/**/*.sol"`
  (integration), `node scripts/export-abis.mjs --check` (typecheck), `node scripts/check-forbidden.mjs` (unit).
- composition: `pnpm -r typecheck` (typecheck), `pnpm exec eslint packages` (typecheck), `node scripts/check-forbidden.mjs` (unit),
  `pnpm --filter @pine/api exec vitest run test/e2e` (integration), `pnpm --filter @pine/api test` (unit, whole API suite).
