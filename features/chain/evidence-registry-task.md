# Task: evidence-registry

## Goal

Implement `contracts/src/EvidenceRegistry.sol` exactly as specified in `docs/prd/PRD-01-chain.md` section 3 against the frozen `contracts/src/interfaces/IEvidenceRegistry.sol`: immutable commit-reveal and direct-publication evidence submissions bound to one ClaimRegistry, with the tests of PRD-01 section 4 (evidence-registry).

## Context

- Rerun: run chain-004 produced candidate commit `6ddcd2764568ffc10a08ad6d92d817505c5a9ce8` (branch `keep/chain-004-candidate`), which passed every check; its review was blocked only because `scripts/forge-test-tap.mjs` reported the two invariants of `ERInvariantTest` as one test (forge 1.8 runs them as one campaign; the wrapper now reports each predicate). Start from it: `git checkout 6ddcd2764568ffc10a08ad6d92d817505c5a9ce8 -- contracts/src/EvidenceRegistry.sol contracts/test/evidence-registry`, review it against the current PRD-01 and decisions, confirm the unit check now lists both invariants (44 tests), and keep the ER prefixes and the other operator-settled choices (list them again in your completion).

- The commitment formula and TYPEHASH are frozen in the interface NatSpec; the cross-language vector is `EVIDENCE_COMMITMENT_VECTOR` in `packages/shared/src/testing/vectors.ts` (TypeScript twin: `packages/shared/src/evidence.ts`).
- Claim deadlines come from `IClaimRegistry.getClaim(market)`; registration from `isRegistered(market)`. The ClaimRegistry implementation is written by another lane: use a test-local mock claim registry that you control (deadlines, registration).
- Timing operators (frozen): commit and publish iff `block.timestamp < evidenceDeadline`; reveal iff `block.timestamp < revealDeadline`.
- The constructor must not require code at, or call, the claim registry address (it is deployed first in the real order); test construction against an empty address.

## Constraints

- Do not modify interfaces, `contracts/foundry.toml`, `contracts/lib`, `scripts/` or anything outside your owned paths.
- No owner, admin, pause, proxy, `delegatecall`, `selfdestruct`, `tx.origin`, URIs or other free text, loops over storage, or token handling. Only staticcalls to the immutable registry.
- Submissions are keyed by a sequential id starting at 1; a commitment hash is never used as a storage key.

## Acceptance

- Checks `build`, `abi`, `unit`, `forbidden` in `features/chain/policy.json` pass (run them yourself first).
- Tests exist and assert: the frozen commitment vector (deployed at the vector's registry address with `deployCodeTo`, `vm.chainId(100)`); boundary warps at deadline−1/deadline/deadline+1 for commit, publish and reveal; the front-running scenario; double reveal, foreign reveal, reveal of a published id, zero salt/digest/commitment, unknown market and unknown id all revert with the interface errors; the handler-based invariant test; constant-gas commit and reveal after 500 prior submissions.

## Stop

Stop and report `blocked` if the frozen interface or vector cannot be satisfied, or if the work requires files outside your owned paths. Ask a `question` when PRD-01 and the interface disagree.
