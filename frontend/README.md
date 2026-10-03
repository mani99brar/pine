# Pine frontend

The web frontend for Pine's GitHub claim verification. A team pins an exact commit, publishes **one bounded, policy-versioned claim** about it, and funds a [Seer](https://seer-3.gitbook.io/seer-documentation) prediction market. The market incentivizes independent investigators, human or AI, to submit a reproducible counterexample before an absolute UTC deadline. Reality.eth answers the market question, and Kleros arbitrates disputed answers.

> A NO outcome means *no qualifying counterexample was submitted*. It is not a safety certification. See [`../SPEC.md`](../SPEC.md).

This directory is a **self-contained pnpm workspace**: its own `package.json`, lockfile, `tsconfig` and `.gitignore`. It is separate from the backend workspace at the repository root, so neither one's installs, configs or CI affect the other. **It is not wired to the backend API yet.** It reads data through its own `PineDataProvider` adapters (mock, REST, Envio), and demo mode needs no services at all.

## Pine Prism

[`apps/prism`](apps/prism) is a Next.js 16 app on port 3004. It's dark, luminous and motion-rich: **a claim is a crystal, and the market is light passing through it.**

- **WebGL hero.** A beam draws in, a crystal seeded from the claim's hash assembles, and light disperses into Yes, No and Invalid beams sized from the live market price.
- **Facet-cutting composer.** Each pinned input cuts a facet shaded by its real hash: commit, policy, question, environment, deadline, oracle, funding, manifest and market. Publishing seals the crystal once the terms freeze.
- **Light table.** Claim crystals sit around a "now" slit. Height is the Yes price, size is liquidity, hue is the policy family, and the glow quickens as the deadline nears.
- **Outcomes in material.**
  - A demonstrated counterexample fractures the crystal.
  - NO leaves it whole but dimmed.
  - Invalid clouds it.
- **Fallbacks.** Every 3D scene falls back to a static poster without WebGL or with reduced motion.

[`apps/prism-share`](apps/prism-share) is a static, browser-only build of the same app for sharing as a hosted artifact. It's a Vite SPA that renders Prism's real pages, with Next shims and an in-browser demo API.

## Quick start (no setup, no credentials)

```bash
cd frontend
pnpm install
pnpm dev:prism        # http://localhost:3004
pnpm build:share      # static build → apps/prism-share/dist
```

With no environment variables, Prism runs in **demo mode**:

- fixture claims in every lifecycle state;
- mock GitHub repos, PRs and commits;
- "Demo sign-in";
- a simulated wallet. Reviewers can force the next transaction to fail and try the recovery flow.

## What's inside

```
frontend/
  packages/
    core/    @pine/core    domain types, policy catalog (FUNC-001, BOT-001, SC-001 gated), claim manifest and question
                           builders, canonical hashing, validation, lifecycle, funding estimator, chain config and ABIs,
                           tx-plan builders, agent artifacts (llms.txt, briefs, JSON Schema, OpenAPI, Atom, JSON-LD), copy
    data/    @pine/data    PineDataProvider and adapters (mock | rest | envio), GitHub source, IPFS manifest storage,
                           draft and account stores, demo fixtures
    react/   @pine/react   headless hooks and providers: queries, wallet (real and demo), resumable tx runner, claim composer
    server/  @pine/server  Next.js route handlers: Auth.js (GitHub read:user and demo), GitHub proxy, SIWE wallet linking,
                           agent API, llms.txt, well-known, IPFS upload
  apps/
    prism/        Pine Prism (Next.js)
    prism-share/  static, browser-only build of Prism for artifact hosting
  docs/
    frontend/     package API contract, app integration guide, deployment, launch gates
    indexer/      the REST OpenAPI and Envio schema contracts the frontend adapters read
    agents/       agent API guide and claim manifest JSON Schema
    research/     Seer / Reality.eth / Kleros / Envio integration notes
    superpowers/  original design spec and implementation plan (historical; the spec describes the earlier
                  multi-version exploration, of which only Prism is kept)
  scripts/smoke.mjs   crawl a running app and its agent endpoints; checks status codes and forbidden wording
```

## Data sources

Prism reads through one interface (`PineDataProvider`), selected by `NEXT_PUBLIC_PINE_DATA_SOURCE`:

- `mock`: fixtures. This is the default.
- `rest`: a service implementing [`docs/indexer/rest-api.openapi.yaml`](docs/indexer/rest-api.openapi.yaml).
- `envio`: an Envio HyperIndex deployment matching [`docs/indexer/envio/schema.graphql`](docs/indexer/envio/schema.graphql).

These are the frontend's own contracts. Aligning them with the backend in this repository (`../packages/api`, `../packages/indexer-envio`) is planned separately.

## Data for AI agents

| Path | What |
|---|---|
| `/llms.txt`, `/llms-full.txt` | What Pine is, how to find open claims, how to submit evidence, and the rules |
| `/.well-known/pine.json` | Discovery descriptor |
| `/api/agent/v1/claims?status=open` | Investigation briefs as JSON. `/api/agent/v1/claims/{id}?format=md` returns a ready-to-use prompt |
| `/api/agent/v1/claims/{id}/manifest.json` | The canonical immutable manifest, with an `x-pine-manifest-hash` header |
| `/api/agent/v1/policies`, `/api/agent/v1/schema/claim-manifest.json`, `/api/agent/v1/openapi.json` | Policies, JSON Schema, OpenAPI |
| `/api/agent/v1/feed.xml` | Atom feed of newly opened claims |

## Scripts (run inside `frontend/`)

```bash
pnpm test        # vitest for all packages
pnpm typecheck   # every package and app
pnpm lint
pnpm build       # production builds (prism, prism-share)
node scripts/smoke.mjs http://localhost:3004
```

## Known issues

- **Late account defaults.** New drafts can read account preferences before the account query resolves (`packages/react/src/composer/use-claim-composer.ts`). Prism works around it.
- **Demo claims are local.** In demo mode, published claims exist only in the browser.
- **Sealed evidence.** Commit-reveal evidence records the commitment, but there is no reveal step yet.
- **Production configuration.** Production needs `AUTH_URL` and `AUTH_SECRET`. See [`docs/frontend/deployment.md`](docs/frontend/deployment.md).
