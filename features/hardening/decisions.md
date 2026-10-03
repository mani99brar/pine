# Decisions: hardening

Settled by the operator on 2026-10-02 from the independent contract security review (no P0/P1 found) and the feature reviews.

## Decisions

- Contract changes are limited to the EvidenceRegistry SafeCast (behaviour unchanged); ClaimRegistry is final as merged.
- Copycat markets sharing Pine's question, condition and INVALID token are accepted (decisions of feature chain); the API and
  indexers key claims only by registry addresses, never by token names.
- Each lane ships a coverage matrix (requirement → test that fails without it); the independent coverage reviewer blocks on gaps.
- Verification runs vitest with one worker (`VITEST_MAX_WORKERS=1`) because of the host's memory.

## Assumptions

- The lanes start from main after the features they touch are merged.

## Deferred

- External audit, bug bounty and the other launch gates of ADR-0001.
