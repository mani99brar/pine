# Pine — project conventions

Backend for GitHub claim verification markets (see `SPEC.md`, `docs/prd/`, `docs/adr/`). Workflow workers start in a
worktree of this repository and read this file. Security is the first priority: when a requirement and convenience
conflict, the requirement wins; when a requirement is ambiguous, choose the safer reading and record it as an open assumption.

## Layout

- `contracts/` — Foundry project (Solidity 0.8.37, EVM cancun, Gnosis Chain). Vendored libs in `contracts/lib/` (never edit).
- `packages/shared/` — `@pine/shared`: frozen cross-package contracts (types, ABIs, addresses, read-model interface, canonical encodings, test fixtures).
- `packages/api/` — `@pine/api`: Fastify HTTP API, background jobs.
- `packages/indexer-native/` — `@pine/indexer-native`: viem log poller writing Postgres + its read model.
- `packages/indexer-envio/` — Envio HyperIndex project; `packages/read-model-envio/` — its read-model client.
- `policies/` — policy family drafts and the versioned policy catalog. `features/` — workflow feature definitions.

## Commands

- Install: `pnpm install --frozen-lockfile` (Node 24, pnpm 12 via corepack). Never add, remove or upgrade dependencies:
  `package.json` files and `pnpm-lock.yaml` are frozen for workflow lanes. If a dependency is truly required, ask.
- Contracts: `cd contracts && forge build`; tests with a parseable summary: `node scripts/forge-test-tap.mjs [forge args]`.
- TypeScript: `pnpm --filter <pkg> typecheck`, `pnpm --filter <pkg> test` (vitest), `pnpm lint` (eslint, repo root).

## Frozen shared contracts (never modify inside a lane)

- `contracts/src/interfaces/**`, `packages/shared/src/**`, `packages/api/src/contracts/**`, `packages/api/src/modules.ts`,
  `packages/api/migrations/platform/0001_core.sql`, `policies/catalog/**`, `docs/**`, `SPEC.md`, `features/**`, root config files.
- Implement against these interfaces exactly. If an interface is wrong or insufficient, stop and ask a question
  (completion status `question`) instead of working around it.

## Security requirements

`docs/security/requirements.md` lists every requirement with a stable id (SEC-AUTH-*, SEC-GH-*, SEC-TX-*, SEC-CLAIM-*,
SEC-EVID-*, SEC-AGENT-*, SEC-SC-*, SEC-IDX-*, SEC-OPS-*, SEC-LEGAL-*). Decisions that override or settle them are in
`docs/adr/`. When you implement a requirement, name its id in the negative test that proves the attack fails
(e.g. `it("SEC-AUTH-04 rejects a SIWE message for another chain", ...)`).

## Web security (API)

- Sessions: opaque 256-bit tokens prefixed `pine_s1_`, stored as SHA-256; cookie `__Host-pine_session`, Secure, HttpOnly,
  SameSite=Lax, Path=/. Rotate on login, GitHub link and privilege change.
- CSRF: unsafe methods require an exact Origin allowlist match, a non-cross-site `Sec-Fetch-Site`, the custom header
  `x-pine-csrf: 1` and `content-type: application/json` (multipart only on the upload route).
- SIWE: never use viem's `generateSiweNonce` (Math.random) or rely on `verifySiweMessage` alone; verify every EIP-4361
  field explicitly and recover EOA signatures locally (no RPC-first ERC-6492 path). Smart-contract-wallet login is off.
- Untrusted content is served only from the separate user-content origin, as `application/octet-stream` with
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`.
  Never render HTML/Markdown server-side.
- Logs: Fastify request logging must not include query strings, cookies or authorization headers; pass log, error,
  audit and notification strings through the redactor (`packages/api/src/contracts/redact.ts`).
- SSRF: the only server-side fetches allowed are the configured GitHub API, the configured RPC endpoints, and
  content-addressed reads from configured IPFS gateways (redirects disabled, size-capped, digest verified after download).
- `trustProxy` is off unless explicitly configured; client IPs come only from the configured proxy hop.

## Code rules

- TypeScript strict, ESM, no `any`, no non-null assertions on external data. Validate every external input
  (HTTP, chain data, env, files, GitHub responses, GraphQL responses) with zod at the boundary.
- Never log or return secrets: RPC URLs may embed API keys, OAuth tokens, session ids, cookies, private keys.
  Build error messages from safe fields only; pass every persisted/returned error string through the redaction helper.
- No `eval`, `new Function`, `child_process` with untrusted input, dynamic `import()` of user data, or server-side
  fetching of user-supplied URLs (SSRF). Never extract uploaded archives or execute submitted evidence.
- Non-custodial: the backend never holds user keys, never signs user transactions, never requests unlimited token approvals.
- Money/amounts: `bigint` base units end to end; decimal strings only at the API edge. No floating point for amounts.
- Time: UTC everywhere; inject a clock; deadlines compare with the exact operator stated by the spec (`<` means strictly before).
- Idempotency: every chain-facing or multi-step operation is a persisted state machine with idempotency keys; a crash
  between steps must never cause a duplicate transaction plan, double count or lost record.
- Solidity: checks-effects-interactions plus `nonReentrant` on every function that makes an external call, custom
  errors, no upgradeability, no owner/admin/pause, no `tx.origin`, no unbounded loops over user-growable storage, explicit
  `uint64` timestamps with SafeCast for narrowing, events for every state change an indexer needs. Treat every token
  transfer as a possible callback (ERC-677/ERC-777/ERC-1155 hooks exist on Gnosis). Contracts never hold user funds.
  Deadline operators are frozen in the interface NatSpec (commit/publish: `block.timestamp < evidenceDeadline`;
  reveal: `block.timestamp < revealDeadline`; Reality opening time = `revealDeadline`).
- Avoid solc patterns with known bug classes even on 0.8.37: no named parameters in `require` with custom errors,
  no `delete` of memory `bytes` elements, no mutual recursion.

## Tests

- Vitest for TypeScript. Tests are deterministic: no wall clock (inject/fake clocks with explicit stepping), no network
  (except the explicit Gnosis fork tests in `contracts/test/fork/`), no shared state between files, PGlite for Postgres.
- A fake must implement the same interface and semantics as the real thing; when a shared conformance suite exists,
  run it against both.
- Every security requirement you implement gets a negative test (the attack fails), not only a happy path.

## Boundaries

- Never deploy, broadcast transactions, use real keys or spend real funds. Fork tests read state only.
- Do not touch files outside your lane's owned paths.
