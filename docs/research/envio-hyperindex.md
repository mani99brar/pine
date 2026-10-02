# Envio HyperIndex v3 research report (envio 3.12.1)

Date: 2026-10-02. Author: research agent (no project code written under /home/agentops/dev).
Probe project: `/tmp/claude-1000/-home-agentops-dev-pine/3bdbf7d8-eaa9-4ef4-bb24-f4ee398ebcc1/scratchpad/research/envio-probe`
pnpm-workspace probe: `.../scratchpad/research/ws-probe` (same indexer as `packages/indexer`, pine-like workspace settings)
Raw doc pages used (downloaded .md from docs.envio.dev): `.../scratchpad/research/docs/`

Sources: docs.envio.dev pages (configuration-file, config-schema-reference, event-handlers, testing, generated-files,
dynamic-contracts, wildcard-indexing, reorgs-support, preload-optimization, schema, navigating-hasura, self-hosting,
environment-variables, rpc-sync, hosted-service, observability, cli-commands, migrate-to-v3, HyperSync networks and
api-tokens), the npm tarball `envio@3.12.1` (`index.d.ts`), the CLI native binary `envio-linux-x64@3.12.1/envio.node`
(embedded templates and Claude skills), the read-only reference project `/home/agentops/dev/kleros/vea/envio-indexer`
(envio 3.2.1, jest), and the hands-on runs below. Every "VERIFIED" item was run on this machine. "DOCS" items come from
the docs or the type declarations and were not run.

## TL;DR

- VERIFIED: v3 unit tests run in vitest 5.0.2 with no Docker, Postgres or network. Use `createTestIndexer()` and
  `indexer.process({ chains: { 100: { simulate: [...] } } })`. Envio's own templates use vitest (`vitest run --test-timeout=20000`).
  `MockDb`, `createMockDb` and `processEvent` were removed in v3.
- VERIFIED: `envio codegen` takes about 3 s, makes no network calls (strace shows zero inet `connect`), spawns no
  package-manager install, and is byte-for-byte deterministic. It writes only `.envio/types.d.ts` (self-gitignored) and
  `envio-env.d.ts`; v3 no longer produces a `generated/` package. Tests run even without codegen, because the runtime
  reads config.yaml and schema.graphql directly. Only `tsc` needs codegen.
- VERIFIED: `envio dev` fails without Docker or Podman. `envio start` needs a reachable Postgres (ECONNREFUSED on :5433 otherwise).
- VERIFIED: HyperSync (Gnosis 100 is supported) needs `ENVIO_API_TOKEN`, even for real-data tests. With an `rpc`
  entry `for: sync`, real-data tests work without a token: a pinned block on Gnosis via https://rpc.gnosischain.com
  ran in 3.7 s.
- VERIFIED: handlers run twice in tests too, as preload and then process. Handlers must be deterministic and free of
  side effects. Use Effects or `if (!context.isPreload)` for anything external.
- VERIFIED pitfall for the pine workspace: `engineStrict: true` together with `.npmrc` `engine-strict=true` makes
  `pnpm install` fail with ERR_PNPM_UNSUPPORTED_ENGINE. The cause is `envio@3.12.1` (and 3.13.0), which pins
  `@fuel-ts/*@0.96.1` with engines `^18.20.3 || ^20 || ^22`, while we run Node 24. `packageExtensions` cannot
  override `engines`, which I tested. `allowBuilds: { esbuild: true }` is required: without it pnpm 12 exits 1 with
  ERR_PNPM_IGNORED_BUILDS. Pine already allows esbuild. `minimumReleaseAge: 4320` is fine, since 3.12.1 was published
  on 2026-09-18.

## 1. config.yaml (v3 schema)

DOCS, and VERIFIED where marked:
- Top level: `name`, `description`, `contracts` (global definitions: `name`, `events`, optional `abi_file_path`, optional
  `handler`), `chains` (list: `id`, `start_block` (number or `latest` since v3.11), optional `end_block`, `block_lag`,
  `max_reorg_depth`, `rpc`, `hypersync_config.url`, `skip`, `contracts: [{ name, address | [addresses], start_block }]`).
  The v2 `networks` key is now `chains`, and v2 `confirmed_block_threshold` is now `max_reorg_depth`.
- Events: a human-readable signature is the recommended form (VERIFIED). With `abi_file_path`, refer to events by name,
  as the vea reference does for Yaho. `name:` gives an alias for overloaded events.
- Field selection, two mechanisms:
  - `field_selection: { transaction_fields: [hash, ...], block_fields: [...] }` at the root or per event. VERIFIED:
    defaults are `block.number`, `block.timestamp` and `block.hash`, and the transaction is empty by default.
  - Since v3.7, the per-handler option `fields: { transaction: ["hash"], block: ["timestamp"] }` on
    `indexer.onEvent` and `indexer.contractRegister`. VERIFIED caveat: `fields` replaces the defaults, so only
    `block.number` stays available. Reading `block.timestamp` without listing it is a tsc error. Second VERIFIED
    caveat: the type of the simulate input `transaction` in tests follows config.yaml `field_selection`, not the
    handler `fields`. With `fields` only, `simulate[].transaction.hash` does not typecheck (the test still runs).
    Recommendation: use config-level `field_selection` for fields you also set in tests.
