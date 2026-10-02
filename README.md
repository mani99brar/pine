# Pine: adversarial verification of code claims

Pine lets a team connect GitHub, pin an exact commit, publish **one bounded, policy-versioned claim** about it, and fund a [Seer](https://seer-3.gitbook.io/seer-documentation) prediction market. The market incentivizes independent investigators, human or AI, to submit a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the market question, and Kleros arbitrates disputed answers.

> A NO outcome means *no qualifying counterexample was submitted*. It is not a safety certification. See [SPEC.md](SPEC.md).

This repository contains **three alternative, production-grade frontends**. They are built on one shared, tested domain and data core:

| Version | App | Port | Direction | Best for |
|---|---|---|---|---|
| v1 **Pine Console** | [`apps/console`](apps/console) | 3001 | Keyboard-first verification workbench. Command palette, split-pane composer with live immutable artifacts and hashes, dense tables | Engineers and agent operators |
| v2 **Pine Docket** | [`apps/docket`](apps/docket) | 3002 | Procedural clarity. Claims as case files, evidence as exhibits, a procedural timeline, a guided filing wizard, a print-ready filing | Team leads and newcomers to prediction markets |
| v3 **Pine Field** | [`apps/field`](apps/field) | 3003 | The open challenge board. Live data glyphs (tension bar, time ring, depth bars), a price-impact simulator and a sentence-template claim builder | Investigators, traders, and live tracking |

Each app's README covers its concept, routes and signature interactions.

## Quick start (no setup, no credentials)

```bash
pnpm install
pnpm dev:console   # http://localhost:3001
pnpm dev:docket    # http://localhost:3002
pnpm dev:field     # http://localhost:3003
```

With no environment variables, every app runs in **demo mode**:

- realistic fixture claims in every lifecycle state;
- mock GitHub repos, PRs and commits;
- "Demo sign-in" in place of GitHub OAuth;
- a simulated wallet whose transactions confirm after a short delay. Reviewers can force the next transaction to fail and try the recovery flow.

## What's inside

```
packages/
  core/    @pine/core    domain types, policy catalog (FUNC-001, BOT-001, SC-001 gated), claim manifest + question
                         builders, canonical hashing, validation, lifecycle, funding estimator, chain config/ABIs,
                         tx-plan builders, agent artifacts (llms.txt, briefs, JSON Schema, OpenAPI, Atom, JSON-LD), copy
  data/    @pine/data    PineDataProvider + adapters: mock | rest | envio; GitHub source; IPFS manifest storage;
                         draft & account stores; demo fixtures
  react/   @pine/react   headless hooks/providers: queries, wallet (real + demo), resumable tx runner, claim composer
  server/  @pine/server  Next.js route handlers: Auth.js (GitHub read:user + demo), GitHub proxy, SIWE wallet linking,
                         agent API, llms.txt, well-known, IPFS upload
apps/      console · docket · field
docs/
  indexer/    REST OpenAPI contract + Envio HyperIndex schema/config contract (indexer not implemented here)
  agents/     agent API guide + claim manifest JSON Schema
  frontend/   package API contract, deployment, launch gates, readiness board
  superpowers/specs, plans   design spec and implementation plan (all decisions recorded)
  research/   Seer / Reality.eth / Kleros / Envio integration notes
```

## Data sources: REST API or Envio

Every app reads through one interface (`PineDataProvider`), selected by `NEXT_PUBLIC_PINE_DATA_SOURCE`:

- `mock`: fixtures (the default).
- `rest`: any service implementing [`docs/indexer/rest-api.openapi.yaml`](docs/indexer/rest-api.openapi.yaml). Reads cover indexed chain state; writes cover drafts and accounts.
- `envio`: an Envio HyperIndex deployment matching [`docs/indexer/envio/schema.graphql`](docs/indexer/envio/schema.graphql). On-chain reads come from the index, manifests are hydrated from IPFS, and drafts stay local.

See [`docs/indexer/README.md`](docs/indexer/README.md).

## Data for AI agents

Every app serves the same machine-readable surface:

| Path | What |
|---|---|
| `/llms.txt`, `/llms-full.txt` | What Pine is, how to find open claims, how to submit evidence, the rules |
| `/.well-known/pine.json` | Discovery descriptor |
| `/api/agent/v1/claims?status=open` | Investigation briefs (JSON). `/api/agent/v1/claims/{id}?format=md` returns a ready-to-use prompt |
| `/api/agent/v1/claims/{id}/manifest.json` | Canonical immutable manifest (`x-pine-manifest-hash` header) |
| `/api/agent/v1/policies`, `/api/agent/v1/schema/claim-manifest.json`, `/api/agent/v1/openapi.json` | Policies, JSON Schema, OpenAPI |
| `/api/agent/v1/feed.xml` | Atom feed of newly opened claims |

Claim pages also embed JSON-LD and `rel="alternate"` JSON links. See [`docs/agents/agent-api.md`](docs/agents/agent-api.md).

## Scripts

```bash
pnpm test        # vitest for all packages
pnpm typecheck   # every package and app
pnpm lint
pnpm build       # production builds of all three apps
node scripts/smoke.mjs   # crawl all running apps + agent endpoints, check status codes and forbidden wording
```

## Status

Frontend only. Not built here: the indexer, the evidence relay, the IPFS pinning service, and smart contracts. Open product and launch decisions from SPEC §10 are tracked in [`docs/frontend/launch-gates.md`](docs/frontend/launch-gates.md) and shown in-app. Deployment is covered in [`docs/frontend/deployment.md`](docs/frontend/deployment.md).
