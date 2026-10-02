# Decisions: claims

Settled by the operator from ADR-0001 (docs/adr/ADR-0001-architecture.md) on 2026-10-02.

## Decisions

- The claim document is `urn:pine:claim:v1` exactly as frozen in `packages/shared/src/claim-document.ts`; a preview freezes its bytes and publication must use the previewed digest: no field may be recomputed between preview and publish.
- The question and token names come only from `@pine/shared/question` (byte-identical to the on-chain `ClaimRegistry.renderQuestion`): the module never formats question text itself.
- Publishing is gated: policy status `approved`, or `draft` only when `allowDraftPolicies` (never in production); `SC-001` is always `FEATURE_DISABLED`; FUNC-001/BOT-001 must be in `enabledPolicyFamilies`.
- API windows: evidence deadline rounded up to the minute, then the window must lie in [max(3 d, config min), min(30 d, config max)]; reveal window fixed 48 h; min bond 1–100 xDAI (default 10); a plan is offered only until min(evidenceDeadline − 1 day − 15 min, previewCreatedAt + 24 h).
- Publication is one plan step (`claimRegistry.createClaim`), idempotent per (user, digest), bound to `{previewId, documentSha256}` (409 on mismatch or a draft edited after preview). Confirmation comes from the finalized read model (claim found by creator and digest) plus the receipt of its indexed creation transaction with the expected `ClaimCreated` log; user-reported hashes are hints that cover speed-ups, replacements and double sends; `expired`/`failed` only once chain time makes createClaim impossible.
- `SC-001` is refused at draft create/update, preview and publication.
- Use `tokenNames()` and `buildDeploymentManifest()` from `@pine/shared`; `commit` is passed as `bytes20` (`0x${commit}`); JSON Schemas use `z.toJSONSchema(schema, { io: "input" })`; frozen schemas are not used as response schemas.
- Listings and feeds come from a module-owned `claims_index` table written by the integrity job (keyset cursors), never by filtering read-model pages in memory.
- The module is `createClaimsModule({ catalogDir })` with `claimsModule` as the default instance; tests use a temporary catalog copy.
- Only claims whose document is retrievable and matches every on-chain field are `verified` and listed; others stay visible by exact id with their integrity status.
- Agent endpoints are public, cookie-free and label user-supplied content `contentTrust: "untrusted"`.

## Assumptions

- `ctx.chain.publicClient` supports `getGasPrice`, `getTransactionReceipt` and `readContract` (scripted in tests).
- The policy catalog directory is at `policies/catalog` relative to the repository root, resolved from this module's file location.
- `ctx.readModel` is fresh enough when its indexed block timestamp is within `config.maxIndexerLagSeconds` of the clock and it is not halted.

## Deferred

- Funding, evidence, oracle and account routes (features `markets`), the native and Envio read models (feature `indexers`), and the production composition (feature `assembly`).