- Dynamic contracts: define the contract globally with events and give it no address on the chain, then call
  `context.chain.<Contract>.add(addr)` inside `indexer.contractRegister(...)` (VERIFIED, section 7b). Events from the
  new address in the same block are included (DOCS, and VERIFIED in simulate with explicit block and logIndex). Since
  v3.9 the same address can be listed under several contracts.
- Wildcard and topic filters: `indexer.onEvent({ contract, event, wildcard: true, where })`. `where` is a static
  object or a callback `({ chain }) => filter | boolean`. A filter is `{ params: {...} | [{...}, {...}] }` (array =
  OR, each value may be an array), plus `block: { number: { _gte } }` as a per-event start block. On RPC, arrays need
  v3.3+. The callback receives only `chain.id` and `chain.<OwnContract>.addresses`. index.d.ts states: "Only the
  event's own contract is exposed — multi-contract address filtering is not supported in this iteration."
  Values must be indexed parameters (topics).
- Reorgs: `rollback_on_reorg: true` is the default. Per-chain `max_reorg_depth` defaults to 200 on most chains,
  including Gnosis, and to 0 on Arbitrum and OP. Detection is guaranteed with HyperSync. RPC has edge cases (non-atomic
  log/header reads). Side effects are not rolled back. `block_lag` intentionally trails the head.
- RPC: `rpc: <url>` or a list of `{ url, for: sync | realtime | fallback, headers, ws, initial_block_interval, ... }`.
  On HyperSync chains, `rpc` is optional. `for: sync` makes RPC the historical source (VERIFIED in tests).
  `for: fallback` is used while HyperSync is down, with a retry back to the primary after 60 s. `${ENVIO_VAR:-default}`
  interpolation works anywhere (VERIFIED with `${ENVIO_GNOSIS_RPC_URL:-https://rpc.gnosischain.com}`).
- Other keys: `address_format: checksum | lowercase`, `bytes_type: hex | uint8array` (v3.10), `storage`
  (postgres or clickhouse), `raw_events`, `full_batch_size`, `disable_default_cross_chain` (v3.6), `handlers` dir
  (default: handler files are auto-discovered from `src/handlers/`), `schema` path.
  `preload_handlers` is rejected in v3.

## 2. schema.graphql

DOCS, and VERIFIED where used in the probe:
- Every type is an entity or table. `id` is `ID!`, `String!`, `Int!` or `BigInt!` (numeric ids since v3.5). There is
  no `@entity` decorator and no immutable-entity option (unlike The Graph). Immutability has to be enforced by our
  handler logic (only `set` once; ids derived deterministically).
- Scalars: ID, String, Int, Float, Boolean, `Bytes` (hex string by default), `BigInt` (bigint), `BigDecimal`
  (bignumber.js, `import { BigDecimal } from "envio"`), `Timestamp` (Date), `Json`. Lists such as `[BigInt!]!` work
  (VERIFIED). `@config(precision, scale)` sets numeric precision.
- Enums become TS string unions (VERIFIED: `ResolutionKind`).
- Relationships: `claim: Claim!` is written as `claim_id` in handlers. The reverse virtual field is
  `answers: [Answer!]! @derivedFrom(field: "claim")` (VERIFIED in codegen and test).
- `@index` is for fields that API consumers filter or sort by. Since v3.5, `getWhere` creates the indices it needs
  (DOCS). Other directives: `@internal` keeps an entity out of GraphQL (v3.8, VERIFIED: QuestionLink),
  `@storage(...)` for ClickHouse, `@crossChain`, and GraphQL descriptions surface in the API.

## 3. Handler API (TypeScript, v3)

- `import { indexer } from "envio"`. Registration calls:
  - `indexer.onEvent({ contract, event, wildcard?, where?, fields? }, async ({ event, context }) => {...})`
  - `indexer.contractRegister(sameOptions, async ({ event, context }) => {...})`. VERIFIED: the handler must return a
    Promise. A non-async arrow fails tsc with "void is not assignable to Promise<void>".
  - `indexer.onBlock({ name, where }, handler)`
  Since v3.4 an event may have several registrations. Handler files are ESM with top-level await. The project needs
  `"type": "module"`.
- `event`: `params`, `chainId`, `srcAddress` (checksummed by default), `logIndex`, `block`, `transaction`,
  `contractName`, `eventName`.
- `context.<Entity>`: `get`, `getOrThrow(id, msg?)`, `getOrCreate(entity)`, `getWhere({ field: { _eq | _gt | _gte | _lt | _lte | _in } , ...AND })`,
  `set(entity)` (sync upsert), `deleteUnsafe(id)`. Plus `context.log.{debug,info,warn,error}(msg, params?)`,
  `context.effect(effect, input)`, `context.isPreload`, and `context.chain.{id,isRealtime}`.
  - The `contractRegister` context has only `log` and `chain.{id, <Contract>.add}`. It has no entity access and no
    `effect` (from index.d.ts). Arbitrary `await` is allowed ("async contract register").
  - `indexer.chains[100].<Contract>.addresses`, `.startBlock` and `.isRealtime` can be read anywhere.
