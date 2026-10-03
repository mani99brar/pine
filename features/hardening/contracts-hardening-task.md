# Task: contracts-hardening

## Goal

Land the pre-deployment contract and test hardening of `docs/prd/PRD-07-hardening.md` section 2: SafeCast in EvidenceRegistry, the copycat-market and maximum-size fork tests, the `Deploy.run()` dry-run test, a non-vacuous evidence invariant, and the e2e tightening.

## Context

- Merged code: `contracts/src/*`, `contracts/script/Deploy.s.sol`, `contracts/test/**`, `scripts/fixtures/export-plan-vectors.mts`; PRD-01, PRD-06 section 2, `features/chain/decisions.md`, `features/assembly/decisions.md`.
- Seer factory behaviour for reused questions and wrappers: `docs/research/seer-protocol.md`; fork block 48550000 on `https://rpc.gnosischain.com` (archive) or `GNOSIS_RPC_URL`.
- `contracts/foundry.toml` keeps `fs_permissions = []` and `ffi = false`: no file access from tests or scripts.

## Constraints

- Only touch your owned paths. Never change `contracts/src/interfaces/**`, `ClaimRegistry.sol`, shared packages or root config. Behaviour of EvidenceRegistry stays identical apart from the cast.
- Fork tests read state only, never broadcast, and respect the RPC budget (one fork per test contract, snapshots for variants).

## Acceptance

- Checks `build`, `abi`, `vectors`, `unit`, `fork`, `e2e`, `forbidden` in `features/hardening/policy.json` pass (run them yourself first).
- Every item of PRD-07 section 2 has a test that fails when the behaviour is removed; the completion includes that coverage matrix.

## Stop

Stop and report `blocked` when a frozen file prevents an item, or after three failed attempts at the same check failure with the same root cause.
