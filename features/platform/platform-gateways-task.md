# Task: platform-gateways

## Goal

Replace the stub `packages/api/src/platform/gateways/index.ts` with `createGateways` implementing `docs/prd/PRD-02-platform.md` section 3: the GitHub auth flow and REST gateway (public repositories only, numeric identities, commit-membership proofs, encrypted expiring tokens, revocation webhook), the Postgres-backed content store with IPFS pin outbox and digest-verified `retrieve`, the separate user-content server, and the dual-RPC chain gateway.

## Context

- Frozen contracts: `packages/api/src/contracts/app.ts` (`GitHubGateway`, `CommitMembership`, `ContentStore`, `ChainGateway`, `ModerationGateway`), `platform.ts` (`Gateways`, `GitHubAuthFlow`, `ContentServer`, `PlatformSecrets`, `GatewayDependencies`), `@pine/shared/canonical` (`identify`, `RAW_CID_MAX_BYTES`, `rawCidFromSha256`).
- Security requirements: `docs/security/requirements.md` sections 1 (SEC-GH) and 5 (SEC-EVID); GitHub behaviour notes in section 0 (fork-network commits, App token scope).
- External HTTP (GitHub, IPFS gateways, Kubo, pinning service, RPC) must be injectable (a `fetch`-like dependency or viem transport) so tests use recorded fixtures and never touch the network.

## Constraints

- Only touch your owned paths; migrations go in `packages/api/migrations/gateways` (`0001_` onwards). No new dependencies.
- Fetch only the configured hosts (GitHub API and token endpoint, configured IPFS gateways, Kubo, pinning service, RPC URLs); `redirect: "error"`; bounded sizes and timeouts; never fetch user-supplied URLs.
- Tokens only ever stored encrypted (AES-256-GCM with AAD bound to user, provider, token kind and key id); every error string passed through the redactor before logging or rethrowing.
- `get`/`retrieve` never return content in moderation state `block`; the content server never sets cookies and serves only `/c/:sha256`.

## Acceptance

- Checks `typecheck`, `lint`, `forbidden`, `unit` in `features/platform/policy.json` pass (run them yourself first).
- Every test listed for gateways in PRD-02 section 4 exists and asserts the behaviour, including a fork-network commit that exists but is not a member, AAD-swapped ciphertexts failing, webhook HMAC rejection, CID-mismatch on pinning, redirect refusal, and content-server headers.

## Stop

Stop and report `blocked` when a frozen contract prevents a required behaviour, or after three failed attempts at the same check failure. Ask a `question` before choosing a behaviour PRD-02 leaves open that affects security.