- Loaders: `handlerWithLoader` and `preload_handlers` were removed. Preload is always on, so every handler runs twice:
  1. A concurrent preload pass where writes and `context.log` are ignored and exceptions are swallowed.
  2. A sequential pass in on-chain order.
  VERIFIED in the test indexer: phases `["preload","process"]` in the same process. As a result:
  - Handlers must be deterministic and free of side effects.
  - Ids must be deterministic (`${chainId}_${block}_${logIndex}` or on-chain ids).
  - No direct `fetch` or RPC calls. Use `createEffect({ name, input: S..., output: S..., rateLimit, cache: true })` and
    `context.effect(...)`, or guard the call with `if (!context.isPreload)`.
  - Put reads at the top of the handler and use `Promise.all` for parallel reads.
  - The same determinism rule covers reorg rollbacks and restarts.

## 4. Testing (v3)

- API (VERIFIED):
  - `createTestIndexer()`.
  - `await indexer.process({ chains: { <id>: { simulate: [{ contract, event, params, srcAddress?, block?, transaction?, logIndex? }] } } })`.
    Explicit ranges `{ startBlock, endBlock }` and auto-exit `{}` fetch real data.
  - The result is `{ changes: [{ block, chainId, eventsProcessed, <Entity>: { sets }, addresses?: { sets } }] }`.
  - State: `indexer.<Entity>.get/getOrThrow/getAll/set`, `indexer.chains[id].<Contract>.addresses`.
  - Helpers: `TestHelpers.Addresses.mockAddresses` and `defaultAddress`.
- Runs in-process with an in-memory store. No Docker or Postgres. Simulate mode needs no network.
- Simulate is strict (VERIFIED): if an item does not reach any handler (unregistered `srcAddress`, filtered by
  `where`), `process()` rejects with "simulate: N items you passed to simulate never reached a handler".
- For factory flows, give each simulated item explicit `block: { number, timestamp }` and `logIndex`. Without them, a
  Swap from a pool registered earlier in the same `simulate` array was rejected as unrouted. With them it works, even
  in the same block.
