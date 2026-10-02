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
- Listings and feeds come from a module-owned `claims_index` table written by the integrity job (keyset cursors, no moderation data); moderation is applied per page at read time (pages may be shorter than `limit`); the `phase` filter accepts only `evidence_open`, `reveal_open`, `closed`.
- Expiry of publications is decided from read-model coverage (not halted, indexed block time past evidenceDeadline − 1 day), never from the chain head alone.
- Plans go over HTTP with `planToWire`; tests decode with `planFromWire` before `verifyPlan`.
- Time comes from `ctx.clock` as a bound parameter everywhere (never SQL `now()` for business logic).
- Drafts have a `revision` counter; previews/publications never cascade from drafts (409 on deleting a draft with a publication).
- Integrity also checks the document's constant fields against the manifest and Seer's `NewMarket` in the creation receipt.
- The module is `createClaimsModule({ catalogDir })` with `claimsModule` as the default instance; tests use a temporary catalog copy.
- Only claims whose document is retrievable and matches every on-chain field are `verified` and listed; others stay visible by exact id with their integrity status.
- Agent endpoints are public, cookie-free and label user-supplied content `contentTrust: "untrusted"`.
- Integrity job = discovery (walk `created_desc` from the head to the first indexed claim, then insert every collected claim as
  `pending` in one transaction, `ON CONFLICT DO NOTHING`; an error inserts nothing) + verification (pending/due rows oldest first,
  ≤ 50 per run, one try/catch and one compare-and-set transaction per claim). Transient errors keep a claim `pending` with backoff;
  inputs the frozen renderer refuses are `mismatch` on `question`.
- Document constants (Seer factory, collateral, realitio, arbitrator, timeout) come only from `buildDeploymentManifest(config.contracts)`
  for both preview and integrity; module registration throws if `config.seer` disagrees with the manifest.
- `POST /publications` order: validation → compliance → NOT_READY → preview (NOT_FOUND) → 409 checks → row (reuse, else consume quota
  then `INSERT ... ON CONFLICT DO NOTHING RETURNING`, re-read on conflict) → chain re-check → content → plan. Two racing first
  requests may consume two quota units (accepted; no 500, no duplicate). After the plan offer expires a retry returns the
  publication with `planExpired: true` and no plan; a new preview (new nonce, new digest) is the way to publish again.
- Deleting a draft without publications deletes its previews in the same transaction; with a publication it is 409.
- Schema endpoint test: separate Fastify with Ajv `removeAdditional: false, coerceTypes: false, useDefaults: false`; structural
  tampering only; refinements are tested against the frozen parse functions; served schemas carry a `$comment` about server-side rules.
- Operator clarifications (claims-004, design-challenge P2s): (1) driver portability — compare-and-set success only from drizzle
  `.returning()` rows, never `rowCount`/`affectedRows`; explicit int8/count casts in raw SQL; (2) inside a transaction only the
  transaction handle; (3) `pending` integrity rows also get `next_attempt_at` (exponential backoff capped at 1 h), selected by
  `next_attempt_at <= now` oldest first; (4) jobs never depend on `register()` having run: one memoized loader verifies the catalog
  and the config.seer/manifest assertion for both; (5) for a `pull` membership ref the base commit is verified with
  `{ kind: "branch", name: pull.baseRef }` (a PR base sha is never a PR commit; accepted deviation from "against the same ref");
  (6) bidi/zero-width/BOM characters appear in tests only as `\u` escapes (the forbidden gate scans tests); (7) the window rule
  stays "round up to the minute, then check bounds" and the refusal message states the maximum minus 60 s.
- Claim index `repository_id` is unbounded `numeric` (an on-chain uint64 never breaks discovery); the ClaimRegistry now also caps
  it at 2^53 - 1.
- Tests serialize PGlite-heavy files across vitest's fork processes with a cross-process lock: an atomic `fs.mkdir` lock
  directory under `os.tmpdir()` holding the owner pid, taken at import before the heavy imports, released in `afterAll`, stale
  owners (dead pid) taken over (each PGlite instance takes ~400 MB on this host). Verified by the operator on 2026-10-02: commit
  `6e46a26` on this base passes the exact gate `pnpm --filter @pine/api exec vitest run src/modules/claims` — 10 files, 77 tests,
  61 s, peak RSS 1.4 GB — and the bracket-title change breaks no claims test.
- claims-005 review fixes (claims-006): `listable` = verified AND parameters_valid (stored) AND policy digest in the currently
  publishable set (query time, never stored; only listable claims in listings and feeds); FK race → NOT_FOUND; agent feed limit
  25 without document bodies; no in-process document cache (content moderation applies on every read); blocked claims never
  expose user-content URLs; moderated resources `no-cache`; tolerant draft reads;
  atomic stale-lock takeover; the missing tests of PRD-03 section 9 (claims-006 additions).
- "Public routes never read cookies" is proven by the platform; this module proves its public handlers ignore sessions (identical
  responses with and without `x-test-session` and a `Cookie` header).
- Coverage matrix (lesson from the platform and claims reviews): each lane's completion maps every required test of its PRD section
  and every decision/operator clarification to the test file and test name that would fail if the behaviour were removed, and
  closes every gap before completing (the independent coverage reviewer blocks on any untested requirement).

## Assumptions

- `ctx.chain.publicClient` supports `getGasPrice`, `getTransactionReceipt` and `readContract` (scripted in tests).
- The policy catalog directory is at `policies/catalog` relative to the repository root, resolved from this module's file location.
- `ctx.readModel` is fresh enough when its indexed block timestamp is within `config.maxIndexerLagSeconds` of the clock and it is not halted.

## Deferred

- Funding, evidence, oracle and account routes (features `markets`), the native and Envio read models (feature `indexers`), and the production composition (feature `assembly`).
