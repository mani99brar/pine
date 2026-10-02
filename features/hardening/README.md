# hardening

Pre-deployment fixes found after features merged: `contracts-hardening` (EvidenceRegistry SafeCast, copycat and max-size fork
tests, Deploy.run() dry run, e2e tightening) and `api-hardening` (cooperative job abort, policy-text pinning, final review
findings). Specification: `docs/prd/PRD-07-hardening.md`. Launch each lane with `--workers <lane>`.
