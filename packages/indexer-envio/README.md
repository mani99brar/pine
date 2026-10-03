# @pine/indexer-envio

Envio HyperIndex v3 project (envio 3.12.1, pinned): the optional second read-model backend
(`docs/prd/PRD-05-indexers.md` section 3, `features/indexers/decisions.md`). It is read through `@pine/read-model-envio`.
The production read model is `@pine/indexer-native`.

- `config.yaml`: Gnosis (chain 100), ClaimRegistry, EvidenceRegistry, Reality.eth v3, Conditional Tokens and the Kleros
  home proxy with the events of `packages/shared/src/chain-events.ts`; `rollback_on_reorg: true`, `block_lag` 40,
  `max_reorg_depth: 200`, lowercase addresses, transaction hashes selected.
- `schema.graphql`: one entity per read-model record (Claim, EvidenceSubmission, OracleQuestion, OracleAnswer,
  Arbitration + ArbitrationStage, ConditionResolution), the lookups TrackedCondition and AnswerCommitment, and the
  `IndexerProgress` singleton (last applied block and its timestamp, which Envio's `_meta` lacks). Every number is
  `BigInt`; lists are `Json`.
- `src/handlers/*`: the reference semantics of `packages/shared/src/testing/memory-read-model.ts`, deterministic (Envio
  runs every handler twice, preload then processing) and free of network calls. Events of untracked ids are ignored by
  entity lookup. Pine events outside the frozen `ChainEvent` domain (e.g. `repositoryId` of 0 or above 2^53 - 1) throw,
  which stops the indexer (halt). Third-party values of tracked ids are stored in their full on-chain domain.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `ENVIO_CLAIM_REGISTRY_ADDRESS` | scenario placeholder `0x…0c1a10` | Pine ClaimRegistry. **Required by `pnpm start`** (placeholders, zero, third-party and malformed addresses refused). |
| `ENVIO_EVIDENCE_REGISTRY_ADDRESS` | scenario placeholder `0x…0e01de` | Pine EvidenceRegistry. **Required by `pnpm start`** (same rules; must differ from the ClaimRegistry). |
| `ENVIO_PINE_START_BLOCK` | `0` | Pine deployment block. **Required by `pnpm start`** (a positive integer; `0` refused). |
| `ENVIO_QUESTION_TIMEOUT` | `302400` | Seer `MarketFactory.questionTimeout()` in seconds. |
| `ENVIO_GNOSIS_RPC_URL` | `https://rpc.gnosischain.com` | RPC endpoint (may embed a key: treat as a secret). `pnpm start` requires https and never prints it. |
| `ENVIO_GNOSIS_RPC_FOR` | `fallback` | `fallback` with HyperSync (`ENVIO_API_TOKEN`) as primary, or `sync` to index from RPC only (`pnpm start` accepts only these two). |
| `ENVIO_BLOCK_LAG` | `40` | Must be **at least 40**: `pnpm start` refuses anything lower and passes the value (default 40) explicitly. Tests alone run with 0 (`vitest.config.ts`): `createTestIndexer`'s simulate source reports the last simulated block as the chain height, so any lag keeps `process()` waiting forever. |

The placeholder registry addresses hold no code on Gnosis, so a run with the defaults would index no Pine claim (and
therefore track no Reality, CTF or Kleros id) while looking healthy. The defaults exist only so `envio codegen` and the
tests run without environment.

### Starting: `pnpm --filter @pine/indexer-envio start` only

**Never invoke `envio start` (or `envio dev`) directly.** The package's `start` script (`scripts/start.mjs`) is the only
supported entry point: it fails closed (exit 1, one line per problem, naming the variable but never its value) when a
registry address is missing, a placeholder, zero, a third-party (`GNOSIS_EXTERNAL`) address or malformed, when both
registries are equal, when `ENVIO_PINE_START_BLOCK` is missing or not a positive integer, when `ENVIO_BLOCK_LAG` is below
40, when `ENVIO_GNOSIS_RPC_URL` is not https or when `ENVIO_GNOSIS_RPC_FOR` is not `fallback`/`sync`. It then asks the
RPC Envio will use (`ENVIO_GNOSIS_RPC_URL`, else config.yaml's `https://rpc.gnosischain.com`) for `eth_chainId` (one
POST, no redirects, 10 s) and refuses unless it is 100 (SEC-IDX-06; Envio 3.12.1 never checks the chain id itself). Only
then does it run the pinned `envio start` with the validated values set explicitly. Deployment manifests must call `pnpm start`.
While Envio runs, SIGTERM and SIGINT received by the wrapper are forwarded to the Envio child (a process manager or
container runtime may signal only the wrapper's PID, e.g. `docker stop` on PID 1), every repeated signal included, and the
wrapper exits only when Envio has exited, with Envio's exit code (128 + the signal number if Envio was killed by a
signal; 1 if it could not be started). In an interactive terminal Ctrl-C reaches Envio twice (once from the terminal's
process group, once forwarded). Reality.eth, Conditional Tokens and the Kleros home proxy use the
`GNOSIS_EXTERNAL` addresses from `@pine/shared/deployment` (pinned by `test/config.test.ts`).

## Commands

```bash
pnpm --filter @pine/indexer-envio codegen     # offline and deterministic; writes .envio/ (ignored) and envio-env.d.ts (committed)
pnpm --filter @pine/indexer-envio typecheck   # codegen + tsc
pnpm --filter @pine/indexer-envio test        # codegen + vitest (createTestIndexer, simulate; no Docker, no network)
UPDATE_SNAPSHOTS=1 pnpm --filter @pine/indexer-envio test   # rewrite the entity snapshots (review the diff)
pnpm --filter @pine/indexer-envio start       # fail-closed env check, then envio start (needs Postgres ENVIO_PG_* and Hasura)
```

## Tests

- `test/entities.test.ts`: every frozen scenario (`scenarioClaimsAndEvidence`, `scenarioOracle`, `scenarioManyClaims`) is
  converted to simulated logs with explicit block, timestamp, hashes and log index, processed by the real handlers, and
  the entities are compared field by field with `MemoryReadModel` (also when processed in several batches). The rows are
  compared with the committed snapshots in `packages/read-model-envio/test/fixtures/<scenario>.entities.json` (sorted,
  bigints as decimal strings, bound to the SHA-256 of the scenario's events), which the read-model fake serves. They are
  rewritten only with `UPDATE_SNAPSHOTS=1`; a normal run fails on any difference and never writes.
- `test/handlers.test.ts`: reference edge cases beyond the scenarios (untracked ids for every event kind, duplicates,
  mixed-case input), halting domain checks for every Pine field, look-alike emitters for every source (SEC-IDX-05) and
  full-domain third-party values. `test/entities.test.ts` also re-submits every processed range to the same store
  (SEC-IDX-04: refused, nothing changes).
- `test/timeout.test.ts` / `test/timeout-invalid.test.ts`: `ENVIO_QUESTION_TIMEOUT` reaches the handlers (compared with
  the reference at 86400 s) and an invalid value stops processing (each file runs in its own process).
- `test/config.test.ts`: every event signature of `config.yaml` equals the shared ABI (names, parameter order, types,
  indexed flags, topic0), the addresses equal `GNOSIS_EXTERNAL`/the scenario placeholders, and the generated event
  types expose the block hash (an Envio default) and the transaction hash (`field_selection`). The native lane verifies the
  topic0s against real Gnosis logs; this lane relies on that plus this equality.
- `test/start.test.ts`: the fail-closed start script (placeholders, start block, block lag >= 40, https RPC, the
  `eth_chainId` check, the child-process refusal, `start` the only script that starts Envio) and its signal forwarding (stub child and stub
  signal source, plus a real process that receives SIGTERM on the wrapper's PID only).
- `test/lock.test.ts`: the takeover rules of the cross-process test lock (`test/lock-core.ts`).
- `test/static.test.ts`: handler purity, the test lock rule, package boundaries, the snapshot write rule, and that
  `schema.graphql` has no list-typed (Postgres array) or `@derivedFrom` fields.
- Test files that run `createTestIndexer` hold the cross-process lock in `test/lock.ts` (decisions.md, test memory).
- Coverage matrix (PRD-05 section 3/3a and decisions.md to the test that fails without each behaviour): `COVERAGE.md`.

## Operational notes

- **Single data source (launch gate).** Unlike the native indexer (two providers that must agree, log `blockHash`es
  checked against headers), the Envio option trusts ONE source: HyperSync when `ENVIO_API_TOKEN` is set (RPC as
  fallback), otherwise the configured RPC alone (`pnpm start` prints a warning in that case). Choosing Envio for
  production therefore requires HyperSync or an RPC the operator has verified; that choice is part of the Envio launch
  gate together with `test:live` and the read-only Hasura role (`packages/read-model-envio/README.md`).
- **Spam on untracked ids.** Envio cannot filter Reality.eth and Conditional Tokens logs by tracked question/condition id
  (the native plan filters on topic1): it ingests every log of the configured topic0s at those addresses and drops
  untracked ones by entity lookup. Anyone can emit cheap Reality/CTF logs, so third-party spam slows (and with an RPC-only
  source can stall) this optional backend; it cannot corrupt it. Spam-resistance is a property of the native backend only.
- Rows are served `block_lag` (~40 blocks, ~3.5 min) behind the source head and rolled back on reorgs inside
  `max_reorg_depth`; the read model reports `finalizedBlock: null` because Envio does not track finality.
- A handler error (domain violation) stops indexing; `status().indexedBlock` then stops advancing. Monitor lag.
- Choosing this backend requires passing `pnpm --filter @pine/read-model-envio test:live` against the real deployment.

## Launch gate (before choosing the Envio option)

1. `pnpm --filter @pine/read-model-envio test:live` passes against the real deployment (verifies `src/envio-meta.ts`).
2. Reorg/rollback drill (SEC-IDX-03; operator-settled exception: `createTestIndexer` cannot roll back, so no in-repo
   test exists): on a test deployment, force a reorg inside `max_reorg_depth` (e.g. a local fork that replaces the last
   blocks) and confirm the rows of the replaced blocks are rolled back and re-indexed, equal to a clean re-index.
3. HyperSync, or an RPC the operator has verified, as the data source (single source; SEC-IDX-06 asks for two providers,
   which Envio 3.12.1 cannot cross-check). `pnpm start` checks `eth_chainId` itself.
4. The read-only Hasura role for the API (`packages/read-model-envio/README.md`; SEC-IDX-11), checked by a mutation
   attempt as that role failing.
5. Finality: Envio has no per-record finality (SEC-IDX-01); rows trail the head by `block_lag` ≥ 40 blocks and
   `status().finalizedBlock` is `null`. Accepting that is part of choosing the option.
