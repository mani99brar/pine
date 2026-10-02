# platform

The API platform: hardened Fastify app, SIWE sessions, CSRF, quotas, audit, moderation, compliance, jobs runner, process entry points
(lane `platform-core`), and the GitHub, content-store/IPFS, user-content and chain gateways (lane `platform-gateways`).
Specification: `docs/prd/PRD-02-platform.md`; decisions: `docs/adr/ADR-0001-architecture.md` and `decisions.md`.

Launch: `python -m workflow launch platform --repo <clone> --dry-run`, then `--live --automatic`.
