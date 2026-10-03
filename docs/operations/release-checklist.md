# Release checklist (launch gates)

Nothing here is decided by code: every item is a human decision or an external deliverable, recorded (who, when, link)
before the first production release and re-checked by every release that touches it. The code fails closed until then
(production refuses SC-001, draft policies, a missing country header or sanctions list, a single RPC provider, missing
pin targets, unverified Seer/Reality/Kleros/Swapr addresses).

Two standing statements, true for v1 and part of every release:

- **Pine executes no submitted code.** Evidence and artifacts are stored and served as opaque bytes only; reproduction
  happens outside Pine.
- **Staging runs on an anvil fork of Gnosis, and testers use throwaway keys only.** A fork that keeps chain id 100
  accepts mainnet signatures: anything a real key signs there could be replayed on Gnosis.

## Launch gates (PRD-06 section 3)

| # | Gate | Evidence required | Done (who, date, link) |
|---|---|---|---|
| 1 | **External audit** of `ClaimRegistry` and `EvidenceRegistry` and a **published bug-bounty scope** (SEC-SC-17) | audit report with all findings resolved or accepted; public scope and disclosure policy | |
| 2 | **Policy approval**: FUNC-001 and BOT-001 versions moved from `draft` to `approved` by humans (catalog status change recorded in docs/adr); Seer/Kleros review of the question and policy text | ADR entry; catalog digests unchanged | |
| 3 | **Legal review**: terms and risk disclosure (`PINE_TERMS_DIGEST`), served and blocked **jurisdictions** (`PINE_BLOCKED_COUNTRIES*`), regulatory role, and a **hosted sanctions-screening provider** (v1 ships only the static denylist, `PINE_SANCTIONS_MODE=static`) | signed legal memo; published terms; provider contract | |
| 4 | **Staff trading and conflict-of-interest policy**, signed by everyone with access to moderation, pre-reveal data or admin wallets (SEC-LEGAL-07) | signed copies | |
| 5 | **GitHub App spike** (SEC-GH-02): the App with zero permissions and expiring user tokens works end to end against github.com (link, browse, revoke via `github_app_authorization` webhook); OAuth App only as documented fallback | spike report | |
| 6 | **Real-Postgres lease test**: the e2e suite on PostgreSQL 16 (`PINE_E2E_DATABASE_URL`, `PINE_E2E_REQUIRE_PG=1`; CI job `checks`), including two job runners competing for one lease, concurrent quota consumption, draft delete vs first publication and identical publications (`packages/api/test/e2e/concurrency.test.ts`), green on the release commit | CI run link | |
| 7 | **Envio live conformance** (only if `PINE_INDEXER_BACKEND=envio`): `pnpm --filter @pine/read-model-envio test:live` against the real deployment, and the Hasura select-only role checked (a mutation as the API role fails) | run log | |
| 8 | **An independently built and released client** (web or CLI) that re-verifies every plan with its own build of `@pine/shared` (`planFromWire` + `verifyPlan`), checks `eth_chainId` before every prompt, re-renders the question from the claim document, builds evidence reveals locally (the salt never leaves the client) and renders every SPEC section 8 state (loading, empty, failed, pending, disputed, invalid, resolved) — SEC-TX-01/02/05/07/10, SEC-AUTH-13 | release tag and build provenance of the client | |
| 9 | **Pilot claim selected** (SPEC section 9-10: target PR/commit, policy family, budget meaning) | decision record | |
| 10 | **Named operational owner and on-call** rota for the runbooks in this directory | names, rota, escalation contacts | |
| 11 | **Pilot measurement plan**: valid findings, noise, latency and total cost, compared with an equally funded bounty and conventional review (SPEC section 10.12) | plan document | |

## Further ADR-0001 gates

| Gate | Done |
|---|---|
| Fee and revenue model; sponsorship-program structure (reported separately) | |
| SC-001 stays disabled until a live-vulnerability disclosure process is approved (SEC-LEGAL-09; production refuses `SC-001`) | |
| Evidence takedown, legal hold and transparency policy; data retention and GDPR basis ([evidence-takedown.md](evidence-takedown.md)) | |
| Smart-contract-wallet login stays off (EOA-only SIWE) unless an ADR enables ERC-1271/6492 | |
| Linking to or embedding trading UI decided | |
| Pinning provider accounts (pin-only token) and the meaning of the minimum funding budget | |
| Incident response contacts ([incident-response.md](incident-response.md)) | |

## Production deployment (operator, after the gates)

1. Deploy the contract pair from a **hardware wallet**, after a dry run (same command without `--broadcast`) and a
   rehearsal on an anvil fork with a throwaway key; keep forge's `broadcast/` record and the printed JSON record:
   ```sh
   cd contracts && PINE_DEPLOYER=0x... forge script script/Deploy.s.sol --rpc-url gnosis --ledger --sender "$PINE_DEPLOYER" --broadcast
   ```
   (`gnosis` = `GNOSIS_RPC_URL` in `contracts/foundry.toml`.) The script refuses a Seer factory that is not the pinned
   address and runtime code hash.
2. Verify both contracts on the explorer; copy addresses and the deployment block into `/etc/pine/api.env`
   (`PINE_CLAIM_REGISTRY`, `PINE_EVIDENCE_REGISTRY`, `PINE_DEPLOYMENT_BLOCK`) and `/etc/pine/indexer.env`.
3. Follow `deploy/README.md`: roles, database, secrets, migrations, indexer, API, proxy, Kubo and pinning.
4. Smoke test on production with a throwaway wallet holding no funds: sign in, `/readyz` ready, browse claims, the
   agent feed and `/.well-known/pine.json`; no plan is sent.
5. CI on the release commit is green (checks, secret scanning, fork job), and the fork job ran its tests: its log shows
   the forge results, not the "fork tests skipped" step (that step runs only when `GNOSIS_RPC_URL` is unavailable).
6. Backups configured and one restore test done (`deploy/procedures/backup.md`); alerts wired for
   `pine_indexer_halted`, `pine_content_pin_*_total`, `pine_job_lease_lost_total`, `pine_http_errors_total`,
   `pine_github_webhook_rejected_total` and the readiness probes.
