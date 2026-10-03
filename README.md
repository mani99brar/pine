# Pine

Pine is the backend of a GitHub claim-verification market: a customer connects GitHub, selects an exact commit of a
public repository, publishes **one bounded, versioned claim** about it ("was a reproducible counterexample demonstrating
*this violation* against commit *X* submitted before *T*?"), and funds a Seer prediction market on Gnosis Chain whose
Reality.eth question asks exactly that, with Kleros arbitration for disputes. Independent researchers and agents
investigate, submit evidence (commit-reveal on chain, content-addressed off chain) and trade. Pine is non-custodial: it
never holds keys or funds and never signs; every on-chain action is a **transaction plan** the user's own wallet
verifies and sends. Product specification: [SPEC.md](SPEC.md); decisions and launch gates:
[docs/adr/ADR-0001-architecture.md](docs/adr/ADR-0001-architecture.md); security requirements:
[docs/security/requirements.md](docs/security/requirements.md).

A NO outcome means "no qualifying counterexample was submitted in time", never "the code is safe". Pine executes no
submitted code in v1.

## Architecture

```
  wallet + independent client (verifies every plan with its own @pine/shared)
        |  HTTPS, same origin                         | HTTPS (downloads only)
  edge proxy (TLS, per-IP limits, GeoIP country) ----+----------------------------+
        |                                                                          |
  pine-api  (packages/api)                                   user-content server (separate origin,
   Fastify: SIWE sessions, CSRF, quotas, audit, moderation,   attachment + sandbox CSP, no cookies)
   claims / markets / funding route modules, jobs             |
        |  pine_api (DML)          | read model (pine_readonly or Envio GraphQL)
  PostgreSQL 16  <-----------------+------------------- pine-indexer-native (pine_indexer)
   public: platform + modules      pine_index: finalized-only chain facts      | two independent RPC providers
        |                                                                      v
  Kubo + Pinning Service (raw CIDs)                 Gnosis: ClaimRegistry, EvidenceRegistry, Seer, Reality.eth,
                                                    ConditionalTokens, Swapr (Algebra), Kleros home proxy
```

- **Contracts** (`contracts/`, Foundry, Solidity 0.8.37): `ClaimRegistry` creates the Seer market for a claim document
  digest and records the claim; `EvidenceRegistry` records evidence commitments, reveals and publications with strict
  deadlines. Immutable: no owner, admin, pause or upgrade.
- **API** (`packages/api`): hardened Fastify app (`src/platform/core`), gateways to GitHub, content storage and IPFS
  pinning, the chain (`src/platform/gateways`), and three route modules: `claims` (policies, GitHub browsing, drafts,
  immutable previews, publication plans, reconciliation, integrity, listings, agent feed), `markets` (evidence intake and
  plans, evidence browsing, oracle status and due actions, oracle plans, notifications) and `funding` (YES sell-ladder
  liquidity, positions, withdraw/merge/redeem plans). `src/readmodel.ts` selects the read model.
- **Read model**: `@pine/indexer-native` (default; a finalized-only dual-RPC log poller writing `pine_index`, halting on
  any integrity conflict) or `@pine/indexer-envio` + `@pine/read-model-envio` (Envio HyperIndex; its live conformance
  is a launch gate). Both implement the frozen `ReadModel` interface of `@pine/shared`.
- **Shared** (`packages/shared`): frozen cross-package contracts: types, ABIs, deployment manifest, canonical claim
  documents and evidence manifests, the question renderer, transaction plans (`buildStep`/`verifyPlan`/`planFromWire`).

## Packages

| Path | Package | What |
|---|---|---|
| `contracts/` | Foundry | ClaimRegistry, EvidenceRegistry, deployment script, unit, fork and fork-e2e tests |
| `packages/shared` | `@pine/shared` | frozen types, ABIs, encodings, transaction plans, read-model interface and test scenarios |
| `packages/api` | `@pine/api` | HTTP API, jobs, migrations (`migrations/`), end-to-end suite (`test/e2e`) |
| `packages/indexer-native` | `@pine/indexer-native` | native indexer and its read model |
| `packages/indexer-envio` | `@pine/indexer-envio` | Envio HyperIndex project |
| `packages/read-model-envio` | `@pine/read-model-envio` | read model over Envio's GraphQL |
| `policies/` | | policy families and the versioned policy catalog referenced by claims |
| `deploy/`, `docs/operations/` | | deployment assets, runbooks, release checklist |

## Running the tests

Node 24 and pnpm 12.8.1 (corepack); Foundry for the contracts.

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm -r typecheck
pnpm exec eslint packages
node scripts/check-forbidden.mjs                     # static security gate
pnpm -r --workspace-concurrency=1 test               # every package (vitest; PGlite, no network)
pnpm --filter @pine/api exec vitest run test/e2e     # the whole backend end to end (PGlite)
forge build --root contracts && node scripts/export-abis.mjs --check
node scripts/forge-test-tap.mjs --match-path "test/{claim-registry,evidence-registry}/**/*.sol"
GNOSIS_RPC_URL=<archive rpc> node scripts/forge-test-tap.mjs --match-path "test/fork/**/*.sol"   # fork tests, no broadcast
GNOSIS_RPC_URL=<archive rpc> node scripts/forge-test-tap.mjs --match-path "test/e2e/**/*.sol"    # deployment + lifecycle on a fork
```

The end-to-end suite (`packages/api/test/e2e`) boots the real `buildApp` with every route module, the real gateways (fake
GitHub and RPC transports injected), the read model of `src/readmodel.ts` over the native index fed by the real
`applyEvents`, and drives the SPEC section 3 journey (SIWE login, GitHub link, draft, preview, publication plan, simulated
`ClaimCreated`, reconciliation, integrity, listings and agent feed, funding ladder, evidence upload with commit/reveal,
oracle status and due actions, resolution, redeem) plus its negative paths (CSRF, stale/halted read model, SC-001
disabled, blocked content, compliance refusals, cookies on public routes, no secret in any response, log line or stored
error). Every plan in a response is decoded with `planFromWire` and verified with `verifyPlan`. On real PostgreSQL 16:

```sh
PINE_E2E_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres PINE_E2E_REQUIRE_PG=1 \
  pnpm --filter @pine/api exec vitest run test/e2e
```

The URL is a **superuser of a disposable cluster**: the suite runs `deploy/postgres/*.sql`, creates the four roles (cluster
wide, with fixed test passwords) and one database `pine_e2e_<hex>` per test file, runs both migration commands, and drops
the database afterwards (a failed drop fails the run); it also runs the concurrency cases PGlite cannot show.
`PINE_E2E_REQUIRE_PG=1` makes a missing URL a failure (CI sets both, with a `postgres:16` service). Because it sets the
production role names' passwords, the suite refuses a URL whose host is not loopback (`127.0.0.1`, `::1`, `localhost`;
no `host`/`hostaddr` parameter) unless `PINE_E2E_DISPOSABLE_CLUSTER=1` declares the whole cluster disposable.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push and pull request with a read-only token and
actions pinned to commit SHAs: audit, forbidden patterns, ABI and plan-vector checks, typecheck, lint, every package's
tests, contract unit tests, the e2e suite on PostgreSQL 16, gitleaks over the whole history (checksum-pinned release,
reviewed allowlist in `.github/workflows/gitleaks.toml`), and the Gnosis fork tests. Repository secrets: only
`GNOSIS_RPC_URL` (an archive RPC, mapped into the fork job's env only; that job's steps are skipped when it is empty,
as on pull requests from forks).

## Deploying

See [deploy/README.md](deploy/README.md): PostgreSQL roles and database, environment files (non-secret configuration
separate from secrets), systemd units (`pine-migrate` oneshot, `pine-indexer-native`, `pine-api`), the edge proxy
(same-origin API, separate user-content domain, per-IP limits, TLS), Kubo and pinning, backups and key rotation.
Contracts are deployed once by an operator with a hardware wallet (`contracts/script/Deploy.s.sol`). Runbooks:
[docs/operations/](docs/operations/README.md).

## Launch gates (ADR-0001)

Pine is not production-ready until every gate of
[docs/operations/release-checklist.md](docs/operations/release-checklist.md) is closed by the people who own it:

1. External contract audit and a published bug-bounty scope (SEC-SC-17).
2. Human approval of the policy versions; Seer/Kleros review of the question and policy text.
3. Legal review: terms and risk disclosure, served and blocked jurisdictions, regulatory role, a hosted sanctions provider.
4. A signed staff trading and conflict-of-interest policy (SEC-LEGAL-07).
5. The GitHub App spike (SEC-GH-02).
6. The real-Postgres lease and concurrency tests green on the release commit.
7. Envio live conformance, if the Envio read model is chosen.
8. An independently built and released client that re-verifies every plan with its own `@pine/shared`, checks
   `eth_chainId`, re-renders the question, builds reveals locally and renders every SPEC section 8 state.
9. Selection of the pilot claim; a named operational owner and on-call; a pilot measurement plan (valid findings, noise,
   latency, total cost).
10. Further ADR-0001 gates: fee and sponsorship model, SC-001 disclosure process (refused in production until then),
    takedown/legal-hold/transparency and retention policy, smart-contract-wallet login (off), trading-UI linking,
    pinning provider accounts and the minimum funding budget.

Staging runs on an anvil fork of Gnosis with throwaway keys only (a fork keeping chain id 100 could replay anything a
real key signs there).
