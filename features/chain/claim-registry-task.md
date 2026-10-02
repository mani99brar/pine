# Task: claim-registry

## Goal

Implement `contracts/src/ClaimRegistry.sol` (and pure helper libraries under `contracts/src/libraries/`) exactly as specified in `docs/prd/PRD-01-chain.md` section 2 against the frozen `contracts/src/interfaces/IClaimRegistry.sol`: an immutable, ownerless registry that validates claim parameters, composes the market question on-chain, creates the Seer categorical Yes/No market atomically and records the claim. Add the deployment script of section 5 and the tests of section 4.

## Context

- Seer sources for reference (read-only): `docs/research/seer-protocol.md` (verified addresses, `MarketFactory.createCategoricalMarket`, question encoding with U+241F separators, question/condition reuse, payouts). Reality.eth semantics: `docs/research/reality-kleros.md`.
- Byte-exact targets: `QUESTION_VECTORS`, `UTC_FORMAT_VECTORS`, `RAW_CID_VECTORS`, `TOKEN_NAME_VECTORS` in `packages/shared/src/testing/vectors.ts`; the TypeScript reference renderer is `packages/shared/src/question.ts`. Transcribe the vectors into a Solidity test file (tests cannot read files).
- Verified Gnosis addresses: `GNOSIS_EXTERNAL` in `packages/shared/src/deployment.ts`.
- The EvidenceRegistry implementation is written by another lane; your tests use a test-local mock that returns `claimRegistry()`.
- PRD-01 section 2.1 and `features/chain/decisions.md` govern the constructor (four arguments including `ExpectedSeer`; the
  EvidenceRegistry is deployed first at the predicted address). The interface NatSpec defers to PRD-01 for the constructor.
- Pin the fork at block 48550000 on `https://rpc.gnosischain.com` (archive). Twin markets share question, condition and outcome tokens.

## Constraints

- Do not modify the interfaces, `contracts/foundry.toml`, `contracts/lib`, `scripts/` or anything outside your owned paths.
- No owner, admin, pause, proxy, `delegatecall`, `selfdestruct` or `tx.origin` (the forbidden-pattern check enforces it). `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient` or `ReentrancyGuard`) on `createClaim`.
- The contract never holds or forwards tokens or native value; `createClaim` is not payable.
- Avoid solc patterns with known bug classes (no named parameters in `require` with custom errors, no `delete` of memory `bytes` elements, no mutual recursion). If the event emission hits "stack too deep", restructure (internal functions, memory structs); do not enable `via_ir`.
- Fork tests read state only, never broadcast, and pin the fork block number; RPC from `vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"))`.

## Acceptance

- Checks `build`, `abi`, `unit`, `fork`, `forbidden` in `features/chain/policy.json` pass (run them yourself with the same commands before completing).
- Every test listed in PRD-01 section 4 for this lane exists and asserts the behaviour (boundaries, every custom error, vectors, fuzz references, malformed mock markets, reentrancy attempt, constructor refusals, real Seer market on the fork including the shared question/condition case).
- `renderQuestion` returns exactly each vector's `question`; `createClaim` passes the identical string to Seer and records `keccak256` of it.

## Stop

Stop and report `blocked` if a frozen interface or vector is impossible to satisfy, if the fork RPC is unreachable after retries (report the exact error), or if the work would require changing files outside your owned paths. Ask a `question` instead of guessing when PRD-01 and the interface disagree.
