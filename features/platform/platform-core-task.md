# Task: platform-core

## Goal

Implement the API platform core described in `docs/prd/PRD-02-platform.md` section 2: fail-closed configuration and secrets, the hardened Fastify application (`buildApp`), SIWE wallet authentication and sessions, CSRF, rate limits, quotas, audit log, moderation with admin routes, the compliance gateway, the jobs runner, `src/main.ts`, `src/migrate.ts`, health/readiness/metrics, and the operator README and `.env.example`.

## Context

- Rerun: run platform-004 produced a candidate (commit `07a58b216f06bda4c7049cb98399dc19444881fb`, ref `keep/platform-004-candidate`) that passed every check; its independent review blocked on one P1 (SEC-GH-11 branch membership) with four P2s. Start from it: `git checkout 07a58b216f06bda4c7049cb98399dc19444881fb -- packages/api/src/platform/core packages/api/src/main.ts packages/api/src/migrate.ts packages/api/migrations/platform packages/api/README.md packages/api/.env.example` (run one `git checkout <commit> -- <path>` per path and skip a path that `git cat-file -e <commit>:<path>` says the candidate lacks; a single command with a missing pathspec checks out nothing), then apply the review fixes of PRD-02 for this lane: the lease abort on failing renewals, rejected-webhook audit sampling (once per IP per minute) and the `/readyz` cache. Keep the operator-settled choices of platform-004 (listed in decisions.md) and list them again in your completion; if core's PGlite-heavy test files are not yet serialized, add a core-owned cross-process lock (`packages/api/src/platform/core/testing/suite-lock.ts`, same pattern as `git show 8b00834:packages/api/src/platform/gateways/testing/suite-lock.ts`) and use lease-test timings of TTL ≥ 2 s and renewal ≥ 500 ms.

- Frozen contracts you implement or consume: `packages/api/src/contracts/app.ts` (AppContext, SessionInfo, RouteModule, RouteSecurityConfig, JobDefinition, gateways interfaces), `platform.ts` (PlatformSecrets, Gateways, GitHubAuthFlow, GatewayFactory, ReadModelFactory), `config.ts`, `errors.ts` (`toErrorResponse`), `redact.ts`, `migrations.ts` (`verifyMigrations`, `runMigrations`), `testing.ts` (harness and fakes, including the step-up semantics your `requireAdmin` must match).
- Security requirements: `docs/security/requirements.md` sections 2 (SEC-AUTH), 9 (SEC-OPS) and 10 (SEC-LEGAL); web rules in `CLAUDE.md`.
- `src/main.ts` must import `createGateways` from `./platform/gateways/index.js` and `createReadModel` from `./readmodel.js` (both stubs owned by other lanes) and typecheck against them.
- PRD-02 sections 2.5 and 2.5a settle the jobs-runner lock seam, atomic statements, cleanup, audit IP retention, session rotation and CSRF details; `features/platform/decisions.md` lists the accepted deviations from the security requirements.
- PRD-02 section 2.4 defines the audit channel for gateway revocations (`ctx.github` is your auditing decorator around `gateways.github`, keyed on `GITHUB_NOT_LINKED`), section 2.3 the webhook and callback-failure audits, section 2.1 the sanctions configuration, section 2.5 the lease timing options, and section 2.5a the exact grants (SELECT only on `schema_migrations`).
- Build in this order with separate test files per area so a failure points at one area: config → buildApp/CSRF/errors → SIWE/sessions → quotas/rate limits/audit/moderation/compliance → jobs/cleanup → main/migrate → README.

## Constraints

- Only touch your owned paths. Never query tables created by the gateways lane; use the `Gateways` interfaces (write your own fakes in your test files).
- Never use viem `generateSiweNonce` or rely on `verifySiweMessage` alone; recover EOA signatures locally with `recoverMessageAddress`; no RPC in the auth path.
- No secret ever reaches a log line, error response, audit row or database column (tokens are stored only as SHA-256).
- New platform migrations start at `0002_`; `0001_core.sql` is frozen. No new dependencies.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/platform/policy.json` pass (run them yourself first).
- Every test listed for core in PRD-02 section 4 exists, runs on PGlite through the frozen harness or `buildApp` with fakes, and names the SEC id it proves in negative tests.
- `buildApp` registers the modules of `src/modules.ts` with the RouteSecurityConfig semantics (public routes: no cookies, CORS `*`, GET/HEAD only; multipart only when flagged).

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour (describe the exact gap), or after three failed attempts at the same check failure with the same root cause (failures in different test areas while you build area by area are normal progress; run the narrower `vitest run <area dir or file>` while iterating, and commit after each area passes). Ask a `question` before inventing configuration that changes security behaviour beyond PRD-02.
