# Task: platform-gateways

## Goal

Replace the stub `packages/api/src/platform/gateways/index.ts` with `createGateways` implementing `docs/prd/PRD-02-platform.md` section 3: the GitHub auth flow and REST gateway (public repositories only, numeric identities, commit-membership proofs, encrypted expiring tokens, revocation webhook), the Postgres-backed content store with IPFS pin outbox and digest-verified `retrieve`, the separate user-content server, and the dual-RPC chain gateway.

## Context

- Frozen contracts: `packages/api/src/contracts/app.ts` (`GitHubGateway`, `CommitMembership`, `ContentStore`, `ChainGateway`, `ModerationGateway`), `platform.ts` (`Gateways`, `GitHubAuthFlow`, `ContentServer`, `PlatformSecrets`, `GatewayDependencies`), `@pine/shared/canonical` (`identify`, `RAW_CID_MAX_BYTES`, `rawCidFromSha256`).
- Security requirements: `docs/security/requirements.md` sections 1 (SEC-GH) and 5 (SEC-EVID); GitHub behaviour notes in section 0 (fork-network commits, App token scope).
- External HTTP (GitHub, IPFS gateways, Kubo, pinning service, RPC) must be injectable (a `fetch`-like dependency or viem transport) so tests use recorded fixtures and never touch the network.
- The content server has no in-app per-IP rate limit (decided: edge proxy); `listPublicRepos` refreshes the login via `GET /user` first.
- GitHub 401, token decrypt/AAD failure and a rejected refresh: delete the token, mark the link revoked (`identityOf` → null), increment `pine_github_link_revoked_total{reason}` and throw `GitHubGatewayError("GITHUB_NOT_LINKED")` (never `UPSTREAM`); core audits it (PRD-02 sections 2.4 and 3.1).
- `createGateways(deps)` wraps an exported `buildGateways(deps, io)` (`io`: `fetch` plus the two viem transports) so every test runs offline; `buildGateways` checks `eth_chainId` on both transports (PRD-02 section 3.3). Revocation metric: `metrics.increment("github_link_revoked", { reason })`.
- Your migrations never mention the role `pine_api`: it is created by platform `0002_`, which is not in your worktree, and its default privileges cover your tables.
- Build in this order with separate test files per area: crypto/token store → GitHub auth flow → GitHub gateway and membership → content store/retrieve/pin outbox → content server → chain gateway → createGateways.

## Constraints

- Only touch your owned paths; migrations go in `packages/api/migrations/gateways` (`0001_` onwards). No new dependencies.
- Fetch only the configured hosts (GitHub API and token endpoint, configured IPFS gateways, Kubo, pinning service, RPC URLs); `redirect: "error"`; bounded sizes and timeouts; never fetch user-supplied URLs.
- Tokens only ever stored encrypted (AES-256-GCM with AAD bound to user, provider, token kind and key id); every error string passed through the redactor before logging or rethrowing.
- `get`/`retrieve` never return content in moderation state `block`; the content server never sets cookies and serves only `/c/:sha256`.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/platform/policy.json` pass (run them yourself first).
- Every test listed for gateways in PRD-02 section 4 exists and asserts the behaviour, including a fork-network commit that exists but is not a member, AAD-swapped ciphertexts failing, webhook HMAC rejection, CID-mismatch on pinning, redirect refusal, and content-server headers.

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour, or after three failed attempts at the same check failure with the same root cause (failures in different test areas while you build area by area are normal progress; run the narrower `vitest run <area dir or file>` while iterating, and commit after each area passes). Ask a `question` before choosing a behaviour PRD-02 leaves open that affects security.
