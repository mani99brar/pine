# chain

The two immutable Pine contracts on Gnosis Chain: `ClaimRegistry` (creates the Seer market and records the claim, composing the
question on-chain) and `EvidenceRegistry` (commit-reveal and direct evidence publication). Specification: `docs/prd/PRD-01-chain.md`;
decisions: `docs/adr/ADR-0001-architecture.md` and `decisions.md`.

- `feature.json`: lanes `claim-registry` and `evidence-registry`, reviewers general/coverage/security, review sidecar.
- `policy.json`: owned paths and controller checks (forge build, ABI drift, forge tests via the TAP wrapper, Gnosis fork test, forbidden patterns).

Launch: `python -m workflow launch chain --repo <clone> --dry-run`, then `--live --automatic`.