- Module-level state in handler files is shared across tests in a file (DOCS, from the embedded skill).
- Runner: vitest is the documented and recommended runner, and the templates pin vitest 4.1.0. VERIFIED with
  vitest 5.0.2 (pine's version), TypeScript 6.0.3 and Node 24.21. Mocha and jest are only "possible". The vea
  reference uses jest with ts-jest ESM, which we cannot use. Vitest snapshots (`toMatchInlineSnapshot`) are the
  documented assertion style.
- Real-data tests: HyperSync throws "An Envio API token is required for using HyperSync as a data-source" without
  `ENVIO_API_TOKEN`. With `rpc: [{ url, for: sync }]` they pass against a public RPC. Keep them opt-in with
  `describe.runIf(process.env.X === "1")`, because they depend on the network and on a public RPC.

## 5. Codegen

- `envio codegen` (VERIFIED, about 3.5 s):
  - It is a native Rust napi module (`envio-linux-x64`, about 40 MB, optionalDependency) run through `node bin.mjs`.
  - strace shows no inet connect and no `pnpm` or `npm` exec (only `node`, `sed`, `uname`). It works offline and does
    not install.
  - A clean regen gives identical sha256 output, so it is deterministic.
  - Output: `.envio/types.d.ts` (ignored by its own `.envio/.gitignore`) and root `envio-env.d.ts`
    (`/// <reference path="./.envio/types.d.ts" />`). No `generated/` directory.
  - Docs: commit `envio-env.d.ts`, ignore `.envio/`.
- `envio dev` and `envio start` run codegen automatically. Handler edits no longer trigger codegen on `dev`.
- Node: `engines.node >=22` (24 recommended). Works on Node 24.21.
- npm, pnpm, yarn and bun are all supported in v3 (v2 required pnpm).
- pnpm workspace (VERIFIED in `ws-probe`: `packages/indexer`, pnpm 12.8.1, `minimumReleaseAge: 4320`,
  `allowBuilds: { esbuild: true }`): install, codegen, `tsc` and vitest all pass, but only with `engineStrict: false`
  (see TL;DR). Options:
  - (a) set `engineStrict: false` and remove `.npmrc` `engine-strict=true` in pine;
  - (b) keep the indexer as a separate non-workspace pnpm project with its own lockfile;
  - (c) wait for envio to bump `@fuel-ts`.
  Also seen: pnpm 12 created a `pnpm-workspace.yaml` in a non-workspace dir to add a `minimumReleaseAgeExclude` entry
  for a package released less than a day ago.

## 6. Running and production

- `envio dev` needs Docker or Podman (VERIFIED error: "Failed connecting to Docker or Podman. Is the daemon running?").
  It starts Postgres on :5433 and Hasura on :8080 (password `testing`).
- `envio start` is the production command. It runs codegen and then indexes into Postgres. VERIFIED: without Postgres
  it fails with ECONNREFUSED on localhost:5433. `-r` resets the DB. `--chain` splits chains across processes.
  - Env vars: `ENVIO_PG_HOST`, `ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD`, `ENVIO_PG_DATABASE`,
    `ENVIO_PG_SCHEMA`, `ENVIO_PG_SSL_MODE`, `ENVIO_API_TOKEN`, `ENVIO_HASURA=false` (disables Hasura),
    `ENVIO_TUI=false`, `ENVIO_INDEXER_PORT` (default 9898: `/metrics`, `/metrics/runtime`, `/healthz`).
    Custom variables need the `ENVIO_` prefix.
  - Reference compose with Postgres, Hasura and the indexer: github.com/enviodev/local-docker-example. Hasura needs
    `HASURA_GRAPHQL_ADMIN_SECRET`.
- Envio Cloud:
  - Git-push deploys through a GitHub App, with monorepo root directory, config path and branch settings.
  - Static production endpoint, version switching and rollback, alerts, IP/domain allowlists.
  - Needs no HyperSync token.
  - GraphQL aggregate queries are intentionally not exposed. ClickHouse only on the Dedicated plan.
- GraphQL API shape (Hasura; DOCS, not run here because Docker is not available):
  - Root fields are named after the entities. Filtering, sorting and paging:
    `ConditionResolution(where: { questionId: { _eq: "0x…" } }, order_by: { blockNumber: desc }, limit: 20, offset: 0) { id kind payoutNumerators }`
  - Lookup by primary key: `ConditionResolution_by_pk(id: "0x…")`.
  - Relationships: `Claim { answers { bond } }` and `Answer { claim { id } }`.
  - Status: `_meta { chainId progressBlock sourceBlock isReady readyAt eventsProcessed }`. Use it to gate freshness
    and readiness.
  - Columns can be `snake_case` in Postgres (`storage.postgres.column_name_format`) while GraphQL keeps schema names.
  - Our backend can query Hasura, or read Postgres directly (self-host).
- HyperSync: Gnosis 100 is supported (`https://100.hypersync.xyz`, alias gnosis.hypersync.xyz), as is Chiado 10200.
  Requests without a token get HTTP 401, so `ENVIO_API_TOKEN` is required except on Envio Cloud. A free-package token
  exists, one per personal account.

## 7. Hands-on: exact files, commands and output

Machine: Linux x64, Node v24.21.0, pnpm 12.8.1, no Docker. All commands run in the probe dir.

```bash
pnpm install                     # envio 3.12.1, vitest 5.0.2, typescript 6.0.3, @types/node 24.19.0 (~5 s with warm store)
pnpm exec envio codegen          # ~3.5 s, no output on success; writes .envio/types.d.ts + envio-env.d.ts
pnpm exec tsc --noEmit -p .      # exit 0
pnpm test                        # = vitest run (network tests skipped)
ENVIO_E2E_RPC=1 pnpm exec vitest run   # + real Gnosis block over public RPC
```

Install log notes:
- The first install (without `allowBuilds`) failed with `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.27.7`
  and exit 1. esbuild comes in through envio's `tsx` dependency.
- Warnings that do not block the install: deprecated `@fuel-ts/interfaces` and `string-similarity`, and peer
  dependency warnings.

Test output (VERIFIED):

```
 ✓ test/ConditionalTokens.test.ts > classify (pure) > classifies payout vectors 4ms
 ✓ test/ConditionalTokens.test.ts > ConditionResolution handler (simulate, no network) > stores one ConditionResolution entity per event 126ms

$ pnpm test   (vitest run, final project)
 Test Files  2 passed | 2 skipped (4)
      Tests  4 passed | 2 skipped (6)
   Duration  3.77s (import 93%, tests 5%, transform 2%, worker 1%)

$ ENVIO_E2E_RPC=1 pnpm exec vitest run
 Test Files  3 passed | 1 skipped (4)
      Tests  5 passed | 1 skipped (6)
   Duration  5.94s

$ ENVIO_E2E=1 vitest run test/e2e.hypersync.test.ts   (no token)
 FAIL ... Error: An Envio API token is required for using HyperSync as a data-source.
```

### 7a. package.json
```json
{
  "name": "envio-probe",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "codegen": "envio codegen",
    "dev": "envio dev",
    "start": "envio start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "envio": "3.12.1"
  },
  "devDependencies": {
    "@types/node": "24.19.0",
    "typescript": "6.0.3",
    "vitest": "5.0.2"
  },
  "engines": {
    "node": ">=22"
  }
}
```

### pnpm-workspace.yaml (probe dir, not a workspace; pnpm 12 created it and I added `allowBuilds`)
```yaml
# Mirrors pine's supply-chain settings: lifecycle scripts blocked unless allowed.
allowBuilds:
  esbuild: true
minimumReleaseAgeExclude:
  - '@types/node@24.19.1'
```

### config.yaml (final: ConditionalTokens plus the hypothetical pine factory pattern)
```yaml
# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
name: envio-probe
description: Probe - ConditionalTokens + hypothetical ClaimRegistry factory pattern on Gnosis
contracts:
  - name: ConditionalTokens
    events:
      - event: "ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)"
        field_selection:
          transaction_fields:
            - hash
  # Hypothetical pine registry (not deployed): links a claim to a Seer market, its Reality.eth question and an Algebra pool.
  - name: ClaimRegistry
    events:
      - event: "ClaimPublished(bytes32 indexed claimId, address indexed market, bytes32 indexed questionId, address pool)"
  # Registered dynamically from ClaimRegistry.ClaimPublished (no static address).
  - name: AlgebraPool
    events:
      - event: "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 price, uint128 liquidity, int24 tick)"
  - name: RealityETH
    events:
      - event: "LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)"
chains:
  - id: 100 # Gnosis Chain
    start_block: 0
    max_reorg_depth: 200 # explicit (200 is the documented default for Gnosis)
    rpc:
      - url: ${ENVIO_GNOSIS_RPC_URL:-https://rpc.gnosischain.com}
        for: sync
    contracts:
      - name: ConditionalTokens
        address: "0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce"
      - name: ClaimRegistry
        address: "0x000000000000000000000000000000000000c1a1" # placeholder
      - name: RealityETH
        address: "0xE78996A233895bE74a66F451f1019cA9734205cc" # Reality.eth v3.0 on Gnosis (verify)
```
This is the minimal single-event version I started from (HyperSync source, which needs `ENVIO_API_TOKEN` to run against real data):
```yaml
# yaml-language-server: $schema=./node_modules/envio/evm.schema.json
name: envio-probe
description: Probe - ConditionalTokens.ConditionResolution on Gnosis Chain
contracts:
  - name: ConditionalTokens
    events:
      - event: "ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)"
        field_selection:
          transaction_fields:
            - hash
chains:
  - id: 100 # Gnosis Chain
    start_block: 0 # HyperSync fast-forwards to the first block with matching logs
    contracts:
      - name: ConditionalTokens
        address: "0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce"
```

### schema.graphql
```graphql
enum ResolutionKind {
  SINGLE_WINNER
  SPLIT
  NO_PAYOUT
}

type ConditionResolution {
  id: ID! # conditionId (bytes32 hex)
  oracle: String! @index
  questionId: String! @index
  outcomeSlotCount: BigInt!
  payoutNumerators: [BigInt!]!
  kind: ResolutionKind!
  blockNumber: Int!
  blockTimestamp: Int!
  txHash: String!
}

type Claim {
  id: ID! # claimId
  market: String! @index
  questionId: String! @index
  pool: String!
  answers: [Answer!]! @derivedFrom(field: "claim")
}

"Lookup row keyed by Reality.eth question id, so answer handlers can do a by-id get."
type QuestionLink @internal {
  id: ID! # questionId
  claimId: String!
}

type Answer {
  id: ID! # chainId_block_logIndex
  claim: Claim!
  answer: String!
  bond: BigInt!
  ts: BigInt!
}

type PoolSwap {
  id: ID!
  pool: String! @index
  amount0: BigInt!
  amount1: BigInt!
}
```

### src/lib/classify.ts
```ts
export type ResolutionKind = "SINGLE_WINNER" | "SPLIT" | "NO_PAYOUT";

/** Pure helper (no envio import) so it can be unit-tested in isolation. */
export function classify(payouts: readonly bigint[]): ResolutionKind {
  const nonZero = payouts.filter((p) => p > 0n).length;
  if (nonZero === 0) return "NO_PAYOUT";
  return nonZero === 1 ? "SINGLE_WINNER" : "SPLIT";
}
```

### src/handlers/ConditionalTokens.ts
```ts
import { indexer } from "envio";
import { classify } from "../lib/classify.js";

indexer.onEvent(
  { contract: "ConditionalTokens", event: "ConditionResolution" },
  async ({ event, context }) => {
    // Pure function of the event => safe to run twice (preload pass + processing pass).
    context.ConditionResolution.set({
      id: event.params.conditionId,
      oracle: event.params.oracle,
      questionId: event.params.questionId,
      outcomeSlotCount: event.params.outcomeSlotCount,
      payoutNumerators: [...event.params.payoutNumerators],
      kind: classify(event.params.payoutNumerators),
      blockNumber: event.block.number,
      blockTimestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    });
    if (!context.isPreload) {
      context.log.info(`resolved condition ${event.params.conditionId}`);
    }
  },
);
```

### 7b. src/handlers/Pine.ts (dynamic registration and question-id filtering prototype)
```ts
import { indexer } from "envio";

// Factory pattern: contractRegister runs before onEvent for the same event; its context has no entity access.
indexer.contractRegister({ contract: "ClaimRegistry", event: "ClaimPublished" }, async ({ event, context }) => {
  context.chain.AlgebraPool.add(event.params.pool);
});

indexer.onEvent({ contract: "ClaimRegistry", event: "ClaimPublished" }, async ({ event, context }) => {
  context.Claim.set({
    id: event.params.claimId,
    market: event.params.market,
    questionId: event.params.questionId,
    pool: event.params.pool,
  });
  context.QuestionLink.set({ id: event.params.questionId, claimId: event.params.claimId });
});

// Reality.eth is a singleton: question_id is bytes32, so it cannot be filtered via chain.<Contract>.addresses.
// Index the contract's LogNewAnswer and drop unknown questions in the handler (by-id get => batched in preload).
indexer.onEvent({ contract: "RealityETH", event: "LogNewAnswer" }, async ({ event, context }) => {
  const link = await context.QuestionLink.get(event.params.question_id);
  if (!link) return;
  context.Answer.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    claim_id: link.claimId,
    answer: event.params.answer,
    bond: event.params.bond,
    ts: event.params.ts,
  });
});

indexer.onEvent({ contract: "AlgebraPool", event: "Swap" }, async ({ event, context }) => {
  context.PoolSwap.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    pool: event.srcAddress,
    amount0: event.params.amount0,
    amount1: event.params.amount1,
  });
});
```

### tsconfig.json (copied from Envio's own template; tsc passes with TS 6.0.3)
```json
{
  "compilerOptions": {
    "esModuleInterop": true,
    "skipLibCheck": true,
    "target": "es2023",
    "allowJs": true,
    "resolveJsonModule": true,
    "moduleDetection": "force",
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "lib": ["es2023"],
    "types": ["node"]
  },
  "include": ["envio-env.d.ts", "src", "test", "vitest.config.ts"]
}
```

### vitest.config.ts
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
```

### test/ConditionalTokens.test.ts (unit test, no network)
```ts
import { describe, it, expect } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";
import { classify } from "../src/lib/classify.js";

const CT = "0xCeAfDD6bc0bEF976fdCd1112955828E00543c0Ce";
const CONDITION_ID = `0x${"11".repeat(32)}`;
const QUESTION_ID = `0x${"22".repeat(32)}`;
const TX_HASH = `0x${"ab".repeat(32)}`;
const [ORACLE] = TestHelpers.Addresses.mockAddresses;

describe("classify (pure)", () => {
  it("classifies payout vectors", () => {
    expect(classify([1n, 0n])).toBe("SINGLE_WINNER");
    expect(classify([1n, 1n])).toBe("SPLIT");
    expect(classify([0n, 0n])).toBe("NO_PAYOUT");
  });
});

describe("ConditionResolution handler (simulate, no network)", () => {
  it("stores one ConditionResolution entity per event", async () => {
    const indexer = createTestIndexer();

    const result = await indexer.process({
      chains: {
        100: {
          simulate: [
            {
              contract: "ConditionalTokens",
              event: "ConditionResolution",
              srcAddress: CT,
              block: { number: 40_000_000, timestamp: 1_750_000_000 },
              transaction: { hash: TX_HASH },
              params: {
                conditionId: CONDITION_ID,
                oracle: ORACLE!,
                questionId: QUESTION_ID,
                outcomeSlotCount: 2n,
                payoutNumerators: [0n, 1n],
              },
            },
          ],
        },
      },
    });

    expect(result.changes).toHaveLength(1);
    const row = await indexer.ConditionResolution.getOrThrow(CONDITION_ID);
    expect(row).toEqual({
      id: CONDITION_ID,
      oracle: ORACLE,
      questionId: QUESTION_ID,
      outcomeSlotCount: 2n,
      payoutNumerators: [0n, 1n],
      kind: "SINGLE_WINNER",
      blockNumber: 40_000_000,
      blockTimestamp: 1_750_000_000,
      txHash: TX_HASH,
    });
    expect(await indexer.ConditionResolution.getAll()).toHaveLength(1);
  });
});
```

### test/Pine.test.ts (factory pattern; the inline snapshot was auto-filled by vitest)
```ts
import { describe, it, expect } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";

const [MARKET, POOL, OTHER_POOL, USER] = TestHelpers.Addresses.mockAddresses;
const REALITY = "0xE78996A233895bE74a66F451f1019cA9734205cc";
const REGISTRY = "0x000000000000000000000000000000000000c1a1";
const CLAIM_ID = `0x${"c1".repeat(32)}`;
const OUR_Q = `0x${"0a".repeat(32)}`;
const OTHER_Q = `0x${"0b".repeat(32)}`;
const YES = `0x${"00".repeat(31)}01`;
const ZERO32 = `0x${"00".repeat(32)}`;

const claimPublished = {
  contract: "ClaimRegistry", event: "ClaimPublished", srcAddress: REGISTRY,
  block: { number: 100, timestamp: 1_750_000_000 },
  params: { claimId: CLAIM_ID, market: MARKET!, questionId: OUR_Q, pool: POOL! },
} as const;

describe("pine factory pattern (simulate)", () => {
  it("registers the pool dynamically and keeps only answers for known questions", async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({
      chains: {
        100: {
          simulate: [
            claimPublished,
            { contract: "RealityETH", event: "LogNewAnswer", srcAddress: REALITY, block: { number: 101, timestamp: 1_750_000_005 },
              params: { answer: YES, question_id: OUR_Q, history_hash: ZERO32, user: USER!, bond: 10n ** 18n, ts: 1_750_000_005n, is_commitment: false } },
            { contract: "RealityETH", event: "LogNewAnswer", srcAddress: REALITY, block: { number: 101, timestamp: 1_750_000_005 },
              params: { answer: YES, question_id: OTHER_Q, history_hash: ZERO32, user: USER!, bond: 1n, ts: 1_750_000_005n, is_commitment: false } },
            { contract: "AlgebraPool", event: "Swap", srcAddress: POOL!, block: { number: 102, timestamp: 1_750_000_010 },
              params: { sender: USER!, recipient: USER!, amount0: -5n, amount1: 7n, price: 1n, liquidity: 1n, tick: 0n } },
          ],
        },
      },
    });

    expect(indexer.chains[100].AlgebraPool.addresses).toContain(POOL);
    const answers = await indexer.Answer.getAll();
    expect(answers).toHaveLength(1);
    expect(answers[0]?.claim_id).toBe(CLAIM_ID);
    expect(await indexer.PoolSwap.getAll()).toHaveLength(1);
    expect(result.changes).toMatchInlineSnapshot(`
      [
        {
          "Claim": {
            "sets": [
              {
                "id": "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
                "market": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                "pool": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                "questionId": "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
              },
            ],
          },
          "QuestionLink": {
            "sets": [
              {
                "claimId": "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
                "id": "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
              },
            ],
          },
          "addresses": {
            "sets": [
              {
                "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
                "contract": "AlgebraPool",
              },
            ],
          },
          "block": 100,
          "chainId": 100,
          "eventsProcessed": 1,
        },
        {
          "Answer": {
            "sets": [
              {
                "answer": "0x0000000000000000000000000000000000000000000000000000000000000001",
                "bond": 1000000000000000000n,
                "claim_id": "0xc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
                "id": "100_101_1",
                "ts": 1750000005n,
              },
            ],
          },
          "block": 101,
          "chainId": 100,
          "eventsProcessed": 2,
        },
        {
          "PoolSwap": {
            "sets": [
              {
                "amount0": -5n,
                "amount1": 7n,
                "id": "100_102_3",
                "pool": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
              },
            ],
          },
          "block": 102,
          "chainId": 100,
          "eventsProcessed": 1,
        },
      ]
    `);
  });

  it("simulate rejects events from a pool that was never registered", async () => {
    const indexer = createTestIndexer();
    await expect(
      indexer.process({
        chains: {
          100: {
            simulate: [
              claimPublished,
              { contract: "AlgebraPool", event: "Swap", srcAddress: OTHER_POOL!, block: { number: 102, timestamp: 1_750_000_010 },
                params: { sender: USER!, recipient: USER!, amount0: -1n, amount1: 1n, price: 1n, liquidity: 1n, tick: 0n } },
            ],
          },
        },
      }),
    ).rejects.toThrow(/never reached a handler/);
  });
});
```

### test/e2e.rpc.test.ts (opt-in, real Gnosis block 48552300 over public RPC, no token)
```ts
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// Opt-in: real Gnosis data over plain RPC (config rpc `for: sync`). Run with ENVIO_E2E_RPC=1.
describe.runIf(process.env.ENVIO_E2E_RPC === "1")("real Gnosis data via RPC", () => {
  it("explicit block range: block 48552300 has one ConditionResolution", { timeout: 180_000 }, async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({ chains: { 100: { startBlock: 48_552_300, endBlock: 48_552_300 } } });
    expect(result).toMatchInlineSnapshot(`
      {
        "changes": [
          {
            "ConditionResolution": {
              "sets": [
                {
                  "blockNumber": 48552300,
                  "blockTimestamp": 1790955035,
                  "id": "0xd168210b95bc63fb7a290f44e11012750ef3efcac3b1feff734a351bd4b9d439",
                  "kind": "SINGLE_WINNER",
                  "oracle": "0xb5786fa17CC3E262d855240a074978C133438e7B",
                  "outcomeSlotCount": 2n,
                  "payoutNumerators": [
                    1n,
                    0n,
                  ],
                  "questionId": "0x3f24114b0ad335936b326cd936d2514ac18cf0dad09da3f81592ebfabb225cce",
                  "txHash": "0x04df79f13abbf098cbe3cbe70033b65a1fcf22d6c46f501d17baedbf115a50ad",
                },
              ],
            },
            "block": 48552300,
            "chainId": 100,
            "eventsProcessed": 1,
          },
        ],
      }
    `);
    const row = await indexer.ConditionResolution.getOrThrow(
      "0xd168210b95bc63fb7a290f44e11012750ef3efcac3b1feff734a351bd4b9d439",
    );
    expect(row.txHash).toBe("0x04df79f13abbf098cbe3cbe70033b65a1fcf22d6c46f501d17baedbf115a50ad");
    expect(row.payoutNumerators).toEqual([1n, 0n]);
  });
});
```

### test/e2e.hypersync.test.ts (opt-in; needs ENVIO_API_TOKEN)
```ts
import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// Opt-in: hits HyperSync for Gnosis (chain 100). Run with ENVIO_E2E=1.
describe.runIf(process.env.ENVIO_E2E === "1")("real Gnosis data via HyperSync", () => {
  it("auto-exit: processes the first block with a ConditionResolution", { timeout: 180_000 }, async () => {
    const indexer = createTestIndexer();
    const result = await indexer.process({ chains: { 100: {} } });
    console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 2).slice(0, 2500));
    expect(result.changes.length).toBeGreaterThan(0);
    const rows = await indexer.ConditionResolution.getAll();
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

### envio-env.d.ts (generated; commit it)
```ts
/**
 * This file is generated by HyperIndex codegen. Do not edit manually.
 * It wires project-specific types from `.envio/types.d.ts` into the `envio` module.
 * If your project's types look out of date, run `envio codegen`
 * (or your package manager's `codegen` script, e.g. `pnpm codegen`).
 */
/// <reference path="./.envio/types.d.ts" />
```

### Workspace variant (`ws-probe/pnpm-workspace.yaml`, `ws-probe/packages/indexer/package.json`)
```yaml
packages:
  - "packages/*"
minimumReleaseAge: 4320
autoInstallPeers: true
strictPeerDependencies: false
allowBuilds:
  esbuild: true
saveExact: true
engineStrict: false # envio 3.12.1 depends on @fuel-ts/*@0.96.1 (engines node ^18||^20||^22); packageExtensions cannot override engines
```
```json
{
  "name": "@pine/indexer-envio",
  "private": true,
  "type": "module",
  "scripts": {
    "codegen": "envio codegen",
    "typecheck": "envio codegen && tsc --noEmit",
    "test": "envio codegen && vitest run"
  },
  "dependencies": { "envio": "3.12.1" },
  "devDependencies": { "@types/node": "24.19.0", "typescript": "6.0.3", "vitest": "5.0.2" }
}
```
`pnpm test` from the workspace root gives `Test Files 2 passed | 2 skipped (4)` and `Tests 4 passed | 2 skipped (6)`.
`pnpm -r run typecheck` exits 0.

## 8. Caveats (consolidated)

1. Workspace install: pine's `engineStrict: true` together with `engine-strict=true` blocks envio on Node 24 (fuel-ts
   engines). `packageExtensions` cannot fix it.
2. Without `allowBuilds: { esbuild: true }`, pnpm 12 exits 1 (ERR_PNPM_IGNORED_BUILDS).
3. The handler `fields` option drops the default `block.timestamp` and `block.hash`, and test simulate types do not
   follow `fields`. Prefer config-level `field_selection`.
4. A `contractRegister` handler must be `async`. Its context cannot read entities or call effects.
5. `where` callbacks see only the event's own contract addresses. A bytes32 topic such as the Reality.eth
   `question_id` cannot be filtered dynamically. Only static lists known at startup (top-level await) work.
6. There are no immutable entities. `set` is always an upsert.
7. Real-data tests need either an API token (HyperSync) or a configured RPC `for: sync`. The public RPC is not a CI-grade dependency.
8. RPC-only indexing has reorg-detection edge cases. HyperSync detection is guaranteed. Side effects are never rolled back.
9. Hasura and GraphQL were not exercised here (no Docker). The GraphQL shape above comes from the docs.
10. The Reality.eth address `0xE78996A233895bE74a66F451f1019cA9734205cc` in the probe is from memory and was not
    verified on-chain. The ClaimRegistry contract is hypothetical.
11. vitest summaries are the default `vitest run` reporter format shown above. This matches what pine's verifier parses.
12. Version churn is high: 3.0 to 3.13 in about 2.5 months, and several features (`fields`, `bytes_type`,
    `start_block: latest`) are minor-version additions. Pin the exact version. `next` = 3.13.0 (2026-09-23).

## 9. Recommendations

- Test runner: vitest, pinned to the workspace version (5.0.2 works).
  - Package scripts: `"test": "envio codegen && vitest run"`, `"typecheck": "envio codegen && tsc --noEmit"`.
  - Default suite: simulate-only, with explicit block and logIndex per item. Assert on entities and use
    `toMatchInlineSnapshot`.
  - Real-chain tests: opt-in (`describe.runIf`), pinned block ranges, inline snapshots. Run them in a separate CI job
    with an `ENVIO_API_TOKEN` secret, or with a paid RPC `for: sync` passed through `${ENVIO_GNOSIS_RPC_URL}`.
- Codegen in CI: always run `envio codegen` before `tsc`. It is offline, deterministic and fast.
  - Commit `envio-env.d.ts`, gitignore `.envio/`. Do not commit generated types.
  - No Docker in CI. Never use `envio dev` there.
  - Decide the workspace question first: either relax `engineStrict`, or keep the indexer out of the pnpm workspace.
- Dynamic registration, for our registry:
  - (i) `ClaimRegistry.ClaimPublished`: in `contractRegister`, `context.chain.SeerMarket.add(market)` and
    `context.chain.AlgebraPool.add(pool)` for per-address contracts. If the pool is not in the event, look it up with
    an async call to Algebra `poolByPair` inside `contractRegister`. Alternatively, register outcome tokens and use the
    documented trick: declare the factory `Pool(address indexed token0, address indexed token1, address pool)` event
    on the `OutcomeToken` contract with `wildcard: true` and
    `where: ({ chain }) => ({ params: [{ token0: chain.OutcomeToken.addresses }, { token1: chain.OutcomeToken.addresses }] })`,
    then check `srcAddress` equals the factory. This pattern was not verified here.
  - (ii) Reality.eth and ConditionalTokens are singletons keyed by bytes32 ids. Index their events by contract address
    and filter in the handler with a by-id `QuestionLink` / `ConditionLink` lookup (batched in preload; VERIFIED in
    `Pine.test.ts`). Gnosis volume for these contracts is modest.
  - (iii) Answers or resolutions that happened before our registration are not replayed. In the `ClaimPublished`
    handler, seed the current Reality.eth state through an Effect (RPC read), or also store raw answers in an
    `@internal` entity.
- Reorgs:
  - Keep `rollback_on_reorg: true` and use HyperSync as primary with an RPC `for: fallback`.
  - Leave `max_reorg_depth` at 200 for Gnosis, or set it explicitly. Gnosis finalizes in minutes, so 200 blocks
    (about 17 min) is conservative.
  - Make all ids deterministic and keep handlers side-effect-free.
  - In the backend, treat rows above the finalized height as provisional. Gate on `_meta.progressBlock` and isReady,
    and run notifications from the DB with a confirmation lag, never from handlers.
- Production:
  - Lowest ops: Envio Cloud. It needs no token and deploys by git push from the monorepo subdirectory, but it does not
    expose GraphQL aggregates and creates vendor coupling.
  - Self-hosted: a container running `envio start` (ENVIO_TUI=false) against managed Postgres (ENVIO_PG_*, SSL), plus
    Hasura (or `ENVIO_HASURA=false` and read Postgres from our API). Add `ENVIO_API_TOKEN` (HyperSync), an RPC
    fallback, and Prometheus on :9898 `/metrics` and `/healthz`. Template: github.com/enviodev/local-docker-example.
  - Pin `envio` exactly and re-run codegen on upgrades.
