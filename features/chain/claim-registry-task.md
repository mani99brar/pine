# Task: claim-registry

## Goal

Implement `contracts/src/ClaimRegistry.sol` (and pure helper libraries under `contracts/src/libraries/`) exactly as specified in `docs/prd/PRD-01-chain.md` section 2 against the frozen `contracts/src/interfaces/IClaimRegistry.sol`: an immutable, ownerless registry that validates claim parameters, composes the market question on-chain, creates the Seer categorical Yes/No market atomically and records the claim, with the tests of section 4. Do NOT write a deployment script: PRD-01 section 5 moves it (and the real-pair fork round trip) to the later `assembly` feature.

## Context

- Rerun: run chain-004 produced candidate commit `6ddcd2764568ffc10a08ad6d92d817505c5a9ce8` (branch `keep/chain-004-candidate`), which passed every check; its review was blocked only because `scripts/forge-test-tap.mjs` reported two invariants as one test (fixed). Start from it: `git checkout 6ddcd2764568ffc10a08ad6d92d817505c5a9ce8 -- contracts/src/ClaimRegistry.sol contracts/src/libraries contracts/test/claim-registry contracts/test/fork`, then review it against the CURRENT PRD-01 and decisions and apply what changed since: titles also refuse `[` (0x5B) and `]` (0x5D) with `TitleForbiddenByte(index)`; `repositoryId > 2^53 - 1` reverts with `error RepositoryIdOutOfRange(uint64 repositoryId)` declared in `ClaimRegistry.sol` (0 stays `ZeroValue`); regenerate `contracts/test/claim-registry/Vectors.sol` from the updated `QUESTION_VECTORS` (vector 3's title lost its brackets) and add boundary tests (`2^53 - 1` accepted; `2^53` and `type(uint64).max` revert; a bracket at the first, a middle and the last index reverts). Keep the operator-settled choices recorded in that run (CR prefixes, staged question helpers, the twin-market exception) and list them again in your completion.

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
