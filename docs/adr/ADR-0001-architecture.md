# ADR-0001: Backend architecture decisions (v1)

Status: accepted for implementation, 2026-10-02. Decided by the operator on the user's delegation, after verified research
(`docs/research/*`), a threat model (`docs/security/requirements.md`) and a three-proposal design panel
(security-minimal, product-complete, operability) with a judge. Items marked **LAUNCH GATE** must be confirmed by a human
(or a recorded test) before any production use; code ships with them enforced fail-closed.

## D1. Chain, collateral, deployments
- Gnosis Chain (chain id 100) only. Seer `MarketFactory` 0x83183DA8…cDcf1 (sDAI profile, `questionTimeout` 302400 s),
  Reality.eth v3 0xE78996A2…05cc, Kleros home proxy 0x68154EA6…91Dc (arbitrator), RealityProxy, CTF, Wrapped1155Factory,
  GnosisRouter, Swapr v3 = Algebra V1.9. All pinned in `packages/shared/src/deployment.ts` (verified on-chain).
- Collateral is sDAI (fixed by the factory). Users fund with native xDAI via `GnosisRouter.splitFromBase{value}` (no ERC-20 approval).
- Staging is an anvil fork of Gnosis (same chain id). No testnet deployment of Seer is relied on.

## D2. Market and question
- Seer `createCategoricalMarket`, outcomes `["Yes","No"]` (Seer appends Invalid), token names `PY_`/`PN_` + first 4 bytes of the
  claim-document digest, category `misc`, lang `en_US`, Reality opening time = `revealDeadline`.
