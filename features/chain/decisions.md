# Decisions: chain

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) and the design panel on 2026-10-02.

## Decisions

- Two immutable, ownerless, unpausable contracts only (`ClaimRegistry`, `EvidenceRegistry`); no orchestrator, LP lock or token custody: lanes must not add any privileged role, rescue function or token transfer.
- The market question is composed on-chain by `ClaimRegistry.renderQuestion` and must match `QUESTION_VECTORS` byte for byte: the vectors are the acceptance oracle, and Seer receives exactly that string.
- Binding: EvidenceRegistry is deployed first with the registry's predicted address; the ClaimRegistry constructor verifies `claimRegistry() == address(this)` and asserts the Seer factory immutables against `ExpectedSeer`: each lane tests with its own mocks, the candidate runs both suites together.
- Duplicates are keyed per `(creator, claimDocumentSha256)` (`DuplicateClaim`); another creator may publish the same digest and Seer then reuses the Reality question and condition: tests must cover the shared-question case.
- Bounds are constants: evidence window 1–90 days, reveal window 12 h–7 days, min bond between the deploy-time floor and 10,000 xDAI (`MinBondTooHigh` above the cap), title 1–120 bytes of printable ASCII without `"` or `\`.
- Evidence timing operators are strict `<` for commit/publish (evidence deadline) and reveal (reveal deadline); Reality opens at the reveal deadline.

- The deployment script and the real-pair fork round trip move to the `assembly` feature (after both lanes merge); this feature writes no `contracts/script` files, and the EvidenceRegistry constructor never requires code at the registry address.

## Assumptions

- The real Seer `MarketFactory` at 0x83183DA8…cDcf1 behaves as its verified source (docs/research/seer-protocol.md); the fork test is the evidence.
- Public Gnosis RPC (`https://rpc.gnosischain.com`) is reachable from the verifier; Foundry caches fork state per block so reruns are stable.
- Gas on Gnosis is cheap enough that on-chain string composition (~800-byte question) is acceptable (~1.7M gas for Seer's creation already).

## Deferred

- External audit, slither/aderyn triage and mainnet deployment (launch gates in ADR-0001 D3).
- A combined end-to-end fork test with both real contracts and the TypeScript plan builders (feature `assembly`).
