# Task: deploy-e2e

## Goal

Write the deployment script and the real-pair Gnosis fork lifecycle tests of `docs/prd/PRD-06-assembly.md` section 2: `contracts/script/Deploy.s.sol` (explicit deployer, address prediction, EvidenceRegistry first, binding and Seer-immutable assertions, JSON record), `contracts/test/e2e/**` (claim creation through evidence, oracle answers, resolution and payouts, plus a YES-ladder funding round on real Swapr/Algebra pools), and `scripts/fixtures/export-plan-vectors.mjs` with committed calldata vectors that the Solidity e2e test replays byte-for-byte.

## Context

- The merged contracts (`contracts/src/ClaimRegistry.sol`, `EvidenceRegistry.sol`, libraries) and their tests; PRD-01 for their behaviour; verified addresses in `packages/shared/src/deployment.ts`; Reality/Seer/Algebra facts in `docs/research/*`.
- The merged TypeScript plan builders: `@pine/shared/tx-plan` and the funding module's pure planner in `packages/api/src/modules/funding`.

## Constraints

- Only touch your owned paths; never modify contracts, interfaces, shared or API code. Fork tests pin block 48550000 on `https://rpc.gnosischain.com` (archive) or `GNOSIS_RPC_URL`, never broadcast, and fund test accounts with `vm.deal`.
- `vm.startBroadcast` appears only in `run()`; test the deployment logic through an internal function under `vm.startPrank(deployer)`.

## Acceptance

- Checks `build`, `abi`, `e2e`, `forbidden` in `features/assembly/policy.json` pass (run them yourself first).
- The e2e suite proves: real deployment and binding; createClaim → commit → reveal → Reality answers (Yes, No, Invalid) → finalization → `RealityProxy.resolve` → expected CTF payouts; funding: split, exact approval consumed, single-sided YES mint, a buyer swap, payouts after resolution; the replayed TypeScript calldata produces the same effects.

## Stop

Stop and report `blocked` if merged code contradicts PRD-01/PRD-04 in a way the e2e test exposes (report the exact divergence), or after three failed attempts at the same check failure.