- The question is composed **on-chain** by `ClaimRegistry` from validated fields only (see `IClaimRegistry.renderQuestion`):
  a printable-ASCII title (no `"`/`\`), the evidence registry address, both deadlines (UTC), the GitHub repository id, the
  commit, and the claim-document and policy digests with their derived raw CIDs. It is byte-identical to
  `packages/shared/src/question.ts` (frozen vectors). No URI or other free text reaches Seer/Reality, which removes the JSON
  injection into Seer's question template (seer-pm/demo PR #504) and any question/record mismatch.
- The claim document governs; the title is informational. **LAUNCH GATE:** Seer/Kleros compatibility review of the question
  and policy text (Kleros General Court jurors are generalists; 2 of 3 historical disputes through this proxy ended "answered too soon").

## D3. Contracts
- Exactly two Pine contracts, immutable, ownerless, unpausable, token-free: `ClaimRegistry` (creates the Seer market and records
  the claim atomically) and `EvidenceRegistry`. No orchestrator, no LP lock, no contract ever holds user funds or NFTs.
- Binding: EvidenceRegistry is deployed first with the registry's predicted address; the ClaimRegistry constructor requires code at
  both and `evidenceRegistry.claimRegistry() == address(this)`, and asserts the Seer factory's immutables equal the expected
  deployment (arbitrator, realitio, realityProxy, CTF, wrapped1155Factory, collateral, timeout 302400).
- Duplicates: one claim per `(creator, claimDocumentSha256)` (`DuplicateClaim`); a copycat cannot block anyone, and a market whose
  on-chain creator differs from the document's `creator` is non-canonical (API integrity check).
- Bounds (immutable): evidence window 1–90 days from creation; reveal window 12 hours–7 days after the evidence deadline;
  min bond between the deploy-time floor (1 xDAI) and 10,000 xDAI; title 1–120 bytes.
- `ClaimCreated(market, creator, claimDocumentSha256, Claim claim, title, marketName)` carries everything indexers need
  (including outcome-token addresses); `Claim` as a struct avoids stack-too-deep and is decoded by viem and Envio v3 (verified).
- **LAUNCH GATE:** independent external audit, slither/aderyn triage, hardware-wallet deployer with no privileges (SEC-SC-17/19).

## D4. Evidence mechanism
- On-chain commit-reveal plus direct publication (`EvidenceRegistry`). Commitment =
  `keccak256(abi.encode(TYPEHASH, chainid, registry, market, submitter, contentSha256, salt))` (frozen vector), salt ≥128 bits
  generated client-side, never sent to Pine before reveal. Submissions keyed by sequential id.
- Operators: commit/publish iff `block.timestamp < evidenceDeadline`; reveal iff `block.timestamp < revealDeadline`, by the
  submitter, once. Answers are possible only from `revealDeadline` (Reality opening), so no timely reveal can follow an answer.
- Content identity is the SHA-256 of a canonical evidence manifest (`urn:pine:evidence-manifest:v1`, ≤256 KiB, names its
  submitter); artifacts ≤256 KiB each, referenced by digest. No URIs on-chain; raw CIDs derive from digests.
- Availability: Pine stores and pins manifests and artifacts it receives (Kubo + one remote pinning provider). Policy C2/C4: an
  unobtainable manifest is inadmissible; an unobtainable claim document makes the question Invalid.
- Kleros disputes: evidence for jurors goes to the Ethereum-mainnet foreign proxy (`submitEvidence`); Pine generates the ERC-1497
  JSON and instructions, but issues no mainnet transaction plans in v1.

## D5. Disclosure and policy families
- FUNC-001 and BOT-001 enabled; SC-001 disabled everywhere (catalog status `disabled`; API returns FEATURE_DISABLED) until a
  human-approved disclosure process exists (**LAUNCH GATE**). Every claim document attests `disclosure.liveSystemImpact: "none"`.
- Policy texts are versioned immutable files (`policies/catalog`); 0.1.0 texts are **drafts**. Production publishes only
  `approved` versions (`allowDraftPolicies` must be false in production). **LAUNCH GATE:** human approval of policy text.
- No confidential-evidence channel in v1: commit-reveal hides content only until reveal.

## D6. Windows and parameters (API defaults, within the on-chain bounds)
- Evidence window 3–30 days, default 7; reveal window fixed 48 h; Reality opening = reveal deadline; min bond default 10 xDAI
  (Seer default), allowed 1–100 xDAI. Deadlines rounded to whole minutes.
- Displayed timeline: evidence closes T, reveals close T+48h (answers open), earliest finalization opening + 3.5 days (each new
  answer resets 3.5 days), a Kleros dispute adds ~16–20 days and 0.1674 ETH paid on Ethereum (at research time).
- A publish plan expires 15 minutes before the on-chain minimum evidence window would be violated; then re-preview (new digest).

## D7. Oracle operations
- Pine runs no keeper and holds no keys: it never answers, bonds or funds arbitration. It provides monitoring (derived status and
  "due actions"), in-app notifications, and verified unsigned plans that any wallet can send for permissionless steps:
  `RealityProxy.resolve`, `reopenQuestion` (after "answered too soon"), Kleros home `handleNotifiedRequest`,
  `handleRejectedRequest`, `reportArbitrationAnswer`, Reality `claimWinnings`/`withdraw`, and exact-value `submitAnswer` /
  `fundAnswerBounty`. **Risk accepted:** liveness depends on interested parties; disclosed in the UI and the agent feed.

## D8. Funding and liquidity
- Market creation and funding are separate plans executed by the user's wallet directly against Seer and Swapr with exact
  approvals (no orchestrator contract). Default strategy: a single-sided **YES sell ladder** — split S into full sets, offer YES
  over [a, b] (b ≤ 0.95), keep NO and Invalid. Maximum loss if YES resolves ≈ S·(1 − √(a·b)) (+ gas); if NO or Invalid
  resolves, the loss is gas only. If the pool exists at a price inconsistent with the ladder, the plan is refused (no re-pricing
  swaps in v1); mint uses tight minimum amounts so a front-run initialisation makes it revert harmlessly.
- Liquidity is withdrawable and is never advertised as a bounty or guaranteed reward. No LP lock in v1 (no audited Algebra locker
  exists on Gnosis; a lock would add custody). The $5 example is treated as a total spending cap including gas; the UI states its
  likely inadequacy. **LAUNCH GATE:** the meaning of the $5 budget and minimum viable funding (SPEC §10.2).

## D9. GitHub
- GitHub App with zero permissions, expiring user-to-server tokens, never installed, PKCE + session-bound state; OAuth App with no
  scopes as the configured fallback (**LAUNCH GATE:** SEC-GH-02 spike). Public repositories only; repositories identified by
  numeric id; commit membership proven (PR head, PR commit list, or branch ancestry via compare), never inferred from existence.

## D10. Authentication and sessions
- SIWE, EOA-only (local ECDSA recovery, no RPC in the auth path), server-issued byte-identical messages, `crypto.randomBytes`
  nonces bound to a pre-session, every EIP-4361 field checked, statement embeds the terms digest (acceptance record).
- Opaque `pine_s1_` sessions stored hashed; `__Host-` cookie; rotation on login/link/privilege change; CSRF per CLAUDE.md;
  admins from a configured allowlist re-evaluated per request, destructive admin actions need a signature < 5 minutes old.

## D11. Content storage
- Source of truth: Postgres `bytea` (objects ≤256 KiB, a single raw IPFS block so the local raw CID equals the pinned CID);
  pin outbox to Pine's Kubo node and one Pinning Service API provider (**LAUNCH GATE:** provider accounts). User content is served
  only by a separate listener on a different registrable domain, `application/octet-stream`, attachment, nosniff, sandbox CSP;
  moderation can hide or block (451) without touching documents or chain data.

## D12. Indexers
- Native indexer (`@pine/indexer-native`) is primary: finalized blocks only (no rollback path), two RPC providers must agree on
  the finalized hash, strict decoding, idempotent writes with the cursor in the same transaction, halt on integrity conflict.
- Envio HyperIndex (`@pine/indexer-envio` + `@pine/read-model-envio`) is the second, optional option behind the same
  `ReadModel`, with `rollback_on_reorg` and a block lag; both must pass the shared conformance suite.
- The API serves staleness with every chain-derived response and refuses plan building (`NOT_READY`) when the read model is
  stale or halted.

## D13. Agents
- Public, cookie-free, CORS `*` endpoints: `/.well-known/pine.json`, `/api/v1/agents/claims[...]`, JSON Schemas generated from the
  frozen zod schemas, OpenAPI. User-supplied fields are always labelled `contentTrust: "untrusted"`; evidence instructions carry
  the commitment formula and the timing operators; a fixed warning to reproduce only in isolated sandboxes without secrets.

## D14. Abuse, moderation, compliance
- Per-user quotas, per-IP rate limits (Postgres-backed store), moderation hide/block with reasons, step-up and audit.
- Compliance hooks fail closed in production: geofence by a trusted CDN header (451), sanctions screening interface (static
  denylist in v1), terms acceptance per action. **LAUNCH GATES:** jurisdictions, sanctions provider, terms and risk copy, legal review.

## D15. Operations
- Postgres roles: migrator (DDL; `pnpm --filter @pine/api migrate`), api (DML, INSERT-only audit), indexer (own schema), readonly.
  API startup only verifies migrations. Processes: api (HTTP + jobs), user-content listener, indexer-native, optional Envio.
- Runtime uses Node 24 with the pinned `tsx` loader (workspace packages export TypeScript sources); a bundled build is deferred.
- Observability: pino JSON with redaction and query-less URLs, Prometheus metrics on an internal port, `/healthz`, `/readyz`.

## D16. Delivery plan (md-manager workflow)
- Wave 1 (≤5 workers): feature `chain` (lanes `claim-registry`, `evidence-registry`), feature `platform` (`platform-core`,
  `platform-gateways`), feature `claims` (`claims`).
- Wave 2 (as slots free): feature `markets` (`markets`, `funding`), feature `indexers` (`indexer-native`, `indexer-envio`).
- Wave 3: feature `assembly` (composition root, read-model wiring, fork end-to-end tests, deployment docs) and security fix-ups
  from an independent review of the merged code.
- Every feature: design challenge, review sidecar, reviewers `general`, `coverage` and `security` (features/_shared/security-review.md).

## Deferred
- Smart-contract-wallet login (ERC-1271/6492), LP lock contract, confidential evidence for SC-001, keeper with keys, re-pricing
  swaps, mainnet Kleros transaction plans, bundled production build, email notifications, frontend.
